import test from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, ChannelType, MessageFlags } from 'discord.js';
import { interactionHandler } from '../src/events/interactionCreate.js';
import { messageHandler } from '../src/events/messageCreate.js';
import { removeSkipVote } from '../src/commands/skipVote.js';
import { componentText, fixture, flattenComponents, logger, settle, track } from './helpers.js';

async function setup(t) {
  const f = fixture();
  t.after(() => f.player.destroy());
  const users = Array.from({ length: 6 }, (_, index) => ({
    id: String(100000000000000000n + BigInt(index)), bot: index === 5
  }));
  const voice = {
    ...f.channel, type: ChannelType.GuildVoice, permissionsFor: () => ({ has: () => true }),
    members: new Map()
  };
  for (const user of users) voice.members.set(user.id, { id: user.id, user, voice: { channel: voice } });
  const guild = { id: 'guild', members: { me: { voice: {} }, fetch: async id => voice.members.get(id) } };
  const manager = {
    get: () => f.player,
    presenters: new Map([['guild', { nonce: 'player', message: { id: 'player-message' } }]])
  };
  const posts = [], edits = [];
  const channel = {
    isThread: () => false, permissionsFor: () => ({ has: () => true }),
    send: async payload => {
      posts.push(payload);
      return { id: 'vote-message', edit: async update => { edits.push(update); } };
    }
  };
  const handleMessage = messageHandler(manager, logger, { cooldown: () => {} });
  const handleButton = interactionHandler(manager, logger, { cooldown: () => {} });
  async function skip(index) {
    let reply;
    await handleMessage({
      content: '>skip', guild, guildId: guild.id, author: users[index], channel, inGuild: () => true,
      reply: async payload => { reply = componentText(payload); }
    });
    return reply;
  }
  async function click(index, customId, messageId = 'vote-message') {
    let reply;
    const interaction = {
      guild, guildId: guild.id, channel, customId, user: users[index], message: { id: messageId },
      isButton: () => true, inGuild: () => true,
      deferReply: async ({ flags }) => {
        assert.equal(flags, MessageFlags.Ephemeral);
        interaction.deferred = true;
      },
      editReply: async payload => { reply = componentText(payload); }
    };
    await handleButton(interaction);
    return reply;
  }
  await f.player.enqueue([
    { ...track('Song A'), requestedBy: users[0] }, track('Song B'), track('Song C')
  ], voice);
  const buttons = () => flattenComponents(posts[0]).filter(component => component.type === 2);
  return { ...f, users, voice, posts, edits, skip, click, buttons };
}

test('the requester skips directly, while a listener opens one poll from the player button', async t => {
  const direct = await setup(t);
  assert.equal(await direct.skip(0), 'Skipped.');
  assert.equal(direct.player.current.title, 'Song B');
  assert.equal(direct.posts.length, 0);

  const f = await setup(t);
  assert.equal(await f.click(1, 'music:player:skip', 'player-message'), 'Skip vote posted.');
  assert.match(await f.skip(2), /already open/);
  assert.equal(f.posts.length, 1);
  assert.match(componentText(f.posts[0]), /Song A/);
  assert.match(componentText(f.posts[0]), /0\/3/);
  assert.deepEqual(f.posts[0].allowedMentions.users, f.users.slice(0, 5).map(user => user.id));
  assert.deepEqual(f.buttons().map(button => [button.label, button.style]), [
    ['Yes', ButtonStyle.Success], ['No', ButtonStyle.Danger]
  ]);
});

test('three of five Yes votes skip exactly one song even with concurrent clicks', async t => {
  const f = await setup(t);
  await f.skip(1);
  const yes = f.buttons()[0].custom_id;
  assert.match(await f.click(5, yes), /Only listeners/);
  const departed = f.voice.members.get(f.users[4].id);
  f.voice.members.delete(departed.id);
  assert.match(await f.click(4, yes), /Only listeners/);
  assert.equal(await f.click(1, yes), 'Vote recorded.');
  assert.match(await f.click(1, yes), /already voted/);
  assert.equal(await f.click(2, yes), 'Vote recorded.');
  assert.equal(f.player.current.title, 'Song A');
  await Promise.all([f.click(3, yes), f.click(0, yes)]);
  assert.equal(f.player.current.title, 'Song B');
  assert.equal(f.player.queue.length, 1);
  assert.match(componentText(f.edits.at(-1)), /Song skipped/);
  assert.deepEqual(f.edits.at(-1).allowedMentions.parse, []);
  assert.equal(f.edits.at(-1).allowedMentions.users, undefined);
  assert.match(await f.click(2, yes), /has ended/);
});

test('a blocking No vote closes the poll and leaves the song playing', async t => {
  const f = await setup(t);
  await f.skip(1);
  const no = f.buttons()[1].custom_id;
  for (const index of [1, 2, 3]) await f.click(index, no);
  assert.equal(f.player.current.title, 'Song A');
  assert.match(componentText(f.edits.at(-1)), /Vote failed/);
  assert.ok(flattenComponents(f.edits.at(-1)).filter(component => component.type === 2).every(button => button.disabled));
  assert.match(await f.skip(4), /has ended/);
  assert.equal(f.posts.length, 1);
});

test('the requester can still skip during voting and old buttons cannot skip the next song', async t => {
  const f = await setup(t);
  await f.skip(1);
  const yes = f.buttons()[0].custom_id;
  assert.equal(await f.skip(0), 'Skipped.');
  await settle();
  assert.match(componentText(f.edits.at(-1)), /Track changed/);
  assert.match(await f.click(2, yes), /has ended/);
  assert.equal(f.player.current.title, 'Song B');
});

test('deleting a poll allows a replacement and invalidates its old buttons',async t=>{
  const f=await setup(t);
  await f.skip(1);
  const old=f.buttons()[0].custom_id;
  removeSkipVote(f.player,'vote-message');
  await f.skip(2);
  assert.equal(f.posts.length,2);
  assert.match(await f.click(1,old),/has ended/);
  assert.equal(f.player.current.title,'Song A');
});
