import { timingSafeEqual } from 'node:crypto';

export function secretEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
}

export function validateConfig(config) {
  const rawServers = config.servers ?? [];
  if (!Array.isArray(rawServers) || rawServers.length > 32) throw new Error('最多配置 32 个服务');
  // Validate on shallow copies so callers keep their own objects (no aliasing side effects).
  const servers = rawServers.map(server => ({ ...server }));
  const ids = new Set();
  for (const server of servers) {
    if (!/^[a-z0-9_-]{1,48}$/i.test(server.id) || ids.has(server.id)) throw new Error('服务器 id 必须唯一且只含字母、数字、_、-');
    ids.add(server.id);
    if(server.source !== undefined) {
      if(typeof server.source !== 'string' || !server.source.trim()) throw new Error('source 必须是本地项目目录或 .service 名称');
      delete server.systemd;delete server.project;
      if(server.source.endsWith('.service')) server.systemd = {unit:server.source,sudo:server.sudo === true};
      else server.project = {...(server.projectOptions || {}),path:server.source};
    }
    if (!server.url && !server.systemd && !server.project) throw new Error("服务需要 url、systemd 或 project");
    if (server.systemd && server.project) throw new Error("systemd 与 project 只能选择一种");
    if (server.systemd && (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*\.service$/.test(server.systemd.unit) || typeof server.systemd.sudo !== "undefined" && typeof server.systemd.sudo !== "boolean")) throw new Error("systemd.unit 必须是有效 .service 名称");
    if (server.project && (typeof server.project.path !== "string" || !server.project.path.trim() || server.project.entry !== undefined && typeof server.project.entry !== "string" || server.project.args !== undefined && (!Array.isArray(server.project.args) || server.project.args.some(x => typeof x !== "string")))) throw new Error("project 需要目录 path 和可选 entry / args");
    if (server.project?.env && (typeof server.project.env !== "object" || Array.isArray(server.project.env) || Object.values(server.project.env).some(x => typeof x !== "string"))) throw new Error("project.env 必须为字符串键值对象");
    if (server.url) {
    const url = new URL(server.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('url 必须为无认证信息的 HTTP(S) 根地址');
    }
    for (const [name, action] of Object.entries(server.actions || {})) {
      if (!['start', 'stop', 'restart'].includes(name) || !action.command || typeof action.command !== 'string' || !Array.isArray(action.args) || action.args.some(x => typeof x !== 'string')) throw new Error('管理操作必须为 start/stop/restart，并配置 command 和字符串数组 args');
    }
  }
  const poll = config.pollIntervalSeconds ?? 15, retention = config.retentionHours ?? 24;
  if (!Number.isFinite(poll) || poll < 5 || poll > 3600 || !Number.isFinite(retention) || retention < 1 || retention > 168) throw new Error('采样间隔应为 5–3600 秒，保留时间为 1–168 小时');
  const host = config.host || {};
  const hostPoll = host.pollIntervalSeconds ?? 5;
  if (!Number.isFinite(hostPoll) || hostPoll < 2 || hostPoll > 60) throw new Error('主机采样间隔应为 2–60 秒');
  for (const key of ['diskPaths', 'networkInterfaces']) {
    if (host[key] !== undefined && (!Array.isArray(host[key]) || host[key].length > 32 || host[key].some(x => typeof x !== 'string' || !x.trim()))) throw new Error(`host.${key} 必须为不超过 32 个非空字符串的数组`);
  }
  if (host.diskPaths && !host.diskPaths.length) throw new Error('diskPaths 至少配置一个目录');
  return { ...config, servers, pollIntervalSeconds: poll, retentionHours: retention, host: { ...host, pollIntervalSeconds: hostPoll } };
}

export async function probe(server, timeout = 5000) {
  const start = performance.now();
  try {
    const response = await fetch(new URL('/healthz?traffic=1', server.url), { signal: AbortSignal.timeout(timeout), redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    let bytes = 0, chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 262144) throw new Error('健康响应超过 256 KiB');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const health = JSON.parse(Buffer.concat(chunks).toString());
    if (health.ok !== true || !['sockets', 'rooms', 'humans', 'matches', 'uptimeSec'].every(k => Number.isFinite(health[k]) && health[k] >= 0)) throw new Error('不兼容的游戏健康接口');
    return { at: Date.now(), online: true, latencyMs: Math.round(performance.now() - start), health };
  } catch (error) {
    return { at: Date.now(), online: false, latencyMs: null, error: error.name === 'TimeoutError' ? '连接超时' : error.message };
  }
}
