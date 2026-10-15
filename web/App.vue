<script setup>
import { ref, watch, computed, onMounted, onUnmounted, nextTick } from 'vue';
import HostPanel from './components/HostPanel.vue';
import GamePanel from './components/GamePanel.vue';
import GameMonitor from './components/GameMonitor.vue';
import PluginPanel from './components/PluginPanel.vue';
import NavIcon from './components/NavIcon.vue';
import ToastHost from './components/ToastHost.vue';
import { notify } from './notifications.js';
import SetupPanel from './components/SetupPanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import LoginBackdrop from './components/LoginBackdrop.vue';
import { requestJson } from './api.js';

import { number, actionName, time } from './format.js';

const phase = ref('loading'), page = ref('host'), password = ref(''), username = ref('admin'), loginError = ref(''), message = ref('');
const state = ref(null), hostHistory = ref([]), gameHistory = ref([]), selected = ref('');
const refreshing = ref(false), loggingIn = ref(false), pending = ref(''), confirmation = ref(null), dialog = ref(null);
const pluginsData = ref(null), pluginBusy = ref('');
let timer, epoch = 0, disposed = false, initialSync = true;
async function checkUpdater(instance) {
  if (instance.pluginId !== 'stronghold-updater' || !instance.enabled) return;
  try {
    const previous = instance.result?.检查时间;
    pluginsData.value = await api(`/api/plugins/instances/${instance.id}/actions/check`, { method: 'POST', body: '{}' });
    for (let i = 0; i < 12 && !disposed; i++) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (disposed) return;
      const result = await api('/api/plugins');
      pluginsData.value = result;
      const current = result.instances?.find(item => item.id === instance.id)?.result;
      if (current?.检查时间 && current.检查时间 !== previous) break;
      if (current?.当前阶段 === '检查失败') break;
    }
  } catch (error) { notify(`版本检查失败：${error.message}`, 'error'); }
}
const titles = { host: ['运行监控', '服务器性能、玩家与游戏对局，集中监控。'], game: ['服务', '集中管理已接入服务的运行状态与启停操作。'], plugins: ['插件管理', '安装扩展，配置参数并查看运行结果。'], settings: ['设置', '管理员账户、采样间隔与插件目录。'] };
const tabs = [['host', '运行监控'], ['game', '服务'], ['plugins', '插件管理'], ['settings', '设置']];
const gameServers = computed(() => state.value?.servers.filter(s => s.url) || []);
const pluginServices = computed(() => (state.value?.servers || []).map(s => ({ id: s.id, name: s.name || s.id })));
const online = computed(() => gameServers.value.filter(s => s.online));
const total = key => online.value.length ? number(online.value.reduce((n, s) => n + (s.health[key] || 0), 0)) : '—';
const cutoff = computed(() => state.value?.startedAt || 0);
const hostPoints = computed(() => hostHistory.value.filter(p => p.at >= cutoff.value));
const gamePoints = computed(() => gameHistory.value.filter(p => p.at >= cutoff.value).map(p => ({ at: p.at, humans: p.online && p.health ? p.health.humans : null, sockets: p.online && p.health ? p.health.sockets : null, matches: p.online && p.health ? p.health.matches : null, rooms: p.online && p.health ? p.health.rooms : null })));
const alerts = computed(() => {
  const result = [];
  if (gameServers.value.some(s => !s.online)) result.push('部分游戏节点离线或不可达');
  const host = state.value?.host;
  if (host?.cpuPercent >= 90) result.push('CPU 使用率达到 90%');
  if (host?.memoryPercent >= 90) result.push('内存使用率达到 90%');
  if (host?.disks.some(d => d.percent >= 90)) result.push('磁盘使用率达到 90%');
  return result;
});
watch(alerts, value => { if (value.length) notify(value.join(' · '), 'warning'); });
async function api(path, options = {}) {
  try { return await requestJson(path, options); }
  catch (error) {
    if (error.status === 401) { phase.value = 'login'; clearTimeout(timer); }
    throw error;
  }
}
const since = points => points.length ? points.at(-1).at + 1 : Date.now() - 24 * 3600000;
function merge(before, incoming) {
  const cutoff = Date.now() - 24 * 3600000;
  return [...before, ...incoming].filter(p => p.at >= cutoff);
}
async function loadGame(capturedEpoch = epoch) {
  const id = selected.value;
  if (!id) return;
  const result = await api(`/api/history?id=${encodeURIComponent(id)}&since=${since(gameHistory.value)}`);
  if (id === selected.value && capturedEpoch === epoch && !disposed) gameHistory.value = merge(gameHistory.value, result);
}
async function refresh() {
  if (refreshing.value || disposed) return;
  refreshing.value = true; clearTimeout(timer);
  const capturedEpoch = epoch;
  try {
    const result = await api(initialSync ? '/api/status?sync=1' : '/api/status');
    initialSync = false;
    if (capturedEpoch !== epoch || disposed) return;
    if (state.value?.startedAt !== result.startedAt) { hostHistory.value = []; gameHistory.value = []; }
    state.value = result; phase.value = 'ready';
    if (message.value.startsWith('更新失败：')) message.value = '';
    if (!result.servers.some(s => s.url && s.id === selected.value)) { selected.value = result.servers.find(s => s.url)?.id || ''; gameHistory.value = []; }
    const [host, , installed] = await Promise.all([api(`/api/host/history?since=${since(hostHistory.value)}`), loadGame(capturedEpoch), api('/api/plugins')]);
    if (capturedEpoch !== epoch || disposed) return;
    hostHistory.value = merge(hostHistory.value, host); pluginsData.value = installed;
  } catch (error) {
    if (capturedEpoch === epoch && !disposed && error.status !== 401) { message.value = `更新失败：${error.message}。显示的数据可能已过期。`; notify(message.value, 'error'); if (phase.value === 'loading') phase.value = 'error'; }
  } finally {
    refreshing.value = false;
    if (['ready', 'error'].includes(phase.value) && !disposed) timer = setTimeout(refresh, (state.value?.hostPollIntervalSeconds || 5) * 1000);
  }
}
async function login() {
  loggingIn.value = true; loginError.value = '';
  try { await api('/api/login', { method: 'POST', body: JSON.stringify({ username: username.value, password: password.value }) }); password.value = ''; epoch++; initialSync = true; message.value = ''; await refresh(); }
  catch (error) { loginError.value = error.message; notify(error.message, 'error'); }
  finally { loggingIn.value = false; }
}
async function logout() {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); epoch++; clearTimeout(timer); phase.value = 'login'; state.value = null; hostHistory.value = []; gameHistory.value = []; message.value = ''; }
  catch (error) { notify(error.message, 'error'); }
}
async function selectGame(id) {
  selected.value = id; gameHistory.value = [];
  try { await loadGame(); } catch (error) { notify(error.message, 'error'); }
}
async function manageService(id) { page.value = 'game'; await nextTick(); document.getElementById('service-' + id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
async function askAction(server, action) {
  confirmation.value = { server, action };
  await nextTick(); dialog.value.showModal();
}
function closeDialog() { dialog.value.close(); confirmation.value = null; }
async function executeAction() {
  const { server, action } = confirmation.value; closeDialog(); pending.value = server.id;
  try { const result = await api(`/api/servers/${server.id}/actions/${action}`, { method: 'POST', body: '{}' }); notify(result.message); await refresh(); }
  catch (error) { notify(error.message, 'error'); }
  finally { pending.value = ''; }
}
async function pluginRequest(path, body, okMessage) {
  if (pluginBusy.value) return;
  pluginBusy.value = path;
  try { pluginsData.value = await api(path, { method: 'POST', body: JSON.stringify(body || {}) }); if (okMessage) notify(okMessage); }
  catch (error) { notify(error.message, 'error'); }
  finally { pluginBusy.value = ''; }
}
function scanPlugins() { return pluginRequest('/api/plugins/rescan', {}, '插件扫描完成'); }
function togglePlugin(instance) { return pluginRequest(`/api/plugins/instances/${instance.id}/${instance.enabled ? 'disable' : 'enable'}`, {}, `${instance.label} ${instance.enabled ? '已停用' : '已启用'}`); }
function savePluginSettings({ id, settings, label, service }) { return pluginRequest(`/api/plugins/instances/${id}/settings`, { settings, label, service }, '实例设置已保存并生效'); }
function addPluginInstance(payload) { return pluginRequest(`/api/plugins/${payload.pluginId}/instances`, { label: payload.label, service: payload.service, settings: payload.settings || {} }, '已添加插件实例'); }
function removePluginInstance(instance) { return pluginRequest(`/api/plugins/instances/${instance.id}/remove`, {}, '已移除插件实例'); }
function runPluginAction({ id, key, label }) { return pluginRequest(`/api/plugins/instances/${id}/actions/${key}`, {}, label ? `${label}已触发` : '操作已触发'); }
function resumeUpdates() { if (!document.hidden && !['login', 'setup'].includes(phase.value)) { initialSync = true; refresh(); } }
onMounted(async () => { try { const setup = await requestJson('/api/setup'); if (setup.required) phase.value = 'setup'; else refresh(); } catch { refresh(); } document.addEventListener('visibilitychange', resumeUpdates); window.addEventListener('online', resumeUpdates); });
onUnmounted(() => { disposed = true; epoch++; clearTimeout(timer); document.removeEventListener('visibilitychange', resumeUpdates); window.removeEventListener('online', resumeUpdates); });
</script>

<template>
  <ToastHost />
  <SetupPanel v-if="phase === 'setup'" @done="phase = 'login'" />
  <section v-else-if="phase === 'login'" class="login">
    <LoginBackdrop />
    <div class="login-intro">
      <div class="login-wordmark">STRONGHOLD<br>PROTOCOL</div>
      <div class="eyebrow">SERVER OPERATIONS / SHP</div>
      <h1>卫戍中枢<span>服务器管理终端</span></h1>
      <div class="login-rule"></div>
      <p>连接同盟，守望每一场协作。<br>游戏运行与服务器性能，统一监控。</p>
    </div>
    <form class="login-console" @submit.prevent="login">
      <div class="login-panel-heading"><span>终端接入</span><span>ACCESS CONTROL</span></div>
      <h2>管理员认证</h2>
      <p>使用管理员账户登录。</p><label for="username">用户名</label><input id="username" v-model="username" autocomplete="username"
        required maxlength="64" placeholder="请输入用户名"><label for="password">管理密码 <span>AUTHENTICATION
          KEY</span></label><input id="password" v-model="password" type="password" autocomplete="current-password"
        required minlength="8" placeholder="请输入管理密码"><button type="submit" :disabled="loggingIn">{{ loggingIn ? '正在登录…'
          : '进入控制台' }}</button><small>独立监控节点 / 会话有效期 8 小时</small>
    </form>
    <div class="login-footer"><span>卫戍中枢</span><span>独立运行 · Node.js 24 LTS</span></div>
  </section>
  <section v-else-if="phase !== 'ready'" class="loading">
    <div class="brand">卫戍中枢</div>
    <p>{{ phase === 'error' ? message : '正在连接服务器…' }}</p><button v-if="phase === 'error'" @click="refresh">重试</button>
  </section>
  <div v-else class="workspace">
    <aside>
      <div class="sidebar-brand"><svg class="brand-emblem" viewBox="0 0 48 48" aria-hidden="true">
          <defs>
            <linearGradient id="brand-grad" x1="14" y1="6" x2="34" y2="42" gradientUnits="userSpaceOnUse">
              <stop offset="0" stop-color="#8bf5d2" /><stop offset="1" stop-color="#2fae88" />
            </linearGradient>
          </defs>
          <path class="brand-shell" d="M24 3.6 41.4 10.2v13.3c0 9.6-8.9 17.2-17.4 20.9-8.5-3.7-17.4-11.3-17.4-20.9V10.2Z" />
          <path class="brand-core" d="M24 13.2 33.5 18.7v10.8L24 35.1l-9.5-5.6V18.7Z" />
          <path class="brand-mark" d="M24 18.6v8.8M19.6 23h8.8" />
        </svg>
        <div class="brand">卫戍中枢</div>
        <p>服务运行 · 尽在掌握</p>
      </div>
      <nav aria-label="主导航"><button
          v-for="[key, label] in tabs" :key="key"
          :class="{ active: page === key }" :aria-current="page === key ? 'page' : undefined" @click="page = key"><NavIcon :name="key" /><span>{{ label }}</span></button></nav>
      <div class="aside-bottom">{{ state.host?.hostname || '服务器' }}<small>Node.js 24 LTS</small></div>
    </aside>
    <main>
      <header>
        <div class="page-heading">
          <h1>{{ titles[page][0] }}</h1>
          <p>{{ titles[page][1] }}</p>
        </div>
        <div class="header-actions"><span>{{ refreshing ? '同步中…' : '自动更新 · ' + time(state.now) }}</span><button
            class="secondary" @click="logout">退出</button></div>
      </header>
      <template v-if="page === 'host'">
        <section v-if="gameServers.length" class="game-summary" aria-label="游戏汇总"><span>在线节点 <b>{{ online.length }} / {{
          state.servers.length }}</b></span><span>真人席位 <b>{{ total('humans') }}</b></span><span>进行中对局 <b>{{
                total('matches') }}</b></span><span>房间 <b>{{ total('rooms') }}</b></span><span>WebSocket <b>{{
                total('sockets') }}</b></span></section>
        <HostPanel :has-game="gameServers.length > 0" :host="state.host" :history="hostPoints"
          :interval="state.hostPollIntervalSeconds">
          <GameMonitor v-if="gameServers.length" :servers="gameServers" :history="gamePoints" :selected="selected"
            :interval="state.pollIntervalSeconds" @select="selectGame" @manage="manageService" />
        </HostPanel>
      </template>
      <GamePanel v-if="page === 'game'" :servers="state.servers" :pending="pending" @action="askAction"
        @updated="refresh" />
      <PluginPanel v-if="page === 'plugins'" :data="pluginsData" :busy="pluginBusy" :services="pluginServices"
        @check="checkUpdater" @scan="scanPlugins" @toggle="togglePlugin" @settings="savePluginSettings" @add="addPluginInstance" @remove="removePluginInstance" @action="runPluginAction" />
      <SettingsPanel v-if="page === 'settings'" />
      <footer><span>卫戍中枢</span><span>管理后台与游戏服务独立运行</span></footer>
    </main>
    <dialog ref="dialog" @cancel="confirmation = null">
      <form v-if="confirmation" @submit.prevent="executeAction">
        <h2>{{ actionName(confirmation.action) }}「{{ confirmation.server.name }}」？</h2>
        <p>操作可能中断玩家连接。命令执行成功后，以后续健康采样为准。</p>
        <div class="dialog-actions"><button type="button" class="secondary" @click="closeDialog">取消</button><button
            type="submit">确认{{ actionName(confirmation.action) }}</button></div>
      </form>
    </dialog>
  </div>
</template>
