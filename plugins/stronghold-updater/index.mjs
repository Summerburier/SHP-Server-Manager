// 卫戍协议：盟约（Stronghold-Protocol）定时更新插件。
// 目标目录来自「实例绑定的服务」的本地目录（context.service → context.global.servers[].path），不再手填路径。
// 每天定时更新（默认 04:00）：
//   - release（默认）：下载官方增量更新包 Stronghold-Protocol-v<版本>-update.zip，覆盖到安装目录，
//     调用官方 server/update.js 应用；应用前先做回滚点备份，失败会自动回滚。
//   - git：git pull --ff-only origin master；更新前记录提交，回滚即 git reset --hard。
// 支持操作按钮：update（立即更新）、rollback（回滚到上一版本）。
// 后台异步执行，collect/action 立即返回，避免占用后台插件 5 秒调用超时。
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp, rm, rmdir, readdir, stat, lstat, copyFile, rename } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'sganggs/Stronghold-Protocol';
const BRANCH = 'master';

const exec = promisify(execFile);
const state = { lastRunDay: null, lastRunAt: null, running: false, checking: false, lastResult: null, lastError: null, lastGood: null, currentVersion: null, latestVersion: null, checkedAt: null, phase: '空闲', progress: null, logs: [] };
function log(message) { state.logs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`); if (state.logs.length > 100) state.logs.shift(); }
function phase(message) { state.phase = message; log(message); }

const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mb = n => `${(n / 1048576).toFixed(1)} MB`;
const settingsOf = context => (context && (context.settings || context.config)) || {};
const exists = async p => stat(p).then(s => s.isFile()).catch(() => false);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function compareVersions(a, b) {
  const parse = v => { const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim()); return m ? [+m[1], +m[2], +m[3]] : null; };
  const x = parse(a), y = parse(b);
  if (!x || !y) return String(a) === String(b) ? 0 : 1;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

async function command(file, args, timeoutMs, options = {}) {
  try {
    const { stdout, stderr } = await exec(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, ...options });
    return (stdout || stderr || '').trim();
  } catch (error) {
    const detail = (error.stderr || error.stdout || error.message || '').toString().trim();
    throw new Error(detail.split('\n').slice(-3).join(' ').slice(0, 300) || `${file} 执行失败`);
  }
}
const git = (j, args) => command('git', ['-C', j.dir, ...args], j.timeoutMs);

async function installedVersion(dir) {
  try { return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version ?? null; } catch { return null; }
}

/** Resolve the job from the instance's bound service: its directory + settings + timeout.
 *  State and backups live under the manager's data dir — never inside the Stronghold-Protocol folder. */
function job(context) {
  const s = settingsOf(context);
  const service = (context.service || '').trim();
  if (!service) throw new Error('未绑定服务：请在实例设置里绑定一个本地服务');
  const server = (context.global?.servers || []).find(x => x.id === service);
  if(server?.kind==='systemd' && !server.unit?.trim())throw new Error('绑定的 systemd 服务缺少 unit 名称，无法自动重启');
  const path = (server?.path || '').trim();
  if (!path) throw new Error(`服务「${server?.name || service}」没有可用目录（project 目录或 systemd 的 WorkingDirectory）`);
  const minutes = Math.min(180, Math.max(1, Number(s.timeoutMinutes) || 30));
  const dataDir = (context.global?.dataDir || '').trim();
  const instanceId = context.instance?.id || service;
  const base = dataDir ? join(dataDir, 'stronghold-updater', instanceId) : join(tmpdir(), 'shp-stronghold-updater', instanceId);
  return {
    dir: resolve(path), mode: s.mode === 'git' ? 'git' : 'release', timeoutMs: minutes * 60 * 1000, service, serviceName: server?.name || service,
    unit: (server?.unit || '').trim(), sudo: server?.sudo === true,
    statePath: join(base, 'state.json'), backupRoot: join(base, 'backups')
  };
}

async function loadState(path) {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    state.lastRunDay = raw.lastRunDay ?? null; state.lastRunAt = raw.lastRunAt ?? null;
    state.lastError=raw.lastError ?? null;
    state.lastResult = raw.lastResult ?? null; state.lastGood = raw.lastGood ?? null;
    state.latestVersion = raw.latestVersion ?? null; state.checkedAt = raw.checkedAt ?? null;
    state.logs = Array.isArray(raw.logs) ? raw.logs.slice(-100) : [];
  } catch { /* 首次运行 */ }
}

async function saveState(path) {
  try { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify({ lastRunDay: state.lastRunDay, lastRunAt: state.lastRunAt, lastResult: state.lastResult, lastError: state.lastError, lastGood: state.lastGood, latestVersion: state.latestVersion, checkedAt: state.checkedAt, logs: state.logs }, null, 2)); }
  catch { /* 状态非关键 */ }
}

function hourOf(s) { const hour=Number(s.scheduleHour ?? 4); return Number.isInteger(hour)&&hour>=0&&hour<=23?hour:4; }
function scheduleFor(s, now) { const at = new Date(now); at.setHours(hourOf(s), 0, 0, 0); return at; }
function isDue(s, now) { return state.lastRunDay !== dayKey(new Date(now)) && now >= scheduleFor(s, now).getTime(); }
function nextRunLabel(s, now) {
  const at = scheduleFor(s, now);
  if (at.getTime() <= now || state.lastRunDay === dayKey(at)) at.setDate(at.getDate() + 1);
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:00`;
}

