import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp,readFile,writeFile,rm,readdir } from 'node:fs/promises';
import { ChannelType,PermissionFlagsBits } from 'discord.js';
import { GuildSettings } from '../src/config/GuildSettings.js';
import { findLogChannel,requireLogChannel } from '../src/utils/channels.js';
import { MusicManager } from '../src/music/MusicManager.js';
import { PlayerPresenter } from '../src/components/PlayerPresenter.js';
import { parsePrefix } from '../src/commands/parsePrefix.js';
import { messageHandler } from '../src/events/messageCreate.js';
import { messageContext } from '../src/commands/messageContext.js';
import { loadConfig } from '../src/config/config.js';
import { voiceStateHandler } from '../src/events/voiceStateUpdate.js';
import { fixture,logger,track,componentText,flattenComponents } from './helpers.js';

const GUILD='111111111111111111',OTHER_GUILD='222222222222222222',SOURCE='333333333333333333',OUTPUT='444444444444444444',SECOND='555555555555555555';
async function folder(t){
  const directory=await mkdtemp(path.join(tmpdir(),'music-log-settings-'));
  t.after(async()=>{assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep));await rm(directory,{recursive:true,force:true});});
  return directory;
}
function channel(id,name='music-logs',guildId=GUILD){
  const messages=[],edits=[],permissions={has:()=>true};
  const value={id,name,guildId,type:ChannelType.GuildText,isTextBased:()=>true,isThread:()=>false,permissionsFor:()=>permissions,messages,edits,permissions};
  value.send=async payload=>{messages.push(payload);const message={id:`message-${messages.length}`,edit:async next=>{edits.push(next);return message;}};return message;};
  return value;
}
function setup(t){
  const source=channel(SOURCE,'commands'),output=channel(OUTPUT),other=channel(SECOND,'other');
  const member={voice:{channel:null},permissions:{has:()=>true}};
  const channels=new Map([source,output,other].map(value=>[value.id,value]));
  const guild={id:GUILD,members:{me:{id:'bot',voice:{}},fetch:async()=>member},channels:{cache:channels,fetch:async id=>id?channels.get(id)??null:channels}};
  const manager=new MusicManager(loadConfig({}),logger,{audio:{dispose(){}}});t.after(()=>manager.destroy());
  const message=content=>({content,author:{id:'666666666666666666',username:'Listener'},guildId:GUILD,guild,channel:source,inGuild:()=>true,reply:payload=>source.send(payload)});
  const run=content=>messageHandler(manager,logger,{cooldown:()=>{}})(message(content));
  return {source,output,other,member,guild,channels,manager,message,run};
}

test('a slow presenter lookup cannot restore older DJ or log destinations',async t=>{
  const f=setup(t);
  f.manager.get(f.guild,true);
  await f.manager.setDjChannel(f.guild,f.source,f.source);
  await f.manager.setLogChannel(f.guild,f.source,f.source);
  let release, started;
  const resolving=new Promise(resolve=>{started=resolve;});
  const pending=new Promise(resolve=>{release=resolve;});
  f.manager.outputChannel=()=>{started();return pending;};
  const binding=f.manager.bindPresenter(f.guild,f.source);
  await resolving;
  try{
    await f.manager.setDjChannel(f.guild,f.other,f.source);
    await f.manager.setLogChannel(f.guild,f.output,f.source);
  }finally{release(f.source);await binding;}
  const presenter=f.manager.presenters.get(GUILD);
  assert.equal(presenter.channel,f.other);
  assert.equal(presenter.noticeTarget,f.output);
});

