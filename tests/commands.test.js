import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType,PermissionFlagsBits } from 'discord.js';
import { execute,voiceAccess } from '../src/commands/execute.js';
import { playerMessage } from '../src/components/playerView.js';
import { playerButtons } from '../src/components/playerButtons.js';
import { interactionHandler } from '../src/events/interactionCreate.js';
import { fixture,logger,track,componentText } from './helpers.js';
function interaction(channelId='voice'){
  const member={voice:{channel:channelId?{id:channelId,type:ChannelType.GuildVoice,full:false,permissionsFor:()=>({has:()=>true})}:null},permissions:{has:()=>true}};
  return {guildId:'guild',user:{id:'user'},guild:{id:'guild',members:{fetch:async()=>member,me:{voice:{}}}},inGuild:()=>true,isButton:()=>false,options:{},editReply:async()=>{},member};
}
test('playback controls require the same voice channel',async()=>{
  await assert.rejects(voiceAccess(interaction(null)),/Join a voice/);
  await assert.rejects(voiceAccess(interaction('other'),{voice:{channelId:'voice'}}),/bot’s voice/);
});
test('missing bot voice permissions are rejected',async()=>{
  const i=interaction();i.member.voice.channel.permissionsFor=()=>({has:()=>false});await assert.rejects(voiceAccess(i),/View Channel, Connect, and Speak/);
});
test('administrative settings require Manage Server',async()=>{
  const i=interaction();i.member.permissions.has=permission=>permission!==PermissionFlagsBits.ManageGuild;i.options.getBoolean=()=>true;
  await assert.rejects(execute(i,{get:()=>undefined},'autoplay'),/Manage Server/);
});
test('invalid command arguments reject without mutating the queue',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue(['A','B'].map(track),f.channel);
  const i=interaction();i.options.getInteger=()=>99;
  await assert.rejects(execute(i,{get:()=>f.player},'remove'),/Position/);assert.equal(f.player.queue.length,1);
});
test('V2 player and buttons serialize current state',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue([track('A')],f.channel);
  assert.ok(componentText(playerMessage(f.player,'session')).includes('**A**'));await f.player.pause();
  const buttons=playerButtons(f.player,'session').flatMap(row=>row.toJSON().components);assert.ok(buttons.some(button=>button.custom_id==='music:session:resume'));
  assert.equal(buttons.length,5);assert.equal(buttons.some(button=>button.label==='Previous'),false);
});
test('expired player buttons return an informative error',async()=>{
  let reply;
  const i={...interaction(),isButton:()=>true,customId:'music:old:skip',message:{id:'old'},deferReply:async()=>{i.deferred=true;},editReply:async value=>{reply=value;}};
  await interactionHandler({presenters:new Map()},logger)(i);assert.match(componentText(reply),/expired/);
});
test('expired interaction replies are contained',async()=>{
  const i={...interaction(),isButton:()=>true,customId:'music:expired:pause',deferReply:async()=>{throw Error('expired');},reply:async()=>{throw Error('expired');}};
  await assert.doesNotReject(interactionHandler({},logger)(i));
});
