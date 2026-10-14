import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpuDelta, parseMeminfo, parseNetDev, networkDelta, createHostMonitor, normalizeNetwork, portableMetrics } from '../src/metrics.js';
import { validateConfig } from '../src/core.js';

test('CPU 使用率基于两次计数器差值，首次或核心变化不报假数据', () => {
  const cpu = (user, idle) => ({ times: { user, idle, sys: 0, nice: 0, irq: 0 } });
  assert.equal(cpuDelta(undefined, [cpu(10, 90)]).percent, null);
  const result = cpuDelta([cpu(10, 90), cpu(10, 90)], [cpu(40, 160), cpu(90, 110)]);
  assert(Math.abs(result.percent - 55) < 1e-9);
  assert.deepEqual(result.cores, [30, 80]);
  assert.equal(cpuDelta([cpu(0, 0)], [cpu(0, 0)]).percent, null);
  assert.equal(cpuDelta([cpu(0, 0)], [cpu(0, 0), cpu(0, 0)]).percent, null);
});

test('Linux 内存与网卡解析，网络首采样和计数器重置返回不可用', () => {
  assert.deepEqual(parseMeminfo('MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 0 kB\n'), { MemTotal: 1024000, MemAvailable: 409600, SwapTotal: 0 });
  const row = (name, rx, tx) => ` ${name}: ${rx} 1 2 0 0 0 0 0 ${tx} 1 3 0 0 0 0 0`;
  const before = parseNetDev([row('lo', 999, 999), row('eth0', 100, 200)].join('\n'));
  assert.equal(before.length, 1); assert.equal(before[0].name, 'eth0');
  const current = parseNetDev(row('eth0', 300, 600));
  const rates = networkDelta(before, current, 2);
  assert.equal(rates[0].rxBytesPerSec, 100); assert.equal(rates[0].txBytesPerSec, 200);
  assert.equal(networkDelta(undefined, current, 2)[0].rxBytesPerSec, null);
  assert.equal(networkDelta(current, before, 2)[0].rxBytesPerSec, null);
  assert.equal(networkDelta(before, current, 0)[0].txBytesPerSec, null);
});

test('主机真实采样，磁盘失败降级且下一采样产生 CPU 占用', async () => {
  const monitor = createHostMonitor({ diskPaths: [tmpdir(), join(tmpdir(), `shp-nonexistent-${Date.now()}`)] });
  const first = await monitor();
  assert.equal(first.cpuPercent, null);
  assert(first.memoryTotal > 0);
  assert(first.disks[0].total > 0);
  assert.equal(first.disks[1].percent, null); assert(first.disks[1].error);
  await new Promise(resolve => setTimeout(resolve, 50));
  const second = await monitor();
  assert(second.cpuPercent >= 0 && second.cpuPercent <= 100);
  assert.equal(second.network.supported, ['linux', 'win32', 'darwin'].includes(process.platform));
});

test('主机采样配置边界', () => {
  const servers = [{ id: 'main', url: 'http://localhost:3000' }];
  assert.equal(validateConfig({ servers }).host.pollIntervalSeconds, 5);
  assert.throws(() => validateConfig({ servers, host: { pollIntervalSeconds: 0 } }));
  assert.throws(() => validateConfig({ servers, host: { diskPaths: [] } }));
  assert.throws(() => validateConfig({ servers, host: { networkInterfaces: 'eth0' } }));
});

test('跨平台网卡归一化，负计数器和回环不会伪造为零', () => {
  const rows = normalizeNetwork([{ iface: 'Loopback', rx_bytes: 100, tx_bytes: 100 }, { iface: 'Wi-Fi', rx_bytes: 1000, tx_bytes: 2000, rx_errors: -1, tx_errors: 0 }, { iface: 'en0', rx_bytes: -1, tx_bytes: -1 }], ['Loopback']);
  assert.equal(rows.length, 2); assert.equal(rows[0].rxErrors, null); assert.equal(rows[1].rxBytes, null);
  assert.equal(networkDelta(rows, rows, 5)[1].rxBytesPerSec, null);
});

test('Windows/macOS 采集适配器独立降级', async () => {
  const result = await portableMetrics({ mem: async () => ({ total: 100, available: 60, swaptotal: 20, swapused: 4 }), networkStats: async () => [{ iface: 'en0', rx_bytes: 10, tx_bytes: 20 }] });
  assert.equal(result.memory.status, 'fulfilled'); assert.equal(result.network.value[0].iface, 'en0');
  const failed = await portableMetrics({ mem: async () => { throw new Error('拒绝访问'); }, networkStats: async () => [] });
  assert.equal(failed.memory.status, 'rejected'); assert.equal(failed.network.status, 'fulfilled');
});