test('manual bot removal sends one log-channel notice even during immediate session release',async t=>{
  const f=setup(t),music=fixture({id:GUILD,config:{persistent:true}});
  t.after(()=>music.player.destroy());
  music.player.onRelease=player=>f.manager.release(player);
  const presenter=new PlayerPresenter(music.player,logger);
  f.manager.players.set(GUILD,music.player);f.manager.presenters.set(GUILD,presenter);
  await f.manager.setLogChannel(f.guild,f.output,f.source);
  await f.manager.setDjChannel(f.guild,f.other,f.source);
  await music.player.enqueue([track('Current'),track('Next')],music.channel);
  const handler=voiceStateHandler(f.manager,{user:{id:'bot'}},logger);
  const before={channelId:'voice'},after={id:'bot',guild:f.guild,channelId:null};
  handler(before,after);handler(before,after);
  await music.player.lock.run(()=>{});
  assert.equal(f.output.messages.length,1);
  assert.match(f.output.messages[0].content,/Disconnected from the voice channel/);
  assert.deepEqual(f.output.messages[0].allowedMentions,{parse:[]});
  assert.equal(f.source.messages.length,0);assert.equal(f.other.messages.length,0);
  assert.equal(music.player.voice.channelId,null);assert.equal(music.player.queue.length,0);
  assert.equal(f.manager.players.has(GUILD),false);assert.equal(presenter.disposed,true);
  assert.equal(presenter.noticeTimer,null);
});

test('logchannel accepts a channel name, mention, ID, off and status query',()=>{
  for(const text of ['#music-logs',`<#${OUTPUT}>`,OUTPUT,'off'])assert.equal(parsePrefix(`>logchannel ${text}`).values.channel,text);
  assert.equal(parsePrefix('>logchannel').values.channel,undefined);
  assert.throws(()=>parsePrefix('>logchannel #one #two'),/Too many/);
});
test('settings start empty and persist independently across guilds and restart',async t=>{
  const file=path.join(await folder(t),'data','guild-settings.json'),settings=await GuildSettings.open(file);
  assert.equal(settings.getLogChannel(GUILD),null);
  await Promise.all([settings.setLogChannel(GUILD,OUTPUT),settings.setLogChannel(OTHER_GUILD,SECOND)]);
  const loaded=await GuildSettings.open(file);assert.equal(loaded.getLogChannel(GUILD),OUTPUT);assert.equal(loaded.getLogChannel(OTHER_GUILD),SECOND);
  await loaded.setLogChannel(GUILD,null);const final=await GuildSettings.open(file);
  assert.equal(final.getLogChannel(GUILD),null);assert.equal(final.getLogChannel(OTHER_GUILD),SECOND);
  assert.deepEqual(await readdir(path.dirname(file)),['guild-settings.json']);
});
test('failed persistent writes do not apply a setting in memory',async t=>{
  const base=await folder(t),blocked=path.join(base,'file');await writeFile(blocked,'not a directory');
  const settings=new GuildSettings(path.join(blocked,'settings.json'));
  await assert.rejects(settings.setLogChannel(GUILD,OUTPUT),{code:'GUILD_SETTINGS'});assert.equal(settings.getLogChannel(GUILD),null);
});
test('malformed and oversized settings fail safely without silent routing fallback',async t=>{
  const file=path.join(await folder(t),'settings.json');
  for(const text of ['invalid private-settings-value',JSON.stringify({version:1,guilds:{bad:{logChannelId:OUTPUT}}}),' '.repeat(1024*1024+1)]){
    await writeFile(file,text);await assert.rejects(GuildSettings.open(file),error=>error.code==='GUILD_SETTINGS'&&!error.message.includes('private-settings-value'));
  }
});
test('settings validate IDs before writing',()=>{
  const settings=new GuildSettings();assert.throws(()=>settings.setLogChannel('../outside',OUTPUT),{code:'GUILD_SETTINGS'});
  assert.throws(()=>settings.setLogChannel(GUILD,'not-a-channel'),{code:'GUILD_SETTINGS'});
});
test('channel lookup supports names/mentions while rejecting duplicate names',async t=>{
  const f=setup(t);assert.equal(await findLogChannel(f.guild,'#music-logs'),f.output);assert.equal(await findLogChannel(f.guild,`<#${OUTPUT}>`),f.output);
  f.other.name='music-logs';await assert.rejects(findLogChannel(f.guild,'music-logs'),/Multiple channels/);
});
test('other-guild, voice and inaccessible channels cannot be configured',async t=>{
  const f=setup(t);await assert.rejects(requireLogChannel(f.guild,channel(SECOND,'private',OTHER_GUILD)),{code:'LOG_CHANNEL'});
  f.output.type=ChannelType.GuildVoice;await assert.rejects(requireLogChannel(f.guild,f.output),{code:'LOG_CHANNEL'});
  f.output.type=ChannelType.GuildText;f.output.permissions.has=()=>false;await assert.rejects(requireLogChannel(f.guild,f.output),/View Channel, Send Messages and Embed Links/);
});
test('moderators can configure the channel without joining voice',async t=>{
  const f=setup(t);await f.run('>logchannel #music-logs');assert.equal(f.manager.settings.getLogChannel(GUILD),OUTPUT);
  assert.match(componentText(f.source.messages.at(-1)),new RegExp(OUTPUT));assert.equal(f.output.messages.length,0);
});
test('non-moderators cannot inspect, change or disable the setting',async t=>{
  const f=setup(t);await f.manager.settings.setLogChannel(GUILD,OUTPUT);f.member.permissions.has=()=>false;
  for(const command of ['>logchannel','>logchannel #other','>logchannel off'])await f.run(command);
  assert.equal(f.manager.settings.getLogChannel(GUILD),OUTPUT);assert.ok(f.source.messages.every(value=>componentText(value).includes('Manage Server')));
});
test('queue replies stay in the invoking channel when logs are configured',async t=>{
  const f=setup(t),music=fixture({id:GUILD});f.manager.players.set(GUILD,music.player);
  await f.manager.settings.setLogChannel(GUILD,OUTPUT);await f.run('>queue');
  assert.equal(f.source.messages.length,1);assert.equal(f.output.messages.length,0);assert.ok(f.source.messages[0].components.length);
  assert.deepEqual(f.source.messages[0].allowedMentions,{parse:[],repliedUser:false});
});

