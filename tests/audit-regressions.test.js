import test from 'node:test';
import assert from 'node:assert/strict';
import { MusicManager } from '../src/music/MusicManager.js';
import { normalizeSpotify } from '../src/music/SpotifyResolver.js';
import { normalizeYouTube } from '../src/music/YouTubeResolver.js';
import { loadConfig } from '../src/config/config.js';
import { UserError } from '../src/utils/errors.js';
import { fixture,logger,track,settle } from './helpers.js';
import { createLogger } from '../src/utils/logger.js';
import { runTool } from '../src/utils/process.js';
import { execute } from '../src/commands/execute.js';
import { ChannelType } from 'discord.js';
import { withAbort } from '../src/utils/async.js';
import { AutoplayManager } from '../src/music/AutoplayManager.js';

function joinContext(){
  const channel={id:'voice',type:ChannelType.GuildVoice,full:false,permissionsFor:()=>({has:()=>true})};
  const member={voice:{channel},permissions:{has:()=>false}};
  return {guildId:'guild',guild:{id:'guild',members:{fetch:async()=>member,me:{voice:{}}}},user:{id:'host'},
    channel:{isTextBased:()=>true,isThread:()=>false,permissionsFor:()=>({has:()=>true})},
    inGuild:()=>true,isButton:()=>false,options:{},editReply:async()=>{}};
}

test('join assigns its host before asynchronous preparation so the host can cancel it',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());let release;
  const binding=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const manager={config:f.player.config,get:()=>f.player,bindPresenter:()=>binding,cancelImport(){}};
  const input=joinContext(),joining=execute(input,manager,'join');
  const ended=assert.rejects(joining,/released/);
  await settle();assert.equal(f.player.ownerId,'host');assert.equal(f.player.idleHolds,1);
  input.guild.members.fetch=async()=>({voice:{channel:null},permissions:{has:()=>false}});
  await execute(input,manager,'stop');release();await ended;
  assert.equal(f.player.closed,true);assert.equal(f.player.voice.channelId,null);assert.equal(f.player.idleHolds,0);
});

test('a pending join cannot be reclaimed by another guild and releases its idle hold on failure',async t=>{
  const manager=new MusicManager(loadConfig({}),logger,{audio:{dispose(){}}});t.after(()=>manager.destroy());
  let release;const pending=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  manager.bindPresenter=async()=>{await pending;throw new UserError('The DJ channel disappeared.');};
  const joining=execute(joinContext(),manager,'join'),failed=assert.rejects(joining,/DJ channel disappeared/);
  await settle();const first=manager.players.get('guild');
  assert.equal(first.idleHolds,1);manager.get({id:'second'},true);
  assert.equal(manager.players.get('guild'),first);assert.equal(first.closed,false);
  release();await failed;assert.equal(first.idleHolds,0);
});

test('subprocess metadata preserves Unicode when a UTF-8 character spans output chunks',async()=>{
  const text='🎵 اردو 日本';
  const script="const data=Buffer.from(process.argv[1]);process.stdout.write(data.subarray(0,1));setTimeout(()=>process.stdout.write(data.subarray(1)),100);";
  const {stdout}=await runTool(process.execPath,['-e',script,text]);
  assert.equal(stdout,text);assert.equal(stdout.includes('\uFFFD'),false);
});

