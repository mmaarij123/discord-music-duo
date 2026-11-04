import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createAudioResource, StreamType } from '@discordjs/voice';
import { killProcess, spawnTool } from '../utils/process.js';
import { UserError } from '../utils/errors.js';
import { decoderError } from './decoderError.js';
export class AudioManager {
  constructor(config,youtube,local,{spawn=spawnTool,kill=killProcess}={}) { Object.assign(this,{config,youtube,local,spawn,kill}); this.handles = new Set(); }
  async prefetch(track,{signal,background=false}={}) {
    if(['local','stream'].includes(track.source)||(this.config.audioSourceCacheMs??60000)===0)return null;
    if(background){
      const slots=this.youtube.semaphore;
      if(this.backgroundWarmup || (slots && slots.active>=slots.limit-1))return null;
      this.backgroundWarmup=true;
    }
    try{return await this.youtube.audio(track,signal);}
    finally{if(background)this.backgroundWarmup=false;}
  }
  async prepare(track,options={}) {
    const {signal,refreshSource=false}=options;
    const source = ['local','stream'].includes(track.source) ? await this.local.entry(track.source,track.mediaId) : await this.youtube.audio(track,signal,{fresh:refreshSource});
    try{return await this.open(source,track,options);}
    catch(error){
      // Renew only a reused signed link. Fresh denials remain terminal.
      if(error.code!=='SOURCE_STALE')throw error;
      signal?.throwIfAborted();
      const fresh=await this.youtube.audio(track,signal,{fresh:true});
      return this.open(fresh,track,options);
    }
  }
  async open(source,track,{signal,offset=0,volume=70,onError=()=>{}}={}) {
    signal?.throwIfAborted();
    const args = ['-hide_banner','-loglevel','error','-nostdin','-threads','1'];
    if (source.kind === 'remote') {
      args.push('-protocol_whitelist','https,tls,tcp,crypto','-rw_timeout','15000000',
        '-reconnect','1','-reconnect_on_network_error','1','-reconnect_on_http_error','500,502,503,504','-reconnect_delay_max','2');
      const headers = Object.entries(source.headers ?? {}).filter(([key]) => ['user-agent','referer','origin'].includes(key.toLowerCase()))
        .map(([key,value]) => `${key}: ${String(value).replace(/[\r\n]/g,'')}`).join('\r\n');
      if (headers) args.push('-headers',`${headers}\r\n`);
    } else args.push('-protocol_whitelist','file,pipe');
    if (offset) args.push('-ss',String(offset));
    args.push('-i',source.input,'-vn','-sn','-dn','-map_metadata','-1','-t',String(Math.max(0.1,this.config.maxTrack-offset)),'-f','s16le','-ar','48000','-ac','2','pipe:1');
    const child = this.spawn(this.config.ffmpeg,args);
    let disposed=false, stderr='', started=false,childClosed=false;
    const pcm=new PassThrough({highWaterMark:48000*2*2});
    const report = error => { if (!disposed) {
      if(['ACCESS_DENIED','SOURCE_STALE'].includes(error.code)&&source.match?.youtubeUrl)this.youtube.invalidate?.(source.match);
      handle.failure ??= error; if(started)onError(error);
    } };
    child.stderr.on('data',data => { stderr=(stderr+data).slice(-2048); });
    child.on('error',() => report(new UserError('FFmpeg could not start. Check FFMPEG_PATH and installation.','FFMPEG')));
    child.stdout.on('error',() => report(new UserError('The audio stream was interrupted.','AUDIO_STREAM')));
    pcm.on('error',report);
    child.stdout.pipe(pcm);
    child.on('close',code => {
      childClosed=true;
      if(code !== 0)report(decoderError(stderr,code,{cachedSource:source.fromCache===true&&Boolean(source.match?.youtubeUrl),provider:source.match?.youtubeUrl?'YouTube':'The provider'}));
    });
    let resource;
    const handle = { resource:null, match:source.match, duration:source.duration, failure:null,
      dispose:() => {
        if (disposed) return; disposed=true;
        signal?.removeEventListener('abort',abort);
        resource?.playStream.destroy(); child.stdout.unpipe(pcm); pcm.destroy(); child.stdout.destroy(); this.kill(child); this.handles.delete(handle);
      }
    };
    const abort = () => handle.dispose();
    this.handles.add(handle); signal?.addEventListener('abort',abort,{once:true});
    const readyController=new AbortController();
    try {
      // Wait for actual bytes, with a deadline, before handing the resource to Discord.
      if (!pcm.readableLength) {
        const readySignal=AbortSignal.any([signal,readyController.signal,AbortSignal.timeout(this.config.processMs)].filter(Boolean));
        await Promise.race([
          once(pcm,'readable',{signal:readySignal}),
          once(child,'close',{signal:readySignal}).then(()=>{if(!pcm.readableLength)throw handle.failure ?? new UserError('The source returned no decodable audio.','NO_AUDIO');})
        ]);
        // 'readable' also fires for EOF with zero bytes. Wait for the decoder's
        // close/status in that case instead of declaring an empty stream ready.
        if(!pcm.readableLength&&!childClosed)await once(child,'close',{signal:readySignal});
      }
      signal?.throwIfAborted();
      if(handle.failure)throw handle.failure;
      if(!pcm.readableLength)throw new UserError('The source returned no decodable audio.','NO_AUDIO');
      if (pcm.readableEnded || pcm.destroyed) throw new UserError('The source returned no playable audio.');
      resource=createAudioResource(pcm,{inputType:StreamType.Raw,inlineVolume:true,metadata:track,silencePaddingFrames:5});
      resource.playStream.on('error',report);
      resource.volume.setVolume(volume/100); handle.resource=resource;
      started=true;
      return handle;
    } catch (error) { handle.dispose(); if (error?.name === 'TimeoutError') throw new UserError('Audio startup timed out.'); throw error; }
    finally { readyController.abort(); }
  }
  dispose() { for (const handle of this.handles) handle.dispose(); }
}
