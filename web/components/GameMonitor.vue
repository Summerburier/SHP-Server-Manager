<script setup>
import TrendChart from './TrendChart.vue';
import { number } from '../format.js';
defineProps({ servers: Array, history: Array, selected: String, interval: Number });
defineEmits(['select','manage']);
</script>
<template>
<section class="panel game-monitor"><div class="section-heading"><div><h2>游戏运行数据</h2></div><select :value="selected" aria-label="历史节点" @change="$emit('select', $event.target.value)"><option v-for="server in servers" :key="server.id" :value="server.id">{{ server.name }}</option></select></div>
<div class="game-monitor-grid"><div class="table-scroll"><table><thead><tr><th>节点</th><th>状态</th><th>真人</th><th>对局</th><th>房间</th><th>AI</th><th>观战</th></tr></thead><tbody><tr v-for="server in servers" :key="server.id"><td><button class="monitor-service-link" type="button" @click="$emit('manage',server.id)">{{ server.name }}</button></td><td :class="server.online ? 'mint' : 'danger'">{{ server.online ? '在线' : '不可达' }}</td><td v-for="key in ['humans','matches','rooms','bots','spectators']" :key="key">{{ server.online ? number(server.health[key]) : '—' }}</td></tr></tbody></table></div><TrendChart :points="history" :interval="interval" label="玩家、连接、对局与房间趋势" :series="[{key:'humans',label:'真人',color:'mint'},{key:'sockets',label:'连接',color:'blue'},{key:'matches',label:'对局',color:'purple'},{key:'rooms',label:'房间',color:'yellow'}]" /></div></section>
</template>
