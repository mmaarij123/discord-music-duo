import { readFile,writeFile,rename,rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadConfig } from '../src/config/config.js';
import { importYouTubeCookieJson } from '../src/utils/youtubeCookies.js';
import { publicError } from '../src/utils/errors.js';

try{
  const config=loadConfig(),envFile=path.join(config.projectRoot,'.env');
  // Check configuration is available before changing any credential export.
  const original=await readFile(envFile,'utf8');
  const result=await importYouTubeCookieJson(config);
  const line='YOUTUBE_COOKIES_FILE=./secrets/youtube.cookies.txt',newline=original.includes('\r\n')?'\r\n':'\n';
  const setting=/^[ \t]*(?:export[ \t]+)?YOUTUBE_COOKIES_FILE[ \t]*=[^\r\n]*$/gm;
  const updated=setting.test(original)
    ?original.replace(setting,line)
    :original.replace(/\s*$/,'')+newline+line+newline;
  const temporary=path.join(config.projectRoot,`.env.cookies-${randomUUID()}.tmp`);
  try{
    await writeFile(temporary,updated,{mode:0o600,flag:'wx'});
    await rename(temporary,envFile);
  }finally{
    await rm(temporary,{force:true}).catch(()=>{});
  }
  console.log(`Imported ${result.count} YouTube cookies and enabled the local export. No cookie values displayed.`);
  console.log('Restart the bot to load the replacement and clear cached sources.');
}catch(error){console.error(`Cookie import failed: ${publicError(error)}`);process.exitCode=1;}