test('help replies in each invoking channel despite independent log and DJ settings',async t=>{
  const f=setup(t);await f.manager.settings.setLogChannel(GUILD,OUTPUT);await f.manager.settings.setDjChannel(GUILD,SECOND);
  await f.run('>help');
  const second=f.message('>help');second.channel=f.other;second.reply=payload=>f.other.send(payload);
  await messageHandler(f.manager,logger,{cooldown:()=>{}})(second);
  assert.equal(f.source.messages.length,1);assert.equal(f.other.messages.length,1);assert.equal(f.output.messages.length,0);
  for(const output of [f.source,f.other]){
    assert.equal(output.messages[0].components[0].toJSON().components[0].content,'**Your Prefix is **`>`');
    assert.equal(output.messages[0].components.length,1);
    assert.deepEqual(output.messages[0].allowedMentions,{parse:[],repliedUser:false});
  }
  assert.equal(f.manager.players.size,0);assert.equal(f.manager.presenters.size,0);
});

test('help never looks up a missing log or DJ destination',async t=>{
  const f=setup(t);await f.manager.settings.setLogChannel(GUILD,OUTPUT);await f.manager.settings.setDjChannel(GUILD,SECOND);
  f.channels.delete(OUTPUT);f.channels.delete(SECOND);
  f.guild.channels.fetch=()=>assert.fail('Help tried to resolve an unrelated channel');
  await f.run('>help');assert.equal(f.source.messages.length,1);assert.ok(f.source.messages[0].components.length);
  assert.equal(f.output.messages.length,0);assert.equal(f.other.messages.length,0);
});

test('help usage errors stay local and its V2 layout works without Embed Links',async t=>{
  const f=setup(t);await f.manager.settings.setLogChannel(GUILD,OUTPUT);
  await f.run('>help extra');assert.match(componentText(f.source.messages[0]),/Usage: >help/);
  f.source.permissions.has=values=>![values].flat().includes(PermissionFlagsBits.EmbedLinks);
  await f.run('>help');assert.equal(f.source.messages[1].components.length,1);
  assert.equal(f.output.messages.length,0);
});

