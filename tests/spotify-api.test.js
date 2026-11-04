import test from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyApi } from '../src/music/SpotifyApi.js';
import { SpotifyResolver } from '../src/music/SpotifyResolver.js';
import { loadConfig } from '../src/config/config.js';
import { Semaphore } from '../src/utils/async.js';

const credentials={clientId:'test-id',clientSecret:'test-secret'};
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
const token=(name='access-one')=>json({access_token:name,token_type:'Bearer',expires_in:3600});
const song=(name='Song',artist='Artist')=>({id:'1234567890123456789012',type:'track',name,artists:[{name:artist}],duration_ms:180000,album:{name:'Album',images:[{url:'https://example.org/art.jpg'}]},external_urls:{spotify:'https://open.spotify.com/track/1234567890123456789012'}});
const catalog=(items=[song()])=>json({tracks:{items}});
const isToken=url=>url==='https://accounts.spotify.com/api/token';

test('official client sends Client Credentials only to Spotify token endpoint and uses Bearer for search',async()=>{
  const calls=[];
  const api=new SpotifyApi({...credentials,market:'PK'},{fetchImpl:async(url,options)=>{calls.push({url,options});return isToken(url)?token():catalog();}});
  const result=await api.search('Artist Song');
  assert.equal(result.name,'Song');assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].options.body.get('grant_type'),'client_credentials');
  assert.equal(calls[0].options.headers.Authorization,`Basic ${Buffer.from('test-id:test-secret').toString('base64')}`);
  assert.equal(calls[1].options.headers.Authorization,'Bearer access-one');assert.equal(calls[1].options.redirect,'error');
  const search=new URL(calls[1].url);assert.equal(search.hostname,'api.spotify.com');assert.equal(search.searchParams.get('type'),'track');assert.equal(search.searchParams.get('limit'),'5');assert.equal(search.searchParams.get('market'),'PK');
});
test('access tokens and successful search results are cached without exposing credentials',async()=>{
  let auth=0,search=0;
  const api=new SpotifyApi(credentials,{fetchImpl:async url=>{if(isToken(url)){auth++;return token();}search++;return catalog();}});
  const first=await api.search('Song');first.name='changed';assert.equal((await api.search('Song')).name,'Song');await api.search('Artist Song');
  assert.equal(auth,1);assert.equal(search,2);assert.ok(!JSON.stringify(api).includes('test-secret'));assert.ok(!JSON.stringify(api).includes('access-one'));
});
test('ranking rejects an unsolicited cover even when Spotify returns it first',async()=>{
  const api=new SpotifyApi(credentials,{fetchImpl:async url=>isToken(url)?token():catalog([song('Song Cover'),song('Song')])});
  assert.equal((await api.search('Artist Song')).name,'Song');
});
test('unrelated and empty Spotify catalogs return null instead of fabricated results',async()=>{
  const api=new SpotifyApi(credentials,{fetchImpl:async url=>isToken(url)?token():catalog([song('Different','Other')])});
  assert.equal(await api.search('Artist Song'),null);
});
test('concurrent metadata requests share one token acquisition',async()=>{
  let release,auth=0;
  const pending=new Promise(resolve=>{release=resolve;});
  const api=new SpotifyApi(credentials,{fetchImpl:async url=>{if(isToken(url)){auth++;await pending;return token();}return catalog();}});
  const a=api.search('Song'),b=api.search('Artist Song');release();await Promise.all([a,b]);assert.equal(auth,1);
});
test('cancelling one token waiter does not cancel another caller',async()=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const api=new SpotifyApi(credentials,{fetchImpl:async()=>{await pending;return token();}});
  const controller=new AbortController(),a=api.getAccessToken(controller.signal),b=api.getAccessToken();controller.abort();await assert.rejects(a,{name:'AbortError'});release();assert.equal(await b,'access-one');
});
test('expired tokens are replaced before subsequent calls',async()=>{
  let now=1000,auth=0;
  const api=new SpotifyApi(credentials,{now:()=>now,fetchImpl:async url=>{if(isToken(url)){auth++;return token(`access-${auth}`);}return catalog();}});
  await api.search('Song');now+=3600000;await api.search('Artist Song');assert.equal(auth,2);
});
test('a rejected access token is refreshed once with no uncontrolled retries',async()=>{
  let auth=0,search=0;
  const api=new SpotifyApi(credentials,{fetchImpl:async url=>{if(isToken(url)){auth++;return token(`access-${auth}`);}search++;return search===1?json({},401):catalog();}});
  assert.equal((await api.search('Song')).name,'Song');assert.equal(auth,2);assert.equal(search,2);
});
test('persistent token rejection stops after the one refresh attempt',async()=>{
  let auth=0,search=0;
  const api=new SpotifyApi(credentials,{fetchImpl:async url=>{if(isToken(url)){auth++;return token();}search++;return json({},401);}});
  await assert.rejects(api.search('Song'),{code:'SPOTIFY_TOKEN_EXPIRED'});assert.equal(auth,2);assert.equal(search,2);
});
test('invalid credentials and denied app access give safe explicit errors',async()=>{
  const bad=new SpotifyApi(credentials,{fetchImpl:async()=>json({error:'invalid_client',detail:'test-secret'},400)});
  await assert.rejects(bad.getAccessToken(),error=>error.code==='SPOTIFY_AUTH'&&!error.message.includes('test-secret'));
  let calls=0;
  const denied=new SpotifyApi(credentials,{fetchImpl:async url=>{calls++;return isToken(url)?token():json({},403);}});
  await assert.rejects(denied.search('Song'),{code:'SPOTIFY_ACCESS'});assert.equal(calls,2);
});
test('429 honors Retry-After locally instead of repeatedly hitting Spotify',async()=>{
  let now=0,search=0;
  const api=new SpotifyApi(credentials,{now:()=>now,fetchImpl:async url=>{if(isToken(url))return token();search++;return search===1?json({},429,{'retry-after':'60'}):catalog();}});
  await assert.rejects(api.search('Song'),{code:'SPOTIFY_RATE_LIMIT'});
  await assert.rejects(api.search('Artist Song'),error=>error.code==='SPOTIFY_RATE_LIMIT'&&error.retryAfterSeconds===60);assert.equal(search,1);
  now=60001;assert.equal((await api.search('Artist Song')).name,'Song');assert.equal(search,2);
});
test('malformed responses cannot expose raw token response bodies',async()=>{
  const api=new SpotifyApi(credentials,{fetchImpl:async()=>new Response('not-json test-secret access-one')});
  await assert.rejects(api.getAccessToken(),error=>error.code==='SPOTIFY_RESPONSE'&&!error.message.includes('test-secret')&&!error.message.includes('access-one'));
});
test('official metadata normalizes through the existing Spotify resolver and failures retain fallback',async()=>{
  const config=loadConfig({});
  const api=new SpotifyApi(credentials,{fetchImpl:async url=>isToken(url)?token():catalog()});
  const resolver=new SpotifyResolver(config,new Semaphore(2),api);
  const result=await resolver.search('Artist Song');assert.equal(result.track.source,'spotify');assert.equal(result.track.duration,180);assert.equal(result.track.album,'Album');
  const failing=new SpotifyResolver(config,new Semaphore(2),new SpotifyApi(credentials,{fetchImpl:async()=>json({},403)}));
  const fallback=await failing.search('Song');assert.equal(fallback.track,null);assert.match(fallback.notice,/denied access/);
});
test('Spotify configuration remains optional and validates only the optional market format',()=>{
  assert.deepEqual(loadConfig({}).spotify,{clientId:'',clientSecret:'',market:''});
  assert.equal(loadConfig({SPOTIFY_MARKET:'pk'}).spotify.market,'PK');assert.throws(()=>loadConfig({SPOTIFY_MARKET:'Pakistan'}),/SPOTIFY_MARKET/);
  assert.throws(()=>new SpotifyApi({clientId:'only-id'}),{code:'SPOTIFY_CONFIG'});
});
