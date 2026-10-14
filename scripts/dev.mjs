import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer, loadEnv } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...loadEnv('development', root, ''), ...process.env };
const port = Number(env.PORT || 7999);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1–65535 的整数');
const backend = spawn(process.execPath, ['--watch', '--watch-preserve-output', 'src/server.js'], { cwd: root, env: { ...env, PORT: String(port), DEV_MODE: 'true' }, stdio: 'inherit', windowsHide: true });
let vite, closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  await vite?.close();
  if (backend.exitCode === null && backend.signalCode === null) {
    const ended = once(backend, 'exit'); backend.kill();
    await ended;
  }
  process.exitCode = code;
  if (process.connected) process.disconnect();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => close().catch(console.error));
process.on('message', message => { if (message === 'shutdown') close().catch(console.error); });
backend.on('error', error => { console.error(`后端启动失败：${error.message}`); close(1).catch(console.error); });
backend.on('exit', code => { if (!closing) { console.error(`API 后端已退出（${code ?? '信号终止'}），请检查终端错误和 .env 配置。`); close(code || 1).catch(console.error); } });
try {
  const deadline = Date.now() + 15000;
  let ready = false;
  while (!closing && Date.now() < deadline) {
    try { const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) }); ready = response.ok && (await response.json()).ok === true; } catch { /* Backend is starting. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!closing && !ready) throw new Error('API 后端启动超时，请检查配置、端口占用和插件启动状态');
  if (!closing) {
    const proxy = { target: `http://127.0.0.1:${port}`, changeOrigin: false };
    vite = await createServer({ root, server: { host: '127.0.0.1', port: Number(env.DEV_WEB_PORT || 5173), proxy: { '/api': proxy, '/healthz': proxy } } });
    await vite.listen();
    console.log(`API 后端已就绪：http://127.0.0.1:${port}`);
    vite.printUrls();
  }
} catch (error) { console.error(error.message); await close(1); }
