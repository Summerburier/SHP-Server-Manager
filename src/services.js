import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, writeFile, rm } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {fileURLToPath} from 'node:url';
const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** A systemd unit's port: PORT= from Environment, else --port / :port from ExecStart. */
function systemdPort(fields) {
  const env = fields.Environment || '';
  let match = /(?:^|\s)PORT=(\d{2,5})(?:\s|$)/.exec(env);
  if (match) return Number(match[1]);
  const exec = fields.ExecStart || '';
  match = /--port[= ]+(\d{2,5})/.exec(exec) || /[:\s](\d{2,5})\b/.exec(exec);
  return match ? Number(match[1]) : null;
}

// Project services are launched detached: they keep running after the manager exits
// (only an explicit stop/restart through the UI sends them a signal). A pid file lets
// the manager recognise an already-running service after it restarts.
export class ServiceController {
  constructor(root, dataDir, runner = execute, platform = process.platform) { this.root = root; this.dataDir = dataDir; this.run = runner; this.platform = platform; this.projects = new Map(); this.pids = new Map(); this.workdirs = new Map(); this.ports = new Map(); }
  async init(services) {
    for (const service of services) {
      if (!service.project) continue;
      const cwd = resolve(this.root, service.project.path);
      if (!(await stat(cwd)).isDirectory()) throw new Error(`项目目录不存在: ${service.id}`);
      let command = process.execPath, args, name = service.name;
      if (service.project.entry) {
        const entry = resolve(cwd, service.project.entry);
        if (!(await stat(entry)).isFile()) throw new Error(`项目入口不存在: ${service.id}`);
        args = [entry, ...(service.project.args || [])];
      } else {
        const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
        const officialLauncher=await stat(join(cwd,'scripts/launch.mjs')).then(s=>s.isFile()).catch(()=>false);
        if(!officialLauncher && !pkg.scripts?.start)throw new Error(`项目没有启动脚本: ${service.id}`);
        name ||= pkg.name;
        args=[fileURLToPath(new URL('../scripts/service-launch.mjs',import.meta.url)),cwd,...(service.project.args || [])];
        // url 可省略：按 project.env.PORT 推导，官方启动器没有 PORT 时用 3000。
        const projectPort=Number(service.project.env?.PORT);
        if(!service.url && Number.isInteger(projectPort) && projectPort>0) service.url=`http://127.0.0.1:${projectPort}`;
        else if(!service.url && officialLauncher) service.url='http://127.0.0.1:3000';
      }
      this.projects.set(service.id, {cwd,command,args});
      service.name ||= name || service.id;
    }
  }
  actions(service) { return service.systemd || service.project ? ['start','stop','restart'] : Object.keys(service.actions || {}); }
  async systemctl(service, args) {
    if (this.platform !== 'linux') throw new Error('systemd 服务仅支持 Linux');
    return this.run(service.systemd.sudo ? 'sudo' : 'systemctl', service.systemd.sudo ? ['-n','systemctl',...args] : args, {shell:false, windowsHide:true, timeout:30000,maxBuffer:65536});
  }
  pidPath(id) { return join(this.dataDir, `service-${id}.pid`); }
  alive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
  /** The pid of a running detached service: from memory, else the pid file (survives manager restarts). */
  async runningPid(id) {
    if (this.pids.has(id)) { const pid = this.pids.get(id); if (this.alive(pid)) return pid; this.pids.delete(id); }
    try {
      const record = JSON.parse(await readFile(this.pidPath(id), 'utf8'));
      if (this.alive(record.pid)) { this.pids.set(id, record.pid); return record.pid; }
    } catch { /* no pid file */ }
    return null;
  }
  async inspect(service) {
    if (service.systemd) {
      try {
        const {stdout} = await this.systemctl(service,['show',service.systemd.unit,'--property=LoadState,ActiveState,SubState,MainPID,Description,WorkingDirectory,Environment,ExecStart']);
        const fields = Object.fromEntries(stdout.trim().split('\n').map(line => {const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
        if (fields.LoadState !== 'loaded') throw new Error('systemd 未找到该服务');
        this.workdirs.set(service.id, fields.WorkingDirectory || '');
        this.ports.set(service.id, systemdPort(fields));
        return {running:fields.ActiveState === 'active', state:fields.ActiveState,pid:Number(fields.MainPID)||null,description:fields.Description,source:service.systemd.unit};
      } catch(error) {return {running:null,state:'unknown',error:error.message,source:service.systemd.unit};}
    }
    if (service.project) {
      const pid = await this.runningPid(service.id);
      let startedAt = null;
      try { startedAt = JSON.parse(await readFile(this.pidPath(service.id), 'utf8')).at ?? null; } catch { /* none */ }
      return { running: pid !== null, state: pid !== null ? 'running' : 'stopped', pid, uptimeSec: pid && startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : null, source: this.projects.get(service.id)?.cwd };
    }
    return null;
  }
  async stop(service) {
    const id = service.id;
    const pid = await this.runningPid(id) ?? this.pids.get(id);
    if (pid) {
      if (this.platform === 'win32') await this.run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }).catch(() => {});
      else {
        try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error.code === 'ESRCH') { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } }
        const until = Date.now() + 10000;
        while (this.alive(pid) && Date.now() < until) await sleep(100);
        if (this.alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
      }
    }
    this.pids.delete(id);
    await rm(this.pidPath(id), { force: true }).catch(() => {});
  }
  async action(service, action) {
    if(service.systemd) return this.systemctl(service,[action,service.systemd.unit]);
    if(service.project) {
      if(action !== 'start') await this.stop(service);
      if(action === 'stop') return;
      if(await this.runningPid(service.id)) return; // already running (detached): do not start a twin
      const spec=this.projects.get(service.id);
      const log=openSync(join(this.dataDir,`service-${service.id}.log`),'a',0o600);
      const env={...process.env};delete env.ADMIN_TOKEN;delete env.ADMIN_PASSWORD;delete env.PORT;delete env.HOST;
      Object.assign(env,service.project.env || {});if(service.url && !env.PORT)env.PORT=new URL(service.url).port || (new URL(service.url).protocol==='https:'?'443':'80');
      // detached + unref + log file descriptor: the service outlives this manager process.
      const child=spawn(spec.command,spec.args,{cwd:spec.cwd,env,windowsHide:true,detached:true,stdio:['ignore',log,log]});
      try { closeSync(log); } catch { /* child holds its own descriptor */ }
      child.unref();
      child.once('error', () => {});
      await new Promise((resolveSpawn, rejectSpawn) => { child.once('spawn', resolveSpawn); child.once('error', rejectSpawn); });
      this.pids.set(service.id, child.pid);
      await writeFile(this.pidPath(service.id), JSON.stringify({ pid: child.pid, at: Date.now() }), { mode: 0o600 });
      child.once('exit', () => { if (this.pids.get(service.id) === child.pid) { this.pids.delete(service.id); rm(this.pidPath(service.id), { force: true }).catch(() => {}); } });
      return;
    }
    const spec=service.actions[action];return this.run(spec.command,spec.args,{shell:false,windowsHide:true,timeout:30000,maxBuffer:65536,...(spec.cwd?{cwd:spec.cwd}:{})});
  }
  // Deliberately does NOT stop services: they run detached and survive the manager.
  async close() { /* 脱手运行：管理后台退出不停止已启动的服务 */ }
}
