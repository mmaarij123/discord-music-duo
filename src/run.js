import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { Supervisor } from './runtime/Supervisor.js';
import { createLogger } from './utils/logger.js';
import { publicError, UserError } from './utils/errors.js';

const entry = fileURLToPath(new URL('./index.js', import.meta.url));
process.chdir(path.dirname(path.dirname(entry)));
const inherited = { ...process.env };
const { loadConfig, requireDiscord } = await import('./config/config.js');

try {
  const profiles = ['bot1', 'bot2'].map(profile => {
    let settings;
    try { settings = parse(readFileSync(`.env.${profile}`)); }
    catch { throw new UserError(`Cannot read .env.${profile}. Configure both bot profiles before starting.`); }
    // Require the profile's own token even if a shell or a legacy .env has one.
    const env = { ...inherited, ...settings, DISCORD_TOKEN: settings.DISCORD_TOKEN?.trim() ?? '', MUSIC_BOT_PROFILE: profile };
    const config = loadConfig(env);
    requireDiscord(config);
    return { profile, env, config };
  });
  if (profiles[0].config.token === profiles[1].config.token) throw new UserError('Bot 1 and Bot 2 must use different Discord tokens.');
  if (profiles[0].config.prefix === profiles[1].config.prefix) throw new UserError('Bot 1 and Bot 2 must use different prefixes.');
  if (process.argv.includes('--check')) {
    console.log(`Bot profiles ready (bot1: ${profiles[0].config.prefix}, bot2: ${profiles[1].config.prefix}).`);
  } else {
    const supervisors = profiles.map(({ profile, env, config }) => new Supervisor({
      entry, env, logger: createLogger(config.logLevel, { profile }),
      onExit: code => { if (code !== 0) process.exitCode = code; }
    }));
    const stop = () => { for (const supervisor of supervisors) supervisor.stop(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    for (const supervisor of supervisors) supervisor.start();
  }
} catch (error) {
  console.error(publicError(error));
  process.exitCode = 1;
}
