import { getCiphers } from 'node:crypto';
import { generateDependencyReport } from '@discordjs/voice';
import { loadConfig } from '../src/config/config.js';
import { runTool } from '../src/utils/process.js';
import { inspectYouTubeCookies } from '../src/utils/youtubeCookies.js';
const config=loadConfig();
const [major,minor]=process.versions.node.split('.').map(Number);
console.log(`Node: ${process.version} (${major>24||(major===24&&minor>=17)?'OK':'NEEDS >=24.17.0'})`);
console.log(`AES-256-GCM: ${getCiphers().includes('aes-256-gcm')}`);
console.log(generateDependencyReport());
let missing=false;
for(const [name,file,args] of [['FFmpeg',config.ffmpeg,['-version']],['yt-dlp',config.ytdlp,['--version']]]){
  try{const {stdout}=await runTool(file,args,{timeoutMs:10000});console.log(`${name}: ${stdout.split('\n')[0].trim()}`);}
  catch(error){missing=true;console.log(`${name}: ${error.message}`);}
}
console.log(`Discord token: ${config.token?'configured (not displayed)':'missing'}`);
try{
  const cookies=await inspectYouTubeCookies(config);
  console.log(`YouTube cookies: ${cookies.enabled?'local file format OK (authentication not tested)':'disabled'}`);
}catch(error){missing=true;console.log(`YouTube cookies: ${error.message}`);}
console.log('No Discord login, voice connection, or external playback was attempted.');
if(missing||major<24||(major===24&&minor<17))process.exitCode=1;
