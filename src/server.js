import http from 'node:http';
import { readFile, readdir, mkdir, writeFile, rename, appendFile, open, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync } from 'node:crypto';
import { ServiceController } from './services.js';
import { probe, secretEqual, validateConfig } from './core.js';
import { createHostMonitor } from './metrics.js';
import { PluginManager } from './plugins.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN;
const configPath = resolve(root, process.env.CONFIG_FILE || 'config.json');
// 原子写配置；若 config.json 被 bind-mount（如 systemd ReadWritePaths 指定单个文件）导致 rename EBUSY，则退回直接写。
async function saveConfig(text) {
  const tmp = configPath + '.tmp';
  try { await writeFile(tmp, text, { mode: 0o600 }); await rename(tmp, configPath); }
  catch (error) {
    if (!['EBUSY', 'EXDEV', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
    await rm(tmp, { force: true }).catch(() => {});
    await writeFile(configPath, text, { mode: 0o600 });
  }
}
let config;
try {config=validateConfig(JSON.parse(await readFile(configPath,'utf8')));} catch(error) {if(error.code !== 'ENOENT') throw error;config=validateConfig({servers:[],pluginsDirectory:'plugins'});}
let savedConfig = config;
let settingsSaving = false;
const dataDir = resolve(root, process.env.DATA_DIR || 'data');
await mkdir(dataDir, { recursive: true });
const authPath = resolve(dataDir, 'admin-auth.json');
let passwordHash;
try { passwordHash = JSON.parse(await readFile(authPath, 'utf8')); } catch(error) { if(error.code !== 'ENOENT') throw error; }
let adminUsername = passwordHash?.username || process.env.ADMIN_USERNAME || 'admin';
const placeholderToken=/replace-with|change-me|changeme|admin@1234/i;
let setupRequired=!passwordHash && (!token || token.length < 8 || placeholderToken.test(token));
const setupPin=setupRequired ? randomBytes(12).toString('hex') : null;
if(setupRequired) console.log('首次配置验证码：'+setupPin);
const verifyPassword = value => typeof value === 'string' && value.length <= 512 && (passwordHash ? secretEqual(scryptSync(value,passwordHash.salt,64).toString('hex'),passwordHash.hash) : secretEqual(value,token));

const services = new ServiceController(root, dataDir);
await services.init(config.servers);
const plugins = new PluginManager(resolve(root, config.pluginsDirectory || process.env.PLUGINS_DIR || 'plugins'), dataDir);
await plugins.init();
const historyPath = resolve(dataDir, 'history.json');
const startedAt = Date.now();
const history = Object.fromEntries(config.servers.map(target => [target.id, []]));
const latest = new Map(), busy = new Set(), sessions = new Map(), attempts = new Map();
const hostHistoryPath = resolve(dataDir, 'host-history.json');
let hostHistory = [];
const monitorHost = createHostMonitor(config.host);
let hostLatest = null, hostPolling = false;
let polling = false, closing = false;
// Port derived automatically: project env.PORT, or a systemd unit's Environment / ExecStart.
function portOf(s) {
  if (s.project) { const port = (s.project.env || {}).PORT; return port && /^\d{1,5}$/.test(String(port)) ? Number(port) : null; }
  if (s.systemd) return services.ports.get(s.id) || null;
  return null;
}
// url is optional in config: when omitted it is derived from the port (still overridable).
function effectiveUrl(s) {
  if (s.url) return s.url;
  const port = portOf(s);
  return port ? `http://127.0.0.1:${port}` : '';
}
// Read-only dashboard settings handed to plugins; never includes credentials or secrets.
function pluginGlobal() {
  return {
    startedAt,
    dataDir,
    pollIntervalSeconds: config.pollIntervalSeconds,
    retentionHours: config.retentionHours,
    host: { pollIntervalSeconds: config.host.pollIntervalSeconds },
    servers: config.servers.map(s => ({ id: s.id, name: s.name || s.id, kind: s.project ? 'project' : s.systemd ? 'systemd' : 'http', online: !!(latest.get(s.id)?.online), url: effectiveUrl(s), port: portOf(s), path: s.project?.path || services.workdirs.get(s.id) || '', unit: s.systemd?.unit || '', sudo: s.systemd?.sudo === true }))
  };
}
async function sampleHost() {
  if (hostPolling || closing) return;
  hostPolling = true;
  try {
    hostLatest = await monitorHost();
    hostHistory.push({ at: hostLatest.at, cpuPercent: hostLatest.cpuPercent, memoryPercent: hostLatest.memoryPercent, rxBytesPerSec: hostLatest.network.rxBytesPerSec, txBytesPerSec: hostLatest.network.txBytesPerSec });
    hostHistory = hostHistory.filter(x => x.at >= Date.now() - config.retentionHours * 3600000).slice(-Math.ceil(config.retentionHours * 3600 / config.host.pollIntervalSeconds));
    await writeFile(hostHistoryPath + '.tmp', JSON.stringify(hostHistory), { mode: 0o600 });
    await rename(hostHistoryPath + '.tmp', hostHistoryPath);
    await plugins.collect({ host: hostLatest, servers: config.servers.map(s => ({ id: s.id, name: s.name || s.id, ...(latest.get(s.id) || { online: false }) })) }, pluginGlobal());
  } catch (error) { console.error('主机采样失败:', error.message); }
  finally { hostPolling = false; }
}
async function audit(entry) {
  await appendFile(resolve(dataDir, 'audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
}
async function sample() {
  if (polling || closing) return;
  polling = true;
  try {
    await Promise.all(config.servers.map(async target => {
      const control = await services.inspect(target);
      const url = effectiveUrl(target);
      const result = url ? await probe({...target, url}) : {at:Date.now(),online:false,latencyMs:null};
      result.control = control;
      latest.set(target.id, result);
      history[target.id].push(result);
      const cutoff = Date.now() - config.retentionHours * 3600000;
      history[target.id] = history[target.id].filter(x => x.at >= cutoff).slice(-Math.ceil(config.retentionHours * 3600 / config.pollIntervalSeconds));
    }));
    await writeFile(historyPath + '.tmp', JSON.stringify(Object.fromEntries(config.servers.map(s => [s.id, history[s.id]]))), { mode: 0o600 });
    await rename(historyPath + '.tmp', historyPath);
  } catch (error) { console.error('采样或持久化失败:', error.message); }
  finally { polling = false; }
}
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function historySince(points, url) {
  const since = Number(url.searchParams.get('since') || 0);
  if (!Number.isFinite(since) || since < 0) throw new Error('since 必须为有效时间戳');
  return points.filter(p => p.at >= since && p.at >= Date.now() - config.retentionHours * 3600000);
}
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 65536) throw new Error('请求过大'); }
  return JSON.parse(text || '{}');
}
const assets = new Map();
async function loadAssets(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name), key = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await loadAssets(path, key);
    else if (entry.isFile()) assets.set(key === '/index.html' ? '/' : key, {
      content: await readFile(path), type: entry.name.endsWith('.js') ? 'text/javascript' : entry.name.endsWith('.css') ? 'text/css' : entry.name.endsWith('.html') ? 'text/html' : entry.name.endsWith('.svg') ? 'image/svg+xml' : entry.name.endsWith('.woff2') ? 'font/woff2' : entry.name.endsWith('.woff') ? 'font/woff' : 'application/octet-stream'
    });
  }
}
if (process.env.DEV_MODE !== 'true') {
  try { await loadAssets(resolve(root, 'dist')); }
  catch { throw new Error('前端构建不存在或无法读取，请先执行 npm ci 和 npm run build'); }
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && assets.has(url.pathname)) {
      const asset = assets.get(url.pathname); res.writeHead(200, { 'Content-Type': `${asset.type}; charset=utf-8` }); res.end(asset.content); return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
    // All writes require a same-origin browser request (or a non-browser request without Origin).
    if (req.method !== 'GET' && req.headers.origin) {
      let origin; try { origin = new URL(req.headers.origin); } catch { return json(res, 403, { error: '无效来源' }); }
      if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) return json(res, 403, { error: '拒绝跨域操作' });
    }
    const ip = req.socket.remoteAddress;
    if(req.method==='GET' && url.pathname==='/api/setup') return json(res,200,{required:setupRequired});
    if(req.method==='POST' && url.pathname==='/api/setup') {
      if(!setupRequired) return json(res,409,{error:'管理员账户已创建'});
      const rate=attempts.get(ip)||{count:0,until:Date.now()+600000};if(rate.until<Date.now()){rate.count=0;rate.until=Date.now()+600000;}if(rate.count>=10)return json(res,429,{error:'尝试过多，请稍后重试'});rate.count++;attempts.set(ip,rate);
      const input=await body(req);
      if(!secretEqual(input.pin,setupPin))return json(res,400,{error:'首次配置验证码错误'});
      if(typeof input.username!=='string'||!/^[a-zA-Z0-9_.@-]{1,64}$/.test(input.username)||typeof input.password!=='string'||input.password.length<8||input.password.length>512)return json(res,400,{error:'请填写有效用户名和至少 8 位密码'});
      if(settingsSaving)return json(res,409,{error:'正在创建账户'});settingsSaving=true;
      try {const next={username:input.username,salt:randomBytes(32).toString('hex')};next.hash=scryptSync(input.password,next.salt,64).toString('hex');await writeFile(authPath+'.tmp',JSON.stringify(next),{mode:0o600});await rename(authPath+'.tmp',authPath);passwordHash=next;adminUsername=next.username;setupRequired=false;attempts.delete(ip);return json(res,200,{ok:true});}finally{settingsSaving=false;}
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const rate = attempts.get(ip) || { count: 0, until: Date.now() + 600000 };
      if (rate.until < Date.now()) { rate.count = 0; rate.until = Date.now() + 600000; }
      if (rate.count >= 10) return json(res, 429, { error: '尝试过多，请十分钟后再试' });
      rate.count++; attempts.set(ip, rate);
      const input = await body(req);
      if (!secretEqual(input.username,adminUsername) || !verifyPassword(input.password)) return json(res,401,{error:'用户名或密码错误'});
      attempts.delete(ip);
      const sid = randomBytes(32).toString('hex'); sessions.set(sid, Date.now() + 8 * 3600000);
      res.setHeader('Set-Cookie', `shp_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`);
      return json(res, 200, { ok: true });
    }
    const sid = /(?:^|;\s*)shp_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    if (!sid || !(sessions.get(sid) > Date.now())) return json(res, 401, { error: '请先登录' });
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      sessions.delete(sid); res.setHeader('Set-Cookie', 'shp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') return json(res,200,{adminUsername,config:{...savedConfig,servers:savedConfig.servers.map(service=>{const copy={...service};if(copy.source){delete copy.systemd;delete copy.project;}return copy;})},pluginsDirectory:savedConfig.pluginsDirectory || process.env.PLUGINS_DIR || 'plugins'});
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      if(settingsSaving) return json(res,409,{error:'设置正在保存，请稍后重试'});
      settingsSaving=true;
      try {
      if(busy.size) return json(res,409,{error:'服务操作进行中，请稍后保存'});
      const input=await body(req);
      const candidate=validateConfig({...input.config,servers:savedConfig.servers});
      if(typeof candidate.pluginsDirectory !== 'string' || !candidate.pluginsDirectory.trim()) return json(res,400,{error:'插件目录不能为空'});
      if(input.newPassword && (typeof input.newPassword !== 'string' || input.newPassword.length < 8 || input.newPassword.length > 512)) return json(res,400,{error:'新密码需要 8–512 个字符'});
      const nextUsername=input.adminUsername ?? adminUsername;
      if(typeof nextUsername !== 'string' || !/^[a-zA-Z0-9_.@-]{1,64}$/.test(nextUsername)) return json(res,400,{error:'用户名需为 1–64 个字母、数字或 _ . @ -'});
      const accountChanged=!!input.newPassword || nextUsername !== adminUsername;
      if(accountChanged && !verifyPassword(input.currentPassword)) return json(res,400,{error:'当前密码错误'});
      await new ServiceController(root,dataDir).init(candidate.servers);
      const document={...candidate,servers:candidate.servers.map(service=>{const copy={...service};if(copy.source){delete copy.systemd;delete copy.project;}return copy;})};
      await saveConfig(JSON.stringify(document,null,2)+'\n');savedConfig=document;
      if(accountChanged) {
        const next={salt:randomBytes(32).toString('hex')};if(input.newPassword || !passwordHash) next.hash=scryptSync(input.newPassword || token,next.salt,64).toString('hex');
        else {next.salt=passwordHash.salt;next.hash=passwordHash.hash;}next.username=nextUsername;
        await writeFile(authPath+'.tmp',JSON.stringify(next),{mode:0o600});await rename(authPath+'.tmp',authPath);passwordHash=next;adminUsername=nextUsername;
        for(const key of sessions.keys()) if(key !== sid) sessions.delete(key);
      }
      await audit({action:'settings-save',ip,result:'success'});
      return json(res,200,{ok:true,message:'设置已保存。密码立即生效，其他设置重启后台后生效。'});
      } finally {settingsSaving=false;}
    }
    if(req.method==='GET' && url.pathname==='/api/services') return json(res,200,{servers:savedConfig.servers.map(service=>{const copy={...service};if(copy.source){delete copy.systemd;delete copy.project;}return copy;})});
    if(req.method==='POST' && url.pathname==='/api/services') {
      if(settingsSaving||busy.size||polling)return json(res,409,{error:'正在同步或执行操作，请稍后保存'});settingsSaving=true;
      try {
        const input=await body(req);const candidate=validateConfig({...savedConfig,servers:input.servers});
        if(candidate.servers.some(s=>!s.project&&!s.systemd&&!savedConfig.servers.some(old=>old.id===s.id&&JSON.stringify(old)===JSON.stringify(s))))return json(res,400,{error:'仅支持本地项目或 systemd 服务接入'});
        for(const active of config.servers){if(!active.project&&!active.systemd)continue;if((await services.inspect(active).catch(()=>null))?.running && JSON.stringify(candidate.servers.find(s=>s.id===active.id))!==JSON.stringify(active))return json(res,409,{error:'请先停止要修改或移除的本地服务'});}
        await services.init(candidate.servers);
        const document={...candidate,servers:candidate.servers.map(service=>{const copy={...service};if(copy.source){delete copy.systemd;delete copy.project;}return copy;})};
        await saveConfig(JSON.stringify(document,null,2)+'\n');
        config.servers=candidate.servers;savedConfig=document;
        for(const s of config.servers)history[s.id] ||= [];
        for(const id of Object.keys(history))if(!config.servers.some(s=>s.id===id))delete history[id];
        for(const id of [...latest.keys()])if(!config.servers.some(s=>s.id===id))latest.delete(id);
        await sample();await audit({action:'services-save',ip,result:'success'});return json(res,200,{ok:true,message:'服务列表已保存并生效'});
      }finally{settingsSaving=false;}
    }
    const logRoute=/^\/api\/servers\/([a-z0-9_-]+)\/logs$/i.exec(url.pathname);
    if(req.method==='GET'&&logRoute){
      const target=config.servers.find(s=>s.id===logRoute[1]);if(!target)return json(res,404,{error:'服务不存在'});
      if(target.systemd){if(process.platform!=='linux')return json(res,400,{error:'systemd 日志仅支持 Linux'});const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const args=['--unit',target.systemd.unit,'--lines','100','--no-pager','--output','short-iso'];const result=await promisify(execFile)(target.systemd.sudo?'sudo':'journalctl',target.systemd.sudo?['-n','journalctl',...args]:args,{windowsHide:true,timeout:10000,maxBuffer:262144});return json(res,200,{text:result.stdout});}
      if(!target.project)return json(res,200,{text:'此服务未接入本地日志源'});
      let file;try{file=await open(resolve(dataDir,'service-'+target.id+'.log'),'r');const info=await file.stat();const size=Math.min(info.size,65536),buffer=Buffer.alloc(size);await file.read(buffer,0,size,info.size-size);return json(res,200,{text:buffer.toString('utf8')});}catch(error){if(error.code==='ENOENT')return json(res,200,{text:'服务尚无日志'});throw error;}finally{await file?.close();}
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, {
      now: Date.now(), startedAt, pollIntervalSeconds: config.pollIntervalSeconds, hostPollIntervalSeconds: config.host.pollIntervalSeconds,
      host: hostLatest,
      servers: config.servers.map(s => ({ id: s.id, name: s.name || latest.get(s.id)?.control?.description || s.id, url: effectiveUrl(s), actions: services.actions(s), kind: s.project ? "project" : s.systemd ? "systemd" : "http", busy: busy.has(s.id), ...(latest.get(s.id) || { online: false, error: '等待首次采样' }) }))
    });
    if (req.method === 'GET' && url.pathname === '/api/host/history') return json(res, 200, historySince(hostHistory, url));
    if (req.method === 'GET' && url.pathname === '/api/plugins') return json(res, 200, plugins.list());
    if (req.method === 'POST' && url.pathname === '/api/plugins/rescan') {
      await audit({ action: 'plugins-rescan', ip, result: 'requested' });
      return json(res, 200, await plugins.rescan());
    }
    const pluginAdd = /^\/api\/plugins\/([a-z0-9_-]+)\/instances$/i.exec(url.pathname);
    if (req.method === 'POST' && pluginAdd) {
      await audit({ plugin: pluginAdd[1], action: 'add-instance', ip, result: 'requested' });
      try {
        const result = await plugins.addInstance(pluginAdd[1], await body(req));
        await audit({ plugin: pluginAdd[1], action: 'add-instance', ip, result: 'success' });
        return json(res, 200, result);
      } catch (error) {
        await audit({ plugin: pluginAdd[1], action: 'add-instance', ip, result: 'failed', error: error.message });
        return json(res, 400, { error: error.message });
      }
    }
    const pluginRun = /^\/api\/plugins\/instances\/([a-z0-9_-]+)\/actions\/([a-z0-9_-]+)$/i.exec(url.pathname);
    if (req.method === 'POST' && pluginRun) {
      await audit({ plugin: pluginRun[1], action: `run-${pluginRun[2]}`, ip, result: 'requested' });
      try {
        const result = await plugins.runAction(pluginRun[1], pluginRun[2]);
        await audit({ plugin: pluginRun[1], action: `run-${pluginRun[2]}`, ip, result: 'success' });
        return json(res, 200, result);
      } catch (error) {
        await audit({ plugin: pluginRun[1], action: `run-${pluginRun[2]}`, ip, result: 'failed', error: error.message });
        return json(res, 400, { error: error.message });
      }
    }
    const pluginAction = /^\/api\/plugins\/instances\/([a-z0-9_-]+)\/(enable|disable|settings|remove)$/i.exec(url.pathname);
    if (req.method === 'POST' && pluginAction) {
      const id = pluginAction[1], action = pluginAction[2];
      await audit({ plugin: id, action, ip, result: 'requested' });
      try {
        const result = action === 'enable' || action === 'disable' ? await plugins.toggle(id, action === 'enable')
          : action === 'settings' ? await plugins.updateSettings(id, await body(req))
          : await plugins.removeInstance(id);
        await audit({ plugin: id, action, ip, result: 'success' });
        return json(res, 200, result);
      } catch (error) {
        await audit({ plugin: id, action, ip, result: 'failed', error: error.message });
        return json(res, 400, { error: error.message });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/history') {
      if (!config.servers.some(s => s.id === url.searchParams.get('id'))) return json(res, 404, { error: '服务器不存在' });
      return json(res, 200, historySince(history[url.searchParams.get('id')], url));
    }
    const actionRoute = /^\/api\/servers\/([a-z0-9_-]+)\/actions\/(start|stop|restart)$/i.exec(url.pathname);
    if (req.method === 'POST' && actionRoute) {
      const target = config.servers.find(s => s.id === actionRoute[1]);
      const action = target && services.actions(target).includes(actionRoute[2]);
      if (!action) return json(res, 403, { error: '此操作未在服务端启用' });
      if (busy.has(target.id)) return json(res, 409, { error: '该服务器已有操作正在执行' });
      busy.add(target.id);
      try {
        await audit({ server: target.id, action: actionRoute[2], ip, result: 'requested' });
        await services.action(target, actionRoute[2]);
        await sample();
        await audit({ server: target.id, action: actionRoute[2], ip, result: 'success' });
        return json(res, 200, { ok: true, message: '管理命令已成功执行，服务状态将在下次采样更新' });
      } catch (error) {
        await audit({ server: target.id, action: actionRoute[2], ip, result: 'failed', error: error.message.slice(0, 2000) }).catch(() => {});
        return json(res, 500, { error: '管理命令失败或超时，请检查 data/audit.jsonl' });
      } finally { busy.delete(target.id); }
    }
    json(res, 404, { error: '接口不存在' });
  } catch (error) { console.error(error.message); if (!res.headersSent) json(res, 400, { error: `请求无法处理：${String(error?.message || error).slice(0, 200)}` }); else res.end(); }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
const interval = setInterval(sample, config.pollIntervalSeconds * 1000);
const hostInterval = setInterval(sampleHost, config.host.pollIntervalSeconds * 1000);
const cleanup = setInterval(() => {
  for (const [key, until] of sessions) if (until < Date.now()) sessions.delete(key);
  for (const [key, rate] of attempts) if (rate.until < Date.now()) attempts.delete(key);
}, 60000);
server.listen(Number(process.env.PORT || 7999), process.env.HOST || '127.0.0.1', () => console.log(`卫戍中枢 http://${process.env.HOST || '127.0.0.1'}:${server.address().port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { closing = true; clearInterval(interval); clearInterval(hostInterval); clearInterval(cleanup); server.close(); plugins.close().catch(console.error); services.close(config.servers).catch(console.error); });
await Promise.all([sample(), sampleHost()]);
