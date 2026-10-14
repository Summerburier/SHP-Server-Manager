import { Worker } from 'node:worker_threads';
import { readFile, readdir, realpath, writeFile, rename } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const KEY_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const ACTION_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const FIELD_TYPES = ['number', 'text', 'boolean', 'select'];

/**
 * Normalize the optional `settings` schema of a manifest into a serializable field list.
 * Returns null when the manifest declares no schema (its `config` object is then used as-is).
 */
function normalizeSchema(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw new Error('settings 必须为字段数组');
  const seen = new Set();
  return raw.map(field => {
    if (!field || typeof field.key !== 'string' || !KEY_RE.test(field.key) || seen.has(field.key)) {
      throw new Error('settings 每个字段都需要唯一且合法的 key');
    }
    seen.add(field.key);
    const type = field.type ?? 'text';
    if (!FIELD_TYPES.includes(type)) throw new Error(`settings.${field.key} 的 type 必须为 number/text/boolean/select`);
    const out = { key: field.key, type, label: typeof field.label === 'string' && field.label ? field.label : field.key };
    if (field.default !== undefined) out.default = field.default;
    if (type === 'number') {
      if (Number.isFinite(field.min)) out.min = field.min;
      if (Number.isFinite(field.max)) out.max = field.max;
    }
    if (type === 'select') {
      if (!Array.isArray(field.options) || !field.options.length || field.options.some(o => !o || typeof o.value !== 'string')) {
        throw new Error(`settings.${field.key} 需要非空的 options [{ value, label }]`);
      }
      out.options = field.options.map(o => ({ value: o.value, label: typeof o.label === 'string' && o.label ? o.label : o.value }));
    }
    return out;
  });
}

/** Normalize the optional `actions` of a manifest into [{key,label,danger}] (buttons on the instance). */
function normalizeActions(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('actions 必须为数组');
  const seen = new Set();
  return raw.map(action => {
    if (!action || typeof action.key !== 'string' || !ACTION_KEY_RE.test(action.key) || seen.has(action.key)) throw new Error('actions 每项需要唯一且合法的 key');
    seen.add(action.key);
    return { key: action.key, label: typeof action.label === 'string' && action.label ? action.label : action.key, danger: action.danger === true };
  });
}

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const objectOrEmpty = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/**
 * Plugins support multiple instances: one plugin can be bound to several services, each with its own
 * settings and worker. A plugin always keeps at least one instance (disabled by default).
 */
