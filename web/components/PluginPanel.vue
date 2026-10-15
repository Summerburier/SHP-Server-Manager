<script setup>
import { ref, computed } from 'vue';
import PluginResult from './PluginResult.vue';

const props = defineProps({ data: Object, busy: String, services: { type: Array, default: () => [] } });
const emit = defineEmits(['scan', 'toggle', 'settings', 'add', 'remove', 'action', 'check']);
const labels = { enabled: '已启用', disabled: '已停用', starting: '启动中', error: '运行异常' };

const viewingId = ref(null), detailId = ref(null), editingId = ref(null);
const viewer = ref(null), editor = ref(null), adder = ref(null);
const draft = ref({}), editMeta = ref({ service: '' }), addForm = ref({ service: '' });

const instances = computed(() => props.data?.instances || []);
const groups = computed(() => {
  const byPlugin = new Map();
  for (const instance of instances.value) {
    if (!byPlugin.has(instance.pluginId)) byPlugin.set(instance.pluginId, []);
    byPlugin.get(instance.pluginId).push(instance);
  }
  // 以插件目录为准：实例被全部移除后，插件卡片仍然显示
  return (props.data?.plugins || []).map(plugin => ({ pluginId: plugin.id, name: plugin.name, version: plugin.version, description: plugin.description, instances: byPlugin.get(plugin.id) || [] }));
});
const viewing = computed(() => groups.value.find(group => group.pluginId === viewingId.value) || null);
const detail = computed(() => instances.value.find(instance => instance.id === detailId.value) || null);
const editing = computed(() => instances.value.find(instance => instance.id === editingId.value) || null);

function serviceName(id) { return props.services.find(service => service.id === id)?.name || id; }
function statusClass(status) { return status === 'error' ? 'error' : status === 'enabled' ? 'enabled' : status === 'starting' ? 'starting' : 'disabled'; }
function stamp(at) { return at ? new Date(at).toLocaleTimeString('zh-CN') : '尚未执行'; }
const asList = value => Array.isArray(value) ? value.map(String) : [String(value)];
function notices(instance) {
  const out = [];
  if (instance.error) out.push({ level: 'error', text: instance.error });
  const result = instance.result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    for (const key of ['错误', 'error', 'errors']) if (result[key]) for (const text of asList(result[key])) out.push({ level: 'error', text });
    for (const key of ['警告', '告警', 'warning', 'warnings']) if (result[key]) for (const text of asList(result[key])) out.push({ level: 'warning', text });
  }
  return out;
}
function summary(instance) {
  const result = instance.result;
  if (result === null || result === undefined) return [];
  if (typeof result !== 'object') return [{ label: '结果', value: String(result) }];
  if (Array.isArray(result)) return [{ label: '条目', value: String(result.length) }];
  const out = [];
  for (const [key, value] of Object.entries(result)) {
    if (['步骤', '详情', '日志', '警告', '告警', '错误'].includes(key)) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out.push({ label: key, value: value === true ? '是' : value === false ? '否' : String(value) });
    if (out.length >= 5) break;
  }
  return out;
}
function line(instance) {
  const service = instance.service ? serviceName(instance.service) : '未绑定';
  const version = summary(instance).find(item => item.label === '版本')?.value;
  const parts = instance.label === service ? [instance.label] : [instance.label, service];
  parts.push(labels[instance.status] || instance.status);
  if (version) parts.push(version);
  return parts.join(' · ');
}
function fieldsOf(instance) {
  if (Array.isArray(instance.settings) && instance.settings.length) return instance.settings;
  return Object.keys(instance.values || {}).map(key => ({ key, label: key, type: typeof instance.values[key] === 'number' ? 'number' : typeof instance.values[key] === 'boolean' ? 'boolean' : 'text' }));
}
function openPlugin(group) { viewingId.value = group.pluginId; detailId.value = null; viewer.value.showModal(); if (group.pluginId === 'stronghold-updater') for (const instance of group.instances) emit('check', instance); }
function closePlugin() { viewer.value?.close(); }
function resetPlugin() { viewingId.value = null; detailId.value = null; }
function openDetail(instance) { detailId.value = instance.id; if (instance.pluginId === 'stronghold-updater') emit('check', instance); }
function openSettings(instance) { editingId.value = instance.id; editMeta.value = { service: instance.service || props.services[0]?.id || '' }; draft.value = JSON.parse(JSON.stringify(instance.values || {})); editor.value.showModal(); }
function closeSettings() { editor.value?.close(); }
function resetEditor() { editingId.value = null; draft.value = {}; }
function save() { emit('settings', { id: editingId.value, label: serviceName(editMeta.value.service), service: editMeta.value.service, settings: JSON.parse(JSON.stringify(draft.value)) }); closeSettings(); }
function openAdd(group) { void group; addForm.value = { service: props.services[0]?.id || '' }; adder.value.showModal(); }
function closeAdd() { adder.value?.close(); }
function submitAdd() { emit('add', { pluginId: viewingId.value, label: serviceName(addForm.value.service), service: addForm.value.service }); closeAdd(); }
</script>

