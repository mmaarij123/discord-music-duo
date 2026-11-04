import { UserError } from '../utils/errors.js';
import { withAbort } from '../utils/async.js';
import { TTLCache } from '../utils/cache.js';
import { cacheTrackKeys, scoreTrack } from './TrackMatcher.js';
import { normalizeSpotify } from './SpotifyResolver.js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';

export class SpotifyApi {
  #clientId;
  #clientSecret;
  #token;
  #expiresAt = 0;
  #tokenRequest;
  #blockedUntil = 0;

  constructor({ clientId, clientSecret, market = '', cacheMs = 900000 }, { fetchImpl = fetch, now = Date.now, cache } = {}) {
    if (!clientId?.trim() || !clientSecret?.trim()) throw new UserError('Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the local .env file.','SPOTIFY_CONFIG');
    this.#clientId = clientId.trim();
    this.#clientSecret = clientSecret.trim();
    this.market = market;
    this.fetch = fetchImpl;
    this.now = now;
    this.cache = cache ?? new TTLCache(cacheMs);
  }

  checkQuota() {
    if (this.now() < this.#blockedUntil) {
      const error = new UserError('Spotify is rate-limiting this app. Wait before trying again.','SPOTIFY_RATE_LIMIT');
      error.retryAfterSeconds = Math.ceil((this.#blockedUntil-this.now())/1000);
      throw error;
    }
  }

  async request(url, options, signal) {
    this.checkQuota();
    const combined = AbortSignal.any([signal,AbortSignal.timeout(10000)].filter(Boolean));
    try {
      const response = await this.fetch(url,{ ...options,redirect:'error',signal:combined });
      if (!response.ok) {
        await response.body?.cancel().catch(()=>{});
        if (response.status === 429) {
          const delay = Number(response.headers.get('retry-after'));
          const seconds = Number.isFinite(delay)&&delay>0 ? delay : 60;
          this.#blockedUntil = this.now()+seconds*1000;
          const error = new UserError('Spotify request quota or rate limit reached. Wait before trying again.','SPOTIFY_RATE_LIMIT');
          error.retryAfterSeconds = seconds;
          throw error;
        }
        if ([400,401].includes(response.status) && url === TOKEN_URL) throw new UserError('Spotify authentication failed. Check the Client ID and Client Secret in .env.','SPOTIFY_AUTH');
        if (response.status === 401) throw new UserError('Spotify rejected the access token.','SPOTIFY_TOKEN_EXPIRED');
        if (response.status === 403) throw new UserError('Spotify denied access. Check app eligibility, Premium requirements and endpoint access in the Developer Dashboard.','SPOTIFY_ACCESS');
        throw new UserError('Spotify metadata service is unavailable. Try again later.','SPOTIFY_UNAVAILABLE');
      }
      if (!response.body) throw new UserError('Spotify returned an empty response.','SPOTIFY_RESPONSE');
      const chunks=[];
      let size=0;
      for await (const chunk of response.body) {
        size+=chunk.length;
        if(size>1024*1024)throw new UserError('Spotify metadata exceeded the response size limit.','SPOTIFY_RESPONSE');
        chunks.push(Buffer.from(chunk));
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new UserError('Spotify returned invalid metadata.','SPOTIFY_RESPONSE'); }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof UserError) throw error;
      throw new UserError('Spotify could not be reached before the request deadline.','SPOTIFY_NETWORK');
    }
  }

  async getAccessToken(signal) {
    signal?.throwIfAborted();
    this.checkQuota();
    if (this.#token && this.now()<this.#expiresAt) return this.#token;
    if (!this.#tokenRequest) {
      this.#tokenRequest = this.request(TOKEN_URL,{
        method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:`Basic ${Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString('base64')}`},
        body:new URLSearchParams({grant_type:'client_credentials'})
      }).then(data=>{
        if(typeof data.access_token!=='string'||!data.access_token||!Number.isFinite(Number(data.expires_in))||Number(data.expires_in)<=0)throw new UserError('Spotify returned an invalid token response.','SPOTIFY_RESPONSE');
        this.#token=data.access_token;
        const lifetime=Number(data.expires_in)*1000;
        this.#expiresAt=this.now()+lifetime-Math.min(30000,lifetime/10);
        return this.#token;
      }).finally(()=>{this.#tokenRequest=undefined;});
    }
    return withAbort(this.#tokenRequest,signal);
  }

  async search(query,{signal}={}) {
    const value=query?.trim();
    if(!value||value.length>500)throw new UserError('Spotify search needs 1–500 characters.','SPOTIFY_QUERY');
    signal?.throwIfAborted();
    const key=value.toLowerCase(),cached=this.cache.get(key);
    if(cached!==undefined)return cached;
    const url=new URL(SEARCH_URL);
    url.search=new URLSearchParams({q:value,type:'track',limit:'5',...(this.market?{market:this.market}:{})}).toString();
    let data;
    for(let attempt=0;attempt<2;attempt++){
      const token=await this.getAccessToken(signal);
      try{data=await this.request(url.href,{headers:{Authorization:`Bearer ${token}`}},signal);break;}
      catch(error){
        if(error.code!=='SPOTIFY_TOKEN_EXPIRED'||attempt!==0)throw error;
        this.#token=undefined;this.#expiresAt=0;
      }
    }
    if(!Array.isArray(data?.tracks?.items))throw new UserError('Spotify returned no valid track catalog response.','SPOTIFY_RESPONSE');
    const ranked=data.tracks.items.filter(track=>track?.type==='track'&&track.name&&Array.isArray(track.artists)&&track.artists.some(artist=>artist?.name)&&!track.is_local)
      .map(track=>({track,...scoreTrack({title:value},{title:track.name,artist:track.artists.map(artist=>artist?.name).filter(Boolean).join(', ')})}))
      .filter(candidate=>!candidate.rejected&&candidate.score>=70).sort((a,b)=>b.score-a.score);
    const result=ranked[0]?.track ?? null;
    this.cache.set(key,result,cacheTrackKeys(normalizeSpotify(result)));
    return result;
  }
}
