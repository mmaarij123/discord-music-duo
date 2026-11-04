import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,track,settle } from './helpers.js';
test('adding tracks during playback does not restart current audio',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue([track('A')],f.channel);await f.player.enqueue([track('B')],f.channel);
  assert.deepEqual(f.prepared,['A']);assert.equal(f.player.queue.length,1);assert.equal(f.player.state,'playing');
});
test('simultaneous skips only advance once',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue(['A','B','C'].map(track),f.channel);
  const results=await Promise.all([f.player.skip(),f.player.skip(),f.player.skip()]);
  assert.equal(results.filter(Boolean).length,1);assert.equal(f.player.current.title,'B');assert.equal(f.player.queue.tracks[0].title,'C');
});
test('simultaneous skips at the end of a queue are also coalesced',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue([track('A')],f.channel);
  const results=await Promise.all([f.player.skip(),f.player.skip()]);assert.deepEqual(results,[true,false]);assert.equal(f.player.current,null);
});
test('cancelled discovery cannot enqueue after a stop',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());const controller=new AbortController();controller.abort();
  await assert.rejects(f.player.enqueue([track('A')],f.channel,{signal:controller.signal}),{name:'AbortError'});assert.equal(f.player.queue.length,0);assert.equal(f.player.current,null);
});
test('natural idle advances once and cleans up old resource',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue(['A','B'].map(track),f.channel);f.fakePlayer.finish();await settle();await settle();
  assert.equal(f.player.current.title,'B');assert.equal(f.handles[0].disposed,true);assert.equal(f.player.queue.history[0].title,'A');
});
test('track repeat repeats naturally but explicit skip advances',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue(['A','B'].map(track),f.channel);await f.player.editQueue(q=>q.setLoop('track'));
  f.fakePlayer.finish();await settle();await settle();assert.equal(f.player.current.title,'A');await f.player.skip();assert.equal(f.player.current.title,'B');
});
test('queue repeat appends completed track after upcoming tracks',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue(['A','B'].map(track),f.channel);await f.player.editQueue(q=>q.setLoop('queue'));
  f.fakePlayer.finish();await settle();await settle();assert.equal(f.player.current.title,'B');assert.equal(f.player.queue.tracks[0].title,'A');
});
test('pause, resume and volume update state without replacing current audio',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue(['A','B'].map(track),f.channel);await f.player.pause();assert.equal(f.player.state,'paused');
  const handle=f.player.handle;await f.player.resume();assert.equal(f.player.state,'playing');await f.player.setVolume(0);assert.equal(f.player.volume,0);
  assert.equal(f.player.current.title,'A');assert.equal(f.player.handle,handle);assert.equal(handle.disposed,false);
});
test('stop clears queue, stops stream and keeps persistent connection',async t=>{
  const f=fixture({config:{persistent:true}});t.after(()=>f.player.destroy());await f.player.enqueue(['A','B'].map(track),f.channel);await f.player.stop();
  assert.equal(f.player.current,null);assert.equal(f.player.queue.length,0);assert.equal(f.player.voice.channelId,'voice');assert.equal(f.player.state,'idle');assert.equal(f.handles[0].disposed,true);
});
test('guild queues and settings remain isolated',async t=>{
  const a=fixture({id:'a'}),b=fixture({id:'b'});t.after(()=>Promise.all([a.player.destroy(),b.player.destroy()]));
  await Promise.all([a.player.enqueue(['A','B'].map(track),a.channel),b.player.enqueue([track('X')],b.channel)]);await a.player.skip();await a.player.setVolume(20);
  assert.equal(b.player.current.title,'X');assert.equal(b.player.volume,70);assert.equal(a.player.current.title,'B');
});
test('source failures advance gracefully and are bounded',async t=>{
  let attempts=0;const f=fixture({audio:{async prepare(){attempts++;throw new Error('provider failure');}}});t.after(()=>f.player.destroy());
  await f.player.enqueue(Array.from({length:10},(_,i)=>track(String(i))),f.channel);assert.equal(attempts,5);assert.equal(f.player.state,'idle');assert.equal(f.player.queue.length,5);
});
test('audio error and idle events cannot double advance',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue(['A','B','C'].map(track),f.channel);
  f.fakePlayer.emit('error',new Error('network'));f.fakePlayer.stop();await settle();await settle();assert.equal(f.player.current.title,'A');assert.equal(f.player.queue.length,2);assert.equal(f.player.recoveryAttempts,1);
});
test('stop aborts in-flight source preparation',async t=>{
  let started;const ready=new Promise(resolve=>{started=resolve;});
  const f=fixture({audio:{prepare(_track,{signal}){started();return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}}});t.after(()=>f.player.destroy());
  const enqueue=f.player.enqueue([track('A')],f.channel);await ready;const stop=f.player.stop();await Promise.all([enqueue,stop]);
  assert.equal(f.player.current,null);assert.equal(f.player.state,'idle');assert.equal(f.player.queue.length,0);
});
test('idle timeout disconnects unless persistent mode is enabled',async t=>{
  const f=fixture({config:{idleMs:15}});t.after(()=>f.player.destroy());await f.player.join(f.channel);await new Promise(r=>{setTimeout(r,35);});assert.equal(f.player.voice.channelId,null);
  const p=fixture({config:{idleMs:15,persistent:true}});t.after(()=>p.player.destroy());await p.player.join(p.channel);await new Promise(r=>{setTimeout(r,35);});assert.equal(p.player.voice.channelId,'voice');
});
test('autoplay attempts only once and stops with no recommendation',async t=>{
  let count=0;const f=fixture({config:{autoplay:true},autoplay:{async next(){count++;return null;}}});t.after(()=>f.player.destroy());
  await f.player.enqueue([track('A')],f.channel);f.fakePlayer.finish();await settle();await settle();assert.equal(count,1);assert.equal(f.player.state,'idle');
});
test('lost voice cleans audio while preserving upcoming queue for reconnect',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue(['A','B'].map(track),f.channel);
  f.player.voice.destroy();f.player.connectionLost();await settle();await settle();
  assert.equal(f.player.state,'disconnected');assert.equal(f.player.current,null);assert.equal(f.handles[0].disposed,true);assert.equal(f.player.queue.length,1);
  await f.player.enqueue([track('C')],f.channel);assert.equal(f.player.current.title,'B');assert.equal(f.player.queue.length,1);
});
