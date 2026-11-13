'use strict';

const { WorkspaceStore } = require('./storage.cjs');
const store = new WorkspaceStore({ schemaPath: process.argv[2] });
const methods = new Set(['openWorkspace', 'listCases', 'createCase', 'openCase', 'close']);

process.parentPort.on('message', ({ data: request }) => {
  const { id, method, args = [] } = request || {};
  if (!Number.isSafeInteger(id) || !methods.has(method) || !Array.isArray(args)) return;
  try {
    const data = store[method](...args);
    process.parentPort.postMessage({ id, ok: true, data });
  } catch (error) {
    process.parentPort.postMessage({ id, ok: false, error: {
      code: error.code || 'STORAGE_ERROR',
      message: error.message || '本地数据操作失败，请重试。'
    } });
  }
});

process.parentPort.postMessage({ ready: true });