function summary(context) {
  const s = settingsOf(context);
  let target = '', targetError = null;
  try { const j = job(context); target = j.dir; } catch (error) { targetError = error.message; }
  return {
    状态: state.running ? '更新中…' : state.checking ? '检查中…' : targetError ? '未就绪' : state.lastError ? '上次失败' : state.lastResult ? '已就绪' : '待运行',
    更新方式: s.mode === 'git' ? 'Git 拉取' : '官方增量更新包',
    当前阶段: state.phase,
    ...(state.progress !== null ? { 下载进度: `${state.progress}%` } : {}),
    ...(state.latestVersion ? { 最新版本: `v${state.latestVersion}`, 检查时间: new Date(state.checkedAt).toLocaleString('zh-CN') } : {}),
    当前版本: state.currentVersion ? `v${state.currentVersion}` : null,
    日志: state.logs.slice(-60),
    服务: target || '未绑定',
    计划: `每天 ${pad(hourOf(s))}:00`,
    上次运行: state.lastRunAt ? new Date(state.lastRunAt).toLocaleString('zh-CN') : '从未',
    下次计划: nextRunLabel(s, Date.now()),
    ...(state.lastResult?.version ? { 版本: state.lastResult.version } : {}),
    ...(state.lastResult?.warnings?.length ? { 警告: state.lastResult.warnings } : {}),
    ...(state.lastResult?.steps?.length ? { 步骤: state.lastResult.steps } : {}),
    ...(targetError ? { 错误: targetError } : state.lastError ? { 错误: state.lastError } : {})
  };
}

function startJob(context) {
  if (state.running || state.checking) throw new Error('已有更新或检查任务正在执行');
  const j = job(context);
  state.running = true; state.lastError = null; state.logs = []; state.progress = null; phase('开始更新');
  const day = dayKey(new Date());
  Promise.resolve()
    .then(() => doUpdate(j))
    .then(result => { state.lastResult = result; state.lastError = null; phase('更新任务结束'); state.progress = null; })
    .catch(error => { state.lastError = error.message; phase(`更新失败：${error.message}`); })
    .finally(() => { state.running = false; state.lastRunDay = day; state.lastRunAt = Date.now(); return saveState(j.statePath); });
  return summary(context);
}

export async function start(context) {
  try { const j = job(context); await mkdir(dirname(j.statePath), { recursive: true }); await loadState(j.statePath); } catch { /* 未绑定服务：暂不加载状态 */ }
}

export async function collect(snapshot, context) {
  let ready = true; try { job(context); } catch { ready = false; }
  if (ready && !state.running && !state.checking && isDue(settingsOf(context), Date.now())) startJob(context);
  return summary(context);
}

// 只提供“立即更新”。回滚是自动的：更新失败时由 releaseUpdate 调用 rollbackRelease。
export async function action(key, context) {
  if (key === 'update') return startJob(context);
  if (key === 'check') {
    const j = job(context);
    if (!state.running && !state.checking) {
      state.checking=true;
      phase('正在检查最新版本');
      void checkLatest(j).then(()=>{state.phase='检查完成';}).catch(error=>{state.lastError=error.message;log(`检查失败：${error.message}`);state.phase='检查失败';}).finally(()=>{state.checking=false;return saveState(j.statePath);});
    }
    return summary(context);
  }
  throw new Error('未知操作');
}

export async function stop() { /* 无需要清理的资源 */ }

