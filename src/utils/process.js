import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { UserError } from './errors.js';
const botCredentials = new Set(['DISCORD_TOKEN', 'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET']);
export function spawnTool(file,args,stdio=['ignore','pipe','pipe']){
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!botCredentials.has(name.toUpperCase())));
  const child=spawn(file,args,{shell:false,windowsHide:true,detached:process.platform!=='win32',stdio,env});
  child.musicProcessGroup=process.platform!=='win32';
  return child;
}
export function killProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if(process.platform==='win32'&&child.pid){
    const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});
    killer.on('error',()=>child.kill());
    killer.on('close',code=>{if(code!==0&&child.exitCode===null)child.kill();});
    return;
  }
  const send=signal=>{try{if(child.musicProcessGroup&&child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch{}};
  send('SIGTERM');
  const timer = setTimeout(() => { if (child.exitCode === null) send('SIGKILL'); }, 1500);
  timer.unref();
}
export function runTool(file, args, { signal, timeoutMs = 45000, maxBytes = 8*1024*1024, allowPartial = false } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawnTool(file,args);
    let stdout = '', stderr = '', bytes = 0, failure, failed=false;
    const decoder = new StringDecoder('utf8');
    const fail = error => { if(failed)return;failed=true;failure=error;killProcess(child); };
    const abort = () => fail(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => fail(new UserError('The media tool timed out. Try a smaller request or another source.','TOOL_TIMEOUT')), timeoutMs);
    timer.unref();
    child.stdout.on('data', data => {
      bytes += data.length;
      if (bytes > maxBytes) fail(new UserError('Metadata exceeded the configured safety limit.','EXTRACTOR'));
      else stdout += decoder.write(data);
    });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4096); });
    child.on('error', error => fail(new UserError(error.code === 'ENOENT' ? `Required tool ${file.split(/[\\/]/).at(-1)} is missing. Check its configured path.` : 'The media tool could not start.', 'TOOL_MISSING')));
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      stdout += decoder.end();
      if (failed) reject(failure);
      else if (code !== 0 && !(allowPartial && stdout.trim())) reject(providerError(stderr));
      else resolve({ stdout, partial: code !== 0 });
    });
  });
}
function providerError(stderr) {
  if (/age.restrict|sign in|login|members.only|private video|not a bot|cookies/i.test(stderr)) return new UserError('This source requires login, age verification, or private access. Choose another permitted public source.','RESTRICTED');
  if (/country|region|geo.restrict/i.test(stderr)) return new UserError('This source is unavailable in the bot’s region. Choose another source.','REGION');
  if (/removed|unavailable|not available|not found/i.test(stderr)) return new UserError('This source is deleted or unavailable. Choose another source.','UNAVAILABLE');
  if (/format/i.test(stderr)) return new UserError('No supported audio format is available. Update yt-dlp or use an authorized local source.','FORMAT');
  return new UserError('The media provider could not supply this source. Update yt-dlp, check network access, or use an authorized local source.','EXTRACTOR');
}
