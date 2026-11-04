export function voiceStateHandler(manager,client,logger){
  return (oldState,newState)=>{
    if(newState.id!==client.user.id)return;
    const player=manager.players.get(newState.guild.id);
    if(!player||player.closed)return;
    if(oldState.channelId&&!newState.channelId){
      logger.info('voice_removed',{guildId:newState.guild.id});
      // A gateway channel=null update is authoritative removal, not a brief
      // audio-network outage. Respect it even when 24/7 mode was enabled.
      manager.cancelImport(newState.guild.id);
      player.notify('Disconnected from the voice channel. Playback stopped and the queue was cleared.');
      player.stop(true).catch(error=>logger.warn('voice_removal_cleanup_failed',{guildId:newState.guild.id,error}));
      return;
    }
    if(newState.channelId&&newState.serverMute)player.notify('The bot is server-muted. A moderator must unmute it for audio to be heard.');
  };
}
