<script setup>
defineProps({ name: String });
</script>

<template>
  <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
    <template v-if="name === 'host'">
      <rect x="2.75" y="4.25" width="18.5" height="12.5" rx="2" />
      <path d="M6 12.4h2.7l1.6-3.1 2.2 5.6 1.8-3.2h3.7" />
    </template>
    <template v-else-if="name === 'game'">
      <rect x="3.5" y="4" width="17" height="6.4" rx="1.8" />
      <rect x="3.5" y="13.6" width="17" height="6.4" rx="1.8" />
      <path d="M7 7.2h.01M7 16.8h.01" />
    </template>
    <template v-else-if="name === 'plugins'">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
      <path d="M17 13.8v6.4M13.8 17h6.4" />
    </template>
    <template v-else-if="name === 'settings'">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.6v2.7M12 18.7v2.7M2.6 12h2.7M18.7 12h2.7M5.2 5.2l1.9 1.9M16.9 16.9l1.9 1.9M5.2 18.8l1.9-1.9M16.9 7.1l1.9-1.9" />
    </template>
  </svg>
</template>
