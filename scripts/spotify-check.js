import { loadConfig } from '../src/config/config.js';
import { SpotifyApi } from '../src/music/SpotifyApi.js';
import { publicError } from '../src/utils/errors.js';

try{
  const config=loadConfig();
  if(!config.spotify.clientId||!config.spotify.clientSecret){
    console.log('NOT CONFIGURED: add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to the local .env. A Client ID alone cannot authenticate.');
    process.exitCode=1;
  }else{
    const spotify=new SpotifyApi({...config.spotify,cacheMs:config.cacheMs});
    await spotify.getAccessToken();
    console.log('PASS: Spotify Client Credentials authentication. Credentials and access token are not displayed.');
    const track=await spotify.search(process.argv.slice(2).join(' ')||'Stephen Sanchez Until I Found You');
    if(track)console.log(`PASS: official metadata search returned ${JSON.stringify({title:track.name,artists:track.artists.map(artist=>artist.name),durationSeconds:Math.round(track.duration_ms/1000),album:track.album?.name})}`);
    else console.log('CONNECTED: Spotify search was available but returned no close match for this query.');
    console.log('No Discord login, playback, callback server or user OAuth consent was used.');
  }
}catch(error){console.error(`Spotify check failed: ${publicError(error)}`);if(error.retryAfterSeconds)console.error(`Retry after at least ${error.retryAfterSeconds} seconds.`);process.exitCode=1;}
