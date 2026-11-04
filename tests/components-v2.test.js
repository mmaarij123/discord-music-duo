import test from 'node:test';
import assert from 'node:assert/strict';
import { Client,MessagePayload,MessageFlags,ChannelType } from 'discord.js';
import { playerMessage,isPlayerMessage } from '../src/components/playerView.js';
import { panelsMessage,textMessage,componentsEdit,commandMessage } from '../src/components/messages.js';
import { PlayerMessageStore } from '../src/components/PlayerMessageStore.js';
import { GuildSettings } from '../src/config/GuildSettings.js';
import { messageContext } from '../src/commands/messageContext.js';
import { interactionHandler } from '../src/events/interactionCreate.js';
import { fixture,track,logger,flattenComponents,componentText } from './helpers.js';

function assertV2(payload){
  assert.equal(payload.flags,MessageFlags.IsComponentsV2);
  assert.equal(Object.hasOwn(payload,'content'),false);assert.equal(Object.hasOwn(payload,'embeds'),false);
  const all=flattenComponents(payload);assert.ok(all.length<=40);
  for(const component of all.filter(item=>item.type===17))assert.equal(component.accent_color,undefined);
  assert.ok(all.filter(component=>component.type===10).reduce((length,component)=>length+component.content.length,0)<=4000);
  for(const component of payload.components)component.toJSON();
}

test('V2 player contains artwork, requester, live state and the five working controls within Discord limits',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());
  await f.player.enqueue([{...track('A'),album:'Album',artwork:'https://example.org/art.jpg',requestedBy:{id:'1037886658462371860'}}],f.channel);
  const payload=playerMessage(f.player,'nonce');assertV2(payload);
  const all=flattenComponents(payload);assert.equal(all.filter(component=>component.type===2).length,5);
  assert.equal(all.find(component=>component.type===11).media.url,'https://example.org/art.jpg');
  assert.ok(componentText(payload).includes('<@1037886658462371860>'));assert.ok(componentText(payload).includes('Playing'));
  assert.equal(payload.components[0].toJSON().accent_color,undefined);assert.equal(isPlayerMessage({components:payload.components}),true);
  await f.player.pause();assert.ok(flattenComponents(playerMessage(f.player,'nonce')).some(component=>component.custom_id==='music:nonce:resume'));
});

test('V2 player snapshots and disconnected displays retain a body without interactive controls',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());
  await f.player.enqueue([track('A')],f.channel);
  assertV2(playerMessage(f.player,undefined,{controls:false}));
  assert.equal(flattenComponents(playerMessage(f.player,undefined,{controls:false})).some(component=>component.type===2),false);
  await f.player.stop(true);const payload=playerMessage(f.player,'nonce',{controls:false});
  assertV2(payload);assert.ok(componentText(payload).includes('Disconnected'));
});

test('maximum track text stays within V2 limits and absent or unsafe artwork never creates an invalid section',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());
  for(const artwork of [undefined,'file:///private/art','not a URL']){
    f.player.current={...track('*'.repeat(300)),artist:'*'.repeat(300),album:'*'.repeat(1200),artwork};
    const payload=playerMessage(f.player,'nonce');assertV2(payload);
    assert.equal(flattenComponents(payload).some(component=>component.type===9),false);
  }
});

test('legacy-to-V2 edits clear old fields while subsequent V2 sends and edits omit them',async()=>{
  const client=new Client({intents:[]});
  try{
    const payload=panelsMessage([{title:'Title',description:'Body',color:16711904}]);assertV2(payload);
    const command=commandMessage(payload);assertV2(command);
    assert.equal(command.components[0].toJSON().accent_color,undefined);
    assert.equal(payload.components[0].toJSON().accent_color,undefined,'Old palette data must not add a colour to any panel');
    const upgraded=componentsEdit({flags:0},payload);
    assert.equal(upgraded.content,null);assert.deepEqual(upgraded.embeds,[]);assert.deepEqual(upgraded.attachments,[]);
    const body=MessagePayload.create({client},upgraded).resolveBody().body;
    assert.equal(body.flags,MessageFlags.IsComponentsV2);assert.equal(body.content,'');assert.deepEqual(body.embeds,[]);
    assert.equal(body.components[0].type,17);assert.equal(body.components[0].accent_color,undefined);
    const edited=componentsEdit({flags:MessageFlags.IsComponentsV2},payload);assertV2(edited);
    const cleanBody=MessagePayload.create({client},edited).resolveBody().body;
    assert.equal(cleanBody.content,undefined);assert.equal(cleanBody.embeds,undefined);
  }finally{await client.destroy();}
});

