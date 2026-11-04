import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,mkdir,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { TTLCache } from '../src/utils/cache.js';
import { Mutex,Semaphore,withAbort } from '../src/utils/async.js';
import { runTool } from '../src/utils/process.js';
import { LocalMediaResolver } from '../src/music/LocalMediaResolver.js';
import { DiscoveryService } from '../src/music/DiscoveryService.js';
import { SpotifyResolver } from '../src/music/SpotifyResolver.js';
import { YouTubeResolver } from '../src/music/YouTubeResolver.js';
import { AutoplayManager } from '../src/music/AutoplayManager.js';
import { MusicManager } from '../src/music/MusicManager.js';
import { loadConfig } from '../src/config/config.js';
import { logger } from './helpers.js';
test('TTL cache isolates returned data, expires entries and bounds size',async()=>{
  const cache=new TTLCache(15,2);cache.set('a',{v:1});cache.get('a').v=2;assert.equal(cache.get('a').v,1);
  cache.set('b',2);cache.set('c',3);assert.equal(cache.get('a'),undefined);await new Promise(r=>{setTimeout(r,25);});assert.equal(cache.get('b'),undefined);
});
test('mutex continues after a rejected operation',async()=>{
  const lock=new Mutex(),order=[];const a=lock.run(()=>{order.push(1);throw Error('expected');}),b=lock.run(()=>order.push(2));await assert.rejects(a);await b;assert.deepEqual(order,[1,2]);
});
test('metadata concurrency is bounded and waiting requests can be cancelled',async()=>{
  const semaphore=new Semaphore(1),controller=new AbortController();let release;
  const first=semaphore.run(()=>new Promise(resolve=>{release=resolve;}));
  const waiting=semaphore.run(()=>assert.fail('cancelled request must not run'),controller.signal);
  controller.abort();await assert.rejects(waiting);release();await first;assert.equal(semaphore.active,0);assert.equal(semaphore.waiters.length,0);
});
test('ignored adapter signals still have a caller-side timeout',async()=>{
  const controller=new AbortController(),pending=withAbort(new Promise(()=>{}),controller.signal);controller.abort();await assert.rejects(pending,{name:'AbortError'});
});
test('tool execution treats metacharacters as literal arguments',async()=>{
  const value='; echo injected & $(hello) `x`';
  const result=await runTool(process.execPath,['-e','process.stdout.write(process.argv[1])','--',value]);assert.equal(result.stdout,value);
});
test('missing tools and process timeouts report useful errors',async()=>{
  await assert.rejects(runTool('music-bot-no-such-tool-123',[]),/missing/);
  await assert.rejects(runTool(process.execPath,['-e','setTimeout(()=>{},30000)'],{timeoutMs:50}),/timed out/);
});
test('authorized library denies arbitrary paths and requires stream authorization',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'music-library-'));
  try{
    const media=path.join(root,'media');await mkdir(media);await writeFile(path.join(root,'secret.txt'),'secret');await writeFile(path.join(media,'song.wav'),'sample');
    const manifest=path.join(root,'media.json');await writeFile(manifest,JSON.stringify({local:{good:{title:'Good',file:'song.wav'},bad:{title:'Bad',file:'../secret.txt'}},streams:{bad:{title:'Bad',url:'https://example.org/audio'}}}));
    const local=new LocalMediaResolver({mediaRoot:media,manifest});assert.equal((await local.resolve('local','good')).tracks[0].title,'Good');
    await assert.rejects(local.entry('local','bad'),/within MEDIA_ROOT/);await assert.rejects(local.entry('stream','bad'),/authorized/);await assert.rejects(local.entry('local','toString'),/not in/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('authorized local metadata is validated and dot-prefixed filenames remain inside the media root',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'music-library-metadata-'));
  try{
    await writeFile(path.join(root,'..song.wav'),'sample');const manifest=path.join(root,'media.json');
    await writeFile(manifest,JSON.stringify({local:{good:{title:' Good ',file:'..song.wav',duration:-1,artist:{bad:true}},bad:{title:42,file:'..song.wav'}}}));
    const local=new LocalMediaResolver({mediaRoot:root,manifest});
    const {tracks}=await local.resolve('local','good');assert.equal(tracks[0].title,'Good');assert.equal(tracks[0].duration,undefined);assert.equal(tracks[0].artist,'Authorized library');
    await assert.rejects(local.resolve('local','bad'),/valid title/);
    const absent=new LocalMediaResolver({mediaRoot:path.join(root,'absent'),manifest});await assert.rejects(absent.entry('local','good'),/MEDIA_ROOT folder/);
  }finally{assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep));await rm(root,{recursive:true,force:true});}
});
test('discovery reports Spotify text-search fallback honestly',async()=>{
  const spotify=new SpotifyResolver(loadConfig({}),new Semaphore(1));
  const discovery=new DiscoveryService(spotify,{search:async()=>[{title:'Song',artist:'Artist',source:'youtube'}]},null);
  const result=await discovery.resolve('Artist Song');assert.equal(result.tracks[0].source,'youtube');assert.match(result.diagnostics[0],/unavailable/);assert.deepEqual(result.notices,[]);
});
test('Spotify search adapter failure falls back, not fabricated results',async()=>{
  const spotify=new SpotifyResolver(loadConfig({}),new Semaphore(1),{search:async()=>{throw Error('service down');}});
  const result=await spotify.search('Song');assert.equal(result.track,null);assert.match(result.notice,/unavailable/);
});
test('YouTube playlist imports report partial and omit inaccessible entries',async()=>{
  const youtube=new YouTubeResolver(loadConfig({}),new Semaphore(1));
  youtube.json=async()=>({data:{entries:[{id:'abcdefghijk',title:'Song',duration:180},null,{id:'abcdefghijl',title:'Live',is_live:true}]},partial:true});
  const result=await youtube.resolveInput('https://www.youtube.com/playlist?list=PL12345678901');
  assert.equal(result.tracks.length,1);assert.ok(result.notices.some(n=>/partial/.test(n)));
});
test('autoplay excludes repeated tracks and unrequested remixes',async()=>{
  let matches=0;const previous={title:'First Song',artist:'Artist',source:'spotify'};
  const youtube={search:async()=>[
    {title:'Artist - First Song (Official Audio)',channel:'Artist - Topic',youtubeUrl:'https://www.youtube.com/watch?v=abcdefghijk'},
    {title:'Different Remix',channel:'Artist - Topic'},
    {title:'Next Song',channel:'Artist - Topic'}
  ],match:async candidate=>{matches++;return {...candidate,youtubeUrl:'https://www.youtube.com/watch?v=abcdefghijl'};}};
  const autoplay=new AutoplayManager(youtube);
  const result=await autoplay.next(previous,[previous]);assert.equal(result.title,'Next Song');assert.equal(matches,1);
});
test('autoplay declines arbitrary channel-only metadata',async()=>{
  const autoplay=new AutoplayManager({search:()=>assert.fail('must not search without artist')});assert.equal(await autoplay.next({title:'Song',channel:'Uploader'},[]),null);
});
test('manager serializes imports per guild, isolates guilds and cancels discovery',async()=>{
  const manager=new MusicManager(loadConfig({}),logger,{audio:{dispose(){}}});let ready;
  const started=new Promise(resolve=>{ready=resolve;});
  const pending=manager.import('a',async signal=>{ready();await withAbort(new Promise(()=>{}),signal);});await started;
  await assert.rejects(manager.import('a',async()=>{}),/already running/);assert.equal(await manager.import('b',async()=>42),42);manager.cancelImport('a');await assert.rejects(pending);assert.equal(manager.imports.size,0);
  await manager.destroy();
});
