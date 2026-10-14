import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ServiceController} from '../src/services.js';
import {validateConfig} from '../src/core.js';
test('systemd 读取状态与启停使用独立参数，未找到和非 Linux 降级',async()=>{
 const calls=[];
 const runner=async(command,args)=>{calls.push({command,args});return {stdout:'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nDescription=Test service\nWorkingDirectory=/home/ecs-user/Stronghold-Protocol\nEnvironment=PORT=3250 HOST=0.0.0.0\nExecStart=/home/ecs-user/.nvm/versions/node/v24.21.0/bin/node server/index.js\n'};};
 const c=new ServiceController('.', '.',runner,'linux'),s={id:'unit',systemd:{unit:'stronghold.service',sudo:true}};
 validateConfig({servers:[s]});
 const unified=validateConfig({servers:[{id:'unified',source:'stronghold.service',sudo:true},{id:'folder',source:'../local'}]});
 assert.equal(unified.servers[0].systemd.unit,'stronghold.service');assert.equal(unified.servers[1].project.path,'../local');
 assert.equal((await c.inspect(s)).running,true);assert.equal((await c.inspect(s)).pid,123);
 assert.equal(c.workdirs.get('unit'),'/home/ecs-user/Stronghold-Protocol'); // 更新目录来自 WorkingDirectory
 assert.equal(c.ports.get('unit'),3250);                                      // 端口来自 Environment=PORT=3250
 await c.action(s,'stop');assert.deepEqual(calls.at(-1),{command:'sudo',args:['-n','systemctl','stop','stronghold.service']});
 const missing=new ServiceController('.','.',async()=>({stdout:'LoadState=not-found\n'}),'linux');assert.equal((await missing.inspect(s)).running,null);
 const windows=new ServiceController('.','.',runner,'win32');assert.equal((await windows.inspect(s)).state,'unknown');
 assert.throws(()=>validateConfig({servers:[{id:'bad',systemd:{unit:'--bad.service'}}]}));
});
test('本地目录解析、项目启停重启、停止后不遗留子进程', {timeout:20000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'shp-project-'));const data=join(root,'data');await mkdir(data);
 await writeFile(join(root,'package.json'),JSON.stringify({name:'local-service',scripts:{start:'node app.js'}}));
 await writeFile(join(root,'app.js'),"setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit(0));");
 const service={id:'project',project:{path:root,entry:'app.js'}};
  const c=new ServiceController(root,data);t.after(async()=>{for(const id of [...c.projects.keys()]) await c.action({id,project:{}},'stop').catch(()=>{});await rm(root,{recursive:true,force:true});});
  await c.init([service]);assert.equal((await c.inspect(service)).running,false);
  await c.action(service,'start');const first=(await c.inspect(service)).pid;assert(first>0);
  await c.action(service,'start');assert.equal((await c.inspect(service)).pid,first);
  await c.close([service]);assert.equal((await c.inspect(service)).running,true); // 管理后台退出不停止已启动的服务
  await c.action(service,'restart');assert.notEqual((await c.inspect(service)).pid,first);
 await c.action(service,'stop');assert.equal((await c.inspect(service)).running,false);
 const npmService={id:'npm',project:{path:root}};await c.init([npmService]);assert.equal(npmService.name,'local-service');
 await c.action(npmService,'start');assert.equal((await c.inspect(npmService)).running,true);
 await new Promise(resolve=>setTimeout(resolve,500));
 assert.equal((await c.inspect(npmService)).running,true);
 await c.action(npmService,'stop');assert.equal((await c.inspect(npmService)).running,false);
 await mkdir(join(root,'scripts'));
 await writeFile(join(root,'scripts','launch.mjs'),"console.log('official:'+process.argv.slice(2).join(',')+':'+process.env.PORT);setInterval(()=>{},1000);");
 const official={id:'official',project:{path:root}};await c.init([official]);assert.equal(official.url,'http://127.0.0.1:3000');
 await c.action(official,'start');let log='';for(let n=0;n<30;n++){try{log=await readFile(join(data,'service-official.log'),'utf8');}catch{}if(log.includes('official:'))break;await new Promise(r=>setTimeout(r,30));}
 assert(log.includes('official:--no-open:3000'));await c.action(official,'stop');

});
