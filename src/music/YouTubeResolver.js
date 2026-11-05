import { runTool } from '../utils/process.js';
import { youtubeUrl, httpsUrl } from '../utils/validators.js';
import { TTLCache } from '../utils/cache.js';
import { bestMatch, cacheTrackKeys } from './TrackMatcher.js';
import { UserError } from '../utils/errors.js';
import { SharedRequests } from '../utils/sharedRequests.js';
import { withYouTubeCookies } from '../utils/youtubeCookies.js';
export function normalizeYouTube(data) {
  if(!data)return null;
  const id = data.id;
  if (typeof id!=='string'||!/^[\w-]{11}$/.test(id) || typeof data.title!=='string'||!data.title.trim()) return null;
  const title=typeof data.track==='string'&&data.track.trim()?data.track:data.title;
  const duration=Number(data.duration);
  return { id, title:title.trim(), artist:typeof data.artist==='string'?data.artist:undefined,
    channel:typeof data.channel==='string'?data.channel:typeof data.uploader==='string'?data.uploader:undefined,
    duration:Number.isFinite(duration)&&duration>0?duration:undefined, artwork: data.thumbnail ?? (Array.isArray(data.thumbnails)?data.thumbnails.at(-1)?.url:undefined),
    source: 'youtube', sourceUrl: `https://www.youtube.com/watch?v=${id}`, youtubeUrl: `https://www.youtube.com/watch?v=${id}`,
    verified: data.channel_is_verified === true, live: data.is_live === true || ['is_live','is_upcoming'].includes(data.live_status) };
}
const searchText = query => query.trim().replace(/\s+/g, ' ');
const searchKey = query => `search:${searchText(query).toLowerCase()}`;

