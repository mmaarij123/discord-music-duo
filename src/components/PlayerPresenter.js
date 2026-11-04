import { randomBytes } from 'node:crypto';
import { playerMessage } from './playerView.js';
import { componentsEdit } from './messages.js';
import { Mutex } from '../utils/async.js';
export class PlayerPresenter {
  constructor(player,logger,{messageStore}={}) {
    this.player=player; this.logger=logger; this.nonce=randomBytes(6).toString('hex'); this.message=null; this.channel=null; this.lock=new Mutex(); this.lastEdit=0; this.disposed=false;
    this.messageStore=messageStore;this.messageOwner=messageStore?.claim(player.guild.id);
    this.onChange=()=>this.schedule(); this.onNotice=message=>this.notice(message);
    player.on('change',this.onChange); player.on('notice',this.onNotice);
  }
  bind(channel) { if (!this.channel) this.channel=channel;if(this.noticeChannel===undefined)this.noticeChannel=channel;this.schedule(); }
  setNoticeChannel(channel){this.noticeChannel=channel;}
  get noticeTarget(){return this.noticeChannel===undefined?this.channel:this.noticeChannel;}
  async relocate(channel){
    await this.lock.run(async()=>{
      if(this.disposed)return;
      clearTimeout(this.timer);this.timer=null;
      const previous=this.message;this.message=null;this.channel=channel;this.nonce=randomBytes(6).toString('hex');
      if(previous)await previous.edit(componentsEdit(previous,playerMessage(this.player,this.nonce,{controls:false}))).catch(error=>this.logger.debug('old_player_controls_cleanup_failed',{code:error.code}));
    });
    this.schedule();
  }
  schedule() {
    if (this.disposed || !this.channel || this.timer) return;
    this.timer=setTimeout(()=>{this.timer=null; this.render().catch(error=>this.logger.warn('player_message_failed',{guildId:this.player.guild.id,error}));},Math.max(100,2000-(Date.now()-this.lastEdit)));
    this.timer.unref();
  }
  render() { return this.lock.run(async()=>{
    if (this.disposed || !this.channel) return;
    const payload=playerMessage(this.player,this.nonce);
    this.lastEdit=Date.now();
    if(this.messageStore?.ownsChannel(this.player.guild.id,this.channel.id)){
      this.message=await this.messageStore.render(this.player.guild,this.channel,payload,this.messageOwner);
      return;
    }
    if (this.message) {
      try { await this.message.edit(componentsEdit(this.message,payload)); }
      catch (error) {
        if (error.code===10008) { this.message=null; this.channel=null; }
        else throw error;
      }
    } else this.message=await this.channel.send(payload);
  }); }
  notice(message) {
    if(this.disposed)return;
    this.pendingNotice=message;
    if (this.noticeTimer || !this.noticeTarget) return;
    this.noticeTimer=setTimeout(()=>{
      void this.flushNotice();
    },3000); this.noticeTimer.unref();
  }
  async flushNotice() {
    clearTimeout(this.noticeTimer);this.noticeTimer=null;
    const message=this.pendingNotice,channel=this.noticeTarget;
    this.pendingNotice=null;
    if(!message||!channel)return;
    try{await channel.send({content:message.slice(0,1900),allowedMentions:{parse:[]}});}
    catch(error){this.logger.warn('notice_failed',{guildId:this.player.guild.id,error});}
  }
  async dispose() {
    if(this.disposed)return;
    this.disposed=true; clearTimeout(this.timer); clearTimeout(this.noticeTimer);
    this.player.off('change',this.onChange); this.player.off('notice',this.onNotice);
    await this.flushNotice();
    await this.lock.run(async()=>{
      if(this.channel&&this.messageStore?.ownsChannel(this.player.guild.id,this.channel.id)){
        await this.messageStore.render(this.player.guild,this.channel,playerMessage(this.player,this.nonce,{controls:false}),this.messageOwner,{create:false});
        return;
      }
      if (this.message) await this.message.edit(componentsEdit(this.message,playerMessage(this.player,this.nonce,{controls:false}))).catch(()=>{});
    });
  }
}
