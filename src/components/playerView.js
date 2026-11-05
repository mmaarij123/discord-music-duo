import { ContainerBuilder, SectionBuilder, ThumbnailBuilder, escapeMarkdown, ComponentType } from 'discord.js';
import { playerButtons } from './playerButtons.js';
import { componentsMessage, textDisplay } from './messages.js';
export const PLAYER_HEADING='MUSIC • YOUR SERVER’S LISTENING ROOM';
export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds<0) return 'Unknown';
  const value=Math.floor(seconds), parts=[Math.floor(value/60),value%60];
  if (value>=3600) return `${Math.floor(value/3600)}:${String(Math.floor(value/60)%60).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
  return `${parts[0]}:${String(parts[1]).padStart(2,'0')}`;
}
function safeUrl(value) { try { const url=new URL(value); return url.protocol==='https:' ? url.href : undefined; } catch { return undefined; } }
export function playerMessage(session,nonce,{controls=true}={}) {
  const prefix=session.config.prefix ?? '>';
  const track=session.current;
  const container=new ContainerBuilder().addTextDisplayComponents(textDisplay(PLAYER_HEADING));
  if(!track){
    container.addTextDisplayComponents(textDisplay(`**${session.state==='disconnected'?'Disconnected':'Ready for the next track'}**`),
      textDisplay(session.queue.length?`${session.queue.length} tracks waiting. Use ${prefix}play or ${prefix}skip to continue.`:`Use ${prefix}play to add a song.`));
  }else{
    const status={paused:'Paused',preparing:'Preparing',buffering:'Buffering',recovering:'Reconnecting','waiting-for-voice':'Connecting'}[session.state]??'Playing';
    const requester=/^\d{17,22}$/.test(track.requestedBy?.id??'')?`<@${track.requestedBy.id}>`:escapeMarkdown((track.requestedBy?.name??'Unknown').slice(0,100));
    const artwork=safeUrl(track.artwork),title=escapeMarkdown(track.title.slice(0,256));
    const details=[textDisplay(`**${title}**`),textDisplay(`**${escapeMarkdown((track.artist||track.channel||'Unknown artist').slice(0,200))}**\n\n${status}`)];
    if(artwork)container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(...details).setThumbnailAccessory(new ThumbnailBuilder().setURL(artwork).setDescription('Track artwork')));
    else container.addTextDisplayComponents(...details);
    container.addTextDisplayComponents(textDisplay(`**Requested by** ${requester}\n**Up next** ${session.queue.length} • **Volume** ${session.volume}%`));
    if(track.album)container.addTextDisplayComponents(textDisplay(`**Album**\n${escapeMarkdown(String(track.album).slice(0,1024))}`));
  }
  if(controls)container.addActionRowComponents(...playerButtons(session,nonce));
  return componentsMessage([container]);
}
export function isPlayerMessage(message){
  if(message.embeds?.length===1&&message.embeds[0].author?.name===PLAYER_HEADING)return true;
  return message.components?.some(component=>{
    const container=component.toJSON?.()??component;
    return container.type===ComponentType.Container&&container.components?.[0]?.type===ComponentType.TextDisplay&&container.components[0].content===PLAYER_HEADING;
  })??false;
}
