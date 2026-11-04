import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType } from 'discord.js';
import { VoiceConnectionDisconnectReason as Reason } from '@discordjs/voice';
import { execute } from '../src/commands/execute.js';
import { interactionHandler } from '../src/events/interactionCreate.js';
import { voiceStateHandler } from '../src/events/voiceStateUpdate.js';
import { VoiceSession } from '../src/music/VoiceSession.js';
import { withAbort } from '../src/utils/async.js';
import { fixture,logger,track,settle ,componentText} from './helpers.js';

function context(user='host',channelId=null,moderator=false){
  const channel=channelId?{id:channelId,type:ChannelType.GuildVoice,full:false,permissionsFor:()=>({has:()=>true})}:null;
  const member={voice:{channel},permissions:{has:()=>moderator}};
  return {guildId:'guild',guild:{id:'guild',members:{fetch:async()=>member,me:{voice:{}}}},user:{id:user,username:user},inGuild:()=>true,isButton:()=>false,options:{},editReply:async()=>{}};
}
async function playing(t){
  const f=fixture({config:{persistent:true}});t.after(()=>f.player.destroy());
  await f.player.enqueue([{...track('Song'),requestedBy:{id:'host'}}],f.channel);
  let cancelled=0;const manager={get:()=>f.player,cancelImport:()=>{cancelled++;}};
  return {...f,manager,cancelled:()=>cancelled};
}

test('session host can stop from outside voice and stop always disconnects',async t=>{
  const f=await playing(t);await execute(context(),f.manager,'stop');
  assert.equal(f.player.current,null);assert.equal(f.player.queue.length,0);assert.equal(f.player.voice.channelId,null);
  assert.ok(f.player.closed);assert.equal(f.player.persistent,false);assert.equal(f.cancelled(),1);
});
test('session host can leave after moving to another voice channel',async t=>{
  const f=await playing(t);await execute(context('host','other'),f.manager,'leave');assert.equal(f.player.voice.channelId,null);
});
test('non-host users cannot stop or disconnect even from the active voice channel',async t=>{
  const f=await playing(t);
  for(const action of ['stop','leave'])await assert.rejects(execute(context('other-user','voice'),f.manager,action),/session host/);
  assert.equal(f.player.current.title,'Song');assert.equal(f.cancelled(),0);
});
test('a Manage Server moderator can stop a session from outside voice',async t=>{
  const f=await playing(t);await execute(context('moderator',null,true),f.manager,'stop');assert.equal(f.player.voice.channelId,null);
});
test('host exception does not relax other playback control voice permissions',async t=>{
  const f=await playing(t);await assert.rejects(execute(context(),f.manager,'pause'),/Join a voice/);assert.equal(f.player.state,'playing');
});
test('adding another requester to the queue does not transfer session ownership',async t=>{
  const f=await playing(t);await f.player.enqueue([{...track('Guest Song'),requestedBy:{id:'guest'}}],f.channel);
  assert.equal(f.player.ownerId,'host');await assert.rejects(execute(context('guest','voice'),f.manager,'stop'),/session host/);
});
test('stop button uses host authorization without requiring voice membership',async t=>{
  const f=await playing(t),i=context();let reply;
  Object.assign(i,{isButton:()=>true,customId:'music:current:stop',message:{id:'player'},deferReply:async()=>{i.deferred=true;},editReply:async payload=>{reply=payload;}});
  f.manager.presenters=new Map([['guild',{nonce:'current',message:{id:'player'}}]]);
  await interactionHandler(f.manager,logger)(i);assert.match(componentText(reply),/left voice/);assert.equal(f.player.voice.channelId,null);
});
test('host is assigned before discovery so stop can cancel an in-flight first play',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());const controller=new AbortController(),i=context('host','voice');
  i.channel={isTextBased:()=>true,isThread:()=>false,permissionsFor:()=>({has:()=>true})};i.options.getString=()=> 'Artist Song';
  const manager={get:()=>f.player,presenters:new Map(),import:async(_id,fn)=>fn(controller.signal),cancelImport:()=>controller.abort(),
    discovery:{resolve:(_query,signal)=>withAbort(new Promise(()=>{}),signal)}};
  const request=execute(i,manager,'play');const failed=assert.rejects(request,{name:'AbortError'});await settle();
  assert.equal(f.player.ownerId,'host');await execute(context(),manager,'stop');await failed;
  assert.ok(f.player.closed);assert.equal(f.player.voice.channelId,null);assert.equal(f.player.queue.length,0);
});
test('gateway removal closes immediately, cancels imports and overrides 24/7',async t=>{
  const f=await playing(t);f.manager.players=new Map([['guild',f.player]]);
  const handler=voiceStateHandler(f.manager,{user:{id:'bot'}},logger);
  const old={channelId:'voice'},next={id:'bot',guild:{id:'guild'},channelId:null};
  handler(old,next);handler(old,next);assert.equal(f.player.voice.channelId,null);assert.ok(f.player.closed);
  await settle();assert.equal(f.player.current,null);assert.equal(f.player.persistent,false);assert.equal(f.cancelled(),1);
});
test('user voice updates and bot channel moves do not terminate the session',async t=>{
  const f=await playing(t);f.manager.players=new Map([['guild',f.player]]);const handler=voiceStateHandler(f.manager,{user:{id:'bot'}},logger);
  handler({channelId:'voice'},{id:'human',guild:{id:'guild'},channelId:null});
  handler({channelId:'voice'},{id:'bot',guild:{id:'guild'},channelId:'other'});
  assert.equal(f.player.closed,false);assert.equal(f.cancelled(),0);
});
test('late voice-loss callbacks cannot alter or restart a stopped session',async t=>{
  const f=await playing(t),notices=[];f.player.on('notice',message=>notices.push(message));
  await execute(context(),f.manager,'stop');f.player.connectionLost();await settle();
  assert.equal(f.player.current,null);assert.equal(f.player.voice.channelId,null);assert.equal(f.player.state,'disconnected');assert.deepEqual(notices,[]);
});

