import { ChannelType,PermissionFlagsBits } from 'discord.js';
import { UserError } from './errors.js';

export async function requireLogChannel(guild,channel,{history=false}={}){
  if(!channel||channel.guildId!==guild.id||![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(channel.type))throw new UserError('Choose a text channel in this server for music output.','LOG_CHANNEL');
  const bot=guild.members.me??await guild.members.fetchMe();
  if(!channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks]))throw new UserError('The bot needs View Channel, Send Messages and Embed Links in the selected channel.','LOG_CHANNEL');
  if(history&&!channel.permissionsFor(bot)?.has(PermissionFlagsBits.ReadMessageHistory))throw new UserError('The bot needs Read Message History in the DJ channel to reuse its permanent player message.','LOG_CHANNEL');
  return channel;
}
export async function findLogChannel(guild,input){
  const id=input.match(/^<#(\d{17,22})>$/)?.[1]??(/^\d{17,22}$/.test(input)?input:null);
  let channel;
  try{
    if(id)channel=guild.channels.cache.get(id)??await guild.channels.fetch(id);
    else{
      const name=input.replace(/^#/,'').toLowerCase();
      const channels=await guild.channels.fetch();
      const matches=[...channels.values()].filter(value=>value?.name?.toLowerCase()===name);
      if(matches.length>1)throw new UserError('Multiple channels have that name. Use a channel mention or channel ID.','LOG_CHANNEL');
      channel=matches[0];
    }
  }catch(error){if(error instanceof UserError)throw error;throw new UserError('That log channel could not be found in this server. Use its channel mention or ID.','LOG_CHANNEL');}
  return requireLogChannel(guild,channel);
}