test('custom-prefix uppercase help stays in the invoking thread with thread permissions',async t=>{
  const f=setup(t);f.manager.config.prefix='!!';await f.manager.settings.setLogChannel(GUILD,OUTPUT);
  f.source.isThread=()=>true;
  f.source.permissions.has=values=>![values].flat().includes(PermissionFlagsBits.SendMessages);
  await f.run('!!HELP');assert.equal(f.source.messages.length,1);assert.equal(f.output.messages.length,0);
  const panels=f.source.messages[0].components.map(component=>component.toJSON());
  assert.equal(panels[0].components[0].content,'**Your Prefix is **`!!`');
  assert.ok(componentText(f.source.messages[0]).includes('`Play`'));assert.equal(panels.length,1);
});
test('malformed commands and validation errors stay in the invoking channel',async t=>{
  const f=setup(t);await f.manager.settings.setLogChannel(GUILD,OUTPUT);await f.run('>volume bad');await f.run('>unknown');
  assert.equal(f.source.messages.length,2);assert.equal(f.output.messages.length,0);assert.match(componentText(f.source.messages[0]),/Usage/);
});
test('search progress edits one message in the invoking channel',async t=>{
  const f=setup(t),context=messageContext(f.message('>play Song'),parsePrefix('>play Song'));
  await context.editReply('Searching of `Song`');await context.editReply('Added `Song` in the queue');
  assert.equal(context.channel,f.source);assert.equal(f.source.messages.length,1);assert.equal(f.output.messages.length,0);assert.equal(f.source.edits.length,1);
});
test('deleted or inaccessible configured channels do not silently send music elsewhere',async t=>{
  const f=setup(t);await f.manager.settings.setLogChannel(GUILD,OUTPUT);f.channels.delete(OUTPUT);
  await assert.rejects(f.manager.outputChannel(f.guild,f.source),{code:'LOG_CHANNEL'});
  await f.run('>queue');assert.equal(f.output.messages.length,0);assert.match(componentText(f.source.messages[0]),/No music session/);
  assert.equal(f.manager.settings.getLogChannel(GUILD),OUTPUT);
});
test('logchannel off is usable when the old destination is missing',async t=>{
  const f=setup(t);await f.manager.settings.setLogChannel(GUILD,OUTPUT);f.channels.delete(OUTPUT);await f.run('>logchannel off');
  assert.equal(f.manager.settings.getLogChannel(GUILD),null);await f.run('>help');assert.ok(f.source.messages.at(-1).components.length);
});
test('changing the DJ output invalidates old controls and preserves active audio',async t=>{
  const f=setup(t),music=fixture({id:GUILD});await music.player.enqueue([track('A')],music.channel);
  const presenter=new PlayerPresenter(music.player,logger);f.manager.players.set(GUILD,music.player);f.manager.presenters.set(GUILD,presenter);
  presenter.bind(f.source);await presenter.render();const handle=music.player.handle,nonce=presenter.nonce;
  await f.manager.setDjChannel(f.guild,f.output,f.source);await presenter.render();
  assert.equal(music.player.handle,handle);assert.equal(music.player.current.title,'A');assert.notEqual(presenter.nonce,nonce);
  assert.equal(flattenComponents(f.source.edits.at(-1)).some(component=>component.type===2),false);assert.ok(componentText(f.source.edits.at(-1)).includes('**A**'));assert.equal(f.output.messages.length,1);assert.equal(presenter.channel,f.output);
});
test('relocation waits for an in-flight render so an old send cannot replace the new player',async t=>{
  const music=fixture({id:GUILD}),presenter=new PlayerPresenter(music.player,logger);t.after(async()=>{await music.player.destroy();await presenter.dispose();});
  let release;const pending=new Promise(resolve=>{release=resolve;});const oldMessage={edit:async()=>{}};
  const old=channel(SOURCE),target=channel(OUTPUT);old.send=async()=>{await pending;return oldMessage;};presenter.channel=old;
  const rendering=presenter.render(),moving=presenter.relocate(target);release();await Promise.all([rendering,moving]);
  assert.equal(presenter.channel,target);assert.equal(presenter.message,null);await presenter.render();assert.equal(target.messages.length,1);
});
test('default binding preserves the original session output without a configured destination',async t=>{
  const f=setup(t),music=fixture({id:GUILD}),presenter=new PlayerPresenter(music.player,logger);
  f.manager.players.set(GUILD,music.player);f.manager.presenters.set(GUILD,presenter);presenter.bind(f.source);
  await f.manager.bindPresenter(f.guild,f.other);assert.equal(presenter.channel,f.source);
});
test('saved JSON contains only channel preferences and no runtime player data',async t=>{
  const file=path.join(await folder(t),'settings.json'),settings=new GuildSettings(file);await settings.setLogChannel(GUILD,OUTPUT);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{version:4,guilds:{[GUILD]:{logChannelId:OUTPUT}}});
});
test('production manager factory reloads saved routing after a restart',async t=>{
  const f=setup(t),config={...loadConfig({}),settingsFile:path.join(await folder(t),'settings.json')};
  const first=await MusicManager.create(config,logger);await first.setLogChannel(f.guild,f.output,f.source);await first.destroy();
  const restarted=await MusicManager.create(config,logger);t.after(()=>restarted.destroy());
  assert.equal(await restarted.outputChannel(f.guild,f.source),f.output);
});
test('legacy log settings load without inventing a DJ channel and migrate safely',async t=>{
  const file=path.join(await folder(t),'settings.json');await writeFile(file,JSON.stringify({version:1,guilds:{[GUILD]:{logChannelId:OUTPUT}}}));
  const settings=await GuildSettings.open(file);assert.equal(settings.getLogChannel(GUILD),OUTPUT);assert.equal(settings.getDjChannel(GUILD),null);
  await settings.setDjChannel(GUILD,SECOND);const loaded=await GuildSettings.open(file);
  assert.equal(loaded.getLogChannel(GUILD),OUTPUT);assert.equal(loaded.getDjChannel(GUILD),SECOND);assert.equal(JSON.parse(await readFile(file,'utf8')).version,4);
});
test('concurrent log and DJ updates preserve both destinations and reset independently',async t=>{
  const file=path.join(await folder(t),'settings.json'),settings=new GuildSettings(file);
  await Promise.all([settings.setLogChannel(GUILD,OUTPUT),settings.setDjChannel(GUILD,SECOND)]);
  await settings.setLogChannel(GUILD,null);const loaded=await GuildSettings.open(file);
  assert.equal(loaded.getLogChannel(GUILD),null);assert.equal(loaded.getDjChannel(GUILD),SECOND);
  await loaded.setLogChannel(GUILD,OUTPUT);await loaded.setDjChannel(GUILD,null);
  assert.equal(loaded.getLogChannel(GUILD),OUTPUT);assert.equal(loaded.getDjChannel(GUILD),null);
});
test('DJ command supports names, status and off independently from the log channel',async t=>{
  const f=setup(t);assert.equal(parsePrefix('>djchannel #other').values.channel,'#other');
  await f.run('>logchannel #music-logs');await f.run('>djchannel #other');
  assert.equal(f.manager.settings.getLogChannel(GUILD),OUTPUT);assert.equal(f.manager.settings.getDjChannel(GUILD),SECOND);
  await f.run('>djchannel');assert.match(componentText(f.source.messages.at(-1)),new RegExp(SECOND));
  await f.run('>djchannel off');assert.equal(f.manager.settings.getDjChannel(GUILD),null);assert.equal(f.manager.settings.getLogChannel(GUILD),OUTPUT);
});
test('DJ configuration requires Manage Server even if a user is in voice',async t=>{
  const f=setup(t);f.member.permissions.has=()=>false;await f.run('>djchannel #other');
  assert.equal(f.manager.settings.getDjChannel(GUILD),null);assert.match(componentText(f.source.messages.at(-1)),/Manage Server/);
});
test('changing only the log channel does not move the embed or invalidate its controls',async t=>{
  const f=setup(t),music=fixture({id:GUILD}),presenter=new PlayerPresenter(music.player,logger);
  f.manager.players.set(GUILD,music.player);f.manager.presenters.set(GUILD,presenter);presenter.bind(f.other);await presenter.render();const nonce=presenter.nonce;
  await f.manager.setLogChannel(f.guild,f.output,f.source);
  assert.equal(presenter.channel,f.other);assert.equal(presenter.noticeChannel,f.output);assert.equal(presenter.nonce,nonce);assert.equal(f.output.messages.length,0);
});
test('play confirmation stays local, the embed stays in DJ, and notices go to logs',async t=>{
  const f=setup(t),music=fixture({id:GUILD}),presenter=new PlayerPresenter(music.player,logger);
  f.manager.players.set(GUILD,music.player);f.manager.presenters.set(GUILD,presenter);
  f.manager.discovery={resolve:async()=>({tracks:[track('Song')],notices:[]})};
  f.member.voice.channel={id:'voice',type:ChannelType.GuildVoice,full:false,permissionsFor:()=>({has:()=>true})};
  await f.manager.settings.setLogChannel(GUILD,OUTPUT);await f.manager.settings.setDjChannel(GUILD,SECOND);
  // The command channel only needs text replies when a separate DJ channel is set.
  f.source.permissions.has=value=>value!==PermissionFlagsBits.EmbedLinks;
  await f.run('>play Artist Song');await presenter.render();
  assert.equal(f.source.messages.length,1);assert.equal(componentText(f.source.messages[0]),'Searching of `Artist Song`');
  assert.equal(componentText(f.source.edits.at(-1)),'Added `Song` in the queue');assert.equal(f.output.messages.length,0);
  assert.equal(f.other.messages.length,1);assert.ok(f.other.messages[0].components.length);assert.equal(f.other.messages[0].content,undefined);
  presenter.notice('Playback notice');await new Promise(resolve=>{setTimeout(resolve,3100);});
  assert.equal(f.output.messages[0].content,'Playback notice');assert.equal(f.other.messages.length,1);
  const handle=music.player.handle;await f.run('>nowplaying');
  assert.equal(f.other.messages.length,1);assert.match(componentText(f.source.messages.at(-1)),/music player is in/);assert.equal(f.output.messages.length,1);assert.equal(music.player.handle,handle);
});

