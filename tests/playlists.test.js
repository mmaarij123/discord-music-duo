import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChannelType } from 'discord.js';
import { PlaylistStore,savedTrack } from '../src/music/PlaylistStore.js';
import { OWNER_USER_ID } from '../src/config/owner.js';
import { parsePrefix } from '../src/commands/parsePrefix.js';
import { messageContext } from '../src/commands/messageContext.js';
import { execute } from '../src/commands/execute.js';
import { messageHandler } from '../src/events/messageCreate.js';
import { fixture,logger,componentText,track,settle } from './helpers.js';

const OWNER=OWNER_USER_ID,OTHER='111111111111111111',URL='https://open.spotify.com/playlist/1234567890123456789012';
const song=(title='Song',id='1234567890123456789012')=>({title,artist:'Artist',source:'spotify',sourceUrl:`https://open.spotify.com/track/${id}`,duration:180});
async function file(t){const dir=await mkdtemp(path.join(tmpdir(),'music-playlists-'));t.after(()=>rm(dir,{recursive:true,force:true}));return path.join(dir,'playlists.json');}
function harness(t,{player,discovery}={}){
  const store=new PlaylistStore(),replies=[],member={voice:{channel:{id:'voice',type:ChannelType.GuildVoice,permissionsFor:()=>({has:()=>true})}}};
  t.after(()=>store.dispose());
  const guild={id:'guild',members:{me:{voice:{}},fetch:async()=>member}};
  const channel={isTextBased:()=>true,isThread:()=>false,permissionsFor:()=>({has:()=>true})};
  const manager={config:{prefix:'>'},playlists:store,get:()=>player,discovery:discovery??{resolve:async()=>({tracks:[song()],notices:[]})},
    import:async(_id,fn)=>fn(new AbortController().signal),bindPresenter:async()=>{}};
  const run=async(input,userId=OWNER)=>{
    const response={edit:async payload=>{replies.push(payload);return response;}};
    const message={guildId:guild.id,guild,channel,author:{id:userId,username:'Listener'},inGuild:()=>true,reply:async payload=>{replies.push(payload);return response;}};
    const context=messageContext(message,parsePrefix(input));
    await execute(context,manager,'playlist');return componentText(replies.at(-1));
  };
  return {store,run,replies,manager,guild,channel,member};
}

test('playlist subcommands validate arguments and reject removed list without storage access',async()=>{
  for(const input of ['create','save','play','show','show 2','remove 1','delete',`import ${URL}`,'add Artist Long Song Name'])assert.equal(parsePrefix(`>playlist ${input}`).commandName,'playlist');
  assert.equal(parsePrefix('!!playlist add Artist Long Song','!!').values.query,'Artist Long Song');
  for(const input of ['create myname','play myname','save myname','delete myname','remove 0','remove 1 2','show 0','import','add','rename newname','list',''])assert.throws(()=>parsePrefix(`>playlist ${input}`));
  await assert.rejects(execute({inGuild:()=>true,user:{id:OWNER},options:{getString:()=> 'list'}},{get playlists(){assert.fail('Removed list touched storage');}},'playlist'),/Unknown playlist action/);
});

test('one unnamed playlist per user survives restart and user ownership remains isolated',async t=>{
  const location=await file(t),store=await PlaylistStore.open(location);
  await Promise.all([store.create(OWNER),store.create(OTHER)]);
  await assert.rejects(store.create(OWNER),/only one/);
  await store.add(OWNER,[song()],store.require(OWNER).id);
  const loaded=await PlaylistStore.open(location);
  assert.equal(loaded.get(OWNER).tracks.length,1);assert.equal(loaded.get(OTHER).tracks.length,0);
  assert.equal(loaded.get(OWNER).name,undefined);
  loaded.get(OWNER).tracks.length=0;assert.equal(loaded.get(OWNER).tracks.length,1);
  await loaded.delete(OWNER);await loaded.create(OWNER);assert.equal(loaded.get(OWNER).tracks.length,0);
  assert.deepEqual(await readdir(path.dirname(location)),['playlists.json']);
});

test('concurrent creates allow exactly one playlist and concurrent adds preserve all unique tracks',async()=>{
  const store=new PlaylistStore();const created=await Promise.allSettled([store.create(OWNER),store.create(OWNER)]);
  assert.equal(created.filter(item=>item.status==='fulfilled').length,1);
  const id=store.require(OWNER).id;
  await Promise.all([store.add(OWNER,[song('A','a'.repeat(22))],id),store.add(OWNER,[song('B','b'.repeat(22))],id)]);
  assert.deepEqual(store.get(OWNER).tracks.map(item=>item.title),['A','B']);
});

