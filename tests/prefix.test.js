import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType,PermissionFlagsBits,MessageFlags } from 'discord.js';
import { parsePrefix } from '../src/commands/parsePrefix.js';
import { messageContext } from '../src/commands/messageContext.js';
import { messageHandler } from '../src/events/messageCreate.js';
import { interactionHandler } from '../src/events/interactionCreate.js';
import { createCooldown } from '../src/utils/cooldown.js';
import { loadConfig } from '../src/config/config.js';
import { fixture,logger,flattenComponents ,componentText} from './helpers.js';
import helpPanels from '../src/components/helpPanels.json' with { type: 'json' };

function message(content='>help') {
  const replies=[],edits=[];
  const permissions={has:()=>true};
  const member={voice:{channel:{id:'voice',type:ChannelType.GuildVoice,full:false,permissionsFor:()=>permissions}},permissions};
  const guild={id:'guild',members:{me:{voice:{}},fetch:async()=>member}};
  const response={id:'reply',edit:async payload=>{edits.push(payload);return response;}};
  return {content,author:{id:'listener',username:'Listener',bot:false},guild,guildId:'guild',
    channel:{isThread:()=>false,isTextBased:()=>true,permissionsFor:()=>permissions},
    inGuild:()=>true,reply:async payload=>{replies.push(payload);return response;},replies,edits,response,permissions,member};
}

test('prefix defaults to > and validates custom prefixes',()=>{
  assert.equal(loadConfig({}).prefix,'>');assert.equal(loadConfig({PREFIX:'!!'}).prefix,'!!');
  for(const prefix of ['', ' ', 'too-long', '>\n'])assert.throws(()=>loadConfig({PREFIX:prefix}),/PREFIX/);
});
test('ignores ordinary messages, slash syntax and empty prefixes',()=>{
  for(const text of ['hello','/play song',' >help','>','>   '])assert.equal(parsePrefix(text),null);
});
test('play preserves full search text and public URLs',()=>{
  assert.deepEqual(parsePrefix('>PLAY Stephen Sanchez Until I Found You'),{commandName:'play',values:{query:'Stephen Sanchez Until I Found You'}});
  assert.equal(parsePrefix('> play https://open.spotify.com/track/1234567890123456789012').values.query,'https://open.spotify.com/track/1234567890123456789012');
});
test('supports every prefix command with typed arguments',()=>{
  const samples=['play Song','pause','resume','skip','stop','queue 2','nowplaying','volume 70','loop queue','shuffle','remove 2','join','leave','autoplay off','logchannel','djchannel','prefix !','clearcache','shutdown','restart','help'];
  for(const sample of samples)assert.ok(parsePrefix(`>${sample}`));
  assert.equal(parsePrefix('>volume 0').values.level,0);assert.equal(parsePrefix('>queue').values.page,undefined);
  assert.equal(parsePrefix('>autoplay true').values.enabled,true);assert.equal(parsePrefix('>autoplay false').values.enabled,false);
});
test('custom prefix affects parsing and usage errors',()=>{
  assert.equal(parsePrefix('!!help','!!').commandName,'help');assert.equal(parsePrefix('>help','!!'),null);
  assert.throws(()=>parsePrefix('!!volume nope','!!'),/Usage: !!volume/);
});
test('rejects unknown, missing, excess and invalid arguments',()=>{
  for(const text of ['>unknown','>play','>volume -1','>volume 101','>volume 5.5','>volume 1e2','>volume 1 2','>pause extra','>loop invalid','>autoplay yes','>remove 0','>play a\nb',`>play ${'a'.repeat(501)}`])assert.throws(()=>parsePrefix(text));
});
test('message context edits a single progress reply and suppresses mentions',async()=>{
  const m=message(),context=messageContext(m,parsePrefix('>help'));
  await Promise.all([context.editReply('Searching…'),context.editReply({embeds:[] ,content:'Added.'})]);
  assert.equal(m.replies.length,1);assert.equal(m.edits.length,1);
  assert.deepEqual(m.replies[0].allowedMentions,{parse:[],repliedUser:false});
});
test('typed options preserve false and zero',()=>{
  const volume=messageContext(message(),parsePrefix('>volume 0'));
  const autoplay=messageContext(message(),parsePrefix('>autoplay off'));
  assert.equal(volume.options.getInteger('level',true),0);assert.equal(autoplay.options.getBoolean('enabled',true),false);
  assert.equal(volume.options.getInteger('page'),null);assert.throws(()=>volume.options.getString('level',true),/Invalid/);
});
test('deleted progress responses can be safely recreated',async()=>{
  const m=message(),context=messageContext(m,parsePrefix('>help'));
  await context.editReply('Searching');m.response.edit=async()=>{const error=Error('deleted');error.code=10008;throw error;};
  await context.editReply('Done');assert.equal(m.replies.length,2);
});
test('V2 help combines all five sections in one unaccented box with native dividers',async()=>{
  const m=message();await messageHandler({config:{prefix:'>'},get:()=>undefined},logger)(m);
  assert.equal(m.replies.length,1);const panels=m.replies[0].components.map(component=>component.toJSON());
  assert.equal(m.replies[0].flags,MessageFlags.IsComponentsV2);assert.equal(m.replies[0].embeds,undefined);assert.equal(m.replies[0].content,undefined);
  assert.equal(panels.length,1);assert.equal(panels[0].accent_color,undefined);
  assert.deepEqual(panels[0].components.filter(component=>component.type===10).map(component=>component.content),helpPanels.filter(panel=>!panel.betaOnly).map(panel=>[panel.title,panel.description].filter(Boolean).join('\n')));
  const dividers=panels[0].components.filter(component=>component.type===14);
  assert.equal(dividers.length,4);assert.ok(dividers.every(component=>component.divider===true));
  assert.ok(flattenComponents(m.replies[0]).length<=40);
});

