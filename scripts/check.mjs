import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
async function files(directory) {
  const result=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const file=join(directory,entry.name);
    if(entry.isDirectory()) result.push(...await files(file));
    else if(/\.(mjs|cjs)$/.test(file)) result.push(file);
  }
  return result;
}
let count=0;
for(const directory of ['src','scripts','test']) for(const file of await files(directory)) {
  const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit',windowsHide:true});
  if(result.status!==0) process.exit(result.status??1);
  count++;
}
console.log(`Syntax checked ${count} JavaScript files.`);
