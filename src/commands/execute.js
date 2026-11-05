import { ChannelType, PermissionFlagsBits, escapeMarkdown } from 'discord.js';
import { commandMap } from './definitions.js';
import helpPanels from '../components/helpPanels.json' with { type: 'json' };
import { playerMessage, duration } from '../components/playerView.js';
import { panelsMessage, commandMessage } from '../components/messages.js';
import { UserError } from '../utils/errors.js';
import { integer, classifyInput } from '../utils/validators.js';
import { performance } from 'node:perf_hooks';
import { channelSettings } from './channelSettings.js';
import { OWNER_USER_ID, ownerCommands, requireOwner } from '../config/owner.js';
import { guildPrefix, prefixPanels } from '../config/prefix.js';
import { playlistCommand } from './playlist.js';
import { requestSkip } from './skipVote.js';
const readOnly=new Set(['help','queue','nowplaying','logchannel','djchannel']);
const songLabel=value=>`\`${String(value).replace(/`/g,'ˋ').replace(/[\r\n]/g,' ').slice(0,500)}\``;
export async function voiceAccess(interaction,player) {
  const member=await interaction.guild.members.fetch(interaction.user.id);
  const channel=member.voice.channel;
  if (!channel) throw new UserError('Join a voice channel before controlling music.');
  if (channel.type!==ChannelType.GuildVoice) throw new UserError('Use a regular voice channel. Stage channels are not supported.');
  const active=player?.voice.channelId;
  if (active && active!==channel.id) throw new UserError('Join the bot’s voice channel to control this session.');
  const bot=interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
  if (!channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak])) throw new UserError('The bot needs View Channel, Connect, and Speak permissions in your voice channel.');
  if (channel.full && !channel.permissionsFor(bot)?.has(PermissionFlagsBits.MoveMembers) && bot.voice.channelId!==channel.id) throw new UserError('That voice channel is full. Free a slot for the bot.');
  return {channel,member};
}
function requirePlayer(player,prefix) { if (!player) throw new UserError(`No music session is active. Use ${prefix}play or ${prefix}join first.`); return player; }
function admin(member) { if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) throw new UserError('Manage Server permission is required to change this setting.'); }
function textAccess(interaction,channel=interaction.channel){
  const bot=interaction.guild.members.me;
  const permissions=[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.EmbedLinks,channel?.isThread()?PermissionFlagsBits.SendMessagesInThreads:PermissionFlagsBits.SendMessages];
  if(!channel?.isTextBased()||!channel.permissionsFor(bot)?.has(permissions))throw new UserError('The bot needs View Channel, Send Messages (or Send Messages in Threads), and Embed Links here to show the music player.');
}
async function playRequest(interaction,manager,reply,load,{label,progress,confirmation}) {
  let player=manager.get(interaction.guild),access=await voiceAccess(interaction,player);
  textAccess(interaction,await manager.djChannel?.(interaction.guild,interaction.channel)??interaction.channel);
  // A server has one outstanding discovery request; queue mutations stay independent.
  return manager.import(interaction.guildId,async signal=>{
    const started=performance.now(),preparation=new AbortController();
    const prepareSignal=AbortSignal.any([signal,preparation.signal]);
    player=manager.get(interaction.guild,true);
    player.claimHost(interaction.user.id);
    const releaseIdle=player.holdIdleTimeout();
    const wasConnected=Boolean(player.voice.channelId),wasPlaying=Boolean(player.current);
    // Voice handshake and discovery run together; the first chat reply is
    // sent concurrently too. No track or audio resource is queued early.
    const voiceReady=wasPlaying?Promise.resolve():player.join(access.channel,{signal:prepareSignal});
    voiceReady.catch(error=>preparation.abort(error));
    const searchingReply=reply(progress);
    searchingReply.catch(error=>preparation.abort(error));
    let accepted=false;
    try{
      let result;
      try{result=await load(prepareSignal);}
      catch(error){
        if(['NO_MATCH','NO_RESULTS'].includes(error.code))throw new UserError(`Could not find ${songLabel(label)}.`,error.code);
        throw error;
      }
      prepareSignal.throwIfAborted();
      for(const diagnostic of result.diagnostics??[])manager.logger?.debug('music_discovery',{guildId:interaction.guildId,message:diagnostic});
      const tracks=result.tracks.map(track=>({...track,requestedBy:{id:interaction.user.id,name:interaction.user.globalName || interaction.user.username}}));
      if(!player.current){
        const next=player.queue.tracks[0]??tracks[0];
        manager.audio?.prefetch?.(next,{signal:prepareSignal}).catch(error=>{if(!prepareSignal.aborted)manager.logger?.debug('source_warmup_failed',{guildId:interaction.guildId,error});});
      }
      await voiceReady;
      // A user can move channels or lose permissions during discovery.
      access=await voiceAccess(interaction,manager.get(interaction.guild));
      prepareSignal.throwIfAborted();
      await manager.bindPresenter?.(interaction.guild,interaction.channel);
      const queued=await player.enqueue(tracks,access.channel,{signal:prepareSignal});
      accepted=true;
      manager.logger?.info('play_request_ready',{guildId:interaction.guildId,elapsedMs:Math.round(performance.now()-started),queuedDuringPlayback:wasPlaying});
      await searchingReply;
      const added=confirmation ?? (queued.added===1
        ? `Added ${songLabel(tracks[0].title)} in the queue`
        : `Added ${songLabel(tracks[0].title)} and ${queued.added-1} more track${queued.added===2?'':'s'} in the queue`);
      return await reply(queued.omitted ? `Added ${queued.added} track${queued.added===1?'':'s'} before the queue filled up.` : added);
    }finally{
      preparation.abort();await Promise.allSettled([voiceReady,searchingReply]);
      releaseIdle();
      if(!accepted&&!wasConnected&&!player.closed&&!player.current&&!player.queue.length&&!player.persistent)await player.stop(true);
    }
  });
}
export async function execute(interaction,manager,action=interaction.commandName) {
  if (!interaction.inGuild()) throw new UserError('Music commands are available in servers only.');
  const prefix=interaction.commandPrefix ?? guildPrefix(manager,interaction.guildId);
  if(!commandMap.has(action))throw new UserError(`Unknown music command. Use ${prefix}help.`);
  const reply=content=>interaction.editReply(commandMessage(content));
  if(ownerCommands.has(action)){
    requireOwner(interaction.user?.id);
    if(action==='clearcache'){
      const removed=manager.clearCaches();
      return reply(`Cleared ${removed} cache entries for played songs.`);
    }
    if(!manager.lifecycle)throw new UserError('Process controls are unavailable in this runtime. Use the supplied startup wrapper.');
    return manager.lifecycle.request(action,()=>reply(action==='shutdown'?'Shutting down the bot in all servers.':'Restarting the bot. Voice connections and in-memory queues will reset.'));
  }
  if(action==='prefix'){
    const selected=interaction.options.getString('prefix');
    if(!selected)return reply(`Your prefix is \`${guildPrefix(manager,interaction.guildId)}\`. Server admins can use \`${prefix}prefix !\` to change it.`);
    const member=await interaction.guild.members.fetch({user:interaction.user.id,force:true});
    if(!member.permissions.has(PermissionFlagsBits.Administrator))throw new UserError('Only server administrators can change the prefix.','ADMIN_ONLY');
    await manager.settings.setPrefix(interaction.guildId,selected);
    manager.presenters?.get(interaction.guildId)?.schedule();
    return reply(`Server prefix set to \`${selected}\`. Use \`${selected}help\` to see commands.`);
  }
  if(action==='playlist')return playlistCommand(interaction,manager,reply,tracks=>playRequest(interaction,manager,reply,async()=>({tracks}),{label:'your playlist',progress:'Preparing your saved playlist…'}));
  let player=manager.get(interaction.guild), access;
  if(action==='skip'){
    player=requirePlayer(player,prefix);
    const track=player.current, generation=player.generation;
    const {channel}=await voiceAccess(interaction,player);
    const status=await requestSkip(interaction,player,channel,track,generation);
    if(status)return reply(status);
    return;
  }
  if (!readOnly.has(action)&&!['stop','leave','play'].includes(action)) access=await voiceAccess(interaction,player);
  const option=interaction.options;
  if(['logchannel','djchannel'].includes(action))return channelSettings(interaction,manager,reply,action==='djchannel'?'dj':'log');
  if (action==='help') {
    const panels=helpPanels.filter(panel=>!panel.betaOnly||interaction.user?.id===OWNER_USER_ID);
    return reply(panelsMessage(prefixPanels(panels,prefix),{combine:true}));
  }
  if (action==='play') {
    const query=option.getString('query',true),parsed=classifyInput(query);
    const collection=parsed.type==='playlist'||parsed.type==='album';
    const source=parsed.source==='spotify'?'Spotify':'YouTube';
    const item=collection?`${source} ${parsed.type}`:undefined;
    const progress=item?`Adding your ${item}…`:parsed.type==='video'?'Preparing your track…':`Searching of ${songLabel(query)}`;
    const confirmation=item?`Added your ${item} to the queue.`:undefined;
    return playRequest(interaction,manager,reply,signal=>manager.discovery.resolve(query,signal),{label:query,progress,confirmation});
  }
  if(action==='join'){
    textAccess(interaction,await manager.djChannel?.(interaction.guild,interaction.channel)??interaction.channel);
    player=manager.get(interaction.guild,true);player.claimHost(interaction.user.id);
    const releaseIdle=player.holdIdleTimeout(),wasConnected=Boolean(player.voice.channelId);
    let connected=false;
    try{
      await manager.bindPresenter?.(interaction.guild,interaction.channel);
      await player.join(access.channel);connected=true;return await reply('Connected to your voice channel.');
    }finally{
      releaseIdle();
      if(!connected&&!wasConnected&&!player.closed&&!player.current&&!player.queue.length)await player.stop(true);
    }
  }
  if(action==='stop'||action==='leave') {
    if(player&&player.ownerId!==interaction.user.id){
      const member=await interaction.guild.members.fetch({user:interaction.user.id,force:true});
      if(!member.permissions.has(PermissionFlagsBits.ManageGuild))throw new UserError('Only the session host or a Manage Server moderator can stop or disconnect this session. The host can stop from outside voice.');
    }
    manager.cancelImport(interaction.guildId);
    if(player)await player.stop(true);
    if(action==='leave')return reply(player?'Left your voice channel.':'I’m already disconnected.');
    return reply('Stopped playback, cleared the queue, and left voice.');
  }
  if(action==='autoplay'){
    admin(await interaction.guild.members.fetch({user:interaction.user.id,force:true}));
    player=manager.get(interaction.guild,true);
    await player.join(access.channel);
    const enabled=option.getBoolean('enabled',true);
    await player.setAutoplay(enabled);
    return reply(`Autoplay ${enabled?'enabled':'disabled'} for this running session.`);
  }
  player=requirePlayer(player,prefix);
  switch(action){
    case 'pause': await player.pause(); return reply('Paused.');
    case 'resume': await player.resume(); return reply('Resumed.');
    case 'volume': await player.setVolume(option.getInteger('level',true)); return reply(`Volume set to ${player.volume}%.`);
    case 'loop': {
      const mode=interaction.isButton() ? ['off','track','queue'][(['off','track','queue'].indexOf(player.queue.loop)+1)%3] : option.getString('mode',true);
      await player.editQueue(queue=>queue.setLoop(mode)); return reply(`Repeat: ${mode}.`);
    }
    case 'shuffle': await player.editQueue(queue=>queue.shuffle()); return reply('Shuffled upcoming tracks.');
    case 'remove': {
      const removed=await player.editQueue(queue=>queue.remove(option.getInteger('position',true)));
      return reply(`Removed “${removed.title}”.`);
    }
    case 'nowplaying': {
      const dj=manager.settings?.getDjChannel(interaction.guildId);
      if(dj){await manager.bindPresenter(interaction.guild,interaction.channel);return reply(`The music player is in <#${dj}>.`);}
      return reply(playerMessage(player,undefined,{controls:false}));
    }
    case 'queue': {
      const page=option.getInteger('page')??1, pages=Math.max(1,Math.ceil(player.queue.length/10));
      integer(page,1,pages,'Page');
      const lines=player.queue.tracks.slice((page-1)*10,page*10).map((track,index)=>`**${(page-1)*10+index+1}.** ${escapeMarkdown(track.title.slice(0,120))} • ${duration(track.duration)}`);
      return reply(panelsMessage([{title:`**Up next • ${player.queue.length} tracks**`,description:`${lines.join('\n')||'The upcoming queue is empty.'}\n\nPage ${page}/${pages} • Repeat ${player.queue.loop}`} ]));
    }
    default: throw new UserError(`Unknown music command. Use ${prefix}help.`);
  }
}