test('Spotify playlist queue confirmation hides resolver notices even on old cache entries',async t=>{
  const f=setup(t),music=fixture({id:GUILD});
  f.manager.players.set(GUILD,music.player);
  f.manager.discovery={resolve:async()=>({
    tracks:[track('Hum'),track('Next song')],
    notices:['Public collection metadata can be incomplete.'],
    diagnostics:['Partial Spotify import.']
  })};
  f.member.voice.channel={id:'voice',type:ChannelType.GuildVoice,full:false,permissionsFor:()=>({has:()=>true})};
  await f.run('>play https://open.spotify.com/playlist/1234567890123456789012');
  assert.equal(componentText(f.source.edits.at(-1)),'Added your Spotify playlist to the queue.');
  assert.equal(music.player.current.title,'Hum');
  assert.equal(music.player.queue.length,1);
});

test('volume, join and leave acknowledge locally while real notices stay in logs',async t=>{
  const f=setup(t),music=fixture({id:GUILD}),presenter=new PlayerPresenter(music.player,logger);
  f.manager.players.set(GUILD,music.player);f.manager.presenters.set(GUILD,presenter);
  await f.manager.settings.setLogChannel(GUILD,OUTPUT);await f.manager.settings.setDjChannel(GUILD,SECOND);
  f.member.voice.channel={id:'voice',type:ChannelType.GuildVoice,full:false,permissionsFor:()=>({has:()=>true})};
  f.source.permissions.has=values=>![values].flat().includes(PermissionFlagsBits.EmbedLinks);
  for(const command of ['>join','>volume 42','>leave'])await f.run(command);
  assert.equal(f.source.messages.length,3);assert.match(componentText(f.source.messages[0]),/Connected/);
  assert.match(componentText(f.source.messages[1]),/Volume set to 42/);assert.equal(componentText(f.source.messages[2]),'Left your voice channel.');
  for(const reply of f.source.messages){
    assert.equal(reply.content,undefined);assert.equal(reply.embeds,undefined);
    for(const container of reply.components){assert.equal(container.toJSON().type,17);assert.equal(container.toJSON().accent_color,undefined);}
  }
  assert.equal(f.output.messages.length,0);
  presenter.notice('Playback interrupted');await presenter.flushNotice();
  assert.equal(f.output.messages.length,1);assert.equal(f.output.messages[0].content,'Playback interrupted');
});

