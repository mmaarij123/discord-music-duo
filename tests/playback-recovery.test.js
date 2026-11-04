import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createAudioPlayer,createAudioResource,StreamType,NoSubscriberBehavior,AudioPlayerStatus,entersState } from '@discordjs/voice';
import { playbackBehaviors,prematureEnd } from '../src/music/playbackPolicy.js';
import { loadConfig } from '../src/config/config.js';
import { UserError } from '../src/utils/errors.js';
import { VoiceSession } from '../src/music/VoiceSession.js';
import { fixture,track,settle,logger } from './helpers.js';

test('real voice audio scheduler survives a 400ms packet gap and consumes the complete stream',async t=>{
  const input=new PassThrough({objectMode:true});
  const behaviors={...playbackBehaviors(loadConfig({})),noSubscriber:NoSubscriberBehavior.Play};
  const player=createAudioPlayer({behaviors});
  const resource=createAudioResource(input,{inputType:StreamType.Opus});
  for(let i=0;i<20;i++)input.write(Buffer.from([0xf8,0xff,0xfe]));
  const timer=setTimeout(()=>{for(let i=0;i<20;i++)input.write(Buffer.from([0xf8,0xff,0xfe]));input.end();},800);
  t.after(()=>{clearTimeout(timer);player.stop(true);input.destroy();});
  player.play(resource);await entersState(player,AudioPlayerStatus.Idle,5000);
  assert.equal(resource.playbackDuration,800);assert.equal(player.state.status,AudioPlayerStatus.Idle);
});
test('premature EOF resumes the same song from heard position instead of advancing the queue',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue(['A','B'].map(track),f.channel);
  f.handles[0].resource.playbackDuration=30000;f.fakePlayer.stop();await settle();await settle();
  assert.deepEqual(f.prepared,['A','A']);assert.deepEqual(f.offsets,[0,30]);assert.equal(f.player.current.title,'A');
  assert.equal(f.player.progress,30);assert.equal(f.player.queue.length,1);assert.equal(f.player.queue.history.length,0);assert.equal(f.handles[0].disposed,true);
});
test('runtime errors and EOF share one recovery budget across the whole track',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue(['A','B'].map(track),f.channel);
  for(let i=0;i<3;i++){f.fakePlayer.emit('error',new UserError('Network interrupted','AUDIO_STREAM'));await settle();await settle();}
  assert.deepEqual(f.prepared,['A','A','A','B']);assert.equal(f.player.current.title,'B');assert.equal(f.player.recoveryAttempts,0);
});
test('exhausted retries leave an empty player ready for new play requests',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue([track('A')],f.channel);
  for(let i=0;i<3;i++){f.fakePlayer.emit('error',new Error('network'));await settle();await settle();}
  assert.equal(f.player.current,null);assert.equal(f.player.state,'idle');await f.player.enqueue([track('B')],f.channel);assert.equal(f.player.current.title,'B');
});
test('provider access denial skips without retrying the denied source',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue(['A','B'].map(track),f.channel);
  f.fakePlayer.emit('error',new UserError('Provider denied access','ACCESS_DENIED'));await settle();await settle();
  assert.deepEqual(f.prepared,['A','B']);assert.equal(f.player.current.title,'B');
});
test('late errors from a replaced resource cannot interrupt the new resource',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue(['A','B'].map(track),f.channel);
  const old=f.handles[0].resource;await f.player.skip();const error=new Error('late error');error.resource=old;f.fakePlayer.emit('error',error);await settle();
  assert.equal(f.player.current.title,'B');assert.deepEqual(f.prepared,['A','B']);
});
test('natural completion after recovery advances once and preserves history',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue(['A','B'].map(track),f.channel);
  f.handles[0].resource.playbackDuration=60000;f.fakePlayer.stop();await settle();await settle();f.fakePlayer.finish();await settle();await settle();
  assert.equal(f.player.current.title,'B');assert.equal(f.player.queue.history.length,1);assert.equal(f.player.queue.history[0].title,'A');
});
test('unknown durations and near-end rounding do not cause an endless replay',()=>{
  assert.equal(prematureEnd({duration:180},179),false);assert.equal(prematureEnd({duration:180},150),true);assert.equal(prematureEnd({},10),false);
});
test('stop aborts source resolution during a playback retry',async t=>{
  let preparingRetry,initial=true;
  const retryStarted=new Promise(resolve=>{preparingRetry=resolve;});
  const f=fixture({audio:{async prepare(item,{signal}){
    if(initial){initial=false;return {resource:{playbackDuration:30000,metadata:item},dispose(){}};}
    preparingRetry();return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  }}});t.after(()=>f.player.destroy());
  await f.player.enqueue([track('A')],f.channel);f.fakePlayer.stop();await retryStarted;await f.player.stop();
  assert.equal(f.player.current,null);assert.equal(f.player.queue.length,0);assert.equal(f.player.state,'idle');
});
test('ready voice sessions restore their audio subscription before reuse',async()=>{
  let subscriptions=0;
  const voice=new VoiceSession({id:'guild'}, {},()=>{},logger);
  voice.connection={state:{status:'ready'},joinConfig:{channelId:'voice'},subscribe(){subscriptions++;}};
  await voice.join({id:'voice'});assert.equal(subscriptions,1);
});