test('a standalone bot mention replies locally with the exact shared prefix embed',async()=>{
  for(const content of ['<@123456789012345678>','<@!123456789012345678>','  <@123456789012345678>\n']){
    const m=message(content);m.client={user:{id:'123456789012345678'}};
    const manager={config:{prefix:'>'},get:()=>assert.fail('Mention accessed a player'),outputChannel:()=>assert.fail('Mention looked up logs or DJ settings')};
    await messageHandler(manager,logger)(m);
    assert.equal(m.replies.length,1);
    const panel=m.replies[0].components[0].toJSON();
    assert.equal(panel.accent_color,undefined);assert.equal(panel.components[0].content,'**Your Prefix is **`>`');
    assert.equal(m.replies[0].flags,MessageFlags.IsComponentsV2);assert.equal(m.replies[0].embeds,undefined);
    assert.deepEqual(m.replies[0].allowedMentions,{parse:[],repliedUser:false});
  }
});

test('mentions ignore other users, role/everyone pings, reply pings, bots, webhooks and DMs',async()=>{
  for(const change of [
    {content:'<@222222222222222222>'},{content:'<@&123456789012345678>'},{content:'@everyone'},
    {content:'hello',mentions:{repliedUser:{id:'123456789012345678'}}},{content:'hello <@123456789012345678>'},
    {author:{id:'other-bot',bot:true}},{webhookId:'hook'},{inGuild:()=>false}
  ]){
    const m=Object.assign(message('<@123456789012345678>'),change);m.client={user:{id:'123456789012345678'}};
    await messageHandler({get:()=>assert.fail('Ignored mention touched music')},logger)(m);
    assert.equal(m.replies.length,0);
  }
});

test('V2 mentions respect text/thread send permissions and work without Embed Links',async()=>{
  for(const isThread of [false,true]){
    const m=message('<@123456789012345678>');m.client={user:{id:'123456789012345678'}};
    m.channel.isThread=()=>isThread;
    const send=isThread?PermissionFlagsBits.SendMessagesInThreads:PermissionFlagsBits.SendMessages;
    m.permissions.has=values=>![values].flat().includes(send);
    await messageHandler({},logger)(m);assert.equal(m.replies.length,0);
    m.permissions.has=values=>![values].flat().includes(PermissionFlagsBits.EmbedLinks);
    await messageHandler({},logger)(m);assert.equal(m.replies[0].components.length,1);
    m.permissions.has=values=>![values].flat().includes(isThread?PermissionFlagsBits.SendMessages:PermissionFlagsBits.SendMessagesInThreads);
    await messageHandler({},logger)(m);assert.equal(m.replies[1].components.length,1);
  }
});

test('mentions share the bounded user cooldown and reply failures are contained',async()=>{
  const m=message('<@123456789012345678>');m.client={user:{id:'123456789012345678'}};
  const handler=messageHandler({},logger);
  await handler(m);await handler(m);await handler(m);
  assert.equal(m.replies.length,2);
  assert.equal(m.replies[0].components.length,1);assert.match(componentText(m.replies[1]),/Please wait/);
  m.reply=async()=>{throw Error('Reply unavailable');};
  await assert.doesNotReject(messageHandler({},logger,{cooldown:()=>{}})(m));
});
test('message handler ignores bot, webhook and direct messages',async()=>{
  for(const change of [{author:{id:'bot',bot:true}},{webhookId:'hook'},{inGuild:()=>false},{content:'ordinary message'}]){
    const m=Object.assign(message(),change);await messageHandler({config:{prefix:'>'},get:()=>assert.fail('ignored message')},logger)(m);assert.equal(m.replies.length,0);
  }
});

