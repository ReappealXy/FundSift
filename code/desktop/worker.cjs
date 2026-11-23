'use strict';

const { WorkspaceStore } = require('./storage.cjs');
const { DesktopData } = require('./desktop-data.cjs');
const { PHASES, sanitizeProgress, sanitizeReceipt } = require('./operation-status.cjs');
let activeRequest = null;
function publishProgress(event) {
  const phase = event.phase === 'completed' ? 'publishing' : event.phase;
  const progress = sanitizeProgress(event);
  if (activeRequest !== null && PHASES.has(phase) && !['completed','failed','queued'].includes(phase) && progress !== null) {
    process.parentPort.postMessage({ id: activeRequest, type: 'progress', phase, ...(progress ? { progress } : {}) });
  }
}
const store = new WorkspaceStore({ schemaPath: process.argv[2], onProgress: phase => publishProgress({ phase }) });
const desktopData = new DesktopData(store, { onProgress: publishProgress });
const dataMethods = new Set(['importFile', 'importFileReceipt', 'getBatchImportState', 'retryImport', 'reimportMaterial', 'listMaterials', 'queryFlows', 'readFlowSource', 'queryRelations',
  'getWorkpaperContext', 'exportWorkpaper', 'getReview', 'saveReview', 'listReviewHistory',
  'listRemovedMaterials', 'removeMaterial', 'restoreMaterial', 'setRecycleMaterials']);
const methods = new Set(['inspectWorkspace', 'openWorkspace', 'listCases', 'createCase', 'openCase',
  'listRemovedCases', 'removeCase', 'restoreCase', 'listRecycleBin', 'setRecycleCases', 'emptyRecycleBin', 'close', ...dataMethods]);
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
      const data = await (dataMethods.has(method) ? desktopData[method](...args) : store[method](...args));
      process.parentPort.postMessage({ id, ok: true, data });
    } catch (error) {
      process.parentPort.postMessage({ id, ok: false, error: {
        code: error.code || 'STORAGE_ERROR',
        message: error.message || '本地数据操作失败，请重试。',
        ...(sanitizeReceipt(error.receipt) ? { receipt: sanitizeReceipt(error.receipt) } : {})
      } });
    } finally { activeRequest = null; }
  });
});

process.parentPort.postMessage({ ready: true });
