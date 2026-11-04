import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, escapeMarkdown } from 'discord.js';
import { componentsMessage, textDisplay } from '../components/messages.js';
import { Mutex } from '../utils/async.js';
import { UserError } from '../utils/errors.js';

export const skipVotePrefix = 'music-vote:';
const votes = new WeakMap();
const voteDuration = 60_000;

function voteMessage(vote, notify = false) {
  const question = `**Skip this song?**\n${vote.title}\n\nYes: **${vote.yes}/${vote.required}** • No: **${vote.no}** • Listeners: **${vote.eligible.size}**`;
  const status = vote.result ?? `Choose Yes or No. Voting ends <t:${Math.floor(vote.deadline / 1000)}:R>.`;
  const container = new ContainerBuilder().addTextDisplayComponents(
    textDisplay(`${question}\n${status}`),
    textDisplay(vote.mentions.map(id => `<@${id}>`).join(' '))
  );
  const buttons = [['yes', 'Yes', ButtonStyle.Success], ['no', 'No', ButtonStyle.Danger]];
  container.addActionRowComponents(new ActionRowBuilder().addComponents(buttons.map(
    ([choice, label, style]) => new ButtonBuilder()
      .setCustomId(`${skipVotePrefix}${vote.id}:${choice}`)
      .setLabel(label)
      .setStyle(style)
      .setDisabled(Boolean(vote.result))
  )));
  const payload = componentsMessage([container]);
  if (notify) payload.allowedMentions.users = vote.mentions;
  return payload;
}

function matchesTrack(vote, player) {
  return !player.closed && player.generation === vote.generation &&
    player.current === vote.track && player.voice.channelId === vote.voiceChannel.id;
}

function updateMessage(vote, player) {
  return vote.edits.run(async () => {
    if (vote.message) await vote.message.edit(voteMessage(vote));
  }).catch(error => {
    if (error.code === 10008) removeSkipVote(player, vote.message.id);
    else player.logger.warn('skip_vote_edit_failed', { guildId: player.guild.id, error });
  });
}

function closeVote(vote, player, result) {
  vote.result = result;
  clearTimeout(vote.timer);
  player.off('change', vote.onChange);
}

export function removeSkipVote(player, messageId) {
  const vote = votes.get(player);
  if (!vote?.message || vote.message.id !== messageId) return;
  closeVote(vote, player, 'Vote message deleted.');
  votes.delete(player);
}

export async function requestSkip(interaction, player, voiceChannel, track, generation) {
  if (player.closed || player.current !== track || player.generation !== generation) {
    throw new UserError('The track has changed. Try Skip again.');
  }
  if (!track || track.requestedBy?.id === interaction.user.id) {
    return await player.skip(generation) ? 'Skipped.' : 'A skip was already handled.';
  }
  if (player.voice.channelId !== voiceChannel.id) throw new UserError('Join the bot’s voice channel to start a skip vote.');
  const previous = votes.get(player);
  if (previous && matchesTrack(previous, player)) {
    return previous.result ? 'This song’s skip vote has ended.' : 'A skip vote is already open for this song.';
  }
  const eligible = new Set([...voiceChannel.members.values()].filter(member => !member.user.bot).map(member => member.id));
  if (!eligible.has(interaction.user.id)) throw new UserError('Join the bot’s voice channel to start a skip vote.');
  const vote = {
    id: randomUUID(), track, generation, voiceChannel, eligible,
    title: escapeMarkdown(track.title.slice(0, 250).replace(/[\r\n]/g, ' ')),
    mentions: [...eligible].slice(0, 100),
    required: Math.floor(eligible.size / 2) + 1,
    deadline: Date.now() + voteDuration, ballots: new Set(), yes: 0, no: 0,
    edits: new Mutex()
  };
  votes.set(player, vote);
  vote.onChange = () => {
    if (matchesTrack(vote, player)) return;
    closeVote(vote, player, 'Track changed. Vote closed.');
    void updateMessage(vote, player);
  };
  player.on('change', vote.onChange);
  vote.timer = setTimeout(() => {
    closeVote(vote, player, 'Time expired. The song was kept.');
    void updateMessage(vote, player);
  }, voteDuration).unref();
  try {
    vote.message = await interaction.channel.send(voteMessage(vote, true));
  } catch (error) {
    closeVote(vote, player, 'Vote could not be posted.');
    if (votes.get(player) === vote) votes.delete(player);
    throw error;
  }
  if (vote.result) await updateMessage(vote, player);
  return interaction.isButton() ? 'Skip vote posted.' : null;
}

export async function castSkipVote(interaction, player) {
  const vote = votes.get(player);
  const [id, choice] = interaction.customId.slice(skipVotePrefix.length).split(':');
  if (!vote || vote.result || vote.id !== id || vote.message?.id !== interaction.message.id ||
      !matchesTrack(vote, player) || Date.now() >= vote.deadline || !['yes', 'no'].includes(choice)) {
    throw new UserError('This skip vote has ended.');
  }
  const userId = interaction.user.id;
  if (!vote.eligible.has(userId) || !vote.voiceChannel.members.has(userId)) {
    throw new UserError('Only listeners who were in this voice channel when the vote opened can vote while connected.');
  }
  if (vote.ballots.has(userId)) throw new UserError('You already voted on this song.');
  vote.ballots.add(userId);
  if (choice === 'yes') vote.yes++;
  else vote.no++;

  if (vote.yes >= vote.required) {
    closeVote(vote, player, 'Vote passed. Skipping…');
    void updateMessage(vote, player);
    try {
      vote.result = await player.skip(vote.generation) ? 'Vote passed. Song skipped.' : 'Track changed. Vote closed.';
    } catch (error) {
      vote.result = 'The skip could not be completed.';
      throw error;
    } finally {
      await updateMessage(vote, player);
    }
  } else {
    if (vote.no > vote.eligible.size - vote.required) closeVote(vote, player, 'Vote failed. The song was kept.');
    await updateMessage(vote, player);
  }
  return 'Vote recorded.';
}
