import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { execute } from '../src/commands/execute.js';
import { YouTubeResolver } from '../src/music/YouTubeResolver.js';
import { loadConfig } from '../src/config/config.js';
import { Semaphore,withAbort } from '../src/utils/async.js';
import { UserError } from '../src/utils/errors.js';
import { EventEmitter } from 'node:events';
import { VoiceSession } from '../src/music/VoiceSession.js';
import { fixture,track,logger,settle ,componentText} from './helpers.js';

function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const video={id:'abcdefghijk',title:'Song',url:'https://r1.googlevideo.com/audio?expire=9999999999',duration:180};
const target={youtubeUrl:'https://www.youtube.com/watch?v=abcdefghijk'};
function resolver(config={}){return new YouTubeResolver({...loadConfig({}),youtubeFastExtraction:true,...config},new Semaphore(2));}

test('fast extraction skips manifests and retains normal player/auth requests',async()=>{
  const y=resolver(),calls=[];y.json=async args=>{calls.push(args);return {data:video};};
  await y.audio(target);
  assert.equal(calls.length,1);assert.ok(calls[0].includes('youtube:skip=hls,dash,translated_subs'));
  assert.ok(!calls[0].join(' ').includes('player_skip'));assert.ok(!calls[0].join(' ').includes('player_client'));
});
test('normal extraction is the default and source selection checks download availability',async()=>{
  const config=loadConfig({});assert.equal(config.youtubeFastExtraction,false);
  const y=new YouTubeResolver(config,new Semaphore(2));let args;
  y.json=async value=>{args=value;return {data:video};};await y.audio(target);
  assert.ok(args.includes('--check-formats'));assert.ok(!args.includes('--check-all-formats'));assert.ok(!args.includes('--extractor-args'));
});
test('fast extraction falls back to full extraction once when no direct format exists',async()=>{
  const y=resolver(),calls=[];y.json=async args=>{calls.push(args);if(calls.length===1)throw new UserError('No format','FORMAT');return {data:video};};
  await y.audio(target);assert.equal(calls.length,2);assert.ok(!calls[1].includes('--extractor-args'));
});
test('missing fast source URL falls back once without skipping restriction checks',async()=>{
  const y=resolver();let calls=0;y.json=async()=>({data:++calls===1?{...video,url:undefined}:video});
  await y.audio(target);assert.equal(calls,2);
  const restricted=resolver();let restrictedCalls=0;restricted.json=async()=>{restrictedCalls++;return {data:{...video,url:undefined,age_limit:18}};};
  await assert.rejects(restricted.audio(target),/restricted/);assert.equal(restrictedCalls,1);
});
test('access and network errors do not trigger another extraction strategy',async()=>{
  for(const code of ['ACCESS_DENIED','RESTRICTED','REGION','EXTRACTOR','TOOL_TIMEOUT']){
    const y=resolver();let calls=0;y.json=async()=>{calls++;throw new UserError('Provider failure',code);};
    await assert.rejects(y.audio(target),{code});assert.equal(calls,1);
  }
});
test('full extraction can be selected explicitly and fallback is bounded',async()=>{
  const y=resolver({youtubeFastExtraction:false});let calls=0;y.json=async args=>{calls++;assert.ok(!args.includes('--extractor-args'));return {data:video};};
  await y.audio(target);assert.equal(calls,1);
  const failing=resolver();let failures=0;failing.json=async()=>{failures++;throw new UserError('No format','FORMAT');};
  await assert.rejects(failing.audio(target),{code:'FORMAT'});assert.equal(failures,2);
});
test('five-minute source cache remains bounded by actual signed URL expiry',async()=>{
  const y=resolver();assert.equal(y.config.audioSourceCacheMs,300000);
  const expires=Math.floor(Date.now()/1000)+120;y.json=async()=>({data:{...video,url:`https://r1.googlevideo.com/audio?expire=${expires}`}});
  const source=await y.audio(target);assert.ok(source.expiresAt<=expires*1000-30000);
});

function harness(t,overrides={}){
  const f=fixture();t.after(()=>f.player.destroy());
  const channel={...f.channel,type:ChannelType.GuildVoice,full:false,permissionsFor:()=>({has:()=>true})};
  const member={voice:{channel},permissions:{has:()=>true}};
  const guild={id:'guild',members:{fetch:async()=>member,me:{voice:{}}}};
  const controller=new AbortController(),replies=[];
  const interaction={guildId:'guild',guild,user:{id:'111111111111111111',username:'Listener'},channel:{isTextBased:()=>true,isThread:()=>false,permissionsFor:()=>({has:()=>true})},
    inGuild:()=>true,options:{getString:()=> 'Artist Song'},editReply:async payload=>{replies.push(componentText(payload));}};
  const manager={config:loadConfig({}),get:()=>f.player,presenters:new Map(),logger,import:async(_id,fn)=>fn(controller.signal),
    discovery:{resolve:async()=>({tracks:[track('Song')],notices:[]})},...overrides};
  return {...f,interaction,manager,member,controller,replies};
}

