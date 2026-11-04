import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { decoderError } from '../src/music/decoderError.js';
import { AudioManager } from '../src/music/AudioManager.js';
import { loadConfig } from '../src/config/config.js';
import { fixture,track,settle } from './helpers.js';
import { UserError } from '../src/utils/errors.js';

test('HTTP status detection ignores numbers inside signed URLs',()=>{
  const error=decoderError('Error opening input https://cdn.example/path403?sig=401abc: Invalid data found when processing input',1);
  assert.equal(error.code,'AUDIO_STREAM');assert.equal(error.httpStatus,undefined);assert.equal(error.decoderReason,'invalid_media');
  assert.ok(!JSON.stringify(error).includes('sig='));
});
test('actual FFmpeg HTTP denial is terminal for a fresh source',()=>{
  for(const text of ['[https @ 0x123] HTTP error 403 Forbidden','Server returned 401 Unauthorized']){
    const error=decoderError(text,1);assert.equal(error.code,'ACCESS_DENIED');assert.ok([401,403].includes(error.httpStatus));assert.equal(error.exitCode,1);
  }
});
test('only a reused signed source is eligible for renewal after HTTP denial',()=>{
  assert.equal(decoderError('HTTP error 403 Forbidden',1,{cachedSource:true}).code,'SOURCE_STALE');
  assert.equal(decoderError('HTTP error 503 Service Unavailable',1,{cachedSource:true}).code,'AUDIO_STREAM');
});

const target={source:'youtube',youtubeUrl:'https://www.youtube.com/watch?v=abcdefghijk'};
function setup(outcomes,sources){
  const children=[],freshOptions=[];
  const youtube={async audio(_track,_signal,options){freshOptions.push(options.fresh);return sources.shift();},invalidate(){}};
  const audio=new AudioManager(loadConfig({}),youtube,null,{
    spawn(){
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();children.push(child);
      const outcome=outcomes.shift();
      process.nextTick(()=>{
        if(outcome==='ok')child.stdout.write(Buffer.alloc(3840));
        else if(outcome==='empty-first'){
          child.stdout.end();setTimeout(()=>{child.stderr.write('HTTP error 403 Forbidden');child.emit('close',1);},15);
        }else if(outcome==='empty-success'){
          child.stdout.end();setTimeout(()=>child.emit('close',0),15);
        }else {child.stderr.write('HTTP error 403 Forbidden');child.emit('close',1);child.stdout.end();}
      });
      return child;
    },
    kill(child){child.stdout.destroy();child.stderr.destroy();}
  });
  return {audio,children,freshOptions};
}
const source=fromCache=>({kind:'remote',input:'https://cdn.example/audio',match:target,fromCache,duration:180});

test('cached startup denial renews once and disposes the failed decoder',async t=>{
  const f=setup(['denied','ok'],[source(true),source(false)]);t.after(()=>f.audio.dispose());
  const handle=await f.audio.prepare(target);
  assert.deepEqual(f.freshOptions,[false,true]);assert.equal(f.children[0].stdout.destroyed,true);assert.equal(f.audio.handles.size,1);assert.ok(handle.resource);
});
test('fresh startup denial never loops or tries another identity',async t=>{
  const f=setup(['denied'],[source(false)]);t.after(()=>f.audio.dispose());
  await assert.rejects(f.audio.prepare(target),{code:'ACCESS_DENIED',httpStatus:403});
  assert.deepEqual(f.freshOptions,[false]);assert.equal(f.audio.handles.size,0);
});
test('fresh denial after cached renewal stops after exactly two attempts',async t=>{
  const f=setup(['denied','denied'],[source(true),source(false)]);t.after(()=>f.audio.dispose());
  await assert.rejects(f.audio.prepare(target),{code:'ACCESS_DENIED'});assert.deepEqual(f.freshOptions,[false,true]);assert.equal(f.audio.handles.size,0);
});
test('late cached-link rejection resumes at heard position using fresh metadata',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue([track('A'),track('B')],f.channel);
  f.handles[0].resource.playbackDuration=5000;
  f.fakePlayer.emit('error',new UserError('Cached signed URL rejected','SOURCE_STALE'));await settle();await settle();
  assert.deepEqual(f.prepared,['A','A']);assert.deepEqual(f.offsets,[0,5]);assert.equal(f.player.current.title,'A');assert.equal(f.player.queue.length,1);
});
test('zero-byte EOF waits for decoder status and never returns a playing resource',async t=>{
  const f=setup(['empty-first'],[source(false)]);t.after(()=>f.audio.dispose());let returned=false;
  const request=f.audio.prepare(target).then(()=>{returned=true;});
  await assert.rejects(request,{code:'ACCESS_DENIED',httpStatus:403});assert.equal(returned,false);assert.equal(f.audio.handles.size,0);
});
test('clean decoder exit with zero bytes is not a successful audio start',async t=>{
  const f=setup(['empty-success'],[source(false)]);t.after(()=>f.audio.dispose());
  await assert.rejects(f.audio.prepare(target),{code:'NO_AUDIO'});assert.equal(f.audio.handles.size,0);
});
