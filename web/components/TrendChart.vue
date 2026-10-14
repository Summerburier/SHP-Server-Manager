<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { number, rate, time } from '../format.js';
const props = defineProps({ points: { type: Array, default: () => [] }, series: { type: Array, required: true }, percentage: Boolean, network: Boolean, interval: { type: Number, default: 5 }, label: String });
const element = ref(null), width = ref(770), height = ref(180);
const plotBottom = computed(() => height.value - 30);
const hoveredAt = ref(null);
const dualAxis = computed(() => props.series.some(s => s.axis === 'right'));
const rightMaximum = computed(() => Math.max(1, ...props.points.flatMap(p => props.series.filter(s => s.axis === 'right').map(s => p[s.key] ?? 0))));
const rightEdge = computed(() => width.value - (dualAxis.value ? 92 : 16));
const hovered = computed(() => hoveredAt.value === null ? null : props.points.find(p => p.at === hoveredAt.value) || null);
function inspect(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const coordinate = (event.clientX - rect.left) / rect.width * width.value;
  const at = first.value + Math.max(0, Math.min(1, (coordinate - 74) / (rightEdge.value - 74))) * (last.value - first.value);
  hoveredAt.value = props.points.reduce((best, point) => !best || Math.abs(point.at - at) < Math.abs(best.at - at) ? point : best, null)?.at ?? null;
}
const valueLabel = (point, series) => !Number.isFinite(point[series.key]) ? '—' : series.unit === 'rate' || props.network ? rate(point[series.key]) : `${number(point[series.key])}${props.percentage ? '%' : ''}`;
let observer;
onMounted(() => {
  observer = new ResizeObserver(() => { width.value = Math.max(280, element.value.clientWidth); height.value = Math.max(110, element.value.querySelector("svg").clientHeight); });
  observer.observe(element.value);
  observer.observe(element.value.querySelector("svg"));
});
onUnmounted(() => observer?.disconnect());
const maximum = computed(() => props.percentage ? 100 : Math.max(1, ...props.points.flatMap(p => props.series.map(s => p[s.key] ?? 0))));
const first = computed(() => props.points[0]?.at || 0);
const last = computed(() => props.points.at(-1)?.at || 0);
const x = at => 74 + (at - first.value) / Math.max(1, last.value - first.value) * (rightEdge.value - 74);
const y = (value, series) => { const max = series?.axis === 'right' ? rightMaximum.value : maximum.value; return plotBottom.value - Math.max(0, Math.min(max, value)) / max * (plotBottom.value - 18); };
const paths = computed(() => props.series.map(series => {
  let drawing = false, previousAt = null, d = '';
  for (const point of props.points) {
    const value = point[series.key];
    if (!Number.isFinite(value)) { drawing = false; continue; }
    if (previousAt !== null && point.at - previousAt > props.interval * 2500) drawing = false;
    d += `${drawing ? 'L' : 'M'}${x(point.at).toFixed(1)},${y(value, series).toFixed(1)} `;
    drawing = true; previousAt = point.at;
  }
  return { ...series, d };
}));
const axisLabel = value => props.network ? rate(value) : `${number(value)}${props.percentage ? '%' : ''}`;
</script>

<template>
  <div ref="element" class="trend">
    <div class="legend"><span v-for="series in series" :key="series.key" :class="series.color">● {{ series.label }}</span></div>
    <svg :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="none" role="img" :aria-label="label || '历史趋势图'" @pointermove="inspect" @pointerdown="inspect" @pointerleave="hoveredAt = null">
      <g v-for="i in 5" :key="i" class="chart-grid">
        <line x1="74" :x2="rightEdge" :y1="y(maximum * (i - 1) / 4)" :y2="y(maximum * (i - 1) / 4)" />
        <text x="66" :y="y(maximum * (i - 1) / 4) + 4" text-anchor="end">{{ axisLabel(maximum * (i - 1) / 4) }}</text>
        <text v-if="dualAxis" :x="rightEdge + 8" :y="y(maximum * (i - 1) / 4) + 4">{{ rate(rightMaximum * (i - 1) / 4) }}</text>
      </g>
      <path v-for="series in paths" :key="series.key" :d="series.d" :class="['chart-line', series.color]" />
      <template v-if="points.length"><circle v-for="series in series.filter(s => Number.isFinite(points.at(-1)[s.key]))" :key="series.key" :cx="x(last)" :cy="y(points.at(-1)[series.key], series)" r="3" :class="series.color" /></template>
      <template v-if="hovered"><line class="chart-crosshair" :x1="x(hovered.at)" :x2="x(hovered.at)" y1="18" :y2="plotBottom"/><circle v-for="s in series.filter(s => Number.isFinite(hovered[s.key]))" :key="s.key" :cx="x(hovered.at)" :cy="y(hovered[s.key], s)" r="4" :class="s.color"/></template>
      <text v-if="!points.length" :x="width / 2" y="90" text-anchor="middle" class="chart-empty">暂无采样数据</text>
      <text x="74" :y="height - 6" class="chart-time">{{ points.length ? time(first) : '等待采样' }}</text><text :x="rightEdge" :y="height - 6" text-anchor="end" class="chart-time">{{ points.length ? time(last) : '' }}</text>
    </svg>
    <div v-if="hovered" class="chart-tooltip" :style="{left: `${Math.max(0, Math.min(width - 220, x(hovered.at) + 12)) / width * 100}%`}" role="status"><b>{{ time(hovered.at) }}</b><div v-for="s in series" :key="s.key"><span :class="s.color">● {{ s.label }}</span><strong>{{ valueLabel(hovered, s) }}</strong></div></div>
  </div>
</template>

<style scoped>
.trend .chart-line {
  fill: none;
  stroke-linejoin: round;
  stroke-linecap: round;
}
</style>
