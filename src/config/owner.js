import { UserError } from '../utils/errors.js';
import { commands } from '../commands/definitions.js';

export const OWNER_USER_ID = '1037886658462371860';
export const ownerCommands = new Set(commands.filter(command=>command.ownerOnly).map(command=>command.name));

export function requireOwner(userId) {
  if (userId !== OWNER_USER_ID) throw new UserError('Only the bot owner can use this command.', 'OWNER_ONLY');
}