test('a missing log channel cannot block command replies or their local errors',async t=>{
  const f=setup(t),music=fixture({id:GUILD});f.manager.players.set(GUILD,music.player);
  await f.manager.settings.setLogChannel(GUILD,OUTPUT);f.channels.delete(OUTPUT);
  f.manager.outputChannel=()=>assert.fail('A command reply tried to resolve logs');
  f.member.voice.channel={id:'voice',type:ChannelType.GuildVoice,full:false,permissionsFor:()=>({has:()=>true})};
  for(const command of ['>volume 35','>queue','>pause','>volume invalid'])await f.run(command);
  assert.equal(f.source.messages.length,4);assert.match(componentText(f.source.messages[0]),/35%/);
  assert.ok(f.source.messages[1].components);assert.match(componentText(f.source.messages[2]),/No playing/);assert.match(componentText(f.source.messages[3]),/Usage/);
  assert.equal(f.output.messages.length,0);
});
test('log-only configuration does not pull the player away from the play command channel',async t=>{
  const f=setup(t),music=fixture({id:GUILD}),presenter=new PlayerPresenter(music.player,logger);
  f.manager.players.set(GUILD,music.player);f.manager.presenters.set(GUILD,presenter);await f.manager.settings.setLogChannel(GUILD,OUTPUT);
  await f.manager.bindPresenter(f.guild,f.source);assert.equal(presenter.channel,f.source);assert.equal(presenter.noticeChannel,f.output);
});
test('missing DJ destination can be reset without touching the log setting',async t=>{
  const f=setup(t);await f.manager.settings.setLogChannel(GUILD,OUTPUT);await f.manager.settings.setDjChannel(GUILD,SECOND);f.channels.delete(SECOND);
  await assert.rejects(f.manager.djChannel(f.guild,f.source),/DJ channel is unavailable/);await f.run('>djchannel off');
  assert.equal(f.manager.settings.getDjChannel(GUILD),null);assert.equal(f.manager.settings.getLogChannel(GUILD),OUTPUT);
});
test('a broken log destination cannot prevent the host from stopping outside voice',async t=>{
  const f=setup(t),music=fixture({id:GUILD});f.manager.players.set(GUILD,music.player);music.player.claimHost('666666666666666666');
  await music.player.enqueue([track('Song')],music.channel);await f.manager.settings.setLogChannel(GUILD,OUTPUT);f.channels.delete(OUTPUT);
  f.member.permissions.has=()=>false;f.source.permissions.has=value=>value!==PermissionFlagsBits.EmbedLinks;
  await f.run('>stop');assert.equal(music.player.voice.channelId,null);assert.ok(music.player.closed);assert.match(componentText(f.source.messages.at(-1)),/left voice/);
});

