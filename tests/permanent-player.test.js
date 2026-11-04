import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { GuildSettings } from '../src/config/GuildSettings.js';
import { loadConfig } from '../src/config/config.js';
import { PlayerMessageStore } from '../src/components/PlayerMessageStore.js';
import { PlayerPresenter } from '../src/components/PlayerPresenter.js';
import { PLAYER_HEADING } from '../src/components/playerView.js';
import { MusicManager } from '../src/music/MusicManager.js';
import { requireLogChannel } from '../src/utils/channels.js';
import { PermissionFlagsBits,MessageFlags,MessageFlagsBitField } from 'discord.js';
import { fixture,logger,track,settle,componentText } from './helpers.js';

const GUILD='111111111111111111',CHANNEL='222222222222222222',OTHER='333333333333333333',BOT='444444444444444444';
let sequence=500000000000000000n;
const guild={id:GUILD,members:{me:{id:BOT}}};
const missing=()=>Object.assign(Error('Unknown message'),{code:10008});
function room(id=CHANNEL){
  const items=new Map(),sent=[],edits=[],fetches=[];
  const channel={id,guildId:GUILD,type:0,permissionsFor:()=>({has:()=>true})};
  const seed=(payload,author=BOT)=>{
    const message={id:String(sequence++),author:{id:author},embeds:[],components:[]};
    const apply=value=>{
      if(message.flags?.has(MessageFlags.IsComponentsV2))assert.equal(Object.hasOwn(value,'embeds'),false,'V2 edits must not include legacy embeds');
      if(value.embeds)message.embeds=value.embeds.map(embed=>embed.toJSON?.()??embed);
      if(value.components)message.components=value.components.map(component=>component.toJSON?.()??component);
      if(value.flags!==undefined)message.flags=new MessageFlagsBitField(value.flags);
    };
    apply(payload);
    message.edit=async value=>{if(!items.has(message.id))throw missing();apply(value);edits.push(value);return message;};
    items.set(message.id,message);return message;
  };
  channel.messages={fetch:async options=>{
    fetches.push(options);
    if(options.message){const message=items.get(options.message);if(!message)throw missing();return message;}
    return new Map([...items.entries()].reverse());
  }};
  channel.send=async payload=>{sent.push(payload);return seed(payload);};
  return Object.assign(channel,{items,sent,edits,fetches,seed});
}
async function setup(t){
  const settings=new GuildSettings();await settings.setDjChannel(GUILD,CHANNEL);
  const store=new PlayerMessageStore(settings),channel=room();
  const make=()=>{
    const f=fixture({id:GUILD});f.player.guild=guild;
    const presenter=new PlayerPresenter(f.player,logger,{messageStore:store});presenter.channel=channel;
    t.after(async()=>{await f.player.destroy();await presenter.dispose();});
    return {...f,presenter};
  };
  return {settings,store,channel,make};
}
async function settingsFile(t){
  const directory=await mkdtemp(path.join(tmpdir(),'music-player-message-'));
  t.after(()=>{assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep));return rm(directory,{recursive:true,force:true});});
  return path.join(directory,'settings.json');
}

test('playlist transitions, adding tracks, pause and volume all edit the same DJ message',async t=>{
  const {channel,settings,make}=await setup(t),f=make();
  await f.player.enqueue([track('First'),track('Second')],f.channel);await f.presenter.render();
  const id=f.presenter.message.id;
  await f.player.enqueue([track('Third')],f.channel);await f.presenter.render();
  await f.player.pause();await f.presenter.render();await f.player.setVolume(32);await f.presenter.render();
  await f.player.resume();f.fakePlayer.finish();await settle();await f.presenter.render();
  assert.equal(f.presenter.message.id,id);assert.equal(settings.getDjMessage(GUILD),id);
  assert.equal(channel.sent.length,1);assert.ok(componentText(channel.items.get(id)).includes('**Second**'));
  assert.equal(f.player.queue.length,1);assert.ok(channel.edits.length>=4);
});

