import { EventEmitter } from 'node:events';
import { createAudioPlayer, AudioPlayerStatus } from '@discordjs/voice';
import { Mutex, withAbort } from '../utils/async.js';
import { UserError, publicError } from '../utils/errors.js';
import { integer } from '../utils/validators.js';
import { QueueManager } from './QueueManager.js';
import { VoiceSession } from './VoiceSession.js';
import { playbackBehaviors, prematureEnd, mayRetry } from './playbackPolicy.js';
import { SourcePrefetcher } from './SourcePrefetcher.js';
export class GuildPlayer extends EventEmitter {
  constructor(guild,config,{audio,autoplay,logger,audioPlayer,voiceFactory,onRelease=()=>{},onPlayed=()=>{}}) {
    super(); Object.assign(this,{guild,config,audio,autoplay,logger,onRelease,onPlayed});
    this.queue=new QueueManager(config.maxQueue); this.lock=new Mutex();
    this.player=audioPlayer ?? createAudioPlayer({behaviors:playbackBehaviors(config)});
    this.voice=voiceFactory ? voiceFactory(()=>this.connectionLost()) : new VoiceSession(guild,this.player,()=>this.connectionLost(),logger);
    this.volume=config.volume; this.persistent=config.persistent; this.autoplayEnabled=config.autoplay;
    this.ownerId=null;
    this.state='idle'; this.current=null; this.handle=null; this.generation=0; this.offset=0; this.controller=null; this.closed=false; this.recoveryAttempts=0;this.idleHolds=0;this.consecutiveFailures=0;
    this.sourcePrefetcher=typeof audio.prefetch==='function'?new SourcePrefetcher(audio,config,logger,guild.id):null;
    this.player.on('stateChange',(oldState,newState)=>{
      if (newState.status===AudioPlayerStatus.Idle && oldState.resource && oldState.resource===this.handle?.resource) {
        const generation=this.generation,handle=this.handle;
        this.safe(()=>this.lock.run(()=>this.finished(generation,handle)));
      } else if (newState.status===AudioPlayerStatus.Playing && this.handle) {
        clearTimeout(this.startTimer);clearTimeout(this.voiceTimer);
        if(this.pauseOnStartGeneration===this.generation){this.pauseOnStartGeneration=null;this.player.pause();this.state='paused';}
        else this.state='playing';
        this.schedulePrefetch();this.changed();
      } else if(newState.status===AudioPlayerStatus.AutoPaused && this.handle){
        this.state='waiting-for-voice';this.voice.ensureSubscription?.();this.changed();
        this.logger.warn('audio_waiting_for_voice',{guildId:this.guild.id,generation:this.generation});
        const generation=this.generation;clearTimeout(this.voiceTimer);
        this.voiceTimer=setTimeout(()=>{
          if(this.generation===generation&&this.state==='waiting-for-voice')this.connectionLost();
        },Math.max(30000,this.config.processMs));this.voiceTimer.unref();
      }
    });
    this.player.on('error',error=>{
      if(error.resource && error.resource!==this.handle?.resource)return;
      const generation=this.generation;
      this.safe(()=>this.lock.run(()=>this.failed(generation,error)));
    });
  }
  safe(fn) { Promise.resolve().then(fn).catch(error=>this.logger.error('player_event_failed',{guildId:this.guild.id,error})); }
  changed() { this.emit('change'); }
  notify(message) { this.emit('notice',message); }
  claimHost(userId){if(!this.ownerId&&typeof userId==='string'&&userId)this.ownerId=userId;}
  get progress() { return this.offset + (this.handle?.resource.playbackDuration ?? 0)/1000; }
  async join(channel,{signal}={}) {
    return this.lock.run(async()=>{
      signal?.throwIfAborted();
      if (this.closed) throw new UserError(`This session was released. Run ${this.config.prefix ?? '>'}play again.`);
      await this.voice.join(channel,{signal});signal?.throwIfAborted();this.scheduleIdle();this.changed();
    });
  }
  async enqueue(tracks,channel,{signal}={}) {
    return this.lock.run(async()=>{
      signal?.throwIfAborted();
      if (this.closed) throw new UserError(`This session was released. Run ${this.config.prefix ?? '>'}play again.`);
      await this.voice.join(channel,{signal});
      signal?.throwIfAborted();
      if(this.closed)throw new UserError('This session was disconnected. Start a new play request.');
      const result=this.queue.add(tracks);
      if (!result.added) throw new UserError('The queue is full. Remove some upcoming tracks first.');
      this.claimHost(tracks[0]?.requestedBy?.id);
      clearTimeout(this.idleTimer);
      if (!this.current) {this.consecutiveFailures=0;await this.startNext();}
      this.schedulePrefetch();this.changed(); return result;
    });
  }
  releaseAudio({keepPrefetch=false}={}) {
    this.sourcePrefetcher?.cancel({keepInFlight:keepPrefetch});
    const handle=this.handle; this.handle=null;
    this.controller?.abort(); this.controller=null;
    this.pauseOnStartGeneration=null;
    this.player.stop(true); handle?.dispose();
    clearTimeout(this.startTimer);clearTimeout(this.voiceTimer);
  }
  schedulePrefetch(){
    if(!this.sourcePrefetcher)return;
    if(this.state!=='playing'||!this.current?.duration||!this.queue.length){this.sourcePrefetcher.cancel();return;}
    const delay=(this.current.duration-this.progress)*1000-this.sourcePrefetcher.windowMs();
    this.sourcePrefetcher.schedule(this.queue.tracks[0],delay);
  }
  activate(handle,generation,{offset=0,paused=false}={}){
    this.handle=handle;this.offset=offset;
    if(Number.isFinite(handle.duration)&&handle.duration>0)this.current.duration=handle.duration;
    if(handle.match?.artist&&!this.current.artist)this.current.artist=handle.match.artist;
    if(handle.match?.youtubeUrl)this.current.youtubeUrl=handle.match.youtubeUrl;
    this.pauseOnStartGeneration=paused?generation:null;
    this.state='buffering';
    this.startTimer=setTimeout(()=>{
      if(this.generation===generation&&this.state==='buffering')this.safe(()=>this.lock.run(()=>this.failed(generation,new UserError('Audio buffering timed out.','AUDIO_STALLED'))));
    },this.config.processMs);this.startTimer.unref();
    this.player.play(handle.resource);
    this.changed();
  }
  settleIdle() {
    this.controller=null;
    this.current=null;
    this.state='idle';
    this.schedulePrefetch();
    this.scheduleIdle();
    this.changed();
  }
  async finished(generation,handle){
    if(generation!==this.generation || handle!==this.handle || !this.current)return;
    const progress=this.progress;
    this.logger.info('audio_ended',{guildId:this.guild.id,generation,playedSeconds:Math.round(progress*100)/100,duration:this.current.duration,recoveryAttempts:this.recoveryAttempts});
    if(handle.failure || prematureEnd(this.current,progress)){
      await this.failed(generation,handle.failure ?? new UserError('The audio stream ended before the track finished.','AUDIO_EARLY_END'));
      return;
    }
    this.consecutiveFailures=0;
    const ended=this.current;
    this.onPlayed(ended);
    this.releaseAudio({keepPrefetch:true});this.current=null;
    if(this.queue.loop==='track')await this.startNext(ended,false);
    else{this.queue.complete(ended);await this.startNext(undefined,true,ended);}
  }
  async startNext(first,allowAutoplay=false,previous) {
    if (this.closed) return;
    clearTimeout(this.idleTimer);
    let next=first ?? this.queue.take();
    if (!next && allowAutoplay && this.autoplayEnabled) {
      this.controller=new AbortController();
      try {
        const signal=AbortSignal.any([this.controller.signal,AbortSignal.timeout(this.config.processMs)]);
        next=await withAbort(this.autoplay.next(previous,[...this.queue.history,previous].filter(Boolean),signal),signal);
      }
      catch (error) { if (!this.controller.signal.aborted) this.notify(`Autoplay stopped: ${publicError(error)}`); }
      if (this.controller.signal.aborted) { this.settleIdle(); return; }
      if (!next) this.notify('No suitable related track was available. Autoplay stopped.');
    }
    let failures=this.consecutiveFailures;
    while (next && failures<5 && !this.closed) {
      this.recoveryAttempts=0;
      this.generation++; this.current=next; this.state='preparing'; this.offset=0;
      const generation=this.generation, controller=new AbortController(); this.controller=controller; this.changed();
      try {
        const handle=await this.audio.prepare(next,{signal:controller.signal,volume:this.volume,onError:error=>this.safe(()=>this.lock.run(()=>this.failed(generation,error)))});
        if (controller.signal.aborted || this.closed) { handle.dispose(); this.settleIdle(); return; }
        this.activate(handle,generation);
        this.logger.info('audio_started',{guildId:this.guild.id,generation,duration:next.duration,trackTitle:next.title,videoId:handle.match?.id});return;
      } catch (error) {
        const cancelled=controller.signal.aborted||this.closed;
        this.releaseAudio();
        if (cancelled) { this.settleIdle(); return; }
        this.notify(`Could not play “${next.title}”: ${publicError(error)}`);
        this.logger.warn('track_failed',{guildId:this.guild.id,trackTitle:next.title,error}); failures++;this.consecutiveFailures=failures;
        next=this.queue.take();
      }
    }
    if (next) { this.queue.tracks.unshift(next); this.notify(`Playback paused after five consecutive source failures. Try ${this.config.prefix ?? '>'}skip or add an authorized local source.`); }
    this.settleIdle();
  }
  async failed(generation,error) {
    if (generation!==this.generation || !this.handle || !this.current) return;
    this.logger.warn('audio_failed',{guildId:this.guild.id,trackTitle:this.current.title,videoId:this.handle.match?.id,playedSeconds:Math.round(this.progress*100)/100,error});
    const track=this.current,position=this.progress,paused=this.state==='paused';
    this.releaseAudio({keepPrefetch:true});this.offset=position;this.generation++;
    const retries=this.config.playbackRetries ?? 2;
    while(mayRetry(error)&&Number.isFinite(track.duration)&&position+2<track.duration&&this.recoveryAttempts<retries&&!this.closed){
      this.recoveryAttempts++;this.generation++;const attemptGeneration=this.generation;
      const controller=new AbortController();this.controller=controller;this.state='recovering';this.changed();
      this.logger.warn('audio_retry',{guildId:this.guild.id,generation:attemptGeneration,attempt:this.recoveryAttempts,positionSeconds:Math.round(position*100)/100});
      this.notify('The audio source was interrupted. Reconnecting and resuming this track…');
      try{
        const handle=await this.audio.prepare(track,{signal:controller.signal,offset:position,volume:this.volume,refreshSource:true,onError:failure=>this.safe(()=>this.lock.run(()=>this.failed(attemptGeneration,failure)))});
        if(controller.signal.aborted||this.closed){handle.dispose();this.settleIdle();return;}
        this.activate(handle,attemptGeneration,{offset:position,paused});return;
      }catch(failure){
        const cancelled=controller.signal.aborted;this.releaseAudio();
        if(cancelled){this.settleIdle();return;}
        error=failure;this.logger.warn('audio_retry_failed',{guildId:this.guild.id,error});
      }
    }
    this.notify(`Playback interrupted: ${publicError(error)}`);
    this.current=null;this.consecutiveFailures++;
    // One advance per resource; failed tracks are never repeated automatically.
    await this.startNext();
  }
  skip(expected=this.generation) {
    if (this.closed || expected!==this.generation) return Promise.resolve(false);
    const wasActive=Boolean(this.current);
    this.controller?.abort();
    return this.lock.run(async()=>{
      if (this.closed || expected!==this.generation) return false;
      if (!this.current && !this.queue.length && !wasActive) throw new UserError('There is no track to skip.');
      this.generation++;this.consecutiveFailures=0;
      const previous=this.current;
      if(previous&&this.progress>0)this.onPlayed(previous);
      this.releaseAudio({keepPrefetch:true}); this.queue.remember(previous); this.current=null;
      await this.startNext(); return true;
    });
  }
  stop(leave=false) {
    this.controller?.abort();
    // Destroy immediately, before the mutex, so pending recovery cannot rejoin
    // while a source/voice preparation is being cancelled.
    if(leave){this.closed=true;this.voice.destroy();}
    return this.lock.run(async()=>{
      this.generation++; this.releaseAudio(); this.current=null; this.queue.clear(); this.state='idle';this.consecutiveFailures=0;
      if (leave) {this.state='disconnected';this.persistent=false;this.ownerId=null;this.onRelease(this);}
      else this.scheduleIdle();
      this.changed();
    });
  }
  pause() { return this.lock.run(()=>{
    if (!this.handle || !this.player.pause()) throw new UserError('No playing track can be paused.');
    this.state='paused';this.schedulePrefetch(); this.changed();
  }); }
  resume() { return this.lock.run(()=>{
    if (!this.handle || !this.player.unpause()) throw new UserError('No paused track can be resumed.');
    this.state='playing';this.schedulePrefetch(); this.changed();
  }); }
  setVolume(value) { return this.lock.run(()=>{ integer(value,0,100,'Volume'); this.volume=value; this.handle?.resource.volume?.setVolume(value/100); this.changed(); }); }
  editQueue(fn) { return this.lock.run(()=>{ const result=fn(this.queue);this.schedulePrefetch(); this.changed(); return result; }); }
  setAutoplay(enabled) { return this.lock.run(()=>{ this.autoplayEnabled=enabled; this.changed(); }); }
  holdIdleTimeout(){
    this.idleHolds++;clearTimeout(this.idleTimer);this.idleTimer=null;
    let released=false;
    return ()=>{if(released)return;released=true;this.idleHolds--;this.scheduleIdle();};
  }
  scheduleIdle() {
    clearTimeout(this.idleTimer);this.idleTimer=null;
    if (!this.idleHolds && !this.persistent && !this.current && this.voice.channelId && !this.closed) {
      this.idleTimer=setTimeout(()=>this.safe(()=>this.stop(true)),this.config.idleMs); this.idleTimer.unref();
    }
  }
  connectionLost() {
    if(this.closed)return;
    this.controller?.abort();
    this.safe(()=>this.lock.run(()=>{
      if(this.closed)return;
      this.logger.warn('voice_session_lost',{guildId:this.guild.id});
      this.generation++; this.releaseAudio(); this.current=null; this.state='disconnected';
      this.voice.destroy();
      this.notify(`Voice connection was lost after bounded recovery attempts. Use ${this.config.prefix ?? '>'}play or ${this.config.prefix ?? '>'}join to reconnect.`);
      this.changed();
    }));
  }
  async destroy() {
    this.closed=true; this.controller?.abort();
    await this.lock.run(()=>{ clearTimeout(this.idleTimer); this.releaseAudio(); this.voice.destroy(); this.queue.clear(); this.current=null; this.state='disconnected'; this.changed(); this.player.removeAllListeners(); });
  }
}
