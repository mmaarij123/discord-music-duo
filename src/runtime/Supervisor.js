import { fork } from 'node:child_process';
import { killProcess } from '../utils/process.js';
import { RESTART_EXIT_CODE } from './ProcessLifecycle.js';

export class Supervisor {
  constructor({ entry, logger, env = process.env, forkChild = fork, killChild = killProcess, onExit = code => { process.exitCode = code; }, restartDelayMs = 500, stopTimeoutMs = 12000 }) {
    Object.assign(this, { entry, logger, env, forkChild, killChild, onExit, restartDelayMs, stopTimeoutMs });
    this.child = null; this.stopping = false; this.finished = false;
  }
  start() {
    if (this.child || this.stopping || this.finished) return;
    try {
      const child = this.forkChild(this.entry, [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], execArgv: [], windowsHide: true, env: { ...this.env, MUSIC_BOT_SUPERVISED: '1' } });
      this.child = child;
      child.once('error', error => this.logger.error('bot_process_failed', { error }));
      child.once('close', (code, signal) => {
        if (this.child !== child) return;
        this.child = null; clearTimeout(this.stopTimer);
        if (!this.stopping && code === RESTART_EXIT_CODE) {
          this.logger.info('bot_process_restarting');
          this.restartTimer = setTimeout(() => { this.restartTimer = null; this.start(); }, this.restartDelayMs);
        } else {
          const exitCode = this.stopping ? 0 : Number.isInteger(code) ? code : 1;
          if (exitCode !== 0) this.logger.error('bot_process_exited', { exitCode, signal });
          this.finish(exitCode);
        }
      });
    } catch (error) { this.logger.error('bot_process_failed', { error }); this.finish(1); }
  }
  stop() {
    if (this.stopping || this.finished) return;
    this.stopping = true; clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) { this.finish(0); return; }
    this.stopTimer = setTimeout(() => this.killChild(child), this.stopTimeoutMs);
    try {
      if (child.connected) child.send({ type: 'music:shutdown' }, error => { if (error) this.killChild(child); });
      else this.killChild(child);
    } catch { this.killChild(child); }
  }
  finish(code) {
    if (this.finished) return;
    this.finished = true; clearTimeout(this.restartTimer); clearTimeout(this.stopTimer);
    this.onExit(code);
  }
}
