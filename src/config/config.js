import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError } from '../utils/errors.js';
import { validPrefix } from './prefix.js';
export const root = fileURLToPath(new URL('../../', import.meta.url));
if (!process.env.MUSIC_BOT_PROFILE) loadDotenv({quiet:true});
export function loadConfig(env = process.env) {
  const profile=env.MUSIC_BOT_PROFILE;
  if(profile&&!['bot1','bot2'].includes(profile))throw new UserError('Unknown bot profile.');
  const number = (key, fallback, min, max) => {
    const value = env[key] === undefined || env[key] === '' ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new UserError(`${key} must be an integer from ${min} to ${max}.`);
    return value;
  };
  const bool = (key, fallback) => {
    if (env[key] === undefined || env[key] === '') return fallback;
    if (!['true','false'].includes(env[key])) throw new UserError(`${key} must be true or false.`);
    return env[key] === 'true';
  };
  const resolve = (v) => path.resolve(root, v);
  const config = {
    projectRoot:root,cookiesRoot:resolve('./secrets'),
    profile,
    settingsFile:resolve(profile?`./data/guild-settings.${profile}.json`:'./data/guild-settings.json'),
    playlistsFile:resolve('./data/playlists.json'),
    sharedDbFile:profile?resolve('./data/music-shared.sqlite'):undefined,
    maxSavedTracks:number('MAX_SAVED_PLAYLIST_TRACKS',500,1,1000),
    youtubeCookiesFile:env.YOUTUBE_COOKIES_FILE?.trim()?resolve(env.YOUTUBE_COOKIES_FILE.trim()):undefined,
    token: env.DISCORD_TOKEN ?? '', prefix: env.PREFIX ?? '>',
    volume: number('DEFAULT_VOLUME',70,0,100), maxQueue: number('MAX_QUEUE_LENGTH',500,1,5000),
    maxPlaylist: number('MAX_PLAYLIST_TRACKS',100,1,1000), idleMs: number('IDLE_TIMEOUT_SECONDS',300,10,86400)*1000,
    autoplay: bool('AUTOPLAY_ENABLED',false), persistent: bool('ENABLE_247_MODE',false),
    logLevel: env.LOG_LEVEL || 'info', ffmpeg: env.FFMPEG_PATH || 'ffmpeg', ytdlp: env.YTDLP_PATH || 'yt-dlp',
    cacheMs: number('SEARCH_CACHE_SECONDS',900,1,86400)*1000,
    audioSourceCacheMs: number('AUDIO_SOURCE_CACHE_SECONDS',300,0,300)*1000,
    youtubeFastExtraction: bool('YOUTUBE_FAST_EXTRACTION',false),
    spotifyDiscoveryMs: number('SPOTIFY_DISCOVERY_TIMEOUT_MS',2000,250,10000),
    concurrency: number('METADATA_CONCURRENCY',2,1,8), processMs: number('PROCESS_TIMEOUT_SECONDS',45,5,120)*1000,
    maxTrack: number('MAX_TRACK_SECONDS',7200,10,86400), maxPlayers: number('MAX_PLAYERS',20,1,1000),
    audioStallMs: number('AUDIO_STALL_TIMEOUT_SECONDS',20,3,60)*1000,
    playbackRetries: number('PLAYBACK_RETRY_LIMIT',2,0,3),
    spotify: { clientId:env.SPOTIFY_CLIENT_ID?.trim()||'',clientSecret:env.SPOTIFY_CLIENT_SECRET?.trim()||'',market:env.SPOTIFY_MARKET?.trim().toUpperCase()||'' },
    mediaRoot: resolve(env.MEDIA_ROOT || './media'), manifest: resolve(env.MEDIA_MANIFEST || './media.json'),
    adapters: { spotify: env.SPOTIFY_SEARCH_ADAPTER, recommendations: env.RECOMMENDATION_ADAPTER }
  };
  if (!['debug','info','warn','error'].includes(config.logLevel)) throw new UserError('LOG_LEVEL must be debug, info, warn, or error.');
  if (!validPrefix(config.prefix)) throw new UserError('PREFIX must contain 1 or 2 visible English letters, numbers, or symbols without spaces or backticks.');
  if(config.spotify.market&&!/^[A-Z]{2}$/.test(config.spotify.market))throw new UserError('SPOTIFY_MARKET must be a two-letter country code or empty.');
  if(config.youtubeCookiesFile){
    const relative=path.relative(config.cookiesRoot,config.youtubeCookiesFile);
    if(!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new UserError('YOUTUBE_COOKIES_FILE must point to a file inside the project secrets folder.','COOKIE_CONFIG');
  }
  return config;
}
export function requireDiscord(config) {
  if (!config.token.trim()) throw new UserError('DISCORD_TOKEN is missing. Copy .env.example to .env and configure the bot token.');
}
