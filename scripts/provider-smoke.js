import { loadConfig } from '../src/config/config.js';
import { Semaphore } from '../src/utils/async.js';
import { SpotifyResolver } from '../src/music/SpotifyResolver.js';
import { YouTubeResolver } from '../src/music/YouTubeResolver.js';
import { publicError } from '../src/utils/errors.js';
if(process.env.RUN_PROVIDER_TESTS!=='true'){
  console.log('Set RUN_PROVIDER_TESTS=true to make live public metadata requests. No audio is downloaded or sent to Discord.');
  process.exit(0);
}
const config=loadConfig(),semaphore=new Semaphore(config.concurrency),spotify=new SpotifyResolver(config,semaphore),youtube=new YouTubeResolver(config,semaphore);
const probes=[
  ['Spotify track metadata',()=>spotify.resolve('https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8')],
  ['Spotify public playlist metadata',()=>spotify.resolve('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')],
  ['YouTube search and weighted matching',()=>youtube.match({title:'Until I Found You',artist:'Stephen Sanchez',duration:177})]
];
for(const [name,probe]of probes){
  try{const result=await probe();console.log(`PASS ${name}: ${result.tracks?`${result.tracks.length} accessible entries`:'close candidate found'}`);if(result.notices)for(const notice of result.notices)console.log(`  ${notice}`);}
  catch(error){console.log(`UNAVAILABLE ${name}: ${publicError(error)}`);process.exitCode=1;}
}
console.log('Public-provider results are time/region dependent. This does not verify extraction, audio playback, or Discord voice.');
