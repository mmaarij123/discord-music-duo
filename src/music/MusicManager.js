import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { root } from '../config/config.js';
import { Semaphore } from '../utils/async.js';
import { UserError } from '../utils/errors.js';
import { SpotifyResolver } from './SpotifyResolver.js';
import { SpotifyApi } from './SpotifyApi.js';
import { YouTubeResolver } from './YouTubeResolver.js';
import { LocalMediaResolver } from './LocalMediaResolver.js';
import { AudioManager } from './AudioManager.js';
import { AutoplayManager } from './AutoplayManager.js';
import { DiscoveryService } from './DiscoveryService.js';
import { GuildPlayer } from './GuildPlayer.js';
import { PlayerPresenter } from '../components/PlayerPresenter.js';
import { PlayerMessageStore } from '../components/PlayerMessageStore.js';
import { GuildSettings } from '../config/GuildSettings.js';
import { requireLogChannel } from '../utils/channels.js';
import { startCacheCleanup } from '../utils/cache.js';
import { guildPrefix } from '../config/prefix.js';
import { PlaylistStore } from './PlaylistStore.js';
import { cacheTrackKeys } from './TrackMatcher.js';
import { youtubeCacheScope } from '../utils/youtubeCookies.js';
async function adapter(file,method) {
  if (!file) return null;
  const module=await import(pathToFileURL(path.resolve(root,file)).href);
  if (typeof module[method]!=='function') throw new UserError(`Configured adapter must export ${method}().`);
  return module;
}
export class MusicManager {
  static async create(config,logger) {
    const [search,recommendations]=await Promise.all([adapter(config.adapters.spotify,'search'),adapter(config.adapters.recommendations,'recommend')]);
    const credentials=config.spotify??{};
    if(Boolean(credentials.clientId)!==Boolean(credentials.clientSecret))logger.warn('spotify_api_credentials_incomplete',{message:'Set both Spotify Client ID and Client Secret to enable optional official metadata search.'});
    const settings=await GuildSettings.open(config.settingsFile);
    let shared;
    try {
      let youtubeScope;
      if (config.sharedDbFile) {
        const { SharedMusicState }=await import('./SharedMusicState.js');
        shared=new SharedMusicState(config.sharedDbFile);
        const account=await youtubeCacheScope(config).catch(error=>{
          logger.warn('youtube_cache_account_check_failed',{error});
          return config.profile??'local';
        });
        youtubeScope=`${account}:${config.maxTrack}:${config.youtubeFastExtraction}`;
      }
      const spotifyScope=createHash('sha256').update(`${credentials.clientId??''}:${credentials.market??''}`).digest('hex');
      const official=credentials.clientId&&credentials.clientSecret
        ?new SpotifyApi({...credentials,cacheMs:config.cacheMs},{cache:shared?.cache(`spotify-search:${spotifyScope}`,config.cacheMs)})
        :null;
      const semaphore=new Semaphore(config.concurrency);
      const youtube=new YouTubeResolver(config,semaphore,{
        cache:shared?.cache(`youtube-search:${youtubeScope}`,config.cacheMs),
        sourceCache:shared?.cache(`youtube-audio:${youtubeScope}`,config.audioSourceCacheMs,100)
      });
      const spotify=new SpotifyResolver(config,semaphore,search??official,shared?.cache(`spotify-public:${config.maxPlaylist}`,config.cacheMs));
      const local=new LocalMediaResolver(config);
      const playlists=shared?new PlaylistStore(null,config.maxSavedTracks,[],shared):await PlaylistStore.open(config.playlistsFile,config.maxSavedTracks);
      return new MusicManager(config,logger,{
        discovery:new DiscoveryService(spotify,youtube,local,config), audio:new AudioManager(config,youtube,local),
        autoplay:new AutoplayManager(youtube,recommendations), settings, playlists, shared,
        caches:[youtube.cache,youtube.sourceCache,spotify.cache,official?.cache].filter(Boolean)
      });
    } catch(error) {
      shared?.close();
      throw error;
    }
  }
  constructor(config, logger, services) {
    Object.assign(this, { config, logger, ...services });
    this.settings = services.settings ?? new GuildSettings();
    this.messageStore = new PlayerMessageStore(this.settings);
    this.players = new Map();
    this.presenters = new Map();
    this.imports = new Map();
    this.cleanups = new Set();
    this.closing = false;
    this.stopCacheCleanup = this.caches?.length ? startCacheCleanup(() => {
      try { this.clearCaches(); }
      catch(error) { this.logger.warn('cache_cleanup_failed',{error}); }
    }) : () => {};
    if(this.shared)this.cacheHeartbeat=setInterval(()=>this.publishCacheProtection(true),30_000).unref();
  }
  async outputChannel(guild,fallback){
    return this.destinationChannel(guild,fallback,'log');
  }
  async djChannel(guild,fallback){
    return this.destinationChannel(guild,fallback,'dj');
  }
  async destinationChannel(guild,fallback,kind){
    const id=kind==='dj'?this.settings.getDjChannel(guild.id):this.settings.getLogChannel(guild.id);if(!id)return fallback;
    let channel;
    try{channel=guild.channels.cache.get(id)??await guild.channels.fetch(id);if(!channel)throw Error();}
    catch{const command=kind==='dj'?'djchannel':'logchannel';throw new UserError(`The configured ${kind==='dj'?'DJ':'music log'} channel is unavailable. A moderator can use ${command} #channelname or ${command} off to fix it.`,'LOG_CHANNEL');}
    return requireLogChannel(guild,channel,{history:kind==='dj'});
  }
  async bindPresenter(guild,fallback){
    const presenter=this.presenters.get(guild.id);
    const djId=this.settings.getDjChannel(guild.id);
    const logId=this.settings.getLogChannel(guild.id);
    const channel=await this.djChannel(guild,fallback);
    if(!presenter)return;
    let notices=null;
    try{notices=await this.outputChannel(guild,fallback);}
    catch(error){this.logger.warn('notice_channel_unavailable',{guildId:guild.id,error});}
    if(this.presenters.get(guild.id)!==presenter||presenter.disposed)return;
    if(this.settings.getLogChannel(guild.id)===logId)presenter.setNoticeChannel(notices);
    if(this.settings.getDjChannel(guild.id)!==djId)return;
    if(djId&&presenter.channel&&presenter.channel.id!==channel.id)await presenter.relocate(channel);
    else presenter.bind(channel);
  }
  async setLogChannel(guild,channel,fallback){
    if(channel)await requireLogChannel(guild,channel);
    await this.settings.setLogChannel(guild.id,channel?.id??null);
    const presenter=this.presenters.get(guild.id);
    if(presenter)presenter.setNoticeChannel(channel??fallback);
  }
  async setDjChannel(guild,channel,fallback){
    if(channel)await requireLogChannel(guild,channel,{history:true});
    await this.settings.setDjChannel(guild.id,channel?.id??null);
    const presenter=this.presenters.get(guild.id);
    if(presenter){
      if(presenter.noticeChannel===undefined)presenter.setNoticeChannel(fallback);
      const target=channel??fallback;
      if(presenter.channel?.id!==target.id)await presenter.relocate(target);else presenter.bind(target);
    }
  }
  get(guild,create=false) {
    let player=this.players.get(guild.id);
    if (!player && create) {
      if (this.closing) throw new UserError('The bot is shutting down. Try again after it restarts.');
      for(const stale of this.players.values()){
        if(!this.imports.has(stale.guild.id)&&!stale.idleHolds&&!stale.voice.channelId&&!stale.current&&!stale.queue.length)this.release(stale);
      }
      if (this.players.size>=this.config.maxPlayers) throw new UserError('The bot has reached its configured server session limit. Try again later.');
      const config=Object.create(this.config);
      Object.defineProperty(config,'prefix',{get:()=>guildPrefix(this,guild.id)});
      player=new GuildPlayer(guild,config,{
        audio:this.audio,autoplay:this.autoplay,logger:this.logger,onRelease:p=>this.release(p),
        onPlayed:track=>this.markTrackPlayed(track)
      });
      this.players.set(guild.id,player); this.presenters.set(guild.id,new PlayerPresenter(player,this.logger,{messageStore:this.messageStore}));
      if(this.shared)player.on('change',()=>this.publishCacheProtection());
    }
    return player;
  }
  release(player) {
    if (this.players.get(player.guild.id)!==player) return;
    this.players.delete(player.guild.id);
    this.publishCacheProtection();
    const presenter=this.presenters.get(player.guild.id); this.presenters.delete(player.guild.id);
    // Release runs inside the player's mutex. Cleanup queues behind that operation.
    const cleanup=Promise.allSettled([player.destroy(),presenter?.dispose()]).then(results=>{
      for(const result of results)if(result.status==='rejected')this.logger.warn('session_release_failed',{error:result.reason});
    }).finally(()=>{
      this.messageStore.release(player.guild.id,presenter?.messageOwner);
      this.cleanups.delete(cleanup);
    });
    this.cleanups.add(cleanup);
  }
  cancelImport(guildId) { this.imports.get(guildId)?.abort(); }
  markTrackPlayed(track) {
    const keys = cacheTrackKeys(track);
    if (!keys.length) return;
    for (const cache of this.caches ?? []) {
      try { cache.markPlayed(keys); }
      catch(error) { this.logger.warn('cache_played_update_failed',{error}); }
    }
  }
  protectedCacheKeys() {
    const protectedKeys = new Set();
    for (const player of this.players.values()) {
      for (const key of cacheTrackKeys(player.current)) protectedKeys.add(key);
      for (const track of player.queue.tracks) {
        for (const key of cacheTrackKeys(track)) protectedKeys.add(key);
      }
    }
    return protectedKeys;
  }
  publishCacheProtection(force=false) {
    if(!this.shared||this.closing)return;
    const keys=this.protectedCacheKeys();
    const snapshot=JSON.stringify([...keys].sort());
    if(!force&&snapshot===this.cacheSnapshot)return;
    try {
      this.shared.protect(keys);
      this.cacheSnapshot=snapshot;
    }catch(error){this.logger.warn('cache_protection_update_failed',{error});}
  }
  clearCaches() {
    if (!this.caches?.length) return 0;
    const protectedKeys=this.protectedCacheKeys();
    let removed = 0;
    for (const cache of this.caches) removed += cache.clearPlayed(protectedKeys);
    return removed;
  }
  async import(guildId,fn) {
    if (this.imports.has(guildId)) throw new UserError(`A discovery/import request is already running in this server. Wait or use ${guildPrefix(this,guildId)}stop to cancel it.`);
    if (this.closing) throw new UserError('The bot is shutting down.');
    if (this.imports.size>=this.config.maxPlayers*2) throw new UserError('The discovery service is busy. Try again shortly.');
    const controller=new AbortController(); this.imports.set(guildId,controller);
    const timeout=setTimeout(()=>controller.abort(),120000); timeout.unref();
    try { return await fn(controller.signal); }
    finally { clearTimeout(timeout); this.imports.delete(guildId); }
  }
  async destroy() {
    this.closing=true; this.stopCacheCleanup(); clearInterval(this.cacheHeartbeat); for(const controller of this.imports.values())controller.abort();
    await this.playlists?.dispose();
    await Promise.allSettled([...this.players.values()].map(p=>p.destroy()));
    await Promise.allSettled([...this.presenters.values()].map(p=>p.dispose()));
    await Promise.all([...this.cleanups]);
    this.audio.dispose(); this.players.clear(); this.presenters.clear();
    this.messageStore.views.clear();
    if(this.shared)this.shared.close();
    else for(const cache of this.caches??[])cache.clear();
  }
}
