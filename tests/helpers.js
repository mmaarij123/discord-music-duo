import { EventEmitter } from 'node:events';
import { GuildPlayer } from '../src/music/GuildPlayer.js';
import { loadConfig } from '../src/config/config.js';
export const logger={debug(){},info(){},warn(){},error(){}};
export const track=(title='Track')=>({title,artist:'Artist',duration:180,source:'local',mediaId:title});
export class FakeAudioPlayer extends EventEmitter {
  constructor(){super();this.state={status:'idle'};}
  play(resource){const old=this.state;this.state={status:'playing',resource};this.emit('stateChange',old,this.state);}
  stop(){const old=this.state;this.state={status:'idle'};this.emit('stateChange',old,this.state);return true;}
  finish(){if(this.state.resource)this.state.resource.playbackDuration=Math.max(0,((this.state.resource.metadata?.duration??0)-(this.state.resource.seekOffset??0))*1000);return this.stop();}
  pause(){if(this.state.status!=='playing')return false;this.state={...this.state,status:'paused'};return true;}
  unpause(){if(this.state.status!=='paused')return false;this.state={...this.state,status:'playing'};return true;}
}
export function fixture(options={}){
  const handles=[],prepared=[],offsets=[],fakePlayer=new FakeAudioPlayer();
  const config={...loadConfig({}),...options.config};
  const audio=options.audio??{async prepare(t,{offset=0}={}){prepared.push(t.title);offsets.push(offset);const h={resource:{playbackDuration:0,volume:{setVolume(){}},metadata:t,seekOffset:offset},disposed:false,dispose(){this.disposed=true;}};handles.push(h);return h;}};
  const player=new GuildPlayer({id:options.id??'guild'},config,{audio,logger,autoplay:options.autoplay??{next:async()=>null},audioPlayer:fakePlayer,voiceFactory:()=>({channelId:null,async join(channel){this.channelId=channel.id;},destroy(){this.channelId=null;}})});
  return {player,handles,prepared,offsets,fakePlayer,channel:{id:'voice'}};
}
export const settle=()=>new Promise(resolve=>{setImmediate(resolve);});
export function flattenComponents(value){
  const components=Array.isArray(value)?value:value.components??[];
  return components.flatMap(component=>{
    const data=component.toJSON?.()??component;
    return [data,...flattenComponents(data.components??[]),...flattenComponents(data.accessory?[data.accessory]:[])];
  });
}
export const componentText=value=>flattenComponents(value).filter(component=>component.type===10).map(component=>component.content).join('\n');
