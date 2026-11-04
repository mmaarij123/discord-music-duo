import { readFile,mkdir,writeFile,rename,rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Mutex } from '../utils/async.js';
import { UserError } from '../utils/errors.js';
import { validPrefix } from './prefix.js';

const validId=value=>typeof value==='string'&&/^\d{17,22}$/.test(value);
export class GuildSettings {
  constructor(file=null,values=[]){this.file=file;this.values=new Map(values);this.lock=new Mutex();}
  static async open(file){
    try{
      const text=await readFile(file,'utf8');
      if(Buffer.byteLength(text)>1024*1024)throw Error();
      const data=JSON.parse(text);
      if(![1,2,3,4].includes(data?.version)||!data.guilds||typeof data.guilds!=='object'||Array.isArray(data.guilds))throw Error();
      const values=Object.entries(data.guilds).map(([id,value])=>{
        if(!validId(id)||!value||typeof value!=='object')throw Error();
        const record={};
        for(const key of data.version===1?['logChannelId']:data.version===2?['logChannelId','djChannelId']:['logChannelId','djChannelId','djMessageId']){
          if(value[key]!==undefined){if(!validId(value[key]))throw Error();record[key]=value[key];}
        }
        if(data.version>=4&&value.prefix!==undefined){if(!validPrefix(value.prefix))throw Error();record.prefix=value.prefix;}
        if(!Object.keys(record).length)throw Error();
        if(record.djMessageId&&!record.djChannelId)throw Error();
        return [id,record];
      });
      return new GuildSettings(file,values);
    }catch(error){
      if(error.code==='ENOENT')return new GuildSettings(file);
      throw new UserError('The saved guild settings file is invalid or unreadable. Check data/guild-settings.json before starting.','GUILD_SETTINGS');
    }
  }
  getLogChannel(guildId){return this.values.get(guildId)?.logChannelId??null;}
  getDjChannel(guildId){return this.values.get(guildId)?.djChannelId??null;}
  getDjMessage(guildId){return this.values.get(guildId)?.djMessageId??null;}
  getPrefix(guildId){return this.values.get(guildId)?.prefix??null;}
  setPrefix(guildId,prefix){
    if(!validId(guildId))throw new UserError('Invalid server ID.','GUILD_SETTINGS');
    if(!validPrefix(prefix))throw new UserError('Prefix must be 1 or 2 visible English letters, numbers, or symbols, without spaces or backticks.','PREFIX');
    return this.update(guildId,record=>{if(record.prefix===prefix)return false;record.prefix=prefix;});
  }
  setLogChannel(guildId,channelId){return this.setChannel(guildId,'logChannelId',channelId);}
  setDjChannel(guildId,channelId){return this.setChannel(guildId,'djChannelId',channelId);}
  setChannel(guildId,key,channelId){
    if(!['logChannelId','djChannelId'].includes(key))throw new UserError('Unknown channel setting.','GUILD_SETTINGS');
    if(!validId(guildId)||(channelId!==null&&!validId(channelId)))throw new UserError('Invalid server or channel ID.','GUILD_SETTINGS');
    return this.update(guildId,record=>{
      if(record[key]===(channelId??undefined))return false;
      if(key==='djChannelId')delete record.djMessageId;
      if(channelId===null)delete record[key];else record[key]=channelId;
    });
  }
  setDjMessage(guildId,channelId,messageId){
    if(!validId(guildId)||!validId(channelId)||(messageId!==null&&!validId(messageId)))throw new UserError('Invalid DJ message ID.','GUILD_SETTINGS');
    return this.update(guildId,record=>{
      if(record.djChannelId!==channelId||record.djMessageId===(messageId??undefined))return false;
      if(messageId===null)delete record.djMessageId;else record.djMessageId=messageId;
    });
  }
  update(guildId,change){
    return this.lock.run(async()=>{
      const next=new Map(this.values),record={...next.get(guildId)};
      if(change(record)===false)return;
      if(Object.keys(record).length)next.set(guildId,record);else next.delete(guildId);
      if(this.file){
        const directory=path.dirname(this.file),temporary=path.join(directory,`.guild-settings-${randomUUID()}.tmp`);
        try{
          await mkdir(directory,{recursive:true,mode:0o700});
          const serialized=JSON.stringify({version:4,guilds:Object.fromEntries(next)},null,2)+'\n';
          if(Buffer.byteLength(serialized)>1024*1024)throw Error();
          await writeFile(temporary,serialized,{mode:0o600,flag:'wx'});
          await rename(temporary,this.file);
        }catch{throw new UserError('The server setting could not be saved. Check write access to the data folder.','GUILD_SETTINGS');}
        finally{await rm(temporary,{force:true}).catch(()=>{});}
      }
      this.values=next;
    });
  }
}