test('imports deduplicate, validate metadata and report caps honestly',async()=>{
  const store=new PlaylistStore(null,2);await store.create(OWNER);
  const result=await store.add(OWNER,[song(),song(),null,song('B','b'.repeat(22)),song('C','c'.repeat(22))],store.require(OWNER).id);
  assert.deepEqual(result,{added:2,duplicates:1,unavailable:1,omitted:1,total:2});
});

test('collection-level Spotify metadata URLs do not collapse different songs into one',async()=>{
  const store=new PlaylistStore();await store.create(OWNER);
  const result=await store.add(OWNER,[{...song('A'),sourceUrl:URL},{...song('B'),sourceUrl:URL}],store.require(OWNER).id);
  assert.equal(result.added,2);
});

test('saved tracks exclude requester, extracted URLs, cookies, headers and matched Spotify audio',()=>{
  const input={...song(),youtubeUrl:'https://www.youtube.com/watch?v=abcdefghijk',input:'https://r1.googlevideo.com/audio',headers:{Cookie:'private'},requestedBy:{id:OTHER},secret:'private'};
  const saved=savedTrack(input);assert.equal(saved.youtubeUrl,undefined);
  for(const key of ['input','headers','requestedBy','secret'])assert.equal(saved[key],undefined);
  assert.throws(()=>savedTrack({...input,sourceUrl:'https://example.org/secret'}));
  assert.throws(()=>savedTrack({title:'Bad',source:'local',mediaId:'../secret'}));
  assert.equal(savedTrack({title:'Library',source:'local',mediaId:'demo'}).mediaId,'demo');
});

test('playlist positions stay consistent after removal and invalid positions preserve order',async()=>{
  const store=new PlaylistStore();await store.create(OWNER);await store.add(OWNER,[song('A'),song('B','b'.repeat(22)),song('C','c'.repeat(22))],store.require(OWNER).id);
  assert.equal((await store.remove(OWNER,2)).title,'B');await assert.rejects(store.remove(OWNER,3));
  assert.deepEqual(store.get(OWNER).tracks.map(item=>item.title),['A','C']);
});

test('deleted and recreated playlists reject stale import results',async()=>{
  const store=new PlaylistStore();await store.create(OWNER);const id=store.require(OWNER).id;
  await store.delete(OWNER);await store.create(OWNER);
  await assert.rejects(store.add(OWNER,[song()],id),/changed or was deleted/);
  assert.equal(store.get(OWNER).tracks.length,0);
});

test('a cancelled import waiting for the write lock cannot add tracks later',async()=>{
  const store=new PlaylistStore();
  await store.create(OWNER);
  let unlock;
  const pending=store.lock.run(()=>new Promise(resolve=>{unlock=resolve;}));
  await settle();
  const controller=new AbortController();
  const adding=store.add(OWNER,[song()],store.require(OWNER).id,{signal:controller.signal});
  controller.abort();
  unlock();
  await pending;
  await assert.rejects(adding,{name:'AbortError'});
  assert.equal(store.get(OWNER).tracks.length,0);
});

test('failed writes retain the last saved state and malformed storage fails safely',async t=>{
  const location=await file(t);await writeFile(location,'not JSON');
  await assert.rejects(PlaylistStore.open(location),{code:'PLAYLIST_STORAGE'});
  const store=new PlaylistStore(path.join(location,'blocked.json'));
  await assert.rejects(store.create(OWNER),{code:'PLAYLIST_STORAGE'});assert.equal(store.get(OWNER),null);
});

test('imports serialize by user across guilds and dispose cancels signal-ignoring providers',async()=>{
  const store=new PlaylistStore();const pending=store.import(OWNER,()=>new Promise(()=>{}));
  await assert.rejects(store.import(OWNER,async()=>{}),/already running/);
  assert.equal(await store.import(OTHER,async()=>42),42);
  await store.dispose();await assert.rejects(pending,{name:'AbortError'});assert.equal(store.pending.size,0);
});

test('all eight playlist actions deny non-owner users before touching storage, discovery or voice',async()=>{
  for(const action of ['create','add Song','save',`import ${URL}`,'play','show','remove 1','delete']){
    const message={guildId:'guild',guild:{id:'guild'},channel:{},author:{id:OTHER},inGuild:()=>true};
    const manager={get:()=>assert.fail('Unauthorized playback access'),get playlists(){assert.fail('Unauthorized storage access');}};
    await assert.rejects(execute(messageContext(message,parsePrefix(`>playlist ${action}`)),manager,'playlist'),{code:'OWNER_ONLY'});
  }
});

