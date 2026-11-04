import spotifyUrlInfo from 'spotify-url-info';
import { spotifyUrl } from '../utils/validators.js';
import { UserError } from '../utils/errors.js';
import { TTLCache } from '../utils/cache.js';
import { withAbort } from '../utils/async.js';
import { cacheTrackKeys } from './TrackMatcher.js';
export function normalizeSpotify(raw, context = {}) {
  const item = raw?.track ?? raw;
  if (!item || item.is_local) return null;
  const title = item.name ?? item.title;
  const artist = Array.isArray(item.artists) ? item.artists.map(a => typeof a === 'string' ? a : a?.name).filter(a=>typeof a==='string'&&a.trim()).join(', ') : item.subtitle ?? item.artist;
  if (typeof title!=='string'||!title.trim()||typeof artist!=='string'||!artist.trim()) return null;
  const uri = typeof item.uri==='string' ? item.uri : '';
  const id = item.id ?? uri.match(/spotify:track:([\w]{22})/)?.[1];
  const milliseconds = item.duration_ms ?? item.duration ?? item.durationMilliseconds;
  return {
    title: title.trim().slice(0,300), artist: artist.trim().slice(0,300),
    duration: Number.isFinite(Number(milliseconds)) && Number(milliseconds)>0 ? Number(milliseconds)/1000 : undefined,
    album: item.album?.name ?? context.album,
    artwork: item.album?.images?.[0]?.url ?? item.coverArt?.sources?.[0]?.url ?? item.visualIdentity?.image?.[0]?.url ?? context.artwork,
    source: 'spotify', sourceUrl: item.external_urls?.spotify ?? (id ? `https://open.spotify.com/track/${id}` : context.sourceUrl)
  };
}
export class SpotifyResolver {
  constructor(config, semaphore, searchAdapter, cache) {
    this.config = config; this.semaphore = semaphore; this.searchAdapter = searchAdapter;
    this.cache = cache ?? new TTLCache(config.cacheMs);
  }
  async search(query, signal) {
    signal?.throwIfAborted();
    if (!this.searchAdapter) return { track: null, notice: 'Public Spotify text search is unavailable; using YouTube metadata.' };
    try {
      const raw = await this.semaphore.run(() => {
        const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(10000)].filter(Boolean));
        return withAbort(this.searchAdapter.search(query,{signal:requestSignal}),requestSignal);
      }, signal);
      const track = normalizeSpotify(raw);
      return { track, notice: track ? undefined : 'Spotify discovery returned no usable metadata; using YouTube.' };
    } catch(error) {
      if(signal?.aborted)throw signal.reason;
      return { track:null,notice:error instanceof UserError?`${error.message} Using YouTube metadata.`:'Spotify discovery is unavailable; using YouTube metadata.' };
    }
  }
  async resolve(input, signal) {
    signal?.throwIfAborted();
    const parsed = spotifyUrl(input), cached = this.cache.get(parsed.url);
    if (cached) return cached;
    return this.semaphore.run(async () => {
      try {
        const requestSignal = AbortSignal.any([signal,AbortSignal.timeout(15000)].filter(Boolean));
        const api = spotifyUrlInfo((url, options = {}) => fetch(url, { ...options, signal: requestSignal }));
        const data = await api.getData(parsed.url);
        const context = { sourceUrl: parsed.url, album: parsed.type === 'album' ? data.name : undefined, artwork: data.coverArt?.sources?.[0]?.url ?? data.images?.[0]?.url };
        let items;
        if (parsed.type === 'track') items = [data];
        else items = data.trackList ?? data.tracks?.items ?? (Array.isArray(data.tracks) ? data.tracks : undefined);
        if (!items) items = await api.getTracks(parsed.url);
        const total = data.tracks?.total ?? data.totalTracks ?? data.trackCount;
        const visible = items.length;
        const tracks = items.slice(0,this.config.maxPlaylist).map(item => normalizeSpotify(item,context)).filter(Boolean);
        if (!tracks.length) throw new UserError('Spotify returned no accessible track metadata. The item may be private, restricted, or unavailable. Try an exact title or a permitted YouTube link.','SPOTIFY_UNAVAILABLE');
        const notices = parsed.type === 'track' ? [] : [`Imported ${tracks.length} accessible Spotify tracks. Public collection metadata can be incomplete (library limit: 100); completeness is not guaranteed.`];
        if (total && total > tracks.length) notices.push(`${total} tracks reported; only ${tracks.length} imported.`);
        if (visible > this.config.maxPlaylist) notices.push(`Import capped at ${this.config.maxPlaylist} tracks.`);
        if (visible > tracks.length && visible <= this.config.maxPlaylist) notices.push('Unavailable entries were omitted.');
        return this.cache.set(parsed.url,{ tracks, notices },tracks.flatMap(cacheTrackKeys));
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof UserError) throw error;
        throw new UserError('Public Spotify metadata could not be retrieved. Private or region-limited items and provider changes are not supported. Try the song title or a permitted YouTube URL.','SPOTIFY_UNAVAILABLE');
      }
    },signal);
  }
}
