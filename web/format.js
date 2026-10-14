export const number = value => Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) : '—';
export const percent = value => Number.isFinite(value) ? `${value.toFixed(1)}%` : '等待采样';
export const bytes = value => {
  if (!Number.isFinite(value)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
};
export const rate = value => Number.isFinite(value) ? `${bytes(value)}/s` : '—';
export const duration = s => Number.isFinite(s) ? `${Math.floor(s / 86400)}天 ${Math.floor(s % 86400 / 3600)}时 ${Math.floor(s % 3600 / 60)}分` : '—';
export const time = at => at ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false }) : '等待采样';
export const actionName = key => ({ start: '启动', stop: '停止', restart: '重启' })[key];