test('owner can create/add/show/remove/delete without voice and replies remain boxed locally',async t=>{
  const f=harness(t);f.manager.get=()=>assert.fail('Storage command touched voice');
  assert.match(await f.run('>playlist create'),/playlist is ready/);
  assert.match(await f.run('>playlist add Artist Song'),/Saved 1 track/);
  assert.match(await f.run('>playlist show'),/Song/);
  assert.match(await f.run('>playlist remove 1'),/Removed/);
  assert.match(await f.run('>playlist delete'),/deleted/);
  assert.equal(f.replies.every(payload=>payload.components.length===1&&payload.embeds===undefined&&payload.allowedMentions.parse.length===0),true);
});

test('Spotify import processes accessible metadata without YouTube playback preloading and reports partial results',async t=>{
  let resolved;
  const f=harness(t,{discovery:{resolve:async input=>{resolved=input;return {tracks:[song(),song(),null],notices:['Public metadata is incomplete.']};}}});
  await f.run('>playlist create');const result=await f.run(`>playlist import ${URL}`);
  assert.equal(resolved,URL);assert.match(result,/Saved 1 track/);assert.match(result,/Duplicates skipped: 1/);assert.match(result,/Unavailable metadata: 1/);assert.match(result,/incomplete/);
  assert.equal(f.store.get(OWNER).tracks.length,1);
  await assert.rejects(f.run('>playlist import https://www.youtube.com/watch?v=abcdefghijk'),/Spotify playlist URL/);
  await assert.rejects(f.run(`>playlist add ${URL}`),/add one song/);
});

test('failed imports leave existing saved tracks intact',async t=>{
  const f=harness(t,{discovery:{resolve:async()=>{throw Error('Provider unavailable');}}});
  await f.run('>playlist create');await f.store.add(OWNER,[song()],f.store.require(OWNER).id);
  await assert.rejects(f.run(`>playlist import ${URL}`),/Provider unavailable/);
  assert.equal(f.store.get(OWNER).tracks.length,1);assert.equal(f.store.pending.size,0);
});

test('save current song strips session data and suppresses duplicates',async t=>{
  const f=harness(t,{player:{current:{...song(),requestedBy:{id:OTHER}}}});await f.run('>playlist create');
  assert.match(await f.run('>playlist save'),/Saved 1 track/);assert.match(await f.run('>playlist save'),/Duplicates skipped: 1/);
  assert.equal(f.store.get(OWNER).tracks[0].requestedBy,undefined);
  f.manager.get=()=>null;await assert.rejects(f.run('>playlist save'),/No song/);
});

test('saved playlist playback uses the normal queue in any guild without resolving every saved song',async t=>{
  const a=fixture(),b=fixture({id:'second'});t.after(()=>a.player.destroy());t.after(()=>b.player.destroy());
  const f=harness(t,{player:a.player,discovery:{resolve:()=>assert.fail('Saved playback preloaded discovery')}});
  await f.run('>playlist create');await f.store.add(OWNER,[track('A'),track('B')],f.store.require(OWNER).id);
  await a.player.enqueue([track('Current')],a.channel);
  await f.run('>playlist play');assert.equal(a.player.current.title,'Current');assert.deepEqual(a.player.queue.tracks.map(item=>item.title),['A','B']);
  f.guild.id='second';f.manager.get=()=>b.player;
  await f.run('>playlist play');assert.equal(b.player.current.title,'A');assert.equal(b.player.queue.length,1);
  assert.equal(a.player.current.title,'Current');assert.equal(f.store.get(OWNER).tracks.length,2);
  assert.equal(b.player.current.requestedBy.id,OWNER);
});

test('playlist play retains voice authorization and empty playlists do not join voice',async t=>{
  const f=harness(t);await f.run('>playlist create');await assert.rejects(f.run('>playlist play'),/empty/);
  await f.store.add(OWNER,[song()],f.store.require(OWNER).id);f.member.voice.channel=null;
  await assert.rejects(f.run('>playlist play'),/Join a voice channel/);
});

test('direct YouTube video command uses preparing text and never enters Spotify or YouTube text search',async t=>{
  const f=fixture();t.after(()=>f.player.destroy());
  const { DiscoveryService }=await import('../src/music/DiscoveryService.js');
  const discovery=new DiscoveryService({search:()=>assert.fail('Spotify text lookup on a URL')},{search:()=>assert.fail('YouTube search on a URL'),resolveInput:async url=>({tracks:[{title:'Exact video',source:'youtube',youtubeUrl:url}],notices:[]})});
  const h=harness(t,{player:f.player,discovery});
  const message={content:'>play <https://youtu.be/abcdefghijk>',guildId:'guild',guild:h.guild,channel:h.channel,author:{id:OWNER},inGuild:()=>true,
    reply:async payload=>{h.replies.push(payload);return {edit:async next=>{h.replies.push(next);}};}};
  await messageHandler(h.manager,logger)(message);
  assert.equal(componentText(h.replies[0]),'Preparing YouTube audio…');assert.equal(f.player.current.youtubeUrl,'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(f.prepared.length,1);await settle();
});
