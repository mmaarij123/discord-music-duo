import { Mutex } from '../utils/async.js';
import { UserError } from '../utils/errors.js';
import { commandMessage } from '../components/messages.js';

export function messageContext(message, parsed, prefix = '>') {
  let response;
  const lock = new Mutex();
  const get = (name, required, type) => {
    const value = parsed.values[name];
    if (value === undefined || value === null) {
      if (required) throw new UserError(`Missing ${name}. Use ${prefix}help.`);
      return null;
    }
    if (typeof value !== type) throw new UserError(`Invalid ${name}. Use ${prefix}help.`);
    return value;
  };
  const context={
    commandName: parsed.commandName,
    commandPrefix: prefix,
    guild: message.guild,
    guildId: message.guildId,
    channel: message.channel,
    user: message.author,
    inGuild: () => message.inGuild(),
    isButton: () => false,
    options: {
      getString: (name, required = false) => get(name, required, 'string'),
      getInteger: (name, required = false) => get(name, required, 'number'),
      getBoolean: (name, required = false) => get(name, required, 'boolean')
    },
    editReply: payload => lock.run(async () => {
      const safe=commandMessage(payload);
      if (response) {
        try { response = await response.edit(safe);return response; }
        catch (error) { if (error.code !== 10008) throw error; response = null; }
      }
      response=await message.reply({...safe,failIfNotExists:false});
      return response;
    })
  };
  return context;
}
