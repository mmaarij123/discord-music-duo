import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInput,spotifyUrl,youtubeUrl,integer } from '../src/utils/validators.js';
import { loadConfig,requireDiscord } from '../src/config/config.js';
import { commands } from '../src/commands/definitions.js';
test('accepts valid supported URLs and strips untrusted query parameters',()=>{
  assert.equal(spotifyUrl('https://open.spotify.com/intl-en/track/1234567890123456789012?si=a').type,'track');
  assert.equal(youtubeUrl('https://youtu.be/abcdefghijk?t=3').url,'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(youtubeUrl('https://www.youtube.com/playlist?list=PL12345678901').type,'playlist');
});
for(const url of ['https://youtube.com.evil.test/watch?v=abcdefghijk','http://youtube.com/watch?v=abcdefghijk','https://user:password@youtube.com/watch?v=abcdefghijk','https://youtube.com:8080/watch?v=abcdefghijk','https://127.0.0.1/a','file:///etc/passwd','local:../secret','https://open.spotify.com/track/bad']){
  test(`rejects unsafe input ${url}`,()=>assert.throws(()=>classifyInput(url)));
}
test('classifies searches and media IDs',()=>{assert.equal(classifyInput('Artist Song').type,'search');assert.deepEqual(classifyInput('local:demo'),{type:'local',id:'demo'});});
test('rejects empty, oversized and control-character input',()=>{for(const q of ['', 'a'.repeat(501),'a\nb'])assert.throws(()=>classifyInput(q));});
test('integer options reject fractions and invalid positions',()=>{for(const n of [0,2.5,NaN,11])assert.throws(()=>integer(n,1,10));});
test('configuration validates bounds, booleans and secrets',()=>{
  assert.equal(loadConfig({}).volume,70);assert.equal(loadConfig({}).autoplay,false);
  for(const env of [{DEFAULT_VOLUME:'101'},{MAX_QUEUE_LENGTH:'0'},{AUTOPLAY_ENABLED:'yes'},{LOG_LEVEL:'trace'}])assert.throws(()=>loadConfig(env));
  assert.throws(()=>requireDiscord(loadConfig({})),/DISCORD_TOKEN/);
});
test('all 22 prefix commands have unique names and bounded arguments',()=>{
  assert.equal(commands.length,22);assert.equal(new Set(commands.map(c=>c.name)).size,22);
  assert.equal(commands.find(c=>c.name==='volume').args[0].max,100);
});
