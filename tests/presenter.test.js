import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerPresenter } from '../src/components/PlayerPresenter.js';
import { fixture,logger,track,flattenComponents } from './helpers.js';
test('deleted message leaves playback active and can be rebound',async t=>{
  const f=fixture(),presenter=new PlayerPresenter(f.player,logger);t.after(async()=>{await f.player.destroy();await presenter.dispose();});
  await f.player.enqueue([track('A')],f.channel);
  presenter.channel={send:async()=>({id:'message',edit:async()=>{const error=Error('deleted');error.code=10008;throw error;}})};
  await presenter.render();await presenter.render();assert.equal(f.player.current.title,'A');assert.equal(f.player.state,'playing');assert.equal(presenter.channel,null);
  let sent=0;presenter.bind({send:async()=>{sent++;return {id:'new',edit:async()=>{}};}});await presenter.render();assert.equal(sent,1);
});
test('coalesces frequent changes into one scheduled edit',async t=>{
  const f=fixture(),presenter=new PlayerPresenter(f.player,logger);t.after(async()=>{await f.player.destroy();await presenter.dispose();});
  let sent=0;presenter.bind({send:async()=>{sent++;return {edit:async()=>{sent++;}};}});
  for(let i=0;i<50;i++)f.player.changed();await new Promise(resolve=>{setTimeout(resolve,130);});assert.equal(sent,1);
});

test('disposal flushes the latest pending notice to logs once and ignores later notices',async t=>{
  const f=fixture(),presenter=new PlayerPresenter(f.player,logger),messages=[];
  t.after(()=>f.player.destroy());
  presenter.channel={send:()=>assert.fail('notice must use log channel')};
  presenter.setNoticeChannel({send:async payload=>{messages.push(payload);}});
  presenter.notice('Earlier notice');presenter.notice('Disconnected from voice');
  await presenter.dispose();await presenter.dispose();presenter.notice('Late notice');
  assert.equal(messages.length,1);assert.equal(messages[0].content,'Disconnected from voice');
  assert.equal(presenter.pendingNotice,null);assert.equal(presenter.noticeTimer,null);
});

test('a notice already delivered by its timer is not repeated on disposal',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(),presenter=new PlayerPresenter(f.player,logger),messages=[];
  t.after(()=>f.player.destroy());
  presenter.setNoticeChannel({send:async payload=>{messages.push(payload);}});
  presenter.notice('Voice connection lost');t.mock.timers.tick(3000);
  await presenter.dispose();
  assert.equal(messages.length,1);assert.equal(presenter.pendingNotice,null);
});

test('failed final notice cannot prevent player controls from being cleaned up',async t=>{
  const f=fixture(),warnings=[],presenter=new PlayerPresenter(f.player,{...logger,warn:event=>warnings.push(event)});
  t.after(()=>f.player.destroy());
  let disabled=false;
  presenter.message={edit:async payload=>{disabled=!flattenComponents(payload).some(component=>component.type===2);}};
  presenter.setNoticeChannel({send:async()=>{throw Error('Missing access');}});
  presenter.notice('Disconnected from voice');await presenter.dispose();
  assert.deepEqual(warnings,['notice_failed']);assert.equal(disabled,true);
  assert.equal(f.player.listenerCount('notice'),0);
});