test('voice handshake and discovery overlap; source warming starts before voice is ready',async t=>{
  const discovery=deferred(),voice=deferred();let discoveryStarted=false,voiceStarted=false,warmed=false;
  const f=harness(t,{discovery:{resolve:async()=>{discoveryStarted=true;return discovery.promise;}},audio:{prefetch:async()=>{warmed=true;}}});
  let joins=0;f.player.voice.join=async(channel,{signal}={})=>{if(++joins===1){voiceStarted=true;await withAbort(voice.promise,signal);}f.player.voice.channelId=channel.id;};
  const request=execute(f.interaction,f.manager,'play');await settle();assert.ok(voiceStarted&&discoveryStarted);assert.equal(f.prepared.length,0);
  discovery.resolve({tracks:[track('Song')],notices:[]});await settle();assert.ok(warmed);assert.equal(f.prepared.length,0);
  voice.resolve();await request;assert.deepEqual(f.prepared,['Song']);
});
test('slow search reply delivery does not delay ready audio',async t=>{
  const delivery=deferred();const f=harness(t);let first=true;
  f.interaction.editReply=async()=>{if(first){first=false;await delivery.promise;}};
  const request=execute(f.interaction,f.manager,'play');await settle();await settle();
  assert.equal(f.player.current.title,'Song');assert.deepEqual(f.prepared,['Song']);delivery.resolve();await request;
});
test('failed discovery rolls back a newly created idle voice session',async t=>{
  const f=harness(t,{discovery:{resolve:async()=>{await settle();throw new UserError('No results','NO_MATCH');}}});
  await assert.rejects(execute(f.interaction,f.manager,'play'),{code:'NO_MATCH'});assert.equal(f.player.voice.channelId,null);assert.equal(f.prepared.length,0);
});
test('failed discovery preserves a pre-existing voice session',async t=>{
  const f=harness(t,{discovery:{resolve:async()=>{throw new UserError('No results','NO_MATCH');}}});f.player.voice.channelId='voice';
  await assert.rejects(execute(f.interaction,f.manager,'play'),{code:'NO_MATCH'});assert.equal(f.player.voice.channelId,'voice');
});
test('cancelled play aborts pending voice preparation and leaves no queued audio',async t=>{
  const voice=deferred();const f=harness(t);let signal;
  f.player.voice.join=async(_channel,options)=>{signal=options.signal;await withAbort(voice.promise,signal);};
  const request=execute(f.interaction,f.manager,'play');await settle();f.controller.abort();
  await assert.rejects(request,{name:'AbortError'});assert.ok(signal.aborted);assert.equal(f.prepared.length,0);assert.equal(f.player.queue.length,0);
});
test('moving to another channel during search cannot enqueue or move the bot',async t=>{
  const discovery=deferred();const f=harness(t,{discovery:{resolve:()=>discovery.promise}});
  const request=execute(f.interaction,f.manager,'play');await settle();f.member.voice.channel={...f.member.voice.channel,id:'other'};
  discovery.resolve({tracks:[track('Song')],notices:[]});await assert.rejects(request,/bot’s voice channel/);
  assert.equal(f.prepared.length,0);assert.equal(f.player.voice.channelId,null);
});
test('invalid URLs fail before connecting to voice or starting discovery',async t=>{
  const f=harness(t,{discovery:{resolve:()=>assert.fail('invalid input reached discovery')}});
  f.interaction.options.getString=()=> 'https://youtube.com.evil.test/watch?v=abcdefghijk';
  await assert.rejects(execute(f.interaction,f.manager,'play'));assert.equal(f.player.voice.channelId,null);
});
test('idle leave is suspended during discovery and restored after a failed request',async t=>{
  const discovery=deferred();const f=harness(t,{discovery:{resolve:()=>discovery.promise}});f.player.voice.channelId='voice';
  const request=execute(f.interaction,f.manager,'play');await settle();f.player.scheduleIdle();
  assert.equal(f.player.idleTimer,null);assert.equal(f.player.idleHolds,1);
  discovery.reject(new UserError('No results','NO_MATCH'));await assert.rejects(request,{code:'NO_MATCH'});
  assert.equal(f.player.idleHolds,0);assert.ok(f.player.idleTimer);assert.equal(f.player.voice.channelId,'voice');
});
test('voice handshake failure cancels discovery without queuing a track',async t=>{
  let cancelled=false;
  const f=harness(t,{discovery:{resolve:async(_query,signal)=>{try{await withAbort(new Promise(()=>{}),signal);}finally{cancelled=signal.aborted;}}}});
  f.player.voice.join=async()=>{throw new UserError('Connection failed','VOICE_TIMEOUT');};
  await assert.rejects(execute(f.interaction,f.manager,'play'),{code:'VOICE_TIMEOUT'});
  assert.ok(cancelled);assert.equal(f.player.queue.length,0);assert.equal(f.prepared.length,0);
});
test('real voice handshake waiter honours cancellation and destroys its connection',async()=>{
  const controller=new AbortController(),voice=new VoiceSession({id:'guild'},{},()=>{},logger);
  const connection=new EventEmitter();let destroyed=false;
  Object.assign(connection,{state:{status:'connecting'},joinConfig:{channelId:'voice'},destroy(){destroyed=true;this.state={status:'destroyed'};}});
  voice.connection=connection;
  const waiting=voice.join({id:'voice'},{signal:controller.signal});controller.abort();
  await assert.rejects(waiting,{name:'AbortError'});assert.ok(destroyed);assert.equal(voice.connection,null);
});

test('stop cancels a real voice handshake waiter even without a caller abort signal',{timeout:2000},async t=>{
  const f=fixture();t.after(()=>f.player.destroy());
  const voice=new VoiceSession({id:'guild'},f.fakePlayer,()=>assert.fail('stop must not report unexpected loss'),logger);
  const connection=new EventEmitter();let destroyed=false;
  Object.assign(connection,{state:{status:'connecting'},joinConfig:{channelId:'voice'},destroy(){destroyed=true;this.state={status:'destroyed'};}});
  voice.connection=connection;f.player.voice=voice;
  const joining=f.player.join(f.channel),cancelled=assert.rejects(joining,{name:'AbortError'});
  await settle();assert.ok(voice.joinController);
  await f.player.stop(true);await cancelled;
  assert.equal(destroyed,true);assert.equal(voice.joinController,null);
  assert.equal(connection.listenerCount('ready'),0);assert.equal(f.player.state,'disconnected');
});
