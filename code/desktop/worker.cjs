'use strict';

const { WorkspaceStore } = require('./storage.cjs');
let activeRequest = null;
const store = new WorkspaceStore({ schemaPath: process.argv[2], onProgress: phase => {
  if (activeRequest !== null) process.parentPort.postMessage({ id: activeRequest, type: 'progress', phase });
} });
const methods = new Set(['inspectWorkspace', 'openWorkspace', 'listCases', 'createCase', 'openCase', 'close']);
let operation = Promise.resolve();

process.parentPort.on('message', ({ data: request }) => {
  const { id, method, args = [] } = request || {};
  if (!Number.isSafeInteger(id) || !methods.has(method) || !Array.isArray(args)) return;
  // A backup yields to the event loop while holding a write lock. Keep later
  // requests (including close) out of that transaction until it has settled.
  operation = operation.then(async () => {
    activeRequest = id;
    try {
      process.parentPort.postMessage({ id, type: 'progress', phase: 'running' });
      const data = await store[method](...args);
      process.parentPort.postMessage({ id, ok: true, data });
    } catch (error) {
      process.parentPort.postMessage({ id, ok: false, error: {
        code: error.code || 'STORAGE_ERROR',
        message: error.message || '本地数据操作失败，请重试。'
      } });
    } finally { activeRequest = null; }
  });
});

process.parentPort.postMessage({ ready: true });
