import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { loadConfig } from '../src/config/config.js';
import { runTool } from '../src/utils/process.js';
import { LocalMediaResolver } from '../src/music/LocalMediaResolver.js';
import { AudioManager } from '../src/music/AudioManager.js';
const folder=await mkdtemp(path.join(tmpdir(),'music-bot-smoke-'));
let audio;
try{
  const config={...loadConfig(),mediaRoot:folder,manifest:path.join(folder,'media.json')};
  await runTool(config.ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=2','-ar','48000','-ac','2',path.join(folder,'tone.wav')]);
  await writeFile(config.manifest,JSON.stringify({local:{tone:{file:'tone.wav',title:'Generated test tone',artist:'Test',duration:2}},streams:{}}));
  const local=new LocalMediaResolver(config);
  audio=new AudioManager(config,null,local);
  const {tracks}=await local.resolve('local','tone');
  const failures=[];
  const handle=await audio.prepare(tracks[0],{volume:50,onError:error=>failures.push(error)});
  let packets=0,bytes=0;
  handle.resource.playStream.on('data',packet=>{packets++;bytes+=packet.length;});
  await once(handle.resource.playStream,'end',{signal:AbortSignal.timeout(10000)});
  assert.ok(packets>=90,`Expected Opus packets; got ${packets}`);
  assert.ok(bytes>0);assert.equal(failures.length,0);
  handle.dispose();assert.equal(audio.handles.size,0);
  console.log(`PASS: generated WAV → FFmpeg PCM → volume → Opus (${packets} packets, ${bytes} bytes), resources disposed.`);
  console.log('This checks actual local decoding and Opus encoding. It does not connect to Discord or validate provider playback.');
}finally{audio?.dispose();await rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