test('new guild creation cannot reclaim another guild while its play request is preparing',async t=>{
  const manager=new MusicManager(loadConfig({}),logger,{audio:{dispose(){}}});t.after(()=>manager.destroy());
  const first=manager.get({id:'first'},true),release=first.holdIdleTimeout();
  manager.get({id:'second'},true);assert.equal(manager.players.get('first'),first);assert.equal(first.closed,false);
  release();manager.get({id:'third'},true);assert.equal(manager.players.has('first'),false);
});
test('active discovery protects a disconnected guild session from stale-session cleanup',async t=>{
  const manager=new MusicManager(loadConfig({}),logger,{audio:{dispose(){}}});t.after(()=>manager.destroy());
  const first=manager.get({id:'first'},true);manager.imports.set('first',new AbortController());
  manager.get({id:'second'},true);assert.equal(manager.players.get('first'),first);assert.equal(first.closed,false);
});
test('malformed public Spotify artist entries do not abort an otherwise usable track',()=>{
  const value=normalizeSpotify({name:' Song ',artists:[null,{},42,{name:'Artist'},'Guest',false]});
  assert.equal(value.title,'Song');assert.equal(value.artist,'Artist, Guest');
  for(const item of [{name:'Song',artists:[null,{}]},{name:{bad:true},artists:['Artist']},{name:' ',artists:['Artist']}])assert.equal(normalizeSpotify(item),null);
});
test('YouTube normalization rejects malformed titles and unsafe text types',()=>{
  assert.equal(normalizeYouTube({id:'abcdefghijk',title:{bad:true}}),null);
  const value=normalizeYouTube({id:'abcdefghijk',title:' Song ',track:{bad:true},artist:42,channel:{bad:true},uploader:'Artist'});
  assert.equal(value.title,'Song');assert.equal(value.artist,undefined);assert.equal(value.channel,'Artist');
});
test('five consecutive runtime failures pause automatic advancement and preserve upcoming tracks',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());const notices=[];f.player.on('notice',message=>notices.push(message));
  await f.player.enqueue(Array.from({length:10},(_,i)=>track(String(i))),f.channel);
  for(let i=0;i<5;i++){f.fakePlayer.emit('error',new UserError('Provider denied','ACCESS_DENIED'));await settle();await settle();}
  assert.equal(f.player.current,null);assert.equal(f.player.queue.length,5);assert.equal(f.prepared.length,5);
  assert.equal(f.player.queue.tracks[0].title,'5');assert.ok(notices.some(message=>message.includes('five consecutive')));
  await f.player.skip();assert.equal(f.player.current.title,'5');assert.equal(f.player.consecutiveFailures,0);
});
test('a completed track resets the consecutive failure budget',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());await f.player.enqueue(['A','B','C'].map(track),f.channel);
  f.fakePlayer.emit('error',new UserError('Denied','ACCESS_DENIED'));await settle();await settle();assert.equal(f.player.consecutiveFailures,1);
  f.fakePlayer.finish();await settle();await settle();assert.equal(f.player.current.title,'C');assert.equal(f.player.consecutiveFailures,0);
});
test('logger redacts nested credentials and source URLs',t=>{
  let output='';t.mock.method(process.stdout,'write',value=>{output+=value;return true;});
  createLogger('info',{pretty:false}).info('audit_probe',{cookie:'private-cookie',nested:{clientSecret:'private-secret',authorization:'private-auth',headers:{Cookie:'private-header'},items:[{password:'private-password',message:'source https://example.test/signed?secret=private-url'}]},count:1});
  const entry=JSON.parse(output);assert.equal(entry.count,1);assert.equal(entry.nested.items[0].message,'source [url]');assert.ok(!output.includes('private-'));
});
test('logger bounds circular object traversal instead of crashing playback',t=>{
  let output='';t.mock.method(process.stdout,'write',value=>{output+=value;return true;});
  const value={};value.self=value;assert.doesNotThrow(()=>createLogger().warn('cycle',{value}));assert.ok(output.includes('[truncated]'));
});

test('terminal logs summarize playback, suppress duplicate startup chatter and sanitize track text',t=>{
  let output='';
  t.mock.method(process.stdout,'write',value=>{output+=value;return true;});
  const terminal=createLogger('info',{pretty:true});
  terminal.info('ready',{guildCount:3,prefix:'>'});
  terminal.info('audio_started',{trackTitle:'Aarzu\n\u001b[31m https://example.test/signed?key=private-url'});
  terminal.info('play_request_ready',{elapsedMs:1500,queuedDuringPlayback:false});
  terminal.info('play_request_ready',{elapsedMs:1500,queuedDuringPlayback:true});
  terminal.error('bot_process_exited',{exitCode:1});
  const lines=output.trimEnd().split('\n');
  assert.equal(lines.length,4);
  assert.match(lines[0],/^\[\d\d:\d\d:\d\d\] INFO\s+Bot ready · 3 servers · prefix ">"$/);
  assert.match(lines[1],/Now playing “Aarzu/);
  assert.match(lines[2],/Song added to queue in 1\.5s/);
  assert.match(lines[3],/ERROR Bot worker exited · exit code 1/);
  assert.ok(!output.includes('\u001b')&&!output.includes('private-url'));
});

test('shutdown waits for released-session notices and then drops cached Discord message references',async()=>{
  let release,disposed=false,finished=false;
  const pending=new Promise(resolve=>{release=resolve;});
  const manager=new MusicManager(loadConfig({}),logger,{audio:{dispose(){disposed=true;}}});
  const player=manager.get({id:'released'},true),presenter=manager.presenters.get('released');
  presenter.setNoticeChannel({send:async()=>pending});presenter.notice('Final disconnect');
  manager.release(player);
  assert.equal(manager.players.size,0);assert.equal(manager.cleanups.size,1);
  const closing=manager.destroy().then(()=>{finished=true;});
  try{
    await settle();assert.equal(finished,false);assert.equal(disposed,false);
  }finally{release();await closing;}
  assert.equal(disposed,true);assert.equal(manager.cleanups.size,0);assert.equal(manager.messageStore.views.size,0);
});

