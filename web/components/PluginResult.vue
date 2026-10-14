<script setup>
defineProps({ value: { default: null } });
const isPrimitive = value => value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const entries = value => isObject(value) ? Object.entries(value) : [];
const format = value => value === null || value === undefined ? '—'
  : typeof value === 'boolean' ? (value ? '是' : '否')
  : typeof value === 'object' ? '' : String(value);
</script>

<template>
  <ul v-if="Array.isArray(value)" class="result-list">
    <li v-for="(item, index) in value" :key="index"><PluginResult v-if="!isPrimitive(item)" :value="item" /><span v-else>{{ format(item) }}</span></li>
  </ul>
  <dl v-else-if="isObject(value)" class="result-grid">
    <template v-for="([key, item], index) in entries(value)" :key="index">
      <dt>{{ key }}</dt>
      <dd><PluginResult v-if="!isPrimitive(item)" :value="item" /><span v-else :class="{ ok: item === true, bad: item === false }">{{ format(item) }}</span></dd>
    </template>
  </dl>
  <span v-else :class="{ ok: value === true, bad: value === false }">{{ format(value) }}</span>
</template>