export class PluginManager {
  constructor(directory, dataDir) {
    this.directory = directory;
    this.statePath = resolve(dataDir, 'plugins.json');
    this.catalog = new Map();     // pluginId -> manifest {id,name,version,description,entry,config,schema}
    this.instances = new Map();   // instanceId -> runtime instance
    this.persisted = new Map();   // instanceId -> {id,pluginId,label,service,enabled,settings}
    this.emptyPlugins = new Set(); // plugins whose instances were all removed: do not auto-add one back
    this.global = {};
    this.queue = Promise.resolve();
    this.requestId = 0;
    this.scanningErrors = [];
  }
  async init() {
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (Array.isArray(state.instances)) {
        for (const item of state.instances) {
          if (!item || typeof item.id !== 'string' || typeof item.pluginId !== 'string' || !ID_RE.test(item.id)) continue;
          this.persisted.set(item.id, {
            id: item.id, pluginId: item.pluginId,
            label: typeof item.label === 'string' ? item.label : '', service: typeof item.service === 'string' ? item.service : '',
            enabled: !!item.enabled, settings: objectOrEmpty(item.settings)
          });
        }
        if (Array.isArray(state.emptyPlugins)) for (const id of state.emptyPlugins) if (typeof id === 'string') this.emptyPlugins.add(id);
      } else {
        // Legacy single-instance state: { enabled: [...], settings: {...} }
        const enabled = new Set(Array.isArray(state.enabled) ? state.enabled.filter(x => typeof x === 'string') : []);
        const settings = objectOrEmpty(state.settings);
        for (const id of new Set([...enabled, ...Object.keys(settings)])) {
          if (!ID_RE.test(id)) continue;
          this.persisted.set(id, { id, pluginId: id, label: '', service: '', enabled: enabled.has(id), settings: objectOrEmpty(settings[id]) });
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await this.rescan();
  }
  serialize(task) {
    const next = this.queue.then(task); this.queue = next.catch(() => {}); return next;
  }
  async save() {
    const instances = [...this.persisted.values()].filter(item => this.catalog.has(item.pluginId));
    const emptyPlugins = [...this.emptyPlugins].filter(id => this.catalog.has(id));
    await writeFile(this.statePath + '.tmp', JSON.stringify({ instances, emptyPlugins }), { mode: 0o600 });
    await rename(this.statePath + '.tmp', this.statePath);
  }
  pluginOf(instance) { return this.catalog.get(instance.pluginId); }
  /** Declared default values of a plugin (schema `default` → manifest `config` → type fallback). */
  defaults(plugin) {
    const out = {};
    const fields = Array.isArray(plugin?.schema) ? plugin.schema : [];
    if (fields.length) {
      for (const field of fields) {
        if (field.default !== undefined) out[field.key] = field.default;
        else if (plugin.config && plugin.config[field.key] !== undefined) out[field.key] = plugin.config[field.key];
        else out[field.key] = field.type === 'number' ? 0 : field.type === 'boolean' ? false : field.type === 'select' ? field.options[0].value : '';
      }
    } else if (plugin?.config && typeof plugin.config === 'object') {
      for (const [key, value] of Object.entries(plugin.config)) if (KEY_RE.test(key)) out[key] = value;
    }
    return out;
  }
  /** Effective values of one instance: plugin defaults merged with that instance's saved overrides. */
  values(instance) {
    const defaults = this.defaults(this.pluginOf(instance));
    const merged = { ...defaults, ...objectOrEmpty(instance.settings) };
    return Object.fromEntries(Object.entries(merged).filter(([key]) => key in defaults));
  }
  /** Validate and coerce an incoming settings object against the plugin's declared defaults/schema. */
  coerce(plugin, input) {
    const defaults = this.defaults(plugin);
    const fields = new Map((Array.isArray(plugin?.schema) ? plugin.schema : []).map(field => [field.key, field]));
    const source = objectOrEmpty(input);
    const out = {};
    for (const [key, fallback] of Object.entries(defaults)) {
      const field = fields.get(key);
      const type = field?.type ?? (typeof fallback === 'number' ? 'number' : typeof fallback === 'boolean' ? 'boolean' : 'text');
      const raw = source[key];
      if (raw === undefined) { out[key] = fallback; continue; }
      if (type === 'number') {
        const number = Number(raw);
        if (!Number.isFinite(number)) throw new Error(`设置「${field?.label || key}」需要数字`);
        out[key] = Math.min(field?.max ?? Infinity, Math.max(field?.min ?? -Infinity, number));
      } else if (type === 'boolean') {
        out[key] = raw === true || raw === 'true' || raw === 1 || raw === '1';
      } else if (type === 'select') {
        const allowed = (field?.options || []).map(option => option.value);
        const value = String(raw);
        if (allowed.length && !allowed.includes(value)) throw new Error(`设置「${field?.label || key}」取值无效`);
        out[key] = value;
      } else {
        out[key] = String(raw ?? '');
      }
    }
    return out;
  }
  /** Worker context: this instance's own settings plus a read-only snapshot of the dashboard settings. */
  context(instance) {
    const values = this.values(instance);
    return { config: values, settings: values, global: this.global, service: instance.service || '', instance: { id: instance.id, label: instance.label || instance.pluginId } };
  }
  list() {
    const instances = [...this.instances.values()].map(instance => {
      const plugin = this.pluginOf(instance);
      return {
        id: instance.id, pluginId: instance.pluginId, pluginName: plugin?.name || instance.pluginId,
        label: instance.label || plugin?.name || instance.pluginId, service: instance.service || '', description: plugin?.description || '', version: plugin?.version || '',
        enabled: !!instance.enabled, status: instance.status, error: instance.error, updatedAt: instance.updatedAt, result: instance.result,
        settings: plugin?.schema ? clone(plugin.schema) : null, values: this.values(instance),
        actions: plugin?.actions ? clone(plugin.actions) : []
      };
    });
    return {
      directory: this.directory, errors: this.scanningErrors,
      plugins: [...this.catalog.values()].map(p => ({ id: p.id, name: p.name, version: p.version, description: p.description, schema: p.schema ? clone(p.schema) : null })),
      instances
    };
  }
  rescan() { return this.serialize(async () => {
    let folders;
    try { folders = await readdir(this.directory, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; folders = []; }
    this.scanningErrors = [];
    const found = new Set();
    for (const folder of folders.filter(x => x.isDirectory())) {
      try {
        const dir = await realpath(resolve(this.directory, folder.name));
        const raw = JSON.parse(await readFile(resolve(dir, 'plugin.json'), 'utf8'));
        const manifest = {
          id: raw.id, name: raw.name, version: raw.version, apiVersion: raw.apiVersion, entry: raw.entry,
          description: typeof raw.description === 'string' ? raw.description : '',
          config: objectOrEmpty(raw.config), schema: normalizeSchema(raw.settings), actions: normalizeActions(raw.actions)
        };
        if (manifest.id !== folder.name || !ID_RE.test(manifest.id) || !manifest.name || typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || manifest.apiVersion !== 1) throw new Error('清单需包含与目录相同的 id、name、version 及 apiVersion:1');
        if (typeof manifest.entry !== 'string') throw new Error('缺少 entry');
        const entry = await realpath(resolve(dir, manifest.entry));
        const rel = relative(dir, entry);
        if (!rel || rel.startsWith('..') || isAbsolute(rel) || !/\.m?js$/.test(entry)) throw new Error('entry 必须是插件目录内的 JS 文件');
        manifest.entry = entry;
        found.add(manifest.id);
        this.catalog.set(manifest.id, manifest);
      } catch (error) { this.scanningErrors.push(`${folder.name}: ${error.message}`); }
    }
    for (const id of [...this.catalog.keys()]) if (!found.has(id)) this.catalog.delete(id);

    // Drop instances/marks of plugins that no longer exist; give a brand-new plugin one default
    // instance (unless its instances were explicitly all removed before).
    for (const [id, item] of this.persisted) if (!this.catalog.has(item.pluginId)) this.persisted.delete(id);
    for (const id of [...this.emptyPlugins]) if (!this.catalog.has(id)) this.emptyPlugins.delete(id);
    for (const pluginId of this.catalog.keys()) {
      if (!this.emptyPlugins.has(pluginId) && ![...this.persisted.values()].some(item => item.pluginId === pluginId)) {
        this.persisted.set(pluginId, { id: pluginId, pluginId, label: '', service: '', enabled: false, settings: {} });
      }
    }
    const wanted = new Set();
    for (const [id, item] of this.persisted) {
      wanted.add(id);
      const plugin = this.catalog.get(item.pluginId);
      let instance = this.instances.get(id);
      if (!instance) instance = { id, pending: new Map(), worker: null, result: null, error: null, status: 'disabled', updatedAt: null };
      Object.assign(instance, { pluginId: item.pluginId, label: item.label, service: item.service, enabled: item.enabled, settings: item.settings });
      const changed = instance.entry !== plugin.entry;
      instance.entry = plugin.entry;
      if (instance.worker && changed) await this.stop(instance);
      this.instances.set(id, instance);
    }
    for (const [id, instance] of this.instances) if (!wanted.has(id)) { await this.stop(instance); this.instances.delete(id); }
    for (const instance of this.instances.values()) if (instance.enabled && !instance.worker) await this.start(instance);
    return this.list();
  }); }
  fail(instance, error) {
    instance.error = error.message; instance.status = 'error'; instance.result = null;
    const worker = instance.worker; instance.worker = null;
    for (const pending of instance.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    instance.pending.clear(); worker?.terminate().catch(() => {});
  }
  call(instance, method, snapshot) {
    return new Promise((resolve, reject) => {
      const requestId = ++this.requestId;
      const timer = setTimeout(() => this.fail(instance, new Error(`插件 ${method} 超时（5 秒）`)), 5000);
      instance.pending.set(requestId, { resolve, reject, timer });
      try { instance.worker.postMessage({ requestId, method, snapshot, context: this.context(instance) }); }
      catch (error) { this.fail(instance, error); }
    });
  }
  async start(instance) {
    instance.status = 'starting'; instance.error = null;
    const worker = new Worker(new URL('./plugin-worker.js', import.meta.url), { workerData: { entry: instance.entry }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
    instance.worker = worker;
    worker.on('message', ({ requestId, error, result }) => {
      const pending = instance.pending.get(requestId); if (!pending) return;
      clearTimeout(pending.timer); instance.pending.delete(requestId);
      if (error) pending.reject(new Error(error)); else pending.resolve(result);
    });
    worker.on('error', error => { if (instance.worker === worker) this.fail(instance, error); });
    worker.on('exit', code => { if (instance.worker === worker) this.fail(instance, new Error(`插件意外退出（${code}）`)); });
    try { await this.call(instance, 'start'); instance.status = 'enabled'; }
    catch (error) { this.fail(instance, error); }
  }
  async stop(instance) {
    if (instance.worker) {
      try { await this.call(instance, 'stop'); } catch { /* Forced termination follows. */ }
      const worker = instance.worker; instance.worker = null;
      await worker?.terminate();
    }
    instance.status = 'disabled'; instance.error = null; instance.result = null;
  }
  toggle(id, enabled) { return this.serialize(async () => {
    const instance = this.instances.get(id); if (!instance) throw new Error('实例不存在，请重新扫描');
    if (enabled) {
      if (!instance.worker) await this.start(instance);
      if (instance.status !== 'enabled') throw new Error(instance.error || '启用失败');
      instance.enabled = true;
    } else { await this.stop(instance); instance.enabled = false; }
    const record = this.persisted.get(id); if (record) record.enabled = instance.enabled;
    try { await this.save(); } catch (error) {
      if (enabled) { instance.enabled = false; await this.stop(instance); }
      throw new Error(`保存插件状态失败: ${error.message}`);
    }
    return this.list();
  }); }
  /** Persist settings (and optional label / bound service) for one instance; an enabled instance restarts. */
  updateSettings(id, input) { return this.serialize(async () => {
    const instance = this.instances.get(id); if (!instance) throw new Error('实例不存在，请重新扫描');
    const record = this.persisted.get(id); if (!record) throw new Error('实例不存在，请重新扫描');
    const source = input && typeof input === 'object' ? input : {};
    const next = this.coerce(this.pluginOf(instance), 'settings' in source ? source.settings : source);
    const nextLabel = typeof source.label === 'string' ? source.label.trim() : record.label;
    const nextService = typeof source.service === 'string' ? source.service.trim() : record.service;
    const previous = { settings: record.settings, label: record.label, service: record.service };
    Object.assign(record, { settings: next, label: nextLabel, service: nextService });
    Object.assign(instance, { settings: next, label: nextLabel, service: nextService });
    try { await this.save(); } catch (error) {
      Object.assign(record, previous); Object.assign(instance, previous);
      throw new Error(`保存插件设置失败: ${error.message}`);
    }
    if (instance.enabled && instance.worker) { await this.stop(instance); await this.start(instance); }
    return this.list();
  }); }
  /** Run a plugin-declared action (e.g. update / rollback) on an enabled instance. */
  runAction(id, key) { return this.serialize(async () => {
    const instance = this.instances.get(id); if (!instance) throw new Error('实例不存在，请重新扫描');
    const plugin = this.pluginOf(instance);
    if (!(plugin?.actions || []).some(action => action.key === key)) throw new Error('未知的插件操作');
    if (!instance.worker || instance.status !== 'enabled') throw new Error('请先启用该实例再执行操作');
    try { instance.result = await this.call(instance, 'action', { key }); instance.updatedAt = Date.now(); instance.error = null; }
    catch (error) { instance.error = error.message; throw error; }
    return this.list();
  }); }
  /** Add another instance of a plugin, bound to a service, with its own settings. */
  addInstance(pluginId, { label, service, settings } = {}) { return this.serialize(async () => {
    const plugin = this.catalog.get(pluginId); if (!plugin) throw new Error('插件不存在，请重新扫描');
    let id = pluginId, n = 2;
    while (this.persisted.has(id)) id = `${pluginId}-${n++}`;
    const values = this.coerce(plugin, settings);
    const record = { id, pluginId, label: (label || '').trim(), service: (service || '').trim(), enabled: false, settings: values };
    this.persisted.set(id, record);
    this.emptyPlugins.delete(pluginId);
    try { await this.save(); } catch (error) { this.persisted.delete(id); throw new Error(`保存插件失败: ${error.message}`); }
    this.instances.set(id, { id, pluginId, label: record.label, service: record.service, enabled: false, settings: values, entry: plugin.entry, pending: new Map(), worker: null, result: null, error: null, status: 'disabled', updatedAt: null });
    return this.list();
  }); }
  /** Remove an instance; removing the last one leaves the plugin empty until a new instance is added. */
  removeInstance(id) { return this.serialize(async () => {
    const instance = this.instances.get(id); if (!instance) throw new Error('实例不存在，请重新扫描');
    const pluginId = instance.pluginId;
    await this.stop(instance);
    this.instances.delete(id); this.persisted.delete(id);
    if (![...this.persisted.values()].some(item => item.pluginId === pluginId)) this.emptyPlugins.add(pluginId);
    else this.emptyPlugins.delete(pluginId);
    try { await this.save(); } catch (error) { throw new Error(`保存插件失败: ${error.message}`); }
    return this.list();
  }); }
  collect(snapshot, global) { if (global) this.global = global; return this.serialize(async () => {
    await Promise.all([...this.instances.values()].filter(instance => instance.worker && instance.status === 'enabled').map(async instance => {
      try { instance.result = await this.call(instance, 'collect', snapshot); instance.updatedAt = Date.now(); }
      catch (error) { this.fail(instance, error); }
    }));
  }); }
  close() { return this.serialize(async () => { await Promise.all([...this.instances.values()].map(instance => this.stop(instance))); }); }
}