test('a failed released-player cleanup still waits for its final presenter cleanup',async()=>{
  let release,finished=false;const warnings=[],pending=new Promise(resolve=>{release=resolve;});
  const manager=new MusicManager(loadConfig({}),{...logger,warn:event=>warnings.push(event)},{audio:{dispose(){}}});
  const player=manager.get({id:'released'},true),presenter=manager.presenters.get('released');
  player.destroy=async()=>{throw Error('Controlled cleanup failure');};
  presenter.setNoticeChannel({send:async()=>pending});presenter.notice('Final disconnect');
  manager.release(player);const closing=manager.destroy().then(()=>{finished=true;});
  try{await settle();assert.equal(finished,false);}finally{release();await closing;}
  assert.deepEqual(warnings,['session_release_failed']);assert.equal(manager.cleanups.size,0);
});

test('failed empty joins release their claimed host and session instead of retaining stale ownership',async()=>{
  const manager=new MusicManager(loadConfig({}),logger,{audio:{dispose(){}}});
  manager.bindPresenter=async()=>{throw new UserError('DJ unavailable');};
  try{
    await assert.rejects(execute(joinContext(),manager,'join'),/DJ unavailable/);
    assert.equal(manager.players.has('guild'),false);
    const next=manager.get({id:'guild'},true);assert.equal(next.ownerId,null);next.claimHost('new-host');assert.equal(next.ownerId,'new-host');
  }finally{await manager.destroy();}
});

test('a successful join remains connected if only its reply delivery fails',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());const input=joinContext();input.editReply=async()=>{throw Error('Reply failed');};
  await assert.rejects(execute(input,{get:()=>f.player},'join'),/Reply failed/);
  assert.equal(f.player.voice.channelId,'voice');assert.equal(f.player.closed,false);assert.equal(f.player.idleHolds,0);
});

test('already-cancelled waits still observe a rejected operation without an unhandled rejection',async()=>{
  const reason=Error('Cancelled'),signal=AbortSignal.abort(reason);let observed=false;
  const operation={then(_resolve,reject){observed=true;reject(Error('Late provider rejection'));}};
  await assert.rejects(withAbort(operation,signal),error=>error===reason);await settle();assert.equal(observed,true);
});

test('invalid YouTube durations cannot enter playback timing or matching as negative/infinite values',()=>{
  for(const duration of [-10,Infinity,-Infinity,'not a duration',0])assert.equal(normalizeYouTube({id:'abcdefghijk',title:'Song',duration}).duration,undefined);
  assert.equal(normalizeYouTube({id:'abcdefghijk',title:'Song',duration:'180'}).duration,180);
});

test('oversized tool output is rejected and its subprocess is closed',async()=>{
  await assert.rejects(runTool(process.execPath,['-e',"process.stdout.write('x'.repeat(65536));setTimeout(()=>{},30000)"],{maxBytes:32,timeoutMs:5000}),/Metadata exceeded/);
});

test('tool cancellation preserves even a falsy abort reason',async()=>{
  const controller=new AbortController();
  const running=runTool(process.execPath,['-e','setTimeout(()=>{},30000)'],{signal:controller.signal});
  const checked=running.then(()=>assert.fail('Cancelled tool unexpectedly succeeded'),reason=>assert.equal(reason,0));
  controller.abort(0);await checked;
});

test('a provider AbortError without a cancelled player advances to the next song',async t=>{
  const f=fixture();
  t.after(()=>f.player.destroy());
  const prepare=f.player.audio.prepare;
  f.player.audio.prepare=(item,options)=>{
    if(item.title==='A')throw new DOMException('Provider cancelled independently','AbortError');
    return prepare(item,options);
  };
  await f.player.enqueue(['A','B'].map(track),f.channel);
  assert.equal(f.player.current.title,'B');
  assert.equal(f.player.state,'playing');
});

test('autoplay tries another candidate after an unavailable match',async()=>{
  const autoplay=new AutoplayManager({
    search:async()=>[{title:'Missing',channel:'Artist - Topic'}, {title:'Available',channel:'Artist - Topic'}],
    match:async candidate=>{
      if(candidate.title==='Missing')throw new UserError('No match','NO_MATCH');
      return {youtubeUrl:'https://www.youtube.com/watch?v=abcdefghijk'};
    }
  });
  const result=await autoplay.next({title:'Finished',artist:'Artist',source:'youtube'},[]);
  assert.equal(result.title,'Available');
});

test('media subprocesses cannot inherit bot or Spotify credentials',async t=>{
  const keys=['DISCORD_TOKEN','SPOTIFY_CLIENT_ID','SPOTIFY_CLIENT_SECRET'];
  const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  t.after(()=>{
    for(const key of keys){
      if(original[key]===undefined)delete process.env[key];
      else process.env[key]=original[key];
    }
  });
  for(const key of keys)process.env[key]='audit-test-value';
  const script="process.stdout.write(JSON.stringify(process.argv.slice(1).filter(key=>Object.hasOwn(process.env,key))))";
  const result=await runTool(process.execPath,['-e',script,...keys]);
  assert.deepEqual(JSON.parse(result.stdout),[]);
});