test('a less-than prefix ignores Discord markup and still accepts actual commands',async()=>{
  let requests=0;
  const handler=messageHandler({config:{prefix:'<'},get:()=>undefined},logger,{cooldown:()=>{requests++;}});
  const botId='123456789012345678';
  for(const content of [
    '<@222222222222222222> play','<@!222222222222222222> stop','<@&222222222222222222> help',
    `<@${botId}> ordinary chat`,'<#222222222222222222> help','<:wave:222222222222222222> hi',
    '<t:1234567890:R> help','</help:222222222222222222>','<https://example.com> help'
  ]){
    const m=Object.assign(message(content),{client:{user:{id:botId}}});
    await handler(m);
    assert.equal(m.replies.length,0);
  }
  assert.equal(requests,0);
  const help=message('<help');
  await handler(help);
  assert.match(componentText(help.replies[0]),/Playback Controls/);
  const mention=Object.assign(message(`<@${botId}>`),{client:{user:{id:botId}}});
  await handler(mention);
  assert.match(componentText(mention.replies[0]),/Your Prefix is/);
  assert.equal(requests,2);
});
test('prefix controls enforce voice membership and shared queue methods',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());const m=message('>volume 25');
  const manager={config:{prefix:'>'},get:()=>f.player};await messageHandler(manager,logger)(m);assert.equal(f.player.volume,25);
  const other=message('>skip');other.member.voice.channel=null;
  await messageHandler(manager,logger)(other);assert.match(componentText(other.replies[0]),/Join a voice channel/);
});
test('prefix play reaches discovery with the complete query',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());const m=message('>play Artist Long Song Name');let query;
  const manager={config:{prefix:'>'},get:()=>f.player,presenters:new Map(),import:async(_id,fn)=>fn(new AbortController().signal),
    discovery:{resolve:async text=>{query=text;return {tracks:[{title:'Song',source:'local',mediaId:'Song'}],notices:[]};}}};
  await messageHandler(manager,logger)(m);assert.equal(query,'Artist Long Song Name');assert.equal(f.player.current.title,'Song');
  assert.equal(componentText(m.replies[0]),'Searching of `Artist Long Song Name`');assert.equal(componentText(m.edits.at(-1)),'Added `Song` in the queue');
});
test('prefix settings retain Manage Server authorization',async()=>{
  const m=message('>autoplay on');m.member.permissions={has:()=>false};
  await messageHandler({config:{prefix:'>'},get:()=>undefined},logger)(m);assert.match(componentText(m.replies[0]),/Manage Server/);
});
test('malformed messages give useful replies and V2 help does not need Embed Links',async()=>{
  const manager={config:{prefix:'>'},get:()=>undefined};
  const bad=message('>volume nope');await messageHandler(manager,logger)(bad);assert.match(componentText(bad.replies[0]),/Usage: >volume/);
  const missing=message();missing.permissions.has=value=>value!==PermissionFlagsBits.EmbedLinks;
  await messageHandler(manager,logger)(missing);assert.equal(missing.replies[0].flags,MessageFlags.IsComponentsV2);
});
test('reply failures cannot crash the message handler',async()=>{
  const m=message('>unknown');m.reply=async()=>{throw Error('missing access');};
  await assert.doesNotReject(messageHandler({config:{prefix:'>'}},logger)(m));
});
test('button handler ignores slash and unrelated interactions',async()=>{
  for(const interaction of [{isButton:()=>false},{isButton:()=>true,customId:'other:action'}]){
    interaction.deferReply=()=>assert.fail('unrelated interaction was acknowledged');
    await interactionHandler({},logger)(interaction);
  }
});
test('cooldown scopes users and guilds independently',()=>{
  let time=0;
  const cooldown=createCooldown({now:()=>time});
  assert.equal(cooldown('a','u'),'allow');
  assert.equal(cooldown('a','u'),'warn');
  assert.equal(cooldown('b','u'),'allow');
  assert.equal(cooldown('a','v'),'allow');
  time=2999;
  assert.equal(cooldown('a','u'),'silent');
  time=3000;
  assert.equal(cooldown('a','u'),'allow');
});

test('rapid help repeats send one help box and one warning until the original three seconds elapse',async()=>{
  let time=0;
  const m=message('>help');
  const handler=messageHandler({get:()=>undefined},logger,{cooldown:createCooldown({now:()=>time})});
  for(let index=0;index<3;index++)await handler(m);
  assert.equal(m.replies.length,2);
  assert.match(componentText(m.replies[0]),/Playback Controls/);
  assert.match(componentText(m.replies[1]),/wait 3 seconds/);
  time=3000;
  await handler(m);
  assert.equal(m.replies.length,3);
  assert.match(componentText(m.replies[2]),/Playback Controls/);
});

test('commands and music buttons share one warning and then acknowledge clicks silently',async()=>{
  const cooldown=createCooldown(),m=message('>help');
  await messageHandler({get:()=>undefined},logger,{cooldown})(m);
  let acknowledgements=0;
  const replies=[];
  const handleButton=interactionHandler({get:()=>assert.fail('Rate-limited vote ran')},logger,{cooldown});
  const button={
    isButton:()=>true,customId:'music:nonce:skip',guildId:m.guildId,user:m.author,
    deferReply:()=>assert.fail('Rate-limited button ran'),
    deferUpdate:async()=>{acknowledgements++;},
    reply:async payload=>{replies.push(payload);}
  };
  await handleButton(button);
  await handleButton({...button,customId:'music-vote:poll:yes'});
  await handleButton(button);
  assert.equal(acknowledgements,2);
  assert.equal(replies.length,1);
  assert.equal(replies[0].flags,MessageFlags.IsComponentsV2|MessageFlags.Ephemeral);
  assert.match(componentText(replies[0]),/wait 3 seconds/);
});
