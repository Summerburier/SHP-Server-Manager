import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

let plugin;
parentPort.on('message', async ({ requestId, method, snapshot, context }) => {
  const ctx = context && typeof context === 'object' ? context : {};
  try {
    let result = null;
    if (method === 'start') {
      plugin = await import(pathToFileURL(workerData.entry).href);
      if (typeof plugin.collect !== 'function') throw new Error('插件必须导出 collect(snapshot, context)');
      if (plugin.start) await plugin.start(ctx);
    } else if (method === 'collect') result = await plugin.collect(snapshot, ctx);
    else if (method === 'action') { if (typeof plugin?.action !== 'function') throw new Error('插件不支持该操作'); result = await plugin.action(snapshot?.key, ctx); }
    else if (method === 'stop' && plugin?.stop) await plugin.stop(ctx);
    const encoded = JSON.stringify(result ?? null);
    if (Buffer.byteLength(encoded) > 65536) throw new Error('插件结果超过 64 KiB');
    parentPort.postMessage({ requestId, result: JSON.parse(encoded) });
  } catch (error) { parentPort.postMessage({ requestId, error: error.message }); }
});
