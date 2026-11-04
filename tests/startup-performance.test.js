import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { SharedRequests } from '../src/utils/sharedRequests.js';
import { withAbort,Semaphore } from '../src/utils/async.js';
import { loadConfig } from '../src/config/config.js';
import { DiscoveryService } from '../src/music/DiscoveryService.js';
import { YouTubeResolver } from '../src/music/YouTubeResolver.js';
import { SourcePrefetcher } from '../src/music/SourcePrefetcher.js';
import { AudioManager } from '../src/music/AudioManager.js';
import { fixture,track,logger,settle } from './helpers.js';

const data=(extra={})=>({id:'abcdefghijk',title:'Artist Song',duration:180,url:'https://r1.googlevideo.com/audio?expire=9999999999',...extra});
const youtube=()=>new YouTubeResolver(loadConfig({}),new Semaphore(2));

test('direct video discovery and playback source share one extraction',async()=>{
  const resolver=youtube();let calls=0;
  resolver.json=async()=>{calls++;return {data:data()};};
  const result=await resolver.resolveInput('https://www.youtube.com/watch?v=abcdefghijk');
  const source=await resolver.audio(result.tracks[0]);assert.equal(calls,1);assert.equal(source.duration,180);
});

test('supported pasted YouTube video forms bypass Spotify and YouTube searches',async()=>{
  for(const input of ['https://youtu.be/abcdefghijk?si=share','<https://www.youtube.com/watch?v=abcdefghijk>',
    'youtube.com/watch?v=abcdefghijk','www.youtube.com/watch?v=abcdefghijk','music.youtube.com/watch?v=abcdefghijk','youtu.be/abcdefghijk']){
    const resolver=youtube();let calls=0;
    resolver.search=()=>assert.fail('A direct video must not search');
    resolver.json=async args=>{calls++;assert.ok(args.includes('--no-playlist'));assert.equal(args.at(-1),'https://www.youtube.com/watch?v=abcdefghijk');return {data:data()};};
    const discovery=new DiscoveryService({search:()=>assert.fail('A video URL must not use Spotify discovery')},resolver,null);
    const result=await discovery.resolve(input);await resolver.audio({...result.tracks[0]});
    assert.equal(calls,1);assert.equal(result.tracks[0].youtubeUrl,'https://www.youtube.com/watch?v=abcdefghijk');
  }
});
test('recent sources are cloned and reused while recovery can force fresh extraction',async()=>{
  const resolver=youtube();let calls=0;
  resolver.json=async()=>{calls++;return {data:data()};};
  const target={youtubeUrl:'https://www.youtube.com/watch?v=abcdefghijk'};
  const a=await resolver.audio(target);a.headers.test='changed';
  assert.equal((await resolver.audio(target)).headers.test,undefined);assert.equal(calls,1);
  await resolver.audio(target,undefined,{fresh:true});assert.equal(calls,2);resolver.invalidate(target);await resolver.audio(target);assert.equal(calls,3);
});
test('sources near signed-URL expiry are not cached',async()=>{
  const resolver=youtube();let calls=0;
  resolver.json=async()=>{calls++;return {data:data({url:`https://r1.googlevideo.com/audio?expire=${Math.floor(Date.now()/1000)+10}`})};};
  const target={youtubeUrl:'https://www.youtube.com/watch?v=abcdefghijk'};await resolver.audio(target);await resolver.audio(target);assert.equal(calls,2);
});
test('restricted source results are rejected rather than cached',async()=>{
  const resolver=youtube();resolver.json=async()=>({data:data({age_limit:18})});
  await assert.rejects(resolver.audio({youtubeUrl:'https://www.youtube.com/watch?v=abcdefghijk'}),/restricted/);assert.equal(resolver.sourceCache.items.size,0);
});
test('concurrent video extractions share work across callers',async()=>{
  const resolver=youtube();let calls=0,release;
  const pending=new Promise(resolve=>{release=resolve;});resolver.json=async()=>{calls++;await pending;return {data:data()};};
  const target={youtubeUrl:'https://www.youtube.com/watch?v=abcdefghijk'};
  const a=resolver.audio(target),b=resolver.audio(target);release();await Promise.all([a,b]);assert.equal(calls,1);
});
test('search cache normalizes case and whitespace without changing ranking',async()=>{
  const resolver=youtube();let calls=0;resolver.json=async()=>{calls++;return {data:{entries:[data()]}};};
  await resolver.search(' Artist   Song ');await resolver.search('artist song');assert.equal(calls,1);
});
test('cancelling one shared caller leaves another caller running',async()=>{
  const shared=new SharedRequests();let release,started=0,upstream;
  const pending=new Promise(resolve=>{release=resolve;});
  const begin=async signal=>{started++;upstream=signal;await pending;return {value:42};};
  const controller=new AbortController(),a=shared.run('key',begin,controller.signal),b=shared.run('key',begin);
  await settle();controller.abort();await assert.rejects(a);assert.equal(upstream.aborted,false);release();assert.deepEqual(await b,{value:42});assert.equal(started,1);
});
test('cancelling every shared caller aborts the owned metadata work',async()=>{
  const shared=new SharedRequests();let upstream;
  const controller=new AbortController();
  const request=shared.run('key',signal=>{upstream=signal;return withAbort(new Promise(()=>{}),signal);},controller.signal);
  await settle();controller.abort();await assert.rejects(request);await settle();assert.equal(upstream.aborted,true);assert.equal(shared.pending.size,0);
});
test('Spotify lookup and YouTube search start together and retain weighted selection',async()=>{
  let resolveSpotify,resolveYoutube;const started=[];
  const spotify={search:async()=>{started.push('spotify');return new Promise(resolve=>{resolveSpotify=resolve;});}};
  const videos={search:async()=>{started.push('youtube');return new Promise(resolve=>{resolveYoutube=resolve;});},match:async()=>assert.fail('should not repeat a successful candidate search')};
  const service=new DiscoveryService(spotify,videos,null);const result=service.resolve('Artist Song');await settle();assert.deepEqual(started,['spotify','youtube']);
  resolveSpotify({track:{title:'Song',artist:'Artist',duration:180,source:'spotify'}});
  resolveYoutube([{title:'Artist Song Cover',duration:180,youtubeUrl:'bad'},{title:'Artist Song Official Audio',duration:180,youtubeUrl:'good'}]);
  assert.equal((await result).tracks[0].youtubeUrl,'good');
});
test('slow optional Spotify metadata does not block validated YouTube results indefinitely',async()=>{
  const spotify={search:async()=>new Promise(()=>{})};
  const videos={search:async()=>[{title:'Artist Song',source:'youtube',youtubeUrl:'good'}]};
  const keeper=setTimeout(()=>{},100);
  try{
    const service=new DiscoveryService(spotify,videos,null,{spotifyDiscoveryMs:15});
    const result=await service.resolve('Artist Song');assert.equal(result.tracks[0].source,'youtube');assert.match(result.diagnostics[0],/startup budget/);
  }finally{clearTimeout(keeper);}
});
test('canonical artist/title search remains a fallback when initial candidates do not match',async()=>{
  let canonical=0;
  const service=new DiscoveryService({search:async()=>({track:{title:'Song',artist:'Artist',source:'spotify'}})},
    {search:async()=>[{title:'Unrelated',artist:'Other'}],match:async()=>{canonical++;return {youtubeUrl:'matched'};}},null);
  assert.equal((await service.resolve('Some remembered lyrics')).tracks[0].youtubeUrl,'matched');assert.equal(canonical,1);
});
test('next-track warmup only prepares metadata for one upcoming track and cancels on pause',async t=>{
  const prepared=[],warmed=[];
  const audio={async prepare(item){prepared.push(item.title);return {resource:{metadata:item,playbackDuration:0},dispose(){}};},async prefetch(item){warmed.push(item.title);return {expiresAt:Date.now()+60000};}};
  const f=fixture({audio});t.after(()=>f.player.destroy());
  await f.player.enqueue(['A','B','C'].map(name=>({...track(name),source:'youtube',duration:10})),f.channel);await delay(15);
  assert.deepEqual(prepared,['A']);assert.deepEqual(warmed,['B']);await f.player.pause();assert.equal(f.player.sourcePrefetcher.target,null);
});
test('changing the next track aborts the obsolete metadata warmup',async()=>{
  const signals=[];
  const prefetcher=new SourcePrefetcher({async prefetch(_track,{signal}){signals.push(signal);await withAbort(new Promise(()=>{}),signal);}},loadConfig({}),logger,'guild');
  prefetcher.schedule({...track('A'),source:'youtube'},0);await delay(10);
  prefetcher.schedule({...track('B'),source:'youtube'},0);await delay(10);assert.equal(signals[0].aborted,true);assert.equal(signals.length,2);
  prefetcher.cancel();await settle();assert.equal(signals[1].aborted,true);
});
test('background source warmup leaves foreground capacity and is capped globally',async()=>{
  let release,calls=0;
  const pending=new Promise(resolve=>{release=resolve;});
  const resolver={semaphore:{active:0,limit:2},async audio(){calls++;await pending;return {expiresAt:Date.now()+60000};}};
  const audio=new AudioManager(loadConfig({}),resolver,null),item={source:'youtube'};
  const first=audio.prefetch(item,{background:true});assert.equal(await audio.prefetch(item,{background:true}),null);
  const foreground=audio.prefetch(item);release();await Promise.all([first,foreground]);assert.equal(calls,2);
  resolver.semaphore.active=1;assert.equal(await audio.prefetch(item,{background:true}),null);assert.equal(calls,2);
});
