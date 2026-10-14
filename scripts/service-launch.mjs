#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {stat,readFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
const folder=resolve(process.argv[2] || '.');
const exists=async file=>{try{return (await stat(file)).isFile();}catch{return false;}};
let args;
if(await exists(join(folder,'scripts/launch.mjs'))) {
  console.log('[卫戍中枢] 使用项目官方启动流程：准备依赖与资源 → 启动服务');
  args=[join(folder,'scripts/launch.mjs'),'--no-open',...process.argv.slice(3)];
} else {
  const pkg=JSON.parse(await readFile(join(folder,'package.json'),'utf8'));
  if(!pkg.scripts?.start)throw new Error('项目没有官方启动器或 npm start 脚本');
  let npm;
  for(const candidate of [process.env.npm_execpath,join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),'/usr/share/nodejs/npm/bin/npm-cli.js','/usr/local/lib/node_modules/npm/bin/npm-cli.js'])if(candidate&&await exists(candidate)){npm=candidate;break;}
  if(!npm)throw new Error('找不到 npm CLI');
  args=[npm,'run','start','--',...process.argv.slice(3)];
}
const child=spawn(process.execPath,args,{cwd:folder,env:{...process.env,SP_NO_BROWSER:'1'},windowsHide:true,stdio:'inherit'});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code ?? (signal?1:0);});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(process.platform==='win32')child.kill(signal);});