<template>
  <section class="plugin-management">
    <div class="section-heading plugin-toolbar"><div><h2>已安装插件</h2><p>点击插件卡片进入，管理它的各个实例。</p></div><button class="secondary" :disabled="!!busy" @click="$emit('scan')">{{ busy ? '处理中…' : '重新扫描' }}</button></div>
    <div v-if="data?.errors.length" class="notice" role="status"><p v-for="error in data.errors" :key="error">{{ error }}</p></div>
    <div v-if="data && !groups.length" class="empty">暂无插件，放入 plugins/&lt;id&gt;/ 后点击“重新扫描”。</div>
    <div class="plugin-grid">
      <article v-for="group in groups" :key="group.pluginId" class="plugin-card">
        <div class="plugin-card-top"><code class="plugin-id">{{ group.pluginId }}</code><span class="plugin-count">{{ group.instances.length }} 个实例</span></div>
        <div class="plugin-identity">
          <span class="plugin-symbol" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M6 6h7v4.2a2.8 2.8 0 1 0 5.6 0V6H26v7h-4.2a2.8 2.8 0 1 0 0 5.6H26V26h-7.4v-4.2a2.8 2.8 0 1 0-5.6 0V26H6v-7.4h4.2a2.8 2.8 0 1 0 0-5.6H6z"/></svg></span>
          <div class="plugin-title"><h3>{{ group.name }}</h3><small>v{{ group.version }}</small></div>
        </div>
        <p class="plugin-desc">{{ group.description || '暂无说明' }}</p>
        <div class="plugin-ticker" role="log" aria-label="实例信息"><p v-for="instance in group.instances" :key="instance.id"><i :class="['dot', statusClass(instance.status)]"></i>{{ line(instance) }}</p><p v-if="!group.instances.length" class="plugin-ticker-empty">暂无实例，点“打开”添加</p></div>
        <div class="plugin-card-foot"><span class="plugin-facts">查看与配置实例</span><button type="button" class="secondary" :disabled="!!busy" @click="openPlugin(group)">打开</button></div>
      </article>
    </div>

    <dialog ref="viewer" class="plugin-editor-dialog plugin-instance-dialog" @close="resetPlugin">
      <template v-if="viewing">
        <div class="modal-heading">
          <div class="plugin-editor-title" v-if="!detail"><h2>{{ viewing.name }}</h2><code>{{ viewing.pluginId }}</code></div>
          <div class="plugin-editor-title" v-else><h2>{{ detail.label }}</h2><code>{{ detail.pluginId }}</code></div>
          <button type="button" class="secondary plugin-back" @click="detail ? (detailId = null) : closePlugin()">返回</button>
        </div>
        <template v-if="detail">
          <p class="plugin-editor-desc">{{ detail.service ? '绑定服务：' + serviceName(detail.service) : (detail.description || '') }} · 最近执行：{{ stamp(detail.updatedAt) }}</p>
          <div class="plugin-detail-body"><PluginResult v-if="detail.result !== null && detail.result !== undefined" :value="detail.result" /><p v-else class="plugin-muted">暂无执行结果</p></div>
        </template>
        <template v-else>
          <p class="plugin-editor-desc">{{ viewing.description || '暂无说明' }} · {{ viewing.instances.length }} 个实例</p>
          <div class="instance-list">
            <div v-for="instance in viewing.instances" :key="instance.id" class="instance-row">
              <div class="plugin-instance-head"><span class="plugin-instance-label">{{ instance.label }}<small v-if="instance.service"> · {{ serviceName(instance.service) }}</small></span><span :class="['plugin-state', statusClass(instance.status)]"><i></i>{{ labels[instance.status] || instance.status }}</span></div>
              <p v-for="(notice, index) in notices(instance)" :key="index" :class="['plugin-notice', notice.level]" role="alert">{{ notice.text }}</p>
              <div class="plugin-instance-summary"><span v-for="item in summary(instance)" :key="item.label"><b>{{ item.label }}</b><em>{{ item.value }}</em></span><span v-if="!summary(instance).length" class="plugin-muted">{{ instance.enabled ? '等待首次执行…' : '实例已停用。' }}</span></div>
              <div class="plugin-instance-actions">
                <button v-if="instance.result !== null && instance.result !== undefined" type="button" class="secondary" :disabled="!!busy" @click="openDetail(instance)">详情</button>
                <button v-if="fieldsOf(instance).length" type="button" class="secondary" :disabled="!!busy" @click="openSettings(instance)">设置</button>
                <button v-for="action in instance.actions || []" :key="action.key" type="button" :class="['secondary', { danger: action.danger }]" :disabled="!!busy || !instance.enabled" :title="instance.enabled ? '' : '请先启用该实例'" @click="$emit('action', { id: instance.id, key: action.key, label: action.label })">{{ action.label }}</button>
                <button type="button" class="secondary plugin-remove" :disabled="!!busy" title="移除该实例" @click="$emit('remove', instance)">移除</button>
                <button type="button" :class="['plugin-toggle', instance.enabled ? 'off' : 'on']" :disabled="!!busy || instance.status === 'starting'" @click="$emit('toggle', instance)">{{ busy ? '处理中…' : instance.enabled ? '停用' : '启用' }}</button>
              </div>
            </div>
            <button type="button" class="instance-add-card" :disabled="!!busy" @click="openAdd(viewing)"><span>＋</span>添加实例</button>
          </div>
        </template>
      </template>
    </dialog>

    <dialog ref="editor" class="service-editor-dialog plugin-editor-dialog" @close="resetEditor">
      <form v-if="editing" @submit.prevent="save">
        <div class="modal-heading"><div class="plugin-editor-title"><h2>{{ editing.label }}</h2><code>{{ editing.pluginId }}</code></div><button type="button" class="secondary plugin-back" @click="closeSettings">返回</button></div>
        <p class="plugin-editor-desc">{{ editing.description || '暂无说明' }}</p>
        <div class="plugin-fields plugin-fields-meta">
          <label class="plugin-field"><span>绑定服务</span><select v-model="editMeta.service" required><option v-for="service in services" :key="service.id" :value="service.id">{{ service.name }}</option></select></label>
        </div>
        <div class="plugin-fields">
          <label v-for="field in fieldsOf(editing)" :key="field.key" :class="['plugin-field', { 'plugin-field-check': field.type === 'boolean' }]">
            <span>{{ field.label }}</span>
            <select v-if="field.type === 'select'" v-model="draft[field.key]"><option v-for="option in field.options" :key="option.value" :value="option.value">{{ option.label }}</option></select>
            <input v-else-if="field.type === 'boolean'" v-model="draft[field.key]" type="checkbox">
            <input v-else-if="field.type === 'number'" v-model.number="draft[field.key]" type="number" :min="field.min" :max="field.max">
            <input v-else v-model="draft[field.key]" type="text">
          </label>
        </div>
        <div class="modal-actions"><small class="plugin-editor-hint">{{ services.length ? '保存后立即重启该实例并生效。' : '请先在“服务”页添加服务。' }}</small><button type="button" class="secondary" :disabled="!!busy" @click="closeSettings">取消</button><button type="submit" :disabled="!!busy || !editMeta.service">保存设置</button></div>
      </form>
    </dialog>

    <dialog ref="adder" class="service-editor-dialog plugin-editor-dialog" @close="closeAdd">
      <form @submit.prevent="submitAdd">
        <div class="modal-heading"><div class="plugin-editor-title"><h2>添加实例</h2><code>{{ viewingId }}</code></div><button type="button" class="secondary plugin-back" @click="closeAdd">返回</button></div>
        <div class="plugin-fields">
          <label class="plugin-field"><span>绑定服务</span><select v-model="addForm.service" required><option v-for="service in services" :key="service.id" :value="service.id">{{ service.name }}</option></select></label>
        </div>
        <div class="modal-actions"><small class="plugin-editor-hint">{{ services.length ? '实例以该服务命名，插件从服务读取目录等设置。' : '请先在“服务”页添加服务，再添加实例。' }}</small><button type="button" class="secondary" :disabled="!!busy" @click="closeAdd">取消</button><button type="submit" :disabled="!!busy || !services.length || !addForm.service">添加</button></div>
      </form>
    </dialog>
  </section>
</template>
