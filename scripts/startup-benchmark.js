import { performance } from 'node:perf_hooks';
import { once } from 'node:events';
import { loadConfig } from '../src/config/config.js';
import { createLogger } from '../src/utils/logger.js';
import { MusicManager } from '../src/music/MusicManager.js';

if(process.env.RUN_PROVIDER_TESTS!=='true'){
  console.log('Set RUN_PROVIDER_TESTS=true to benchmark live metadata and first audio bytes from an authorized Creative Commons Blender video. No Discord messages or voice connection are used.');
  process.exit(0);
}
const manager=await MusicManager.create(loadConfig(),createLogger('error'));
const timed=async(name,fn)=>{
  const start=performance.now();const result=await fn();console.log(`${name}: ${Math.round(performance.now()-start)} ms`);return result;
};
try{
  const query='Stephen Sanchez Until I Found You';
  for(const phase of ['cold','warm']){
    const found=await timed(`${phase} text discovery`,()=>manager.discovery.resolve(query,AbortSignal.timeout(45000)));
    await timed(`${phase} selected-video audio metadata`,()=>manager.audio.youtube.audio(found.tracks[0],AbortSignal.timeout(45000)));
  }
  const input='https://www.youtube.com/watch?v=aqz-KE-bpKQ';
  for(const phase of ['cold','warm']){
    const total=performance.now();
    const result=await timed(`${phase} permitted direct-video discovery`,()=>manager.discovery.resolve(input,AbortSignal.timeout(45000)));
    let handle;
    try{
      await timed(`${phase} permitted direct-video first Opus packet`,async()=>{
        handle=await manager.audio.prepare(result.tracks[0]);
        if(!handle.resource.playStream.readableLength)await once(handle.resource.playStream,'readable',{signal:AbortSignal.timeout(45000)});
      });
      console.log(`${phase} permitted direct-video total: ${Math.round(performance.now()-total)} ms`);
    }finally{handle?.dispose();}
  }
  console.log('Timings include this host and current network/provider conditions; they exclude Discord voice handshakes. Only the authorized Blender source supplied audio, and only the first packet was awaited.');
}finally{await manager.destroy();}