async function doUpdate(j) {
  const steps = [], warnings = [];
  const result = j.mode === 'git' ? await gitUpdate(j, steps) : await releaseUpdate(j, steps, warnings);
  await activateUpdate(j,result,steps);
  return { version: result.version, steps, warnings };
}

/** Restart a systemd-bound service so the update takes effect (the plugin is bound to its unit). */
async function activateUpdate(j,result,steps,restart=restartUnit) {
  if(!result.updated)return;
  state.currentVersion=await installedVersion(j.dir);
  if(!j.unit){steps.push('已更新，请在“服务”页重启服务使其生效');return;}
  phase('更新已应用，正在重启 systemd 服务');
  try {steps.push(await restart(j));}
  catch(error){state.lastResult={version:result.version,steps:[...steps,'systemd 自动重启失败'],warnings:[]};throw new Error(`更新文件已应用，但服务 ${j.unit} 自动重启失败：${error.message}`);}
}
async function restartUnit(j,run=command) {
  const file=j.sudo?'sudo':'systemctl';
  const args=j.sudo?['-n','systemctl','restart',j.unit]:['restart',j.unit];
  const timeout=Math.min(j.timeoutMs,60000);
  await run(file,args,timeout);
  for(let attempt=0;attempt<20;attempt++){
    const query=['show',j.unit,'--property=ActiveState','--value'];
    const active=(await run(file,j.sudo?['-n','systemctl',...query]:query,timeout)).trim();
    if(active==='active')return `已自动重启 ${j.unit}，运行状态 active`;
    if(!['activating','reloading'].includes(active))throw new Error('服务状态为 '+(active||'未知'));
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error('等待服务进入 active 状态超时');
}
export {activateUpdate,restartUnit};

async function gitUpdate(j, steps) {
  if(await git(j,['status','--porcelain'])) throw new Error('Git 工作区存在本地修改，请先处理后再更新');
  const branch=await git(j,['branch','--show-current']);if(branch!==BRANCH)throw new Error('请切换到 '+BRANCH+' 分支后更新');
  const before = (await git(j, ['rev-parse', 'HEAD'])).trim();
  const output = await git(j, ['pull', '--ff-only', 'origin', BRANCH]);
  const after = (await git(j, ['rev-parse', 'HEAD'])).trim();
  const updated = before !== after;
  steps.push(`${BRANCH}: ${(output || '完成').split('\n').slice(-2).join(' ')}`);
  steps.push(updated ? `更新提交 ${before.slice(0, 7)} → ${after.slice(0, 7)}` : `已是最新提交 ${after.slice(0, 7)}`);
  return { updated, version: updated ? `${before.slice(0, 7)} → ${after.slice(0, 7)}` : `v${before.slice(0, 7)}` };
}

async function checkLatest(j) {
  state.currentVersion=await installedVersion(j.dir);
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, { headers: { 'User-Agent': 'shp-stronghold-updater', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(j.timeoutMs) });
  if (!response.ok) throw new Error(`获取最新 Release 失败：HTTP ${response.status}`);
  const release = await response.json();
  state.latestVersion = String(release.tag_name || release.name || '').replace(/^v/, '');
  state.checkedAt = Date.now();
  log(`最新 Release：v${state.latestVersion}`);
  return release;
}
async function releaseUpdate(j, steps, warnings) {
  phase('检查最新版本');
  const current = await installedVersion(j.dir);
  if(!current)throw new Error('无法读取本地 package.json 版本，已停止更新');
  const release = await checkLatest(j);
  const version = state.latestVersion;
  steps.push(`当前版本 v${current ?? '未知'}，最新 Release v${version}`);
  if (current && compareVersions(version, current) <= 0) { steps.push('已是最新，无需更新'); return { updated: false, version: `v${current}` }; }
  const asset = (release.assets || []).find(a => /-update\.zip$/i.test(a.name));
  if (!asset) throw new Error(`Release v${version} 没有增量更新包（-update.zip）`);
  steps.push(`下载 ${asset.name}（${mb(asset.size || 0)}）`);

  // Download and extract on the persistent disk, not a small /tmp tmpfs.
  await mkdir(dirname(j.statePath), { recursive: true });
  let backupReady=false;
  const work = await mkdtemp(join(dirname(j.statePath), 'shp-sh-update-'));
  try {
    const zip = join(work, asset.name);
    phase(`下载 ${asset.name}（${mb(asset.size || 0)}）`);
    await download(asset.browser_download_url, zip, j.timeoutMs, (bytes, total) => { state.progress = total ? Math.min(100, Math.floor(bytes * 100 / total)) : null; });
    log(`下载完成：${asset.name}`);
    const extract = join(work, 'x'); await mkdir(extract, { recursive: true });
    phase('解压更新包');
    await extractZip(zip, extract, j.timeoutMs);
    const root = await innerRoot(extract);
    const updatePath = join(root, 'UPDATE.json');
    let meta = null;
    if (!(await exists(updatePath)))throw new Error('更新包缺少 UPDATE.json，已停止更新');
    if (await exists(updatePath)) {
      meta = JSON.parse(await readFile(updatePath, 'utf8'));
      const from = Array.isArray(meta.from) ? meta.from : [];
      if (current && from.length && !from.includes(current)) throw new Error(`增量包 v${version} 只适用于 v${from.join('、')}，当前 v${current}：请先安装对应的完整包`);
      steps.push(`适用于 v${from.join('、') || '（未声明）'}`);
    }

    await validateStage(root,meta,j.dir);
    phase('备份原文件');
    const backup = await makeBackup(j, meta, current, version);
    log(`备份完成：${backup.count} 个文件`);
    backupReady=true;
    state.lastGood = { mode: 'release', backupDir: backup.dir, version: current, at: Date.now() };
    steps.push(`已创建回滚点（备份 ${backup.count} 个文件）`);

    phase('覆盖安装文件');
    const count = await overlayCopy(root, j.dir);
    log(`文件覆盖完成：${count} 个文件`);
    steps.push(`解压覆盖 ${count} 个文件 → ${j.dir}`);
    phase('应用官方更新');
    const applied = await applyOfficial(j.dir);
    log(applied.text);
    steps.push(applied.text);
    if(applied.failed)throw new Error(applied.text);
    await pruneBackups(j, backup.dir);
    return { updated: true, version: current ? `v${current} → v${version}` : `v${version}` };
  } catch(error) {
    if(backupReady){phase('更新异常，正在回滚');try{await rollbackRelease(j,steps);state.lastGood=null;}catch(rollbackError){throw new Error(error.message+'；回滚失败：'+rollbackError.message+'。请保留备份并手动恢复');}throw new Error(error.message+'；已恢复更新前文件');}
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Back up the files an update will overwrite/delete, and record the files it will newly create. */
async function makeBackup(j, meta, current, version) {
  const dir = join(j.backupRoot, new Date().toISOString().replace(/[:.]/g, '-'));
  const paths = new Set(['MANIFEST.json', 'UPDATE.json', '.update-applied.json', 'UPDATE.json.rejected']);
  if (meta?.files) for (const rel of Object.keys(meta.files)) paths.add(rel);
  if (Array.isArray(meta?.removed)) for (const item of meta.removed) if (item?.path) paths.add(item.path);
  const saved = [], added = [];
  for (const rel of paths) {
    const src = join(j.dir, ...rel.split('/'));
    if (await exists(src)) {
      const dst = join(dir, ...rel.split('/'));
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
      saved.push(rel);
    } else {
      added.push(rel);
    }
  }
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'backup.json'), JSON.stringify({ at: Date.now(), from: current, to: version, saved, added }, null, 2));
  return { dir, count: saved.length };
}

async function pruneBackups(j, keep) {
  let entries;
  try { entries = await readdir(j.backupRoot); } catch { return; }
  for (const name of entries) if (join(j.backupRoot, name) !== keep) await rm(join(j.backupRoot, name), { recursive: true, force: true }).catch(() => {});
}

async function rollbackRelease(j, steps, backupDir = state.lastGood?.backupDir) {
  if (!backupDir) throw new Error('没有可用的回滚点');
  const meta = JSON.parse(await readFile(join(backupDir, 'backup.json'), 'utf8'));
  for (const rel of meta.saved || []) {
    const src = join(backupDir, ...rel.split('/')), dst = join(j.dir, ...rel.split('/'));
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
  }
  for (const rel of meta.added || []) {
    const abs = join(j.dir, ...rel.split('/'));
    await rm(abs, { force: true }).catch(() => {});
    for (let d = dirname(abs); d.length > j.dir.length; d = dirname(d)) { try { await rmdir(d); } catch { break; } }
  }

  await rm(backupDir, { recursive: true, force: true }).catch(() => {});
  steps.push(`已回滚：恢复 ${(meta.saved || []).length} 个文件，删除 ${(meta.added || []).length} 个新增文件，重启服务后生效`);
}

async function download(url, file, timeoutMs, onProgress = () => {}) {
  const response = await fetch(url, { headers: { 'User-Agent': 'shp-stronghold-updater' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  let bytes = 0, last = 0;
  const source = Readable.fromWeb(response.body);
  source.on('data', chunk => {
    bytes += chunk.length;
    if (Date.now() - last >= 500) { last = Date.now(); onProgress(bytes, total); }
  });
  await pipeline(source, createWriteStream(file));
  onProgress(bytes, total);
}

async function extractZip(zip, dir, timeoutMs) {
  if(process.platform==='win32') {
    const quote=value=>"'"+value.replaceAll("'","''")+"'";
    const script=String.raw`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead(${quote(zip)}); try { foreach($e in $z.Entries){if($e.FullName -match '(^[/\\]|(^|[/\\])\.\.([/\\]|$)|:)' -or (($e.ExternalAttributes -shr 16) -band 61440) -eq 40960){throw 'Unsafe ZIP entry'}} } finally {$z.Dispose()}; [IO.Compression.ZipFile]::ExtractToDirectory(${quote(zip)},${quote(dir)})`;
    await command('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],timeoutMs);return;
  }
  const list=await command('unzip',['-Z1',zip],timeoutMs);
  for(const entry of list.split('\n').filter(Boolean))safePath(entry.replace(/\/$/,''));
  await command('unzip',['-o','-q',zip,'-d',dir],timeoutMs);
}
function safePath(path) {
  if(typeof path!=='string'||!path||path.includes('\\')||path.includes(':')||isAbsolute(path)||path.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('更新包包含不安全路径');
  return path;
}
async function validateStage(root,meta,target) {
  if(!meta?.files||typeof meta.files!=='object'||Array.isArray(meta.files))throw new Error('更新包文件清单无效');
  const allowed=new Set(['MANIFEST.json','UPDATE.json',...Object.keys(meta.files).map(safePath)]);
  for(const item of meta.removed||[])safePath(item.path);
  async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isSymbolicLink())throw new Error('更新包不允许符号链接');if(entry.isDirectory())await walk(path);else if(!allowed.has(relative(root,path).split('\\').join('/')))throw new Error('更新包包含未声明文件：'+entry.name);}}
  await walk(root);
  for(const rel of [...allowed,...(meta.removed||[]).map(x=>x.path)]){let cursor=target;for(const segment of rel.split('/')){cursor=join(cursor,segment);try{if((await lstat(cursor)).isSymbolicLink())throw new Error('安装目录更新路径包含符号链接');}catch(error){if(error.code!=='ENOENT')throw error;}}}
}
export {scheduleFor, safePath, validateStage, makeBackup, rollbackRelease, extractZip};

async function innerRoot(dir) {
  const roots = await readdir(dir);
  if (roots.length === 1) { const only = join(dir, roots[0]); if ((await stat(only)).isDirectory()) return only; }
  return dir;
}

async function overlayCopy(src, dest, counter = { count: 0 }) {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const from = join(src, entry.name), to = join(dest, entry.name);
    if (entry.isDirectory()) await overlayCopy(from, to, counter);
    else if (entry.isFile()) { await mkdir(dirname(to), { recursive: true }); await copyFile(from, to); counter.count += 1; }
  }
  return counter.count;
}

async function applyOfficial(repoDir) {
  const modPath = join(repoDir, 'server', 'update.js');
  if (!(await exists(modPath))) return {text:'未找到官方更新器 server/update.js',failed:true};
  try {
    const mod = await import(pathToFileURL(modPath).href+'?update='+Date.now());
    const quiet = { log() {}, warn() {}, error() {} };
    const result = await mod.applyPendingUpdate(repoDir, { log: quiet });
    if (result.state === 'applied') return { text: `已应用更新：校验 ${result.checked ?? 0} 个文件`, failed: false };
    if (result.state === 'none') return {text:'官方更新器未发现待应用更新，已停止并恢复',failed:true};
    if (result.state === 'failed') {
      await rename(join(repoDir, 'UPDATE.json'), join(repoDir, 'UPDATE.json.rejected')).catch(() => {});
      return { text: `更新包与当前安装不匹配（${result.reason || '文件不一致'}）`, failed: true };
    }
    return { text: `更新包未应用（${result.state}）`, failed: true };
  } catch (error) {
    return { text: `应用更新出错：${error.message}`, failed: true };
  }
}
