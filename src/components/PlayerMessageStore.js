import { randomBytes } from 'node:crypto';
import { Mutex } from '../utils/async.js';
import { UserError } from '../utils/errors.js';
import { componentsEdit } from './messages.js';
import { isPlayerMessage } from './playerView.js';

// A guild's message outlives its voice sessions. A shared lock and owner token
// prevent a retiring presenter from replacing a newer session's display.
export class PlayerMessageStore {
  constructor(settings){this.settings=settings;this.views=new Map();}
  claim(guildId){
    let view=this.views.get(guildId);
    if(!view){view={lock:new Mutex()};this.views.set(guildId,view);}
    view.owner=Symbol('player');
    return view.owner;
  }
  ownsChannel(guildId,channelId){return Boolean(channelId&&this.settings.getDjChannel(guildId)===channelId);}
  release(guildId,owner){if(this.views.get(guildId)?.owner===owner)this.views.delete(guildId);}
  async savedMessage(guild,channel){
    const saved=this.settings.getDjMessage(guild.id);
    const botId=guild.members.me?.id??channel.client?.user?.id;
    if(saved){
      let message;
      try{message=await channel.messages.fetch({message:saved,force:true});}
      catch(error){
        if(error.code!==10008)throw error;
        await this.settings.setDjMessage(guild.id,channel.id,null);
      }
      if(message){
        if(message.author?.id!==botId||message.webhookId||!isPlayerMessage(message))throw new UserError('The saved DJ message is not a player message from this bot. Turn off the DJ channel setting and set it again.','DJ_MESSAGE');
        return message;
      }
    }
    // One bounded migration scan adopts the bot's existing player instead of
    // creating another message when upgrading from channel-only settings.
    if(!channel.messages?.fetch||!botId)return null;
    const recent=await channel.messages.fetch({limit:100,cache:false});
    return [...recent.values()].find(message=>message.author?.id===botId&&!message.webhookId&&isPlayerMessage(message))??null;
  }
  render(guild,channel,payload,owner,{create=true}={}){
    const view=this.views.get(guild.id);
    if(!view)return Promise.resolve(null);
    return view.lock.run(async()=>{
      if(view.owner!==owner||!this.ownsChannel(guild.id,channel.id))return null;
      if(view.channelId!==channel.id){
        Object.assign(view,{channelId:channel.id,message:null,loaded:false,nonce:randomBytes(12).toString('hex')});
      }
      if(!view.loaded){view.message=await this.savedMessage(guild,channel);view.loaded=true;}
      if(view.owner!==owner||!this.ownsChannel(guild.id,channel.id))return null;
      if(view.message){
        try{await view.message.edit(componentsEdit(view.message,payload));}
        catch(error){
          if(error.code!==10008)throw error;
          view.message=null;view.nonce=randomBytes(12).toString('hex');
          await this.settings.setDjMessage(guild.id,channel.id,null);
        }
      }
      if(!view.message&&create)view.message=await channel.send({...payload,nonce:view.nonce,enforceNonce:true});
      if(view.message)await this.settings.setDjMessage(guild.id,channel.id,view.message.id);
      return view.message;
    });
  }
}
