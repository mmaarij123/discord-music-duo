import { joinVoiceChannel, entersState, VoiceConnectionStatus as Status, VoiceConnectionDisconnectReason as Reason } from '@discordjs/voice';
import { UserError } from '../utils/errors.js';
export class VoiceSession {
  constructor(guild, audioPlayer, onLost, logger,{createConnection=joinVoiceChannel,waitForState=entersState}={}) {
    Object.assign(this,{guild,audioPlayer,onLost,logger,createConnection,waitForState});this.connection=null;this.joinController=null;this.recoveryController=null;this.closed=false;
  }
  get channelId() { return this.connection?.joinConfig.channelId; }
  ensureSubscription(){
    if(this.connection?.state.status===Status.Ready)this.connection.subscribe(this.audioPlayer);
  }
  async join(channel,{signal}={}) {
    signal?.throwIfAborted();
    if (this.channelId && this.channelId !== channel.id) throw new UserError('The bot is already active in another voice channel.');
    if (this.connection?.state.status === Status.Ready) {this.ensureSubscription();return;}
    this.closed=false;
    if (!this.connection) {
      const connection=this.createConnection({ channelId:channel.id,guildId:this.guild.id,adapterCreator:this.guild.voiceAdapterCreator,selfDeaf:true,selfMute:false });
      this.connection=connection;
      connection.on('error',error=>this.logger.warn('voice_error',{guildId:this.guild.id,error}));
      connection.on(Status.Disconnected,()=>this.recover(connection));
      connection.on(Status.Destroyed,()=>{ if (!this.closed && this.connection===connection) { this.connection=null; this.onLost(); } });
      connection.subscribe(this.audioPlayer);
    }
    const controller=new AbortController();this.joinController=controller;
    try {
      const readySignal=AbortSignal.any([signal,controller.signal,AbortSignal.timeout(20000)].filter(Boolean));
      await this.waitForState(this.connection,Status.Ready,readySignal);readySignal.throwIfAborted();this.ensureSubscription();
    }catch {
      const cancelled=controller.signal.aborted;
      this.destroy();
      if(signal?.aborted)throw signal.reason;
      if(cancelled)throw controller.signal.reason;
      throw new UserError('Voice connection timed out. Check Connect/Speak permissions and outbound UDP networking.','VOICE_TIMEOUT');
    }finally{if(this.joinController===controller)this.joinController=null;}
  }
  async recover(connection) {
    if(this.closed||this.recoveryController||connection!==this.connection)return;
    if(connection.state.reason===Reason.Manual){this.destroy();this.onLost();return;}
    const kicked=connection.state.reason===Reason.WebSocketClose&&connection.state.closeCode===4014;
    const controller=new AbortController();this.recoveryController=controller;
    const wait=milliseconds=>this.waitForState(connection,Status.Ready,AbortSignal.any([controller.signal,AbortSignal.timeout(milliseconds)]));
    try {
      // A 4014 may accompany a channel move. Permit library-managed recovery,
      // but never send an explicit rejoin for a kick/do-not-reconnect close.
      try {await wait(5000);if(!controller.signal.aborted&&connection===this.connection)this.ensureSubscription();return;}catch{}
      if(controller.signal.aborted||this.closed||connection!==this.connection)return;
      if(kicked){this.destroy();this.onLost();return;}
      for (let attempt=0;attempt<2;attempt++) {
        if(controller.signal.aborted||this.closed||connection!==this.connection)return;
        connection.rejoin();
        try {await wait(10000);if(!controller.signal.aborted&&connection===this.connection)this.ensureSubscription();return;}catch{}
      }
      if (!this.closed && connection===this.connection) { this.destroy(); this.onLost(); }
    } catch (error) {
      this.logger.warn('voice_recovery_failed',{guildId:this.guild.id,error});
      if (!this.closed) { this.destroy(); this.onLost(); }
    }finally{if(this.recoveryController===controller)this.recoveryController=null;}
  }
  destroy() {
    this.closed=true;
    this.joinController?.abort();this.joinController=null;
    this.recoveryController?.abort();this.recoveryController=null;
    const connection=this.connection; this.connection=null;
    if (connection && connection.state.status !== Status.Destroyed) connection.destroy();
  }
}
