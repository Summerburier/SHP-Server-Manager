<script setup>
import { computed } from 'vue';
import TrendChart from './TrendChart.vue';
import { number, percent, bytes, rate, duration, time } from '../format.js';
const props = defineProps({ host: Object, history: { type: Array, default: () => [] }, interval: Number, hasGame: {type:Boolean,default:true} });
const diskPercent = computed(() => Math.max(0, ...(props.host?.disks || []).map(x => x.percent || 0)));
const tone = value => value >= 90 ? 'danger' : value >= 75 ? 'warning' : 'mint';
</script>

<template>
  <template v-if="host">
    
    <div v-if="host.warnings.length" class="notice">{{ host.warnings.join('；') }}</div>
    <section class="metrics host-metrics" aria-label="服务器性能">
      <article><label>CPU 使用率</label><strong :class="tone(host.cpuPercent)">{{ percent(host.cpuPercent) }}</strong><div class="meter"><i :class="tone(host.cpuPercent)" :style="{ width: `${host.cpuPercent || 0}%` }"></i></div><small>{{ host.logicalCpus }} 个逻辑核心 · {{ host.cpus }} 核可用并行度</small></article>
      <article><label>内存使用率</label><strong :class="tone(host.memoryPercent)">{{ percent(host.memoryPercent) }}</strong><div class="meter"><i :class="tone(host.memoryPercent)" :style="{ width: `${host.memoryPercent || 0}%` }"></i></div><small>{{ bytes(host.memoryUsed) }} / {{ bytes(host.memoryTotal) }}</small></article>
      <article><label>最高磁盘占用</label><strong :class="tone(diskPercent)">{{ host.disks.some(d => d.percent !== null) ? percent(diskPercent) : '不可用' }}</strong><div class="meter"><i :class="tone(diskPercent)" :style="{ width: `${diskPercent}%` }"></i></div></article>
      <article><label>网络实时速率</label><strong class="rate-value">↓ {{ rate(host.network.rxBytesPerSec) }}</strong><div class="network-up">↑ {{ rate(host.network.txBytesPerSec) }}</div></article>
    </section>
    <div class="host-charts combined-chart" :class="{'host-only':!hasGame}">
      <article class="panel"><div class="section-heading"><div><h2>资源运行趋势</h2></div></div><TrendChart :points="history" :interval="interval" percentage label="CPU、内存与网络综合趋势" :series="[{key:'cpuPercent', label:'CPU', color:'mint'}, {key:'memoryPercent', label:'内存', color:'blue'}, {key:'rxBytesPerSec', label:'网络接收', color:'purple', axis:'right', unit:'rate'}, {key:'txBytesPerSec', label:'网络发送', color:'yellow', axis:'right', unit:'rate'}]" /></article>
      <slot />
    </div>
    <section class="host-info-grid" aria-label="服务器资源详情">
      <article class="panel"><div class="section-heading"><div><h2>磁盘空间</h2></div></div><div class="info-body"><div v-for="disk in host.disks" :key="disk.path" class="disk"><div class="disk-heading"><code>{{ disk.path }}</code><b :class="tone(disk.percent)">{{ disk.error || percent(disk.percent) }}</b></div><div class="meter"><i :class="tone(disk.percent)" :style="{width:`${disk.percent || 0}%`}"></i></div><p>{{ bytes(disk.used) }} 已用 / {{ bytes(disk.total) }} 总量 · {{ bytes(disk.available) }} 可用</p></div></div></article>
      <article class="panel"><div class="section-heading"><div><h2>系统信息</h2></div></div><div class="info-body"><dl><div><dt>系统 / 架构</dt><dd>{{ host.platform }} {{ host.release }} / {{ host.arch }}</dd></div><div><dt>处理器</dt><dd>{{ host.cpuModel }}</dd></div><div><dt>负载（1 / 5 / 15m）</dt><dd>{{ host.load ? host.load.map(number).join(' / ') : '当前系统不提供' }}</dd></div><div><dt>Swap / 页面文件</dt><dd>{{ host.swap ? `${bytes(host.swap.used)} / ${bytes(host.swap.total)}` : '当前系统不提供' }}</dd></div><div><dt>系统运行时间</dt><dd>{{ duration(host.uptimeSec) }}</dd></div><div><dt>后台内存 RSS</dt><dd>{{ bytes(host.dashboardRss) }}</dd></div></dl></div></article>
    <article class="panel network-panel"><div class="section-heading"><div><h2>网卡详情</h2></div></div><div class="info-body"><div class="table-scroll"><table v-if="host.network.interfaces?.length"><thead><tr><th>接口</th><th>接收速率</th><th>发送速率</th><th>累计 / 错误</th></tr></thead><tbody><tr v-for="nic in host.network.interfaces" :key="nic.name"><td><code>{{ nic.name }}</code></td><td class="mint">{{ rate(nic.rxBytesPerSec) }}</td><td class="blue">{{ rate(nic.txBytesPerSec) }}</td><td><span>↓ {{ bytes(nic.rxBytes) }} · ↑ {{ bytes(nic.txBytes) }}</span><small class="nic-errors">错误 {{ number(nic.rxErrors) }} / {{ number(nic.txErrors) }}</small></td></tr></tbody></table><p v-else class="empty">{{ host.network.supported ? '未获得网卡数据，请检查权限及 host.networkInterfaces 配置' : '当前系统没有可用网络采集器' }}</p></div></div></article>
    </section>
  </template>
  <article v-else class="panel empty">正在采样服务器性能…</article>
</template>
