import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {scheduleFor,safePath,validateStage,makeBackup,rollbackRelease,extractZip,activateUpdate,restartUnit} from '../plugins/stronghold-updater/index.mjs';
test('更新默认凌晨四点，支持零点并回退非法值',()=>{const date=new Date(2026,9,16,1);assert.equal(scheduleFor({},date).getHours(),4);assert.equal(scheduleFor({scheduleHour:0},date).getHours(),0);assert.equal(scheduleFor({scheduleHour:99},date).getHours(),4);});
test('更新包路径拒绝穿越、绝对路径与 Windows 路径',()=>{for(const path of ['../outside','/etc/passwd','C:/test','a/../b','a\\b'])assert.throws(()=>safePath(path));assert.equal(safePath('server/index.js'),'server/index.js');});
test('更新备份恢复原文件、旧元数据，并清除新增文件',async t=>{const root=await mkdtemp(join(tmpdir(),'shp-updater-'));t.after(()=>rm(root,{recursive:true,force:true}));const dir=join(root,'game');await mkdir(dir);await writeFile(join(dir,'old.js'),'old');await writeFile(join(dir,'.update-applied.json'),'previous');const j={dir,backupRoot:join(root,'backups')};const meta={files:{'old.js':{},'added.js':{}},removed:[]};const backup=await makeBackup(j,meta,'1.0.0','1.0.1');await writeFile(join(dir,'old.js'),'new');await writeFile(join(dir,'added.js'),'new');await writeFile(join(dir,'.update-applied.json'),'new');await rollbackRelease(j,[],backup.dir);assert.equal(await readFile(join(dir,'old.js'),'utf8'),'old');assert.equal(await readFile(join(dir,'.update-applied.json'),'utf8'),'previous');await assert.rejects(readFile(join(dir,'added.js')), {code:'ENOENT'});});
test('解压前后的文件清单校验，Windows 可直接使用原生解压',async t=>{const root=await mkdtemp(join(tmpdir(),'shp-updater-zip-'));t.after(()=>rm(root,{recursive:true,force:true}));const stage=join(root,'stage'),target=join(root,'game');await mkdir(stage);await mkdir(target);await writeFile(join(stage,'file.js'),'hello');await validateStage(stage,{files:{'file.js':{}}},target);await assert.rejects(validateStage(stage,{files:{}},target),/未声明/);await assert.rejects(validateStage(stage,{files:{'../outside':{}}},target),/不安全/);
if(process.platform==='win32'){const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const zip=join(root,'archive.zip'),dest=join(root,'extract');await mkdir(dest);const q=p=>"'"+p.replaceAll("'","''")+"'";const script='Compress-Archive -LiteralPath '+q(join(stage,'file.js'))+' -DestinationPath '+q(zip);await promisify(execFile)('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true});await extractZip(zip,dest,15000);assert.equal(await readFile(join(dest,'file.js'),'utf8'),'hello');}
});

test('systemd 更新后自动重启并确认 active，无更新不重启',async()=>{
 const j={dir:tmpdir(),unit:'stronghold.service',sudo:false,timeoutMs:1800000};const calls=[];
 const run=async(file,args,timeout)=>{calls.push({file,args,timeout});return args[0]==='show'?'active':'completed';};
 const result=await restartUnit(j,run);assert.match(result,/active/);assert.deepEqual(calls[0].args,['restart','stronghold.service']);assert.equal(calls[0].timeout,60000);
 calls.length=0;await restartUnit({...j,sudo:true},async(file,args)=>{calls.push({file,args});return 'active';});assert.equal(calls[0].file,'sudo');assert.deepEqual(calls[0].args,['-n','systemctl','restart','stronghold.service']);
 let count=0;const restart=async()=>{count++;return 'restarted';};const steps=[];await activateUpdate(j,{updated:false},steps,restart);assert.equal(count,0);await activateUpdate(j,{updated:true,version:'v1.0.1'},steps,restart);assert.equal(count,1);assert.deepEqual(steps,['restarted']);
 await assert.rejects(activateUpdate(j,{updated:true,version:'v1.0.1'},[],async()=>{throw new Error('denied');}),/更新文件已应用.*自动重启失败/);
 await assert.rejects(restartUnit(j,async(file,args)=>args[0]==='show'?'failed':''),/服务状态为 failed/);
});