test('a released production manager session reuses its previous DJ message',async t=>{
  const settings=new GuildSettings();await settings.setDjChannel(GUILD,CHANNEL);
  const channel=room(),server={...guild,channels:{cache:new Map([[CHANNEL,channel]])}};
  const manager=new MusicManager(loadConfig({}),logger,{settings,audio:{dispose(){}}});t.after(()=>manager.destroy());
  const first=manager.get(server,true);first.current=track('Before stop');first.state='playing';
  await manager.bindPresenter(server,channel);await manager.presenters.get(GUILD).render();
  const id=settings.getDjMessage(GUILD);
  await first.stop(true);
  const second=manager.get(server,true);second.current=track('After stop');second.state='playing';
  await manager.bindPresenter(server,channel);await manager.presenters.get(GUILD).render();await settle();
  assert.notEqual(first,second);assert.equal(settings.getDjMessage(GUILD),id);
  assert.equal(channel.sent.length,1);assert.ok(componentText(channel.items.get(id)).includes('**After stop**'));
});

test('saved message IDs survive a restart without searching or creating another message',async t=>{
  const file=await settingsFile(t),settings=new GuildSettings(file),channel=room();
  await settings.setDjChannel(GUILD,CHANNEL);
  let store=new PlayerMessageStore(settings),owner=store.claim(GUILD);
  const first=await store.render(guild,channel,{embeds:[{title:'First',author:{name:PLAYER_HEADING}}]},owner);
  const reloaded=await GuildSettings.open(file);store=new PlayerMessageStore(reloaded);owner=store.claim(GUILD);
  const restored=await store.render(guild,channel,{embeds:[{title:'Restored'}]},owner);
  assert.equal(restored.id,first.id);assert.equal(channel.sent.length,1);
  assert.deepEqual(channel.fetches.at(-1),{message:first.id,force:true});
  assert.equal(restored.embeds[0].title,'Restored');
});

test('migration adopts an existing bot player and ignores user copies and other bot embeds',async t=>{
  const {channel,store,settings}=await setup(t);
  const payload={embeds:[{title:'Old player',author:{name:'MUSIC • YOUR SERVER’S LISTENING ROOM'}}]};
  const old=channel.seed(payload);channel.seed(payload,'555555555555555555');channel.seed({embeds:[{title:'Other bot message'}]});
  const adopted=await store.render(guild,channel,{embeds:[{title:'New track'}]},store.claim(GUILD));
  assert.equal(adopted.id,old.id);assert.equal(settings.getDjMessage(GUILD),old.id);assert.equal(channel.sent.length,0);
  assert.deepEqual(channel.fetches,[{limit:100,cache:false}]);
});

test('deleted DJ message is replaced once even with simultaneous updates',async t=>{
  const {channel,store,settings}=await setup(t),owner=store.claim(GUILD);
  const first=await store.render(guild,channel,{embeds:[{title:'First'}]},owner);channel.items.delete(first.id);
  const results=await Promise.all(Array.from({length:10},(_,i)=>store.render(guild,channel,{embeds:[{title:String(i)}]},owner)));
  assert.equal(new Set(results.map(message=>message.id)).size,1);assert.equal(channel.sent.length,2);assert.equal(channel.items.size,1);
  assert.equal(settings.getDjMessage(GUILD),results[0].id);
});

test('access failures never create a duplicate DJ message',async t=>{
  const {channel,settings}=await setup(t),message=channel.seed({embeds:[{title:'Existing'}]});
  await settings.setDjMessage(GUILD,CHANNEL,message.id);
  channel.messages.fetch=async()=>{throw Object.assign(Error('Missing access'),{code:50013});};
  const store=new PlayerMessageStore(settings),owner=store.claim(GUILD);
  await assert.rejects(store.render(guild,channel,{},owner),{code:50013});assert.equal(channel.sent.length,0);
  assert.equal(settings.getDjMessage(GUILD),message.id);
});

test('a slow retiring presenter cannot overwrite a new session or make another message',async t=>{
  const {channel,make}=await setup(t),first=make();
  await first.player.enqueue([track('Old')],first.channel);await first.presenter.render();
  let release;const pending=new Promise(resolve=>{release=resolve;});
  first.presenter.setNoticeChannel({send:async()=>pending});first.presenter.notice('Disconnect notice');
  const retiring=first.presenter.dispose(),second=make();
  await second.player.enqueue([track('New')],second.channel);await second.presenter.render();
  release();await retiring;
  assert.equal(channel.sent.length,1);assert.ok(componentText(channel.items.values().next().value).includes('**New**'));
  assert.ok(channel.items.values().next().value.components.length);
});

test('creation in flight is shared with the next session rather than duplicated',async t=>{
  const {channel,store}=await setup(t);let release,entered;
  const waiting=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const send=channel.send;channel.send=async payload=>{entered();await waiting;return send(payload);};
  const first=store.render(guild,channel,{embeds:[{title:'Old'}]},store.claim(GUILD));await started;
  const second=store.render(guild,channel,{embeds:[{title:'New'}]},store.claim(GUILD));release();
  const [old,current]=await Promise.all([first,second]);
  assert.equal(old.id,current.id);assert.equal(channel.sent.length,1);assert.equal(current.embeds[0].title,'New');
});

