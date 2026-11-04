import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { root } from '../src/config/config.js';
async function check(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    if(['node_modules','.git','media','secrets'].includes(entry.name))continue;
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())await check(file);
    else if(/\.(?:js|cjs)$/.test(file)){
      const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit',shell:false,windowsHide:true});
      if(result.status!==0)process.exitCode=1;
    }
  }
}
await check(root);
if(!process.exitCode)console.log('All JavaScript files passed syntax checks.');