export class YouTubeResolver {
  constructor(config, semaphore, { cache, sourceCache } = {}) {
    this.config=config;this.semaphore=semaphore;this.cache=cache??new TTLCache(config.cacheMs);
    this.sourceCache=sourceCache??new TTLCache(config.audioSourceCacheMs??60000,100);this.requests=new SharedRequests();
  }
  baseArgs() { return ['--ignore-config','--no-plugin-dirs','--no-warnings','--no-progress','--socket-timeout','15','--retries','1','--extractor-retries','1','--js-runtimes',`node:${process.execPath}`]; }
  async json(args, signal, allowPartial = false) {
    return this.semaphore.run(async () => {
      const result = await withYouTubeCookies(this.config,cookieArgs=>runTool(this.config.ytdlp,[...this.baseArgs(),...cookieArgs,...args],{ signal, timeoutMs:this.config.processMs, allowPartial }),signal);
      try { return { data: JSON.parse(result.stdout), partial: result.partial }; }
      catch { throw new UserError('The extractor returned invalid metadata. Update yt-dlp.','EXTRACTOR'); }
    },signal);
  }
  async search(query, signal) {
    signal?.throwIfAborted();
    const text=searchText(query),key=searchKey(query),cached=this.cache.get(key);
    if (cached) return cached;
    return this.requests.run(key,async sharedSignal=>{
      const { data } = await this.json(['--flat-playlist','--dump-single-json','--playlist-end','8','--',`ytsearch8:${text}`],sharedSignal);
      const results = (data.entries ?? []).map(normalizeYouTube).filter(t => t && !t.live && (!t.duration || t.duration <= this.config.maxTrack));
      if (!results.length) throw new UserError('No matching track found.','NO_RESULTS');
      return this.cache.set(key,results,results.flatMap(cacheTrackKeys));
    },signal);
  }
  async match(track, signal) {
    const query = `${track.artist ?? ''} ${track.title}`;
    const match = bestMatch(track,await this.search(query,signal));
    this.cache.tag(searchKey(query),cacheTrackKeys(track));
    return match;
  }
  invalidate(track){
    if(track.youtubeUrl)this.sourceCache.delete(`audio:${youtubeUrl(track.youtubeUrl).id}`);
  }
  async resolveInput(input, signal) {
    signal?.throwIfAborted();
    const parsed = youtubeUrl(input);
    if(parsed.type==='video'){
      const source=await this.audio({youtubeUrl:parsed.url},signal);
      if(!source.match)throw new UserError('The video returned no usable metadata.','EXTRACTOR');
      return {tracks:[source.match]};
    }
    const { data, partial } = await this.json(['--flat-playlist','--dump-single-json','--ignore-errors','--playlist-end',String(this.config.maxPlaylist),'--',parsed.url],signal,true);
    const entries = data.entries ?? [];
    const tracks = entries.map(normalizeYouTube).filter(t => t && !t.live && (!t.duration || t.duration <= this.config.maxTrack));
    if (!tracks.length) throw new UserError('No playable tracks were found in this playlist.','UNAVAILABLE');
    const diagnostics = partial || tracks.length < entries.length ? ['YouTube playlist import was partial.'] : [];
    return { tracks, diagnostics };
  }
  async audio(track, signal, {fresh=false}={}) {
    signal?.throwIfAborted();
    const video = track.youtubeUrl ? { youtubeUrl: track.youtubeUrl } : await this.match(track,signal);
    const parsed = youtubeUrl(video.youtubeUrl);
    const key=`audio:${parsed.id}`;
    if(fresh)this.sourceCache.delete(key);
    const cached=this.sourceCache.get(key);
    const trackKeys=cacheTrackKeys(track);
    if(cached&&cached.expiresAt>Date.now()){
      this.sourceCache.tag(key,trackKeys);
      return {...cached,fromCache:true};
    }
    if(cached)this.sourceCache.delete(key);
    const source=await this.requests.run(key,async sharedSignal=>{
      const args=['--no-playlist','--check-formats','--dump-single-json','--format','bestaudio/best','--',parsed.url];
      let result,fast=this.config.youtubeFastExtraction===true;
      try{
        // Prefer direct audio without fetching unused streaming manifests.
        // Keep normal webpage, player, JS and account validation requests.
        result=await this.json(fast?['--extractor-args','youtube:skip=hls,dash,translated_subs',...args]:args,sharedSignal);
      }catch(error){
        if(!fast||error.code!=='FORMAT')throw error;
        fast=false;result=await this.json(args,sharedSignal);
      }
      if(fast&&!result.data.url&&!result.data.is_live&&!result.data.has_drm&&(result.data.age_limit??0)<18){
        result=await this.json(args,sharedSignal);
      }
      const {data}=result;
      const match=normalizeYouTube(data);
      if (data.is_live || match?.live || (data.age_limit ?? 0) >= 18 || data.has_drm || (data.duration ?? 0)>this.config.maxTrack || !data.url) throw new UserError('This video is restricted, live, too long, or has no permitted audio format.');
      const url = httpsUrl(data.url);
      if (!(url.hostname.endsWith('.googlevideo.com') || url.hostname === 'googlevideo.com')) throw new UserError('The extractor did not return a supported YouTube audio CDN.','EXTRACTOR');
      const ttl=this.config.audioSourceCacheMs??60000;
      const expiry=Number(url.searchParams.get('expire'));
      const expiresAt=Math.min(Date.now()+ttl,Number.isFinite(expiry)&&expiry>0?expiry*1000-30000:Infinity);
      const headers=Object.fromEntries(Object.entries(data.http_headers??{})
        .filter(([name])=>['user-agent','referer','origin'].includes(name.toLowerCase())));
      const source={kind:'remote',input:url.href,headers,duration:match?.duration,match,expiresAt,fromCache:false};
      if(ttl>0&&expiresAt>Date.now())this.sourceCache.set(key,source,[...trackKeys,...cacheTrackKeys(match),parsed.url]);
      return source;
    },signal);
    this.sourceCache.tag(key,trackKeys);
    return source;
  }
}
