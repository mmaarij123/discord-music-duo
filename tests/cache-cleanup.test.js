import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TTLCache, startCacheCleanup, CACHE_CLEANUP_INTERVAL_MS } from '../src/utils/cache.js';
import { MusicManager } from '../src/music/MusicManager.js';
import { loadConfig } from '../src/config/config.js';
import { cacheTrackKeys } from '../src/music/TrackMatcher.js';
import { logger } from './helpers.js';

test('automatic cleanup removes played entries every two and a half minutes', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const cache = new TTLCache(900000);
  const stop = startCacheCleanup(() => cache.clearPlayed(new Set()));
  t.after(stop);
  cache.set('played', 'Old song', ['played']);
  cache.set('unused', 'Unplayed search', ['unused']);
  cache.markPlayed(['played']);
  assert.equal(CACHE_CLEANUP_INTERVAL_MS, 150000);
  t.mock.timers.tick(149999);
  assert.equal(cache.get('played'), 'Old song');
  t.mock.timers.tick(1);
  assert.equal(cache.get('played'), undefined);
  assert.equal(cache.get('unused'), 'Unplayed search');
});

test('stopping cleanup cancels subsequent periodic clears', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const cache = new TTLCache(900000), stop = startCacheCleanup(() => cache.clearPlayed(new Set()));
  stop();
  stop();
  cache.set('kept', 'Result', ['kept']);
  cache.markPlayed(['kept']);
  t.mock.timers.tick(150000);
  assert.equal(cache.get('kept'), 'Result');
});

test('production cleanup protects shared entries used by current or upcoming tracks across guilds', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'music-cache-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const manager = await MusicManager.create({
    ...loadConfig({ SPOTIFY_CLIENT_ID: 'test-client', SPOTIFY_CLIENT_SECRET: 'test-secret' }),
    settingsFile: path.join(directory, 'settings.json')
  }, logger);
  t.after(() => manager.destroy());
  const youtube = manager.discovery.youtube, spotify = manager.discovery.spotify;
  const caches = [youtube.cache, youtube.sourceCache, spotify.cache, spotify.searchAdapter.cache];
  assert.equal(new Set(manager.caches).size, 4);
  const old = { title: 'Played song', artist: 'Artist' };
  const current = { title: 'Current song', artist: 'Artist' };
  const next = { title: 'Next song', artist: 'Artist' };
  const queue = { tracks: [next] };
  let disposed = false;
  const handle = { dispose() { disposed = true; } };
  manager.audio.handles.add(handle);
  manager.players.set('guild', { current, queue, destroy: async () => {} });
  manager.players.set('other', { current: old, queue: { tracks: [] }, destroy: async () => {} });
  for (const cache of caches) {
    cache.set('old', 'played alone', cacheTrackKeys(old));
    cache.set('shared', 'shared playlist', [old, next].flatMap(cacheTrackKeys));
    cache.set('current', 'current', cacheTrackKeys(current));
    cache.set('next', 'upcoming', cacheTrackKeys(next));
  }
  manager.markTrackPlayed(old);
  manager.markTrackPlayed(current);
  t.mock.timers.tick(150000);
  for (const cache of caches) assert.equal(cache.items.size, 4);
  manager.players.delete('other');
  assert.equal(manager.clearCaches(), 4);
  for (const cache of caches) {
    assert.equal(cache.get('old'), undefined);
    assert.equal(cache.get('current'), 'current');
    assert.equal(cache.get('next'), 'upcoming');
    assert.equal(cache.get('shared'), 'shared playlist');
  }
  assert.equal(manager.players.get('guild').current, current);
  assert.equal(manager.players.get('guild').queue, queue);
  assert.equal(manager.audio.handles.has(handle), true);
  assert.equal(disposed, false);
  for (const cache of caches) cache.set('refilled', 'Result');
  await manager.destroy();
  assert.equal(disposed, true);
  for (const cache of caches) {
    assert.equal(cache.items.size, 0);
    cache.set('after-shutdown', 'Result');
  }
  t.mock.timers.tick(150000);
  assert.equal(youtube.cache.get('after-shutdown'), 'Result');
});

test('a Spotify track protects its prefetched YouTube source before it starts playing',async t=>{
  const manager=await MusicManager.create(loadConfig({}),logger);
  t.after(()=>manager.destroy());
  const youtube=manager.discovery.youtube;
  youtube.json=async args=>({data:args.at(-1).startsWith('ytsearch')
    ?{entries:[{id:'abcdefghijk',title:'Artist Song'}]}
    :{id:'abcdefghijk',title:'Artist Song',duration:180,url:'https://r1.googlevideo.com/audio'}});
  const next={title:'Song',artist:'Artist',source:'spotify',sourceUrl:'https://open.spotify.com/track/1234567890123456789012'};
  const audio=await youtube.audio(next);
  manager.markTrackPlayed(audio.match);
  manager.players.set('guild',{current:null,queue:{tracks:[next]},destroy:async()=>{}});
  assert.equal(manager.clearCaches(),0);
  assert.equal(youtube.sourceCache.get('audio:abcdefghijk').duration,180);
  manager.players.get('guild').queue.tracks.length=0;
  assert.equal(manager.clearCaches(),2);
  assert.equal(youtube.sourceCache.get('audio:abcdefghijk'),undefined);
});
