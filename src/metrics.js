import os from 'node:os';
import { readFile, statfs } from 'node:fs/promises';
import si from 'systeminformation';

const percent = (used, total) => total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : null;

export function cpuDelta(previous, current) {
  if (!previous || previous.length !== current.length) return { percent: null, cores: current.map(() => null) };
  const deltas = current.map((cpu, i) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0) - Object.values(previous[i].times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle - previous[i].times.idle;
    return { total, used: total - idle };
  });
  return {
    percent: percent(deltas.reduce((n, x) => n + x.used, 0), deltas.reduce((n, x) => n + x.total, 0)),
    cores: deltas.map(x => percent(x.used, x.total))
  };
}

export function parseMeminfo(text) {
  return Object.fromEntries([...text.matchAll(/^(\w+):\s+(\d+)\s+kB/gm)].map(([, key, value]) => [key, Number(value) * 1024]));
}

export function parseNetDev(text) {
  return text.split('\n').flatMap(line => {
    const match = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!match || match[1] === 'lo') return [];
    const fields = match[2].trim().split(/\s+/).map(Number);
    if (fields.length < 16 || fields.some(n => !Number.isFinite(n) || n < 0)) return [];
    return [{ name: match[1], rxBytes: fields[0], txBytes: fields[8], rxErrors: fields[2], txErrors: fields[10] }];
  });
}

export function networkDelta(previous, current, seconds) {
  return current.map(item => {
    const before = previous?.find(x => x.name === item.name);
    const valid = before && seconds > 0 && Number.isFinite(item.rxBytes) && Number.isFinite(item.txBytes) && Number.isFinite(before.rxBytes) && Number.isFinite(before.txBytes) && item.rxBytes >= before.rxBytes && item.txBytes >= before.txBytes;
    return { ...item, rxBytesPerSec: valid ? (item.rxBytes - before.rxBytes) / seconds : null, txBytesPerSec: valid ? (item.txBytes - before.txBytes) / seconds : null };
  });
}

export function normalizeNetwork(rows, internalNames = []) {
  const value = n => Number.isFinite(n) && n >= 0 ? n : null;
  const normalized = rows.filter(row => row.iface && !internalNames.includes(row.iface) && !/^lo\d*$/.test(row.iface) && !/^loopback/i.test(row.iface)).map(row => ({
    name: row.iface, rxBytes: value(row.rx_bytes), txBytes: value(row.tx_bytes), rxErrors: value(row.rx_errors), txErrors: value(row.tx_errors)
  }));
  // Some Windows adapters are reported more than once by the system provider.
  return [...new Map(normalized.map(row => [row.name, row])).values()];
}

async function deadline(promise, ms = 6000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('系统采集超时')), ms); })]); }
  finally { clearTimeout(timer); }
}

export async function portableMetrics(provider = si) {
  const [memory, network] = await Promise.allSettled([deadline(provider.mem()), deadline(provider.networkStats('*'))]);
  return { memory, network };
}

export function createHostMonitor(options = {}) {
  let previousCpu, previousNet, previousAt;
  const diskPaths = options.diskPaths || [os.platform() === 'win32' ? process.cwd() : '/'];
  return async function sampleHost() {
    const cpus = os.cpus(), now = performance.now(), warnings = [];
    const cpu = cpuDelta(previousCpu, cpus); previousCpu = cpus;
    let available = os.freemem(), total = os.totalmem(), swap = null, interfaces = null;
    if (os.platform() === 'linux') {
      try {
        const mem = parseMeminfo(await readFile('/proc/meminfo', 'utf8'));
        total = mem.MemTotal || total;
        // MemAvailable excludes reclaimable caches from used memory.
        available = mem.MemAvailable ?? mem.MemFree ?? available;
        swap = { total: mem.SwapTotal ?? 0, used: (mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0) };
      } catch { warnings.push('无法读取 /proc/meminfo，内存回退到系统空闲内存口径'); }
      try {
        const net = parseNetDev(await readFile('/proc/net/dev', 'utf8'));
        const selected = options.networkInterfaces?.length ? net.filter(x => options.networkInterfaces.includes(x.name)) : net;
        interfaces = networkDelta(previousNet, selected, previousAt === undefined ? 0 : (now - previousAt) / 1000);
        previousNet = selected;
      } catch { warnings.push('无法读取 /proc/net/dev，网络速率不可用'); }
    } else if (['win32', 'darwin'].includes(os.platform())) {
      const portable = await portableMetrics();
      if (portable.memory.status === 'fulfilled') {
        const mem = portable.memory.value;
        if (Number.isFinite(mem.total) && mem.total > 0) total = mem.total;
        if (Number.isFinite(mem.available) && mem.available >= 0) available = mem.available;
        if (Number.isFinite(mem.swaptotal) && Number.isFinite(mem.swapused)) swap = { total: mem.swaptotal, used: mem.swapused };
      } else warnings.push('系统内存详情读取失败，使用基本内存信息');
      if (portable.network.status === 'fulfilled') {
        const internalNames = Object.entries(os.networkInterfaces()).filter(([, list]) => list?.every(x => x.internal)).map(([name]) => name);
        const rows = normalizeNetwork(portable.network.value, internalNames);
        const selected = options.networkInterfaces?.length ? rows.filter(x => options.networkInterfaces.includes(x.name)) : rows;
        interfaces = networkDelta(previousNet, selected, previousAt === undefined ? 0 : (now - previousAt) / 1000);
        previousNet = selected;
        if (!rows.length) warnings.push('系统未返回可用网卡，请检查系统权限和网卡状态');
      } else warnings.push('网络统计读取失败，请检查系统权限或采集命令可用性');
    }
    previousAt = now;
    const disks = await Promise.all(diskPaths.map(async path => {
      try {
        const fs = await statfs(path);
        const total = fs.blocks * fs.bsize, free = fs.bfree * fs.bsize, available = fs.bavail * fs.bsize;
        return { path, total, used: total - free, available, percent: percent(total - free, total), error: null };
      } catch (error) { return { path, total: null, used: null, available: null, percent: null, error: error.code || '不可用' }; }
    }));
    const ratesAvailable = interfaces?.length && interfaces.every(x => x.rxBytesPerSec !== null);
    return {
      at: Date.now(), hostname: os.hostname(), platform: os.platform(), release: os.release(), arch: os.arch(),
      scope: 'host',
      cpus: os.availableParallelism(), logicalCpus: cpus.length, cpuModel: cpus[0]?.model || '未知',
      cpuPercent: cpu.percent, cpuCores: cpu.cores,
      load: os.platform() === 'win32' ? null : os.loadavg(),
      memoryTotal: total, memoryFree: available, memoryUsed: total - available, memoryPercent: percent(total - available, total), swap,
      disks,
      network: { supported: ['linux', 'win32', 'darwin'].includes(os.platform()), available: interfaces !== null, interfaces, rxBytesPerSec: ratesAvailable ? interfaces.reduce((n, x) => n + x.rxBytesPerSec, 0) : null, txBytesPerSec: ratesAvailable ? interfaces.reduce((n, x) => n + x.txBytesPerSec, 0) : null },
      uptimeSec: os.uptime(), dashboardRss: process.memoryUsage().rss, warnings
    };
  };
}