test('a missing log destination does not block play or leak playback notices into the DJ channel',async t=>{
  const f=setup(t),music=fixture({id:GUILD}),presenter=new PlayerPresenter(music.player,logger);
  f.manager.players.set(GUILD,music.player);f.manager.presenters.set(GUILD,presenter);
  f.manager.discovery={resolve:async()=>({tracks:[track('Song')],notices:[]})};
  await f.manager.settings.setDjChannel(GUILD,SECOND);await f.manager.settings.setLogChannel(GUILD,OUTPUT);f.channels.delete(OUTPUT);
  f.member.voice.channel={id:'voice',type:ChannelType.GuildVoice,full:false,permissionsFor:()=>({has:()=>true})};
  await f.run('>play Artist Song');await presenter.render();
  assert.equal(music.player.current.title,'Song');assert.match(componentText(f.source.edits.at(-1)),/Added `Song`/);
  assert.equal(presenter.noticeTarget,null);presenter.notice('Provider interrupted');await presenter.flushNotice();
  assert.equal(f.source.messages.length,1);assert.equal(f.other.messages.length,1);assert.equal(f.output.messages.length,0);
  await f.manager.setLogChannel(f.guild,f.other,f.source);presenter.notice('Recovered notice');await presenter.flushNotice();
  assert.equal(f.other.messages.at(-1).content,'Recovered notice');
});
