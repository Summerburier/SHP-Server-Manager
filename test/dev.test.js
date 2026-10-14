import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function freePort() {
  const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
test('一键开发模式启动前后端，代理使用自定义 API 端口', { timeout: 30000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'shp-dev-'));
  const port = await freePort(), webPort = await freePort();
  const config = join(temp, 'config.json'), token = 'dev-test-password-longer-than-24-characters';
  await writeFile(config, JSON.stringify({ servers: [{ id: 'main', url: 'http://127.0.0.1:1' }] }));
  const child = spawn(process.execPath, ['scripts/dev.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, HOST: '127.0.0.1', ADMIN_TOKEN: token, ADMIN_PASSWORD:token, ADMIN_USERNAME:'admin', CONFIG_FILE: config, DATA_DIR: join(temp, 'data'), PLUGINS_DIR: join(temp, 'plugins'), PORT: String(port), DEV_WEB_PORT: String(webPort) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  t.after(async () => {
    if (child.exitCode === null) { const ended = once(child, 'exit'); child.send('shutdown'); await ended; }
    await rm(temp, { recursive: true, force: true });
  });
  // Vite prints its URLs with ANSI colors, so strip escape codes before matching.
  const plain = () => output.replace(/\u001b\[[0-9;]*m/g, '');
  const deadline = Date.now() + 20000;
  while (!plain().includes(`127.0.0.1:${webPort}/`) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert(plain().includes(`127.0.0.1:${webPort}/`), output);
  const base = `http://127.0.0.1:${webPort}`;
  assert.equal((await fetch(base)).status, 200);
  const unauthenticated = await fetch(base + '/api/status');
  assert.equal(unauthenticated.status, 401); assert.equal((await unauthenticated.json()).error, '请先登录');
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username:'admin', password:token }) });
  assert.equal(login.status, 200);
  const status = await fetch(base + '/api/status', { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } });
  assert.equal(status.status, 200); assert.equal((await status.json()).servers[0].id, 'main');
  const settings = await fetch(base + '/api/settings', {headers:{Cookie:login.headers.get('set-cookie').split(';')[0]}});
  assert.equal(settings.status,200);assert.equal((await settings.json()).config.servers[0].id,'main');
});
