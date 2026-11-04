import test from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../src/commands/definitions.js';
import { parsePrefix } from '../src/commands/parsePrefix.js';
import { execute } from '../src/commands/execute.js';
import { interactionHandler } from '../src/events/interactionCreate.js';
import { loadConfig } from '../src/config/config.js';
import { GuildPlayer } from '../src/music/GuildPlayer.js';
import { QueueManager } from '../src/music/QueueManager.js';
import { OWNER_USER_ID } from '../src/config/owner.js';
import { logger, fixture, track, settle, componentText } from './helpers.js';

const removed=['previous','jump','move','seek','247','lyrics','clear'];
for(const name of removed)test(`removed ${name} is rejected by parsing and direct dispatch before state access`,async()=>{
  assert.equal(commands.some(command=>command.name===name),false);
  assert.throws(()=>parsePrefix(`>${name}`),/Unknown music command/);
  await assert.rejects(execute({inGuild:()=>true,user:{id:OWNER_USER_ID}},{get:()=>assert.fail('Removed command accessed a session')},name),/Unknown music command/);
});

test('remove and owner-only clearcache remain available while removed methods/config are absent',()=>{
  assert.equal(parsePrefix('>remove 2').values.position,2);assert.equal(parsePrefix('>clearcache').commandName,'clearcache');
  for(const method of ['previous','jump','seek','setPersistent'])assert.equal(GuildPlayer.prototype[method],undefined);
  for(const method of ['previous','jump','move'])assert.equal(QueueManager.prototype[method],undefined);
  assert.equal(typeof QueueManager.prototype.clear,'function');
  assert.equal(Object.hasOwn(loadConfig({LYRICS_ADAPTER:'missing-removed-adapter.js'}).adapters,'lyrics'),false);
});

test('shared help lists active public controls without removed commands or extra fields',async()=>{
  let payload;
  await execute({inGuild:()=>true,user:{id:OWNER_USER_ID},editReply:async value=>{payload=value;}},{get:()=>undefined},'help');
  const descriptions=componentText(payload);
  const listed=[...descriptions.matchAll(/^`([a-z0-9]+)` /gmi)].map(match=>match[1].toLowerCase());
  for(const name of removed)assert.equal(listed.includes(name),false);
  assert.ok(listed.includes('remove'));
  assert.equal(payload.embeds,undefined);
  assert.deepEqual([...listed].sort(),commands.filter(command=>!command.ownerOnly&&!command.beta&&command.name!=='help').map(command=>command.name).sort());
});

test('legacy previous button cannot access a player even with a matching current nonce',async()=>{
  let reply;
  const interaction={isButton:()=>true,inGuild:()=>true,customId:'music:nonce:previous',guildId:'guild',user:{id:OWNER_USER_ID},message:{id:'player'},
    deferReply:async()=>{interaction.deferred=true;},editReply:async payload=>{reply=payload;}};
  await interactionHandler({presenters:new Map([['guild',{nonce:'nonce',message:{id:'player'}}]]),get:()=>assert.fail('Removed button accessed player')},logger)(interaction);
  assert.match(componentText(reply),/Unknown player control/);
});

test('paused interruption recovery still resumes from heard position after public seek removal',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue([track('Song'),track('Next')],f.channel);
  f.handle=f.player.handle;f.handle.resource.playbackDuration=30000;await f.player.pause();
  f.fakePlayer.emit('error',new Error('Network interruption'));await settle();await settle();
  assert.equal(f.player.state,'paused');assert.equal(f.player.progress,30);assert.deepEqual(f.offsets,[0,30]);
  assert.equal(f.player.current.title,'Song');assert.equal(f.player.queue.length,1);assert.equal(f.handle.disposed,true);
});