test('an error after a V2 progress response remains V2 instead of attempting an invalid downgrade',async()=>{
  const sends=[],edits=[],reply={edit:async payload=>{edits.push(payload);return reply;}};
  const context=messageContext({reply:async payload=>{sends.push(payload);return reply;}},{values:{}});
  await context.editReply(textMessage('Preparing'));await context.editReply('Could not play this track.');
  assert.equal(sends.length,1);assertV2(sends[0]);assertV2(edits[0]);
  assert.equal(componentText(edits[0]),'Could not play this track.');
});

test('search progress and later errors use one V2 box from the first response',async()=>{
  const edits=[],reply={edit:async payload=>{edits.push(payload);return reply;}};let sends=0;
  const context=messageContext({reply:async()=>{sends++;return reply;}},{values:{}});
  await context.editReply('Searching');await context.editReply(textMessage('Ready'));await context.editReply('Error');
  assert.equal(sends,1);assertV2(edits[0]);assert.equal(componentText(edits[0]),'Ready');
  assertV2(edits[1]);assert.equal(componentText(edits[1]),'Error');
});

test('migration finds an existing V2 player when its saved ID is absent, without sending another message',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());
  const guildId='111111111111111111',channelId='222222222222222222',botId='333333333333333333';
  const settings=new GuildSettings();await settings.setDjChannel(guildId,channelId);
  const edits=[],message={id:'444444444444444444',author:{id:botId},flags:MessageFlags.IsComponentsV2,components:playerMessage(f.player,'old').components,
    edit:async payload=>{edits.push(payload);return message;}};
  const channel={id:channelId,messages:{fetch:async()=>new Map([[message.id,message]])},send:()=>assert.fail('Created a duplicate player')};
  const store=new PlayerMessageStore(settings),payload=playerMessage(f.player,'new');
  const adopted=await store.render({id:guildId,members:{me:{id:botId}}},channel,payload,store.claim(guildId));
  assert.equal(adopted.id,message.id);assertV2(edits[0]);assert.equal(settings.getDjMessage(guildId),message.id);
});

test('buttons nested inside a V2 container execute pause and resume with normal voice and session checks',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue([track('A')],f.channel);
  const manager={config:f.player.config,get:()=>f.player,presenters:new Map([['guild',{nonce:'nonce',message:{id:'player'}}]])};
  const handler=interactionHandler(manager,logger,{cooldown:()=>{}});
  for(const action of ['pause','resume']){
    const button=flattenComponents(playerMessage(f.player,'nonce')).find(component=>component.custom_id===`music:nonce:${action}`);
    assert.ok(button);let reply;
    const member={voice:{channel:{id:'voice',type:ChannelType.GuildVoice,full:false,permissionsFor:()=>({has:()=>true})}}};
    const interaction={customId:button.custom_id,isButton:()=>true,inGuild:()=>true,guildId:'guild',user:{id:'listener'},message:{id:'player'},
      guild:{id:'guild',members:{me:{voice:{}},fetch:async()=>member}},options:{},deferReply:async options=>{assert.equal(options.flags,MessageFlags.Ephemeral);interaction.deferred=true;},
      editReply:async payload=>{reply=payload;}};
    await handler(interaction);assert.equal(f.player.state,action==='pause'?'paused':'playing');assert.equal(componentText(reply),action==='pause'?'Paused.':'Resumed.');
    assertV2(reply);assert.equal(reply.components[0].toJSON().type,17);assert.equal(reply.components[0].toJSON().accent_color,undefined);
  }
});
