import { escapeMarkdown } from 'discord.js';
import { requireOwner } from '../config/owner.js';
import { UserError } from '../utils/errors.js';
import { classifyInput,integer } from '../utils/validators.js';
import { duration } from '../components/playerView.js';
import { panelsMessage } from '../components/messages.js';
import { commandMap } from './definitions.js';

export async function playlistCommand(interaction,manager,reply,play){
  // The beta gate applies to every subcommand, including reads, across all guilds.
  requireOwner(interaction.user.id);
  const userId=interaction.user.id,action=interaction.options.getString('action',true);
  if(!commandMap.get('playlist').subcommands.some(command=>command.name===action))throw new UserError('Unknown playlist action.');
  const store=manager.playlists;
  if(!store)throw new UserError('Playlist storage is unavailable in this runtime.');
  if(action==='create'){await store.create(userId);return reply('Your playlist is ready. You can have one unnamed playlist across all servers. (Beta)');}
  if(action==='delete'){await store.delete(userId);return reply('Your playlist was deleted.');}
  const list=store.require(userId);
  if(action==='remove'){const removed=await store.remove(userId,interaction.options.getInteger('position',true));return reply(`Removed “${removed.title}” from your playlist.`);}
  if(action==='show'){
    const pages=Math.max(1,Math.ceil(list.tracks.length/10)),page=interaction.options.getInteger('page')??1;integer(page,1,pages,'Page');
    const lines=list.tracks.slice((page-1)*10,page*10).map((track,index)=>`**${(page-1)*10+index+1}.** ${escapeMarkdown(track.title.slice(0,100))}${track.artist?` • ${escapeMarkdown(track.artist.slice(0,60))}`:''} • ${duration(track.duration)}`);
    return reply(panelsMessage([{title:'**Your playlist • Beta**',description:`${lines.join('\n')||'Your playlist is empty.'}\n\n${list.tracks.length} saved tracks • Page ${page}/${pages}`} ]));
  }
  if(action==='save'){
    const player=manager.get(interaction.guild);
    if(!player?.current)throw new UserError('No song is currently playing in this server.');
    const result=await store.add(userId,[player.current],list.id);
    return reply(summary(result));
  }
  if(action==='play'){
    if(!list.tracks.length)throw new UserError('Your playlist is empty. Add or import some songs first.');
    return play(list.tracks);
  }
  let input=interaction.options.getString(action==='import'?'url':'query',true);
  const parsed=classifyInput(input);
  if(action==='import'){
    if(parsed.source!=='spotify'||parsed.type!=='playlist')throw new UserError('Use a public Spotify playlist URL for playlist import.');
    input=parsed.url;
  }else{
    if(['playlist','album'].includes(parsed.type))throw new UserError('Use playlist import with a Spotify playlist URL, or add one song/link at a time.');
  }
  return store.import(userId,async signal=>{
    await reply(action==='import'?'Importing accessible Spotify playlist metadata…':'Finding the song for your playlist…');
    const result=await manager.discovery.resolve(input,signal);signal.throwIfAborted();
    const counts=await store.add(userId,result.tracks,list.id,{signal});
    return reply([summary(counts),...(result.notices??[]).map(notice=>`Metadata: ${notice}`)].join('\n').slice(0,3900));
  });
}
function summary(result){
  return `Saved ${result.added} track${result.added===1?'':'s'} to your playlist. ${result.total} total.\nDuplicates skipped: ${result.duplicates} • Unavailable metadata: ${result.unavailable} • Omitted at the playlist limit: ${result.omitted}`;
}
