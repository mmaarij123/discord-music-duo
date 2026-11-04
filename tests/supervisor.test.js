import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Supervisor } from '../src/runtime/Supervisor.js';
import { RESTART_EXIT_CODE } from '../src/runtime/ProcessLifecycle.js';
import { logger } from './helpers.js';

test('PM2 directly supervises the worker and respects intentional shutdown exit status',()=>{
  const config=createRequire(import.meta.url)('../ecosystem.config.cjs').apps[0];
  assert.equal(config.script,'src/index.js');assert.deepEqual(config.stop_exit_codes,[0]);
  assert.equal(config.env.MUSIC_BOT_SUPERVISED,'pm2');assert.equal(config.instances,1);
  assert.equal(config.max_memory_restart,'512M');assert.ok(config.kill_timeout>10000);
});

function harness(t){
  t.mock.timers.enable({apis:['setTimeout']});
  const children=[],exits=[],kills=[],errors=[];
  const supervisor=new Supervisor({entry:'bot.js',logger:{...logger,error:(event,fields)=>errors.push({event,...fields})},onExit:code=>exits.push(code),killChild:child=>{kills.push(child);child.emit('close',1);},forkChild:(_file,_args,options)=>{
    assert.equal(options.env.MUSIC_BOT_SUPERVISED,'1');assert.deepEqual(options.execArgv,[]);
    const child=new EventEmitter();child.connected=true;child.messages=[];child.send=(message,callback)=>{child.messages.push(message);callback(null);};children.push(child);return child;
  }});
  supervisor.start();return {supervisor,children,exits,kills,errors};
}

test('explicit restart starts one replacement child after the previous child closes',t=>{
  const f=harness(t);f.children[0].emit('close',RESTART_EXIT_CODE);
  assert.equal(f.children.length,1);t.mock.timers.tick(500);assert.equal(f.children.length,2);assert.deepEqual(f.exits,[]);
  f.children[1].emit('close',0);t.mock.timers.tick(5000);assert.deepEqual(f.exits,[0]);assert.equal(f.children.length,2);
});

for(const code of [0,1,null])test(`exit ${code} never causes an automatic restart loop`,t=>{
  const f=harness(t),signal=code===null?'SIGTERM':null;f.children[0].emit('close',code,signal);t.mock.timers.tick(5000);
  assert.equal(f.children.length,1);assert.deepEqual(f.exits,[code===0?0:1]);
  assert.deepEqual(f.errors,code===0?[]:[{event:'bot_process_exited',exitCode:1,signal}]);
});

test('stopping during a restart delay cancels the replacement child',t=>{
  const f=harness(t);f.children[0].emit('close',RESTART_EXIT_CODE);f.supervisor.stop();t.mock.timers.tick(5000);
  assert.equal(f.children.length,1);assert.deepEqual(f.exits,[0]);
});

test('supervisor stop asks for graceful cleanup once through the private IPC channel',t=>{
  const f=harness(t);f.supervisor.stop();f.supervisor.stop();
  assert.deepEqual(f.children[0].messages,[{type:'music:shutdown'}]);
  f.children[0].emit('close',RESTART_EXIT_CODE);t.mock.timers.tick(15000);
  assert.deepEqual(f.exits,[0]);assert.equal(f.children.length,1);assert.equal(f.kills.length,0);
});

test('an unresponsive child has a bounded stop deadline',t=>{
  const f=harness(t);f.supervisor.stop();t.mock.timers.tick(12000);
  assert.equal(f.kills.length,1);assert.deepEqual(f.exits,[0]);
});

test('a closed IPC channel falls back to scoped child cleanup',t=>{
  const f=harness(t);f.children[0].send=()=>{throw Error('IPC closed');};f.supervisor.stop();
  assert.equal(f.kills.length,1);assert.deepEqual(f.exits,[0]);
});

test('failed child creation exits with an error without retrying',()=>{
  const exits=[];let calls=0;
  const supervisor=new Supervisor({entry:'bot.js',logger,onExit:code=>exits.push(code),forkChild:()=>{calls++;throw Error('spawn failed');}});
  supervisor.start();supervisor.start();assert.deepEqual(exits,[1]);assert.equal(calls,1);
});

test('real fork replaces the worker on restart and stays stopped on normal shutdown',{timeout:10000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'music-supervisor-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const entry=path.join(directory,'worker.cjs'),counter=path.join(directory,'count.txt');
  await writeFile(entry,`const fs=require('node:fs');const file=${JSON.stringify(counter)};const count=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0;fs.writeFileSync(file,String(count+1));process.exit(count===0?${RESTART_EXIT_CODE}:0);`);
  let finish;const done=new Promise(resolve=>{finish=resolve;});
  const supervisor=new Supervisor({entry,logger,onExit:finish,restartDelayMs:20});t.after(()=>supervisor.stop());
  supervisor.start();assert.equal(await done,0);assert.equal(await readFile(counter,'utf8'),'2');assert.equal(supervisor.child,null);
});

test('real worker receives graceful stop without creating a replacement',{timeout:10000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'music-supervisor-stop-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const entry=path.join(directory,'worker.cjs');
  await writeFile(entry,"process.on('message',message=>{if(message.type==='music:shutdown')process.exit(0);});process.send({ready:true});");
  let finish;const done=new Promise(resolve=>{finish=resolve;});
  const supervisor=new Supervisor({entry,logger,onExit:finish});t.after(()=>supervisor.stop());
  supervisor.start();await once(supervisor.child,'message');supervisor.stop();assert.equal(await done,0);assert.equal(supervisor.child,null);
});
