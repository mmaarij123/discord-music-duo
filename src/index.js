import { Client, Events, GatewayIntentBits, ActivityType } from 'discord.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, requireDiscord, root } from './config/config.js';
import { createLogger } from './utils/logger.js';
import { MusicManager } from './music/MusicManager.js';
import { interactionHandler } from './events/interactionCreate.js';
import { voiceStateHandler } from './events/voiceStateUpdate.js';
import { runTool } from './utils/process.js';
import { messageHandler } from './events/messageCreate.js';
import { createCooldown } from './utils/cooldown.js';
import { ProcessLifecycle } from './runtime/ProcessLifecycle.js';
import { removeSkipVote } from './commands/skipVote.js';
import { UserError } from './utils/errors.js';
let client,manager,shuttingDown=false;
const logger=createLogger(process.env.LOG_LEVEL,{profile:process.env.MUSIC_BOT_PROFILE});
async function shutdown(reason,code=0){
  if(shuttingDown)return; shuttingDown=true;
  logger.info('shutdown',{reason});
  const deadline=setTimeout(()=>process.exit(code),10000); deadline.unref();
  try{await manager?.destroy();}
  catch(error){logger.error('shutdown_cleanup_failed',{error});}
  try{await client?.destroy();}
  catch(error){logger.error('discord_cleanup_failed',{error});}
  finally{process.exitCode=code;if(process.connected)process.disconnect();}
}
try{
  const config=loadConfig();
  if (!config.profile && ['.env.bot1','.env.bot2'].some(file=>existsSync(path.join(root,file)))) {
    throw new UserError('Start both configured bots with Start Music Bot.bat or npm start.');
  }
  requireDiscord(config);
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<24||(major===24&&minor<17))throw new Error('Node.js 24.17.0 or newer is required.');
  await runTool(config.ffmpeg,['-version'],{timeoutMs:5000});
  try{await runTool(config.ytdlp,['--version'],{timeoutMs:5000});}
  catch(error){logger.warn('youtube_unavailable_local_media_still_supported',{error});}
  manager=await MusicManager.create(config,logger);
  manager.lifecycle=new ProcessLifecycle({shutdown,canRestart:typeof process.send==='function'&&['1','pm2'].includes(process.env.MUSIC_BOT_SUPERVISED)});
  client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],allowedMentions:{parse:[]}});
  client.once(Events.ClientReady,ready=>{
    ready.user.setActivity('Mention me for help • Music',{type:ActivityType.Listening});
    logger.info('ready',{userId:ready.user.id,guildCount:ready.guilds.cache.size,commandMode:'prefix',prefix:config.prefix});
  });
  const cooldown=createCooldown();
  client.on(Events.MessageCreate,messageHandler(manager,logger,{cooldown}));
  client.on(Events.InteractionCreate,interactionHandler(manager,logger,{cooldown}));
  client.on(Events.MessageDelete,message=>removeSkipVote(manager.players.get(message.guildId),message.id));
  client.on(Events.MessageBulkDelete,messages=>{
    for(const message of messages.values())removeSkipVote(manager.players.get(message.guildId),message.id);
  });
  client.on(Events.VoiceStateUpdate,voiceStateHandler(manager,client,logger));
  client.on(Events.GuildDelete,guild=>{manager.cancelImport(guild.id);const player=manager.players.get(guild.id);if(player)manager.release(player);});
  client.on(Events.Error,error=>logger.error('discord_error',{error}));
  client.on(Events.Warn,message=>logger.warn('discord_warning',{message}));
  process.once('SIGINT',()=>void shutdown('SIGINT'));
  process.once('SIGTERM',()=>void shutdown('SIGTERM'));
  process.on('message',message=>{if(message?.type==='music:shutdown')void shutdown('supervisor_stop');});
  process.on('unhandledRejection',error=>logger.error('unhandled_rejection',{error:error instanceof Error?error:new Error(String(error))}));
  process.once('uncaughtException',error=>{logger.error('uncaught_exception',{error});void shutdown('uncaughtException',1);});
  await client.login(config.token);
}catch(error){logger.error('startup_failed',{error});await shutdown('startup_failed',1);}
