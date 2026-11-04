import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize,scoreTrack,bestMatch } from '../src/music/TrackMatcher.js';
import { normalizeSpotify } from '../src/music/SpotifyResolver.js';
import { normalizeYouTube } from '../src/music/YouTubeResolver.js';
test('normalizes accents, punctuation and whitespace',()=>assert.equal(normalize('  BÉYONCÉ — Halo!  '),'beyonce halo'));
test('retains non-Latin song names',()=>assert.equal(normalize('夜に駆ける！'),'夜に駆ける'));
const target={title:'Until I Found You',artist:'Stephen Sanchez',duration:177};
const official={title:'Stephen Sanchez - Until I Found You (Official Audio)',channel:'Stephen Sanchez',duration:177};
test('prefers official close-duration audio',()=>assert.equal(bestMatch(target,[{...official,title:'Until I Found You Cover'},official]),official));
for(const version of ['Nightcore','Slowed','Sped Up','Cover','Karaoke','Instrumental','Remix','Live','Acoustic']){
  test(`rejects unsolicited ${version}`,()=>assert.equal(scoreTrack(target,{...official,title:`Stephen Sanchez Until I Found You ${version}`}).rejected,true));
}
test('allows requested versions',()=>assert.equal(scoreTrack({...target,title:'Until I Found You acoustic'},{...official,title:'Stephen Sanchez Until I Found You acoustic'}).rejected,false));
test('rejects unrelated first result',()=>assert.throws(()=>bestMatch(target,[{title:'Other song',artist:'Someone Else',duration:177}]),/No matching track/));
test('rejects wrong duration and artist',()=>{
  assert.equal(scoreTrack(target,{title:'Until I Found You',artist:'Other',duration:900}).rejected,true);
});
test('Spotify embed and API metadata normalize consistently',()=>{
  const a=normalizeSpotify({title:'Song',subtitle:'Artist',duration:180000,uri:'spotify:track:1234567890123456789012'});
  const b=normalizeSpotify({name:'Song',artists:[{name:'Artist'}],duration_ms:180000,id:'1234567890123456789012'});
  assert.equal(a.title,b.title);assert.equal(a.artist,b.artist);assert.equal(a.duration,180);assert.equal(a.sourceUrl,b.sourceUrl);
});
test('Spotify collection context fills album and artwork',()=>{
  const t=normalizeSpotify({title:'Song',subtitle:'Artist'},{album:'Album',artwork:'https://example.org/art.jpg'});
  assert.equal(t.album,'Album');assert.equal(t.artwork,'https://example.org/art.jpg');assert.equal(t.duration,undefined);
});
test('incomplete Spotify metadata is omitted',()=>{assert.equal(normalizeSpotify({name:'Song'}),null);assert.equal(normalizeSpotify(null),null);});
test('YouTube normalization rejects malformed IDs and marks live',()=>{
  assert.equal(normalizeYouTube({id:'bad',title:'Title'}),null);
  assert.equal(normalizeYouTube({id:'abcdefghijk',title:'Title',live_status:'is_live'}).live,true);
});
