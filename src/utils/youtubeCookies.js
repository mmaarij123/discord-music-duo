import path from 'node:path';
import { createHash } from 'node:crypto';
import { open,realpath,mkdtemp,writeFile,rm,chmod,rename } from 'node:fs/promises';
import { UserError } from './errors.js';

const MAX_BYTES=1024*1024;
const inside=(directory,file)=>{const relative=path.relative(directory,file);return relative!==''&&!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative);};
const invalid=()=>new UserError('YouTube cookies must be a Netscape-format export containing only youtube.com cookies. Cookie values must never be pasted into chat.','COOKIE_CONFIG');

export function validateYouTubeCookies(text,now=Date.now()) {
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/);
  if(!/^# (?:Netscape )?HTTP Cookie File\s*$/.test(lines[0]??'')||text.includes('\0'))throw invalid();
  let count=0,usable=0;
  for(const line of lines.slice(1)){
    if(!line.trim()||(line.startsWith('#')&&!line.startsWith('#HttpOnly_')))continue;
    const cells=line.replace(/^#HttpOnly_/,'').split('\t');
    if(cells.length!==7)throw invalid();
    const [domain,subdomains,cookiePath,secure,expiry,name,value]=cells;
    const hostname=domain.replace(/^\./,'').toLowerCase();
    if(!(hostname==='youtube.com'||hostname.endsWith('.youtube.com'))||/[\s/:]/.test(hostname)
      ||!['TRUE','FALSE'].includes(subdomains)||!['TRUE','FALSE'].includes(secure)
      ||!cookiePath.startsWith('/')||/[\r\n\x00-\x1f]/.test(cookiePath)
      ||!/^\d+$/.test(expiry)||!Number.isSafeInteger(Number(expiry))
      ||! /^[!#$%&'*+.^_`|~\w-]+$/.test(name)||/[\r\n\x00-\x1f]/.test(value))throw invalid();
    count++;if(Number(expiry)===0||Number(expiry)*1000>now)usable++;
  }
  if(!count)throw invalid();
  if(!usable)throw new UserError('All cookies in the YouTube cookie file have expired. Replace the local export.','COOKIE_EXPIRED');
  return {count,usable};
}

async function readCookieText(config,filePath) {
  let file;
  try{
    const [root,project,target]=await Promise.all([realpath(config.cookiesRoot),realpath(config.projectRoot),realpath(filePath)]);
    if(!inside(project,root)||!inside(root,target))throw invalid();
    file=await open(target,'r');
    const stats=await file.stat();
    if(!stats.isFile()||stats.size>MAX_BYTES)throw invalid();
    // Read at most 1 MiB, including when another process replaces/grows the export.
    const bytes=Buffer.alloc(MAX_BYTES+1),{bytesRead}=await file.read(bytes,0,bytes.length,0);
    if(bytesRead>MAX_BYTES)throw invalid();
    const text=bytes.subarray(0,bytesRead).toString('utf8').replace(/^\uFEFF/,'');
    return {text,root};
  }catch(error){
    if(error instanceof UserError)throw error;
    throw new UserError('The configured YouTube cookie file cannot be read. Save the export inside the project secrets folder and check its permissions.','COOKIE_CONFIG');
  }finally{await file?.close();}
}

async function readCookies(config){
  if(!config.youtubeCookiesFile)return null;
  const value=await readCookieText(config,config.youtubeCookiesFile);
  return {...value,...validateYouTubeCookies(value.text)};
}

export function convertYouTubeCookieJson(raw){
  const rows=Array.isArray(raw)?raw:raw?.cookies;
  if(!Array.isArray(rows)||!rows.length)throw new UserError('The JSON cookie export is empty or unsupported. Save your YouTube cookie array in secrets/youtube.cookies.json.','COOKIE_CONFIG');
  const lines=rows.map(cookie=>{
    if(!cookie||typeof cookie.domain!=='string'||typeof cookie.name!=='string'||typeof cookie.value!=='string')throw invalid();
    const expiry=cookie.session===true?0:Number(cookie.expirationDate??cookie.expires??cookie.expiry??0);
    if(!Number.isFinite(expiry)||expiry<0)throw invalid();
    return [(cookie.httpOnly?'#HttpOnly_':'')+cookie.domain,cookie.hostOnly===true?'FALSE':cookie.domain.startsWith('.')?'TRUE':'FALSE',cookie.path??'/',cookie.secure?'TRUE':'FALSE',Math.floor(expiry),cookie.name,cookie.value].join('\t');
  });
  const text='# Netscape HTTP Cookie File\n'+lines.join('\n')+'\n';
  return {text,...validateYouTubeCookies(text)};
}

export async function importYouTubeCookieJson(config){
  const input=await readCookieText(config,path.join(config.cookiesRoot,'youtube.cookies.json'));
  let raw;try{raw=JSON.parse(input.text);}catch{throw new UserError('The local cookie JSON is invalid. No cookie values are displayed.','COOKIE_CONFIG');}
  const converted=convertYouTubeCookieJson(raw);
  const directory=await mkdtemp(path.join(input.root,'.yt-cookies-import-'));
  if(!inside(input.root,directory))throw invalid();
  try{
    await chmod(directory,0o700);
    const temporary=path.join(directory,'cookies.txt');
    await writeFile(temporary,converted.text,{mode:0o600,flag:'wx'});
    await rename(temporary,path.join(input.root,'youtube.cookies.txt'));
    return {count:converted.count,usable:converted.usable};
  }finally{await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
}

export async function inspectYouTubeCookies(config) {
  const cookies=await readCookies(config);
  return cookies?{enabled:true,count:cookies.count,usable:cookies.usable}:{enabled:false};
}

export async function youtubeCacheScope(config) {
  const cookies=await readCookies(config);
  return cookies ? createHash('sha256').update(cookies.text).digest('hex') : 'public';
}

export async function withYouTubeCookies(config,operation,signal) {
  signal?.throwIfAborted();
  const cookies=await readCookies(config);
  if(!cookies)return operation([]);
  signal?.throwIfAborted();
  // yt-dlp writes its cookie jar on exit. Isolate each request so concurrent
  // guilds never overwrite the user's original export or each other's jar.
  const directory=await mkdtemp(path.join(cookies.root,'.yt-cookies-'));
  if(!inside(cookies.root,directory)||!path.basename(directory).startsWith('.yt-cookies-'))throw invalid();
  try{
    await chmod(directory,0o700);
    const file=path.join(directory,'cookies.txt');
    await writeFile(file,cookies.text,{mode:0o600});
    signal?.throwIfAborted();
    return await operation(['--cookies',file]);
  }finally{
    await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
}
