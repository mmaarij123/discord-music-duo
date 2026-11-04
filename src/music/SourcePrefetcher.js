export class SourcePrefetcher {
  constructor(audio,config,logger,guildId){Object.assign(this,{audio,config,logger,guildId});}
  schedule(track,delayMs){
    if(!track||['local','stream'].includes(track.source)||(this.config.audioSourceCacheMs??60000)<=0){this.cancel();return;}
    if(this.target===track&&this.pending)return;
    if(this.target===track&&this.expiresAt>Date.now()+delayMs+this.windowMs()+1000)return;
    this.cancel();this.target=track;
    this.timer=setTimeout(()=>{
      this.timer=null;
      const controller=new AbortController();this.controller=controller;
      const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(this.config.processMs)]);
      this.pending=this.audio.prefetch(track,{signal,background:true}).then(source=>{
        if(this.controller===controller)this.expiresAt=source?.expiresAt??0;
      }).catch(error=>{
        if(!controller.signal.aborted)this.logger.debug('next_source_warmup_failed',{guildId:this.guildId,error});
      }).finally(()=>{if(this.controller===controller){this.controller=null;this.pending=null;}});
    },Math.max(0,delayMs));this.timer.unref();
  }
  windowMs(){return Math.min(20000,(this.config.audioSourceCacheMs??60000)/2);}
  cancel({keepInFlight=false}={}){
    clearTimeout(this.timer);this.timer=null;
    if(keepInFlight&&this.pending)return;
    this.controller?.abort();this.controller=null;this.pending=null;this.target=null;this.expiresAt=0;
  }
}