function voiceFixture(wait){
  let lost=0,rejoins=0;const connection=new EventEmitter();
  Object.assign(connection,{state:{status:'ready'},joinConfig:{channelId:'voice'},subscribe(){},destroy(){this.state={status:'destroyed'};this.emit('destroyed');},rejoin(){rejoins++;}});
  const voice=new VoiceSession({id:'guild'},{},()=>{lost++;},logger,{createConnection:()=>connection,waitForState:async(conn,status,signal)=>{
    if(conn.state.status==='ready')return conn;return wait(conn,status,signal);
  }});
  return {voice,connection,lost:()=>lost,rejoins:()=>rejoins};
}
test('manual disconnect never waits or sends a rejoin',async()=>{
  const f=voiceFixture(()=>assert.fail('manual disconnect tried recovery'));await f.voice.join({id:'voice'});
  f.connection.state={status:'disconnected',reason:Reason.Manual};await f.voice.recover(f.connection);
  assert.equal(f.rejoins(),0);assert.equal(f.lost(),1);assert.equal(f.voice.connection,null);
});
test('4014 do-not-reconnect close never explicitly rejoins after its grace period',async()=>{
  const f=voiceFixture(async()=>{throw Error('not ready');});await f.voice.join({id:'voice'});
  f.connection.state={status:'disconnected',reason:Reason.WebSocketClose,closeCode:4014};await f.voice.recover(f.connection);
  assert.equal(f.rejoins(),0);assert.equal(f.lost(),1);
});
test('4014 automatic channel-move recovery can finish without an explicit rejoin',async()=>{
  const f=voiceFixture(async conn=>{conn.state={status:'ready'};return conn;});await f.voice.join({id:'voice'});
  f.connection.state={status:'disconnected',reason:Reason.WebSocketClose,closeCode:4014};await f.voice.recover(f.connection);
  assert.equal(f.rejoins(),0);assert.equal(f.lost(),0);assert.equal(f.voice.connection,f.connection);f.voice.destroy();
});
test('transient failures retain a bounded two-rejoin recovery budget',async()=>{
  const f=voiceFixture(async()=>{throw Error('network unavailable');});await f.voice.join({id:'voice'});
  f.connection.state={status:'disconnected',reason:Reason.EndpointRemoved};await f.voice.recover(f.connection);
  assert.equal(f.rejoins(),2);assert.equal(f.lost(),1);assert.equal(f.voice.connection,null);
});
test('destroy cancels an active recovery waiter before it can rejoin',async()=>{
  const f=voiceFixture((_conn,_status,signal)=>withAbort(new Promise(()=>{}),signal));await f.voice.join({id:'voice'});
  f.connection.state={status:'disconnected',reason:Reason.EndpointRemoved};const recovering=f.voice.recover(f.connection);await settle();
  f.voice.destroy();await recovering;assert.equal(f.rejoins(),0);assert.equal(f.lost(),0);assert.equal(f.voice.recoveryController,null);
});
