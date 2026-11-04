import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/config.js';
import { youtubeUrl } from '../src/utils/validators.js';
import { Semaphore } from '../src/utils/async.js';
import { YouTubeResolver } from '../src/music/YouTubeResolver.js';
import { AudioManager } from '../src/music/AudioManager.js';
import { publicError } from '../src/utils/errors.js';
if(!process.argv[2]){
  console.log('Usage: npm run test:source -- https://www.youtube.com/watch?v=VIDEO_ID');
  console.log('Choose a public video you have permission to play. This reads a few audio packets; no Discord connection or full-song download.');
  process.exit(0);
}
let audio;
try{
  const parsed=youtubeUrl(process.argv[2]);assert.equal(parsed.type,'video','Use a single video URL.');
  const config=loadConfig(),youtube=new YouTubeResolver(config,new Semaphore(config.concurrency));
  audio=new AudioManager(config,youtube,null);
  const track={title:'Permitted source smoke test',source:'youtube',youtubeUrl:parsed.url};
  const errors=[],handle=await audio.prepare(track,{volume:50,onError:error=>errors.push(error)});
  let packets=0;
  // Complete the probe before intentional disposal; destroying a partially read
  // pipeline can emit a premature-close error that is expected during cleanup.
  await new Promise((resolve,reject)=>{
    const stream=handle.resource.playStream;
    const timer=setTimeout(()=>finish(new Error('Timed out waiting for audio packets.')),15000);
    const finish=error=>{clearTimeout(timer);stream.off('data',data);stream.off('error',failed);stream.off('close',closed);error?reject(error):resolve();};
    const data=()=>{if(++packets===10)finish();};
    const failed=error=>finish(error);
    const closed=()=>finish(new Error('The source closed before ten audio packets.'));
    stream.on('data',data);stream.once('error',failed);stream.once('close',closed);
  });
  handle.dispose();
  assert.ok(packets>=10);assert.equal(errors.length,0);
  console.log(`PASS: yt-dlp extraction → FFmpeg PCM → Opus (${packets} packets), then disposed.`);
  console.log('This validates this permitted source at this time, not Discord voice or general YouTube availability.');
}catch(error){console.error(`Source smoke failed: ${publicError(error)}`);process.exitCode=1;}
finally{audio?.dispose();}
