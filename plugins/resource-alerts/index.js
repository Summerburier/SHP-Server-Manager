// 示例插件：阈值检查。通知地址不手动配置，直接取实例绑定服务的 url/端口（与服务启动端口一致）。
export function collect(snapshot, context) {
  const settings = context.settings || context.config || {};
  const threshold = Number(settings.threshold) || 90;
  const alerts = [];
  if (snapshot.host?.cpuPercent >= threshold) alerts.push(`CPU ${snapshot.host.cpuPercent.toFixed(1)}% 超过 ${threshold}%`);
  if (snapshot.host?.memoryPercent >= threshold) alerts.push(`内存 ${snapshot.host.memoryPercent.toFixed(1)}% 超过 ${threshold}%`);
  for (const disk of snapshot.host?.disks || []) if (disk.percent >= threshold) alerts.push(`磁盘 ${disk.path} 达到 ${disk.percent.toFixed(1)}%`);
  const offline = (snapshot.servers || []).filter(server => !server.online);
  if (settings.notifyOffline && offline.length) alerts.push(`${offline.length} 个节点不可达：${offline.map(s => s.name).join('、')}`);

  const dashboard = context.global || {};
  const server = (dashboard.servers || []).find(s => s.id === context.service);
  return {
    status: alerts.length ? '需要关注' : '正常',
    阈值: `${threshold}%`,
    绑定服务: server ? `${server.name}（${server.kind}）` : '未绑定服务',
    通知地址: server?.url || '未绑定服务',
    后台同步间隔: dashboard.pollIntervalSeconds ? `${dashboard.pollIntervalSeconds}s` : '未知',
    告警: alerts
  };
}
