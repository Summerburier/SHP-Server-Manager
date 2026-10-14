<script setup>
import {notify} from '../notifications.js';
import {ref,onUnmounted} from 'vue';
import ConnectionsPanel from './ConnectionsPanel.vue';
import {requestJson} from '../api.js';
import { duration, time, actionName, number } from '../format.js';
const props = defineProps({ servers: Array, pending: String });
defineEmits(['action','updated']);
const removing=ref(false),editorId=ref(null),editing=ref(false),logService=ref(null),logText=ref(''),logError=ref('');let logTimer,logEpoch=0;
async function openLogs(service){clearTimeout(logTimer);const epoch=++logEpoch;logService.value=service;logText.value='正在读取…';logError.value='';async function update(){try{const result=await requestJson('/api/servers/'+service.id+'/logs');if(epoch===logEpoch)logText.value=result.text;}catch(error){if(epoch===logEpoch)notify(error.message,'error');}if(epoch===logEpoch)logTimer=setTimeout(update,3000);}await update();}
function closeLogs(){logEpoch++;clearTimeout(logTimer);logService.value=null;}
onUnmounted(closeLogs);
const running = server => server.control?.running ?? server.online;
const status = server => server.control?.state === 'unknown' ? '状态未知' : running(server) ? '运行中' : server.control ? '已停止' : '不可达';
const busy = server => server.busy || props.pending === server.id;
const actionDisabled = (server, action) => {
  if (!server.actions.includes(action) || busy(server)) return true;
  if (server.control && server.control.running === null) return false; // Unknown state: keep every action available.
  const isRunning = running(server);
  if (action === 'start') return isRunning;
  if (action === 'stop') return !isRunning;
  return false;
};
const actionTitle = (server, action) => {
  if (!server.actions.includes(action)) return '尚未配置此操作';
  if (busy(server)) return '操作执行中';
  if (!actionDisabled(server, action)) return actionName(action);
  return action === 'start' ? '服务已在运行' : action === 'stop' ? '服务已停止' : actionName(action);
};
</script>
<template>
<section class="service-management">
  <ConnectionsPanel v-if="editing" :service-id="editorId" :remove="removing" @saved="$emit('updated')" @close="editing=false" />
  <div class="service-grid">
    <article v-for="server in servers" :key="server.id" :id="'service-'+server.id" :class="['server service-card', { 'service-offline': !running(server), 'service-busy': server.busy || pending === server.id }]">
      <div class="service-card-top"><span class="service-id">{{ server.id }}</span><span :class="['service-state', {offline:!running(server)}]"><i></i>{{ server.busy || pending === server.id ? '操作执行中' : status(server) }}</span><button type="button" class="service-remove-icon secondary" :aria-label="'移除 ' + server.name" @click="removing=true;editorId=server.id;editing=true">×</button></div>
      <div class="service-identity"><div class="service-symbol" aria-hidden="true"><svg viewBox="0 0 32 32"><rect x="5" y="5" width="22" height="9"/><rect x="5" y="18" width="22" height="9"/><path d="M9 9.5h2m-2 13h2m6-13h6m-6 13h6"/></svg></div><div><h3>{{ server.name }}</h3><code>{{ server.control?.source || server.url }}</code></div></div>
      <dl class="service-facts"><div><dt>运行时间</dt><dd>{{ server.control?.uptimeSec != null ? duration(server.control.uptimeSec) : server.online ? duration(server.health.uptimeSec) : '—' }}</dd></div><div><dt>响应延迟</dt><dd>{{ server.online ? number(server.latencyMs) + ' ms' : '—' }}</dd></div><div><dt>服务版本</dt><dd>{{ server.online ? server.health.app : server.kind === "systemd" ? "systemd" : server.kind === "project" ? "本地项目" : "—" }}</dd></div><div><dt>最近检查</dt><dd>{{ time(server.at) }}</dd></div></dl>
      <p v-if="!running(server)" class="service-message" role="status">{{ server.control?.error || server.error || '服务已停止' }}</p>
      <p v-else-if="server.control?.pid" class="service-message">PID {{ server.control.pid }}</p>
      <div class="service-controls"><button v-for="action in ['start','stop','restart']" :key="action" :class="['service-control', action === 'start' ? '' : 'secondary', {'stop-control':action === 'stop'}]" :disabled="actionDisabled(server, action)" :title="actionTitle(server, action)" @click="$emit('action', server, action)">{{ actionName(action) }}</button></div>
      <div class="service-card-foot"><button type="button" class="secondary" @click="removing=false;editorId=server.id;editing=true">编辑</button><button type="button" class="secondary" @click="openLogs(server)">查看日志</button><span>{{ server.actions.length ? '已配置 ' + server.actions.length + ' 项控制操作' : '只读服务 · 尚未配置控制命令' }}</span><span v-if="server.busy || pending === server.id" class="mint">正在执行…</span></div>
    </article>
    <article class="service-create-placeholder"><button type="button" class="create-service-card secondary" aria-label="＋ 添加服务" @click="removing=false;editorId=null;editing=true"><span class="create-service-plus" aria-hidden="true">＋</span><span>添加服务</span></button></article>
  </div>

<section v-if="logService" class="panel service-logs"><div class="section-heading"><h2>{{ logService.name }} · 实时日志</h2><button type="button" class="secondary" @click="closeLogs">关闭日志</button></div><pre>{{ logText }}</pre></section>
</section>
</template>
