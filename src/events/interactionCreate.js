import { MessageFlags } from 'discord.js';
import { execute } from '../commands/execute.js';
import { UserError, publicError } from '../utils/errors.js';
import { cooldownWarning, createCooldown } from '../utils/cooldown.js';
import { commandMessage } from '../components/messages.js';
import { guildPrefix } from '../config/prefix.js';
import { castSkipVote, skipVotePrefix } from '../commands/skipVote.js';
export function interactionHandler(manager,logger,{cooldown=createCooldown()}={}) {
  return async interaction=>{
    if(!interaction.isButton())return;
    const isVote=interaction.customId.startsWith(skipVotePrefix);
    if(!isVote&&!interaction.customId.startsWith('music:'))return;
    const decision = cooldown(interaction.guildId, interaction.user.id);
    if (decision === 'warn' || decision === 'silent') {
      try {
        if (decision === 'silent') await interaction.deferUpdate();
        else {
          const payload = commandMessage(cooldownWarning);
          await interaction.reply({...payload,flags:payload.flags|MessageFlags.Ephemeral});
        }
      } catch (error) { logger.debug('interaction_expired', { code: error?.code }); }
      return;
    }
    try {
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      if(!interaction.inGuild())throw new UserError('Use music commands inside a server.');
      if(isVote){
        const status=await castSkipVote(interaction,manager.get(interaction.guild));
        return await interaction.editReply(commandMessage(status));
      }
      const prefix=guildPrefix(manager,interaction.guildId);
      const [,nonce,action]=interaction.customId.split(':');
      const presenter=manager.presenters.get(interaction.guildId);
      if(!presenter || nonce!==presenter.nonce || presenter.message?.id!==interaction.message.id)throw new UserError(`These controls have expired. Use the current player or ${prefix}help.`);
      if(!['pause','resume','skip','stop','loop','shuffle'].includes(action))throw new UserError('Unknown player control.');
      await execute(interaction,manager,action);
    }catch(error){
      logger.warn('interaction_failed',{guildId:interaction.guildId,command:interaction.commandName,error});
      try{
        const payload=commandMessage(publicError(error));
        if(interaction.deferred||interaction.replied)await interaction.editReply(payload);
        else await interaction.reply({...payload,flags:payload.flags|MessageFlags.Ephemeral});
      }catch(replyError){logger.debug('interaction_expired',{code:replyError.code});}
    }
  };
}
