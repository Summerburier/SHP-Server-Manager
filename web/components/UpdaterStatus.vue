<script setup>
import {computed} from 'vue';
const props=defineProps({instance:Object,detailed:Boolean});
const result=computed(()=>props.instance.result||{});
const progress=computed(()=>{const value=result.value['下载进度'];if(value===undefined||value===null)return null;const n=Number(String(value).replace('%',''));return Number.isFinite(n)?Math.max(0,Math.min(100,n)):null;});
const errors=computed(()=>[...new Set([props.instance.error,result.value['错误']].filter(Boolean))]);
const warnings=computed(()=>[...new Set([result.value['警告']].flat().filter(Boolean))].filter(value=>!errors.value.includes(value)));
const logs=computed(()=>Array.isArray(result.value['日志'])?result.value['日志']:[]);
const working=computed(()=>['更新中…','检查中…'].includes(result.value['状态']));
</script>
<template><section class="updater-status"><div class="updater-phase"><span :class="{'mint':working}">{{ result['当前阶段'] || (instance.enabled?'等待执行':'已停用') }}</span><span v-if="progress!==null" class="updater-progress-value">{{ progress }}%</span></div><div v-if="progress!==null" class="meter" role="progressbar" aria-label="下载进度" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100"><i :style="{width:progress+'%'}"></i></div><div class="updater-facts"><div><span>本地版本</span><b>{{ result['当前版本'] || result['版本'] || '尚未读取' }}</b></div><div><span>最新版本</span><b>{{ result['最新版本'] || '尚未检查' }}</b></div><div><span>下次更新</span><b>{{ instance.enabled ? result['下次计划'] || '待计算' : '已暂停' }}</b></div></div><p v-for="error in errors" :key="error" class="plugin-notice error" role="alert">{{ error }}</p><p v-for="warning in warnings" :key="warning" class="plugin-notice warning">{{ warning }}</p><template v-if="detailed"><dl class="updater-metadata"><div><dt>更新方式</dt><dd>{{ result['更新方式'] || '—' }}</dd></div><div><dt>上次运行</dt><dd>{{ result['上次运行'] || '从未' }}</dd></div><div><dt>服务目录</dt><dd>{{ result['服务'] || '未绑定' }}</dd></div></dl><div class="updater-log-heading"><h3>运行日志</h3><span>{{ logs.length }} 条</span></div><pre class="updater-log" role="log" aria-label="更新运行日志">{{ logs.length?logs.join('\n'):'尚无运行日志' }}</pre></template></section></template>
