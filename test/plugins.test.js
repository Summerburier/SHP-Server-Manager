import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginManager } from '../src/plugins.js';

const find = (manager, id) => manager.list().instances.find(instance => instance.id === id);

test('插件扫描、启停、结果、持久化恢复与异常处理', { timeout: 20000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'shp-plugins-'));
  const directory = join(temp, 'plugins'), data = join(temp, 'data');
  await mkdir(join(directory, 'example'), { recursive: true }); await mkdir(data);
  const manifest = { id: 'example', name: '测试插件', version: '1.0.0', apiVersion: 1, entry: 'main.mjs' };
  await writeFile(join(directory, 'example', 'plugin.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'example', 'main.mjs'), 'export function collect(snapshot) { if(snapshot.fail) throw new Error("测试异常"); return { value: snapshot.value }; }');
  const manager = new PluginManager(directory, data);
  let restored;
  t.after(async () => { await manager.close(); await restored?.close(); await rm(temp, { recursive: true, force: true }); });
  await manager.init(); assert.equal(find(manager, 'example').status, 'disabled');
  await manager.toggle('example', true); await manager.collect({ value: 42 });
  assert.equal(find(manager, 'example').status, 'enabled'); assert.equal(find(manager, 'example').result.value, 42);
  assert.equal(JSON.parse(await readFile(join(data, 'plugins.json'), 'utf8')).instances.find(i => i.id === 'example').enabled, true);
  await manager.close(); restored = new PluginManager(directory, data); await restored.init();
  assert.equal(find(restored, 'example').status, 'enabled');
  await restored.collect({ fail: true }); assert.equal(find(restored, 'example').status, 'error');
  await restored.toggle('example', false); assert.equal(find(restored, 'example').enabled, false);
  await assert.rejects(restored.toggle('missing', true));
  await mkdir(join(directory, 'bad')); await writeFile(join(directory, 'bad', 'plugin.json'), JSON.stringify({ ...manifest, id: 'bad', entry: '../../outside.mjs' }));
  await writeFile(join(temp, 'outside.mjs'), 'export function collect() {}');
  await restored.rescan();
  assert.equal(restored.list().plugins.length, 1); assert.equal(restored.list().instances.length, 1); assert.equal(restored.list().errors.length, 1);
});

test('插件死循环超时终止，不阻塞主线程', { timeout: 12000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'shp-plugins-timeout-'));
  await mkdir(join(temp, 'plugins', 'slow'), { recursive: true }); await mkdir(join(temp, 'data'));
  await writeFile(join(temp, 'plugins', 'slow', 'plugin.json'), JSON.stringify({ id: 'slow', name: '超时测试', version: '1', apiVersion: 1, entry: 'main.mjs' }));
  await writeFile(join(temp, 'plugins', 'slow', 'main.mjs'), 'export function collect() { while(true) {} }');
  const manager = new PluginManager(join(temp, 'plugins'), join(temp, 'data'));
  t.after(async () => { await manager.close(); await rm(temp, { recursive: true, force: true }); });
  await manager.init(); await manager.toggle('slow', true); await manager.collect({});
  assert.equal(find(manager, 'slow').status, 'error'); assert.match(find(manager, 'slow').error, /超时/);
});

test('插件设置声明、保存、校验与整体设置快照', { timeout: 20000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'shp-plugins-settings-'));
  const directory = join(temp, 'plugins'), data = join(temp, 'data');
  await mkdir(join(directory, 'tuner'), { recursive: true }); await mkdir(data);
  const manifest = {
    id: 'tuner', name: '调参插件', version: '1.0.0', apiVersion: 1, entry: 'main.mjs',
    settings: [
      { key: 'threshold', type: 'number', label: '阈值', default: 80, min: 1, max: 100 },
      { key: 'alert', type: 'boolean', default: true },
      { key: 'mode', type: 'select', default: 'fast', options: [{ value: 'fast', label: '快' }, { value: 'slow', label: '慢' }] },
      { key: 'label', type: 'text', default: 'x' }
    ]
  };
  await writeFile(join(directory, 'tuner', 'plugin.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'tuner', 'main.mjs'),
    'export function collect(snapshot, context) { return { threshold: context.settings.threshold, mode: context.settings.mode, sample: snapshot.value, globalServers: (context.global.servers || []).length, poll: context.global.pollIntervalSeconds }; }');
  const manager = new PluginManager(directory, data);
  t.after(async () => { await manager.close(); await rm(temp, { recursive: true, force: true }); });
  await manager.init();
  const first = find(manager, 'tuner');
  assert.deepEqual(first.values, { threshold: 80, alert: true, mode: 'fast', label: 'x' });
  assert.equal(first.settings.length, 4);

  await manager.toggle('tuner', true);
  await manager.collect({ value: 7 }, { pollIntervalSeconds: 15, servers: [{ id: 'a' }, { id: 'b' }] });
  assert.deepEqual(find(manager, 'tuner').result, { threshold: 80, mode: 'fast', sample: 7, globalServers: 2, poll: 15 });

  await manager.updateSettings('tuner', { threshold: 250, alert: 'false', mode: 'slow', label: ' ok ', extra: 'ignored' });
  assert.deepEqual(find(manager, 'tuner').values, { threshold: 100, alert: false, mode: 'slow', label: ' ok ' });
  assert.deepEqual(JSON.parse(await readFile(join(data, 'plugins.json'), 'utf8')).instances.find(i => i.id === 'tuner').settings, { threshold: 100, alert: false, mode: 'slow', label: ' ok ' });
  await assert.rejects(manager.updateSettings('tuner', { mode: 'nope' }), /取值无效/);
  assert.equal(find(manager, 'tuner').status, 'enabled');

  await manager.collect({ value: 1 }, { pollIntervalSeconds: 30, servers: [] });
  const after = find(manager, 'tuner').result;
  assert.equal(after.threshold, 100); assert.equal(after.mode, 'slow'); assert.equal(after.poll, 30); assert.equal(after.globalServers, 0);
});

