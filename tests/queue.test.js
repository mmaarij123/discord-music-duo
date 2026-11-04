import test from 'node:test';
import assert from 'node:assert/strict';
import { QueueManager } from '../src/music/QueueManager.js';
import { track } from './helpers.js';
test('queue insertion caps memory and reports omitted entries',()=>{
  const q=new QueueManager(2);assert.deepEqual(q.add([track('A'),track('B'),track('C')]),{added:2,omitted:1});assert.equal(q.take().title,'A');
});
test('removing a track preserves one-based queue positions and remaining order',()=>{
  const q=new QueueManager();q.add(['A','B','C','D'].map(track));
  assert.equal(q.remove(2).title,'B');assert.deepEqual(q.tracks.map(t=>t.title),['A','C','D']);
  assert.equal(q.remove(3).title,'D');assert.deepEqual(q.tracks.map(t=>t.title),['A','C']);assert.throws(()=>q.remove(100));
});
test('repeat modes distinguish queue completion from track repeat',()=>{
  const q=new QueueManager();q.complete(track('A'));assert.equal(q.length,0);q.setLoop('queue');q.complete(track('B'));assert.equal(q.take().title,'B');
  q.setLoop('track');q.complete(track('C'));assert.equal(q.length,0);assert.throws(()=>q.setLoop('invalid'));
});
test('shuffle preserves all track identities and can change order',()=>{
  const q=new QueueManager();const tracks=['A','B','C','D'].map(track);q.add(tracks);q.shuffle(()=>0);
  assert.deepEqual(new Set(q.tracks),new Set(tracks));assert.notDeepEqual(q.tracks,tracks);
});
test('history stays bounded for autoplay while internal queue cleanup clears upcoming tracks',()=>{
  const q=new QueueManager(1);for(let i=0;i<100;i++)q.remember(track(String(i)));assert.equal(q.history.length,50);
  assert.equal(q.history.at(-1).title,'99');q.add([track('Upcoming')]);q.clear();assert.equal(q.length,0);assert.equal(q.history.length,50);
});
