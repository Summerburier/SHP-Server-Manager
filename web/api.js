export async function requestJson(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, signal: options.signal || AbortSignal.timeout(40000), headers: { 'Content-Type': 'application/json', ...options.headers } });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? '接口请求超时，请检查后端运行状态' : '无法连接后台，请检查服务和网络连接');
  }
  const text = await response.text();
  let data;
  try { data = text.trim() ? JSON.parse(text) : null; } catch { /* Proxy or HTML error response. */ }
  if (!response.ok) {
    const fallback = [502, 503, 504].includes(response.status) || !data
      ? `API 后端不可用（HTTP ${response.status}），请检查后端启动状态和代理端口`
      : `接口请求失败（HTTP ${response.status}）`;
    throw Object.assign(new Error(data?.error || fallback), { status: response.status });
  }
  if (data === null || data === undefined) throw new Error('接口返回空响应或非 JSON 数据，请检查开发代理是否连接到 API 后端');
  return data;
}