test('清单 settings 结构非法时进入扫描错误，不影响其他插件', { timeout: 20000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'shp-plugins-schema-'));
  const directory = join(temp, 'plugins'), data = join(temp, 'data');
  await mkdir(join(directory, 'broken'), { recursive: true }); await mkdir(data);
  await writeFile(join(directory, 'broken', 'plugin.json'), JSON.stringify({ id: 'broken', name: '坏设置', version: '1.0.0', apiVersion: 1, entry: 'main.mjs', settings: [{ key: 'x', type: 'color' }] }));
  await writeFile(join(directory, 'broken', 'main.mjs'), 'export function collect() { return {}; }');
  const manager = new PluginManager(directory, data);
  t.after(async () => { await manager.close(); await rm(temp, { recursive: true, force: true }); });
  await manager.init();
  assert.equal(manager.list().plugins.length, 0);
  assert.equal(manager.list().errors.length, 1);
  assert.match(manager.list().errors[0], /type/);
});

test('多实例：同一插件绑定不同服务，各自独立设置与结果', { timeout: 20000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'shp-plugins-multi-'));
  const directory = join(temp, 'plugins'), data = join(temp, 'data');
  await mkdir(join(directory, 'multi'), { recursive: true }); await mkdir(data);
  await writeFile(join(directory, 'multi', 'plugin.json'), JSON.stringify({ id: 'multi', name: '多实例', version: '1.0.0', apiVersion: 1, entry: 'main.mjs', settings: [{ key: 'target', type: 'text', label: '目标', default: '' }] }));
  await writeFile(join(directory, 'multi', 'main.mjs'),
    'export function collect(snapshot, context) { return { service: context.service, target: context.settings.target, instance: context.instance.id }; }');
  const manager = new PluginManager(directory, data);
  let restored;
  t.after(async () => { await manager.close(); await restored?.close(); await rm(temp, { recursive: true, force: true }); });
  await manager.init();
  assert.equal(manager.list().instances.length, 1);

  await manager.addInstance('multi', { label: '主服', service: 'main', settings: { target: 'A' } });
  await manager.addInstance('multi', { label: '测试服', service: 'test', settings: { target: 'B' } });
  assert.deepEqual(manager.list().instances.map(i => i.label), ['多实例', '主服', '测试服']);

  await manager.updateSettings('multi-2', { target: 'A2' });
  assert.equal(find(manager, 'multi-2').values.target, 'A2');
  assert.equal(find(manager, 'multi').values.target, '');

  await manager.toggle('multi-2', true);
  await manager.toggle('multi-3', true);
  await manager.collect({});
  assert.deepEqual(find(manager, 'multi-2').result, { service: 'main', target: 'A2', instance: 'multi-2' });
  assert.deepEqual(find(manager, 'multi-3').result, { service: 'test', target: 'B', instance: 'multi-3' });

  await manager.close(); restored = new PluginManager(directory, data); await restored.init();
  assert.equal(restored.list().instances.length, 3);
  assert.equal(find(restored, 'multi-2').service, 'main');
  assert.equal(find(restored, 'multi-2').status, 'enabled');
  assert.deepEqual(JSON.parse(await readFile(join(data, 'plugins.json'), 'utf8')).instances.map(i => i.service), ['', 'main', 'test']);

  await restored.removeInstance('multi-3');
  assert.equal(restored.list().instances.length, 2);
  await restored.removeInstance('multi-2');
  await restored.removeInstance('multi');            // 最后一个实例也可以移除
  assert.equal(restored.list().instances.length, 0);
  await restored.rescan();                            // 移除到空后重新扫描不会自动补回
  assert.equal(restored.list().instances.length, 0);
  await restored.addInstance('multi', { label: '新实例' }); // 需要时再添加
  assert.deepEqual(restored.list().instances.map(i => i.label), ['新实例']);
});