test('failed persistence keeps the sent message in memory so retry edits it',async t=>{
  const {channel,store,settings}=await setup(t),save=settings.setDjMessage.bind(settings);let fail=true;
  settings.setDjMessage=(...args)=>{if(fail){fail=false;throw Error('Disk unavailable');}return save(...args);};
  const owner=store.claim(GUILD);
  await assert.rejects(store.render(guild,channel,{embeds:[{title:'First'}]},owner),/Disk unavailable/);
  const restored=await store.render(guild,channel,{embeds:[{title:'Retried'}]},owner);
  assert.equal(channel.sent.length,1);assert.equal(settings.getDjMessage(GUILD),restored.id);
});

test('changing DJ channels clears the old ID and rejects stale saves without losing log preferences',async t=>{
  const file=await settingsFile(t),settings=new GuildSettings(file);
  await settings.setDjChannel(GUILD,CHANNEL);await settings.setDjMessage(GUILD,CHANNEL,'666666666666666666');
  await settings.setLogChannel(GUILD,OTHER);await settings.setDjChannel(GUILD,CHANNEL);
  assert.equal(settings.getDjMessage(GUILD),'666666666666666666');
  await settings.setDjChannel(GUILD,OTHER);await settings.setDjMessage(GUILD,CHANNEL,'777777777777777777');
  const restored=await GuildSettings.open(file);assert.equal(restored.getDjMessage(GUILD),null);assert.equal(restored.getLogChannel(GUILD),OTHER);
  await writeFile(file,JSON.stringify({version:3,guilds:{[GUILD]:{djMessageId:'666666666666666666'}}}));
  await assert.rejects(GuildSettings.open(file),{code:'GUILD_SETTINGS'});
});

test('DJ persistence requires Read Message History while an ordinary log channel does not',async()=>{
  const channel=room();channel.permissionsFor=()=>({has:values=>![values].flat().includes(PermissionFlagsBits.ReadMessageHistory)});
  assert.equal(await requireLogChannel(guild,channel),channel);
  await assert.rejects(requireLogChannel(guild,channel,{history:true}),/Read Message History/);
});

test('a saved non-player message is rejected even when it was sent by this bot',async t=>{
  const {channel,store,settings}=await setup(t);
  for(const author of ['555555555555555555',BOT]){
    const unrelated=channel.seed({embeds:[{title:'Unrelated message'}]},author);
    await settings.setDjMessage(GUILD,CHANNEL,unrelated.id);
    await assert.rejects(store.render(guild,channel,{},store.claim(GUILD)),{code:'DJ_MESSAGE'});
  }
  assert.equal(channel.edits.length,0);assert.equal(channel.sent.length,0);
});

test('a deleted saved message after restart is replaced once and the new ID is remembered',async t=>{
  const {channel,store,settings}=await setup(t);
  await settings.setDjMessage(GUILD,CHANNEL,'888888888888888888');
  const owner=store.claim(GUILD),replacement=await store.render(guild,channel,{embeds:[{title:'New'}]},owner);
  await store.render(guild,channel,{embeds:[{title:'Next'}]},owner);
  assert.equal(channel.sent.length,1);assert.equal(settings.getDjMessage(GUILD),replacement.id);
});

test('guilds have separate permanent messages and disposing an unused presenter creates nothing',async t=>{
  const {channel,store,settings,make}=await setup(t),unused=make();await unused.presenter.dispose();assert.equal(channel.sent.length,0);
  const secondGuild={...guild,id:'999999999999999999'},secondChannel=room(OTHER);secondChannel.guildId=secondGuild.id;
  await settings.setDjChannel(secondGuild.id,OTHER);
  const [a,b]=await Promise.all([
    store.render(guild,channel,{embeds:[{title:'A'}]},store.claim(GUILD)),
    store.render(secondGuild,secondChannel,{embeds:[{title:'B'}]},store.claim(secondGuild.id))
  ]);
  assert.notEqual(a.id,b.id);assert.equal(settings.getDjMessage(GUILD),a.id);assert.equal(settings.getDjMessage(secondGuild.id),b.id);
  assert.equal(channel.sent.length,1);assert.equal(secondChannel.sent.length,1);
});
