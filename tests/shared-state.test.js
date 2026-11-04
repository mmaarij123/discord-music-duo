import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SharedMusicState } from '../src/music/SharedMusicState.js';
import { PlaylistStore } from '../src/music/PlaylistStore.js';
import { loadConfig } from '../src/config/config.js';

const run = promisify(execFile);
const user = '111111111111111111';

async function database(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'music-shared-test-'));
  t.after(() => rm(directory, { recursive:true, force:true }));
  return path.join(directory, 'music.sqlite');
}

test('bot profiles use separate settings and the same database path',()=>{
  const a=loadConfig({MUSIC_BOT_PROFILE:'bot1',PREFIX:'>'});
  const b=loadConfig({MUSIC_BOT_PROFILE:'bot2',PREFIX:'!'});
  assert.notEqual(a.settingsFile,b.settingsFile);
  assert.equal(a.sharedDbFile,b.sharedDbFile);
  assert.deepEqual([a.prefix,b.prefix],['>','!']);
});

test('two worker processes write to the same playlist without losing either song', async t => {
  const file = await database(t);
  const state = new SharedMusicState(file);
  const store = new PlaylistStore(null,500,[],state);
  try {
    await store.create(user);
    const id=store.require(user).id;
    const script=`
      import { SharedMusicState } from './src/music/SharedMusicState.js';
      import { PlaylistStore } from './src/music/PlaylistStore.js';
      const [file,user,id,title] = process.argv.slice(1);
      const state=new SharedMusicState(file);
      try {
        const store=new PlaylistStore(null,500,[],state);
        await store.add(user,[{title,source:'local',mediaId:title}],id);
      } finally { state.close(); }
    `;
    await Promise.all(['First','Second'].map(title=>run(process.execPath,[
      '--input-type=module','-e',script,file,user,id,title
    ],{windowsHide:true})));
    assert.deepEqual(store.require(user).tracks.map(track=>track.title).sort(),['First','Second']);
  } finally { state.close(); }
});

test('a cache entry is visible to both connections and cleanup respects the other bot queue', async t => {
  const file=await database(t), a=new SharedMusicState(file), b=new SharedMusicState(file);
  try {
    const first=a.cache('youtube',300000),second=b.cache('youtube',300000);
    first.set('video',{title:'Song'},['video']);
    assert.deepEqual(second.get('video'),{title:'Song'});
    second.tag('video',['playlist-track']);
    b.protect(new Set(['playlist-track']));
    first.markPlayed(['video']);
    assert.equal(first.clearPlayed(new Set()),0);
    assert.ok(second.get('video'));
    b.protect(new Set());
    assert.equal(first.clearPlayed(new Set()),1);
    assert.equal(second.get('video'),undefined);
  } finally { a.close(); b.close(); }
});
