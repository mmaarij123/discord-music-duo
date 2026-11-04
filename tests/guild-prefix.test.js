import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { PermissionFlagsBits } from 'discord.js';
import { GuildSettings } from '../src/config/GuildSettings.js';
import { validPrefix,guildPrefix } from '../src/config/prefix.js';
import { MusicManager } from '../src/music/MusicManager.js';
import { loadConfig } from '../src/config/config.js';
import { messageHandler } from '../src/events/messageCreate.js';
import { interactionHandler } from '../src/events/interactionCreate.js';
import { logger,componentText } from './helpers.js';

const GUILD='111111111111111111',OTHER='222222222222222222',DJ='333333333333333333',MESSAGE='444444444444444444';
async function temporary(t){
  const directory=await mkdtemp(path.join(tmpdir(),'music-prefix-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return path.join(directory,'settings.json');
}
function setup(settings=new GuildSettings()){
  let administrator=true;
  const replies=[];
  const member={permissions:{has:permission=>permission===PermissionFlagsBits.ManageGuild||(permission===PermissionFlagsBits.Administrator&&administrator)},voice:{channel:null}};
  const guild={id:GUILD,members:{me:{id:'bot'},fetch:async()=>member}};
  const manager={settings,config:{prefix:'>'},get:()=>assert.fail('Prefix command accessed playback'),outputChannel:()=>assert.fail('Prefix reply accessed logs')};
  const handler=messageHandler(manager,logger,{cooldown:()=>{}});
  const send=async(content,guildId=GUILD,userId='listener')=>{
    const response={edit:async payload=>{replies.push(payload);return response;}};
    await handler({content,guildId,guild:{...guild,id:guildId},author:{id:userId},inGuild:()=>true,
      channel:{isThread:()=>false,permissionsFor:()=>({has:()=>true})},reply:async payload=>{replies.push(payload);return response;}});
    return componentText(replies.at(-1));
  };
  return {manager,replies,send,setAdmin:value=>{administrator=value;}};
}

test('prefix accepts one or two visible letters, digits or symbols and rejects unsafe input',()=>{
  for(const value of ['>','!!','ab','A','12','??','\\'])assert.equal(validPrefix(value),true);
  for(const value of ['', 'abc',' ', 'a b','!\n','\t','\x7f','\u200b','`','😀',null,1])assert.equal(validPrefix(value),false);
});

test('server prefix persists beside channels and DJ message and survives reload',async t=>{
  const file=await temporary(t),settings=await GuildSettings.open(file);
  await settings.setDjChannel(GUILD,DJ);await settings.setDjMessage(GUILD,DJ,MESSAGE);
  await Promise.all([settings.setPrefix(GUILD,'!!'),settings.setPrefix(OTHER,'ab'),settings.setLogChannel(GUILD,OTHER)]);
  const loaded=await GuildSettings.open(file);
  assert.equal(loaded.getPrefix(GUILD),'!!');assert.equal(loaded.getPrefix(OTHER),'ab');
  assert.equal(loaded.getDjMessage(GUILD),MESSAGE);assert.equal(loaded.getDjChannel(GUILD),DJ);assert.equal(loaded.getLogChannel(GUILD),OTHER);
  assert.equal(JSON.parse(await readFile(file,'utf8')).version,4);
  await loaded.setLogChannel(GUILD,null);await loaded.setDjChannel(GUILD,null);
  assert.equal((await GuildSettings.open(file)).getPrefix(GUILD),'!!');
});

test('legacy settings migrate without losing player IDs or log destinations',async t=>{
  const file=await temporary(t);
  for(const version of [1,2,3]){
    const record={logChannelId:OTHER,...(version>=2?{djChannelId:DJ}:{}),...(version>=3?{djMessageId:MESSAGE}:{})};
    await writeFile(file,JSON.stringify({version,guilds:{[GUILD]:record}}));
    const settings=await GuildSettings.open(file);assert.equal(settings.getPrefix(GUILD),null);
    await settings.setPrefix(GUILD,'?');
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')).guilds[GUILD],{...record,prefix:'?'});
  }
});

test('invalid stored prefixes fail safely and failed writes keep the old prefix',async t=>{
  const file=await temporary(t);
  await writeFile(file,JSON.stringify({version:4,guilds:{[GUILD]:{prefix:'long'}}}));
  await assert.rejects(GuildSettings.open(file),{code:'GUILD_SETTINGS'});
  const settings=new GuildSettings(path.join(file,'blocked.json'),[[GUILD,{prefix:'!'}]]);
  await assert.rejects(settings.setPrefix(GUILD,'??'),{code:'GUILD_SETTINGS'});
  assert.equal(settings.getPrefix(GUILD),'!');
  assert.throws(()=>settings.setPrefix(GUILD,'abc'),{code:'PREFIX'});
});

test('only server Administrator can change prefix, including when bot owner has no admin permission',async()=>{
  const f=setup();f.setAdmin(false);
  assert.match(await f.send('>prefix !'),/Only server administrators/);
  assert.match(await f.send('>prefix !',GUILD,'1037886658462371860'),/Only server administrators/);
  assert.equal(f.manager.settings.getPrefix(GUILD),null);
  // Manage Server alone is deliberately insufficient.
  f.setAdmin(true);assert.match(await f.send('>prefix !'),/Server prefix set to `!`/);
  assert.equal(f.manager.settings.getPrefix(GUILD),'!');
});

test('prefix changes take effect immediately, stay isolated by guild and can reset to >',async()=>{
  const f=setup();await f.send('>prefix !!');
  let before=f.replies.length;await f.send('>prefix');assert.equal(f.replies.length,before);
  f.setAdmin(false);assert.match(await f.send('!!prefix'),/Your prefix is `!!`/);
  assert.match(await f.send('>prefix',OTHER),/Your prefix is `>`/);
  f.setAdmin(true);await f.send('!!prefix >');
  assert.equal(guildPrefix(f.manager,GUILD),'>');
  before=f.replies.length;await f.send('!!prefix');assert.equal(f.replies.length,before);
  assert.match(await f.send('>prefix'),/Your prefix is `>`/);
});

test('invalid prefix arguments never change the saved setting',async()=>{
  const f=setup();
  for(const input of ['abc','! !','`','\u200b']){
    await f.send(`>prefix ${input}`);assert.equal(f.manager.settings.getPrefix(GUILD),null);
  }
});

test('help, mention and usage replies show the current server prefix without changing templates',async()=>{
  const f=setup();await f.manager.settings.setPrefix(GUILD,'ab');
  f.manager.get=()=>undefined;
  assert.match(await f.send('abhelp'),/Your Prefix is \*\*`ab`/);
  assert.match(await f.send('<@bot>'),/Your Prefix is \*\*`ab`/);
  assert.match(await f.send('abvolume nope'),/Usage: abvolume/);
  assert.match(await f.send('>help',OTHER),/Your Prefix is \*\*`>`/);
});

test('existing sessions read prefix changes without sharing configuration across guilds',async t=>{
  const manager=new MusicManager(loadConfig({}),logger,{audio:{dispose(){}}});t.after(()=>manager.destroy());
  const a=manager.get({id:GUILD,voiceAdapterCreator:()=>({sendPayload:()=>true,destroy(){}})},true);
  // Avoid stale-session eviction while creating a second guild session.
  a.idleHolds=1;
  const b=manager.get({id:OTHER},true);
  await manager.settings.setPrefix(GUILD,'!');
  assert.equal(a.config.prefix,'!');assert.equal(b.config.prefix,'>');assert.equal(manager.config.prefix,'>');
  await manager.settings.setPrefix(GUILD,'??');assert.equal(a.config.prefix,'??');
  manager.imports.set(GUILD,new AbortController());
  await assert.rejects(manager.import(GUILD,()=>{}),/\?\?stop/);
});

test('expired button controls direct users to their own server prefix',async()=>{
  const settings=new GuildSettings();await settings.setPrefix(GUILD,'!');let reply;
  const interaction={guildId:GUILD,user:{id:'listener'},customId:'music:expired:skip',message:{id:'old'},isButton:()=>true,inGuild:()=>true,
    deferReply:async()=>{interaction.deferred=true;},editReply:async payload=>{reply=payload;}};
  await interactionHandler({settings,config:{prefix:'>'},presenters:new Map()},logger)(interaction);
  assert.match(componentText(reply),/!help/);
});
