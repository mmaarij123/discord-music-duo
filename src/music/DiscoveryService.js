import { classifyInput } from '../utils/validators.js';
import { bestMatch } from './TrackMatcher.js';
import { withAbort } from '../utils/async.js';
export class DiscoveryService {
  constructor(spotify,youtube,local,config={}) { Object.assign(this,{spotify,youtube,local,config}); }
  async resolve(input, signal) {
    const parsed = classifyInput(input);
    if (parsed.source === 'spotify') return this.spotify.resolve(parsed.url,signal);
    if (parsed.source === 'youtube') return this.youtube.resolveInput(parsed.url,signal);
    if (['local','stream'].includes(parsed.type)) return this.local.resolve(parsed.type,parsed.id);
    const metadataSignal=AbortSignal.any([signal,AbortSignal.timeout(this.config.spotifyDiscoveryMs??2000)].filter(Boolean));
    const spotifyRequest=withAbort(this.spotify.search(parsed.query,metadataSignal),metadataSignal).catch(()=>{
      if(signal?.aborted)throw signal.reason;
      return {track:null,notice:metadataSignal.aborted?'Spotify metadata lookup exceeded the startup budget; using YouTube metadata.':'Spotify metadata search is unavailable; using YouTube metadata.'};
    });
    const [metadata,candidates]=await Promise.allSettled([spotifyRequest,this.youtube.search(parsed.query,signal)]);
    signal?.throwIfAborted();
    if(metadata.status==='rejected')throw metadata.reason;
    const found=metadata.value;
    let match;
    if(candidates.status==='fulfilled'){
      try{match=bestMatch(found.track??{title:parsed.query},candidates.value);}
      catch(error){if(!found.track)throw error;}
    }
    if(!match&&found.track){
      if(candidates.status==='rejected'&&!['NO_RESULTS','NO_MATCH'].includes(candidates.reason?.code))throw candidates.reason;
      const canonical=`${found.track.artist??''} ${found.track.title}`.trim().replace(/\s+/g,' ');
      if(canonical.toLowerCase()!==parsed.query.toLowerCase())match=await this.youtube.match(found.track,signal);
    }
    if(!match){if(candidates.status==='rejected')throw candidates.reason;match=bestMatch(found.track??{title:parsed.query},candidates.value);}
    return {tracks:[found.track?{...found.track,youtubeUrl:match.youtubeUrl}:match],diagnostics:[found.notice].filter(Boolean)};
  }
}
