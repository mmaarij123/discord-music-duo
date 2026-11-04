import { UserError } from '../utils/errors.js';

export const RESTART_EXIT_CODE = 75;

export class ProcessLifecycle {
  constructor({ shutdown, canRestart = false }) {
    Object.assign(this, { shutdown, canRestart });
    this.pending = null;
  }
  async request(action, acknowledge) {
    if (!['shutdown', 'restart'].includes(action)) throw new UserError('Unknown process control.');
    if (this.pending) throw new UserError('A shutdown or restart is already in progress.');
    if (action === 'restart' && !this.canRestart) throw new UserError('Restart needs the startup wrapper. Start the bot with npm start, Start Music Bot.bat, or the supplied PM2 configuration.');
    this.pending = action;
    try { await acknowledge(); }
    catch (error) { this.pending = null; throw error; }
    await this.shutdown(`owner_${action}`, action === 'restart' ? RESTART_EXIT_CODE : 0);
  }
}
