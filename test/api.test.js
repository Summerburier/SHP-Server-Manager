import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestJson } from '../web/api.js';

test('开发代理空响应和 HTML 错误返回清晰连接提示', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 502 }));
  await assert.rejects(requestJson('/api/status'), error => error.status === 502 && /后端不可用/.test(error.message));
});
test('空成功响应不暴露 JSON 解析错误', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 200 }));
  await assert.rejects(requestJson('/api/status'), /空响应或非 JSON/);
});
test('接口错误保留认证状态与说明，正常数据可读取', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('{"error":"请先登录"}', { status: 401 }));
  await assert.rejects(requestJson('/api/status'), error => error.status === 401 && error.message === '请先登录');
  mock.mock.mockImplementation(async () => new Response('{"ok":true}'));
  assert.deepEqual(await requestJson('/api/status'), { ok: true });
});
