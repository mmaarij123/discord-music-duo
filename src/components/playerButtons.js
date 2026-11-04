import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
export function playerButtons(player,nonce) {
  const active=Boolean(player.current), paused=player.state==='paused';
  const make=(action,label,disabled=false,style=ButtonStyle.Secondary)=>new ButtonBuilder().setCustomId(`music:${nonce}:${action}`).setLabel(label).setStyle(style).setDisabled(disabled);
  return [
    new ActionRowBuilder().addComponents(make(paused?'resume':'pause',paused?'Resume':'Pause',!active,ButtonStyle.Success),make('skip','Skip',!active&&!player.queue.length),make('stop','Stop',!active&&!player.queue.length&&!player.voice.channelId&&!player.idleHolds,ButtonStyle.Danger)),
    new ActionRowBuilder().addComponents(make('loop',`Loop: ${player.queue.loop}`),make('shuffle','Shuffle',player.queue.length<2))
  ];
}
