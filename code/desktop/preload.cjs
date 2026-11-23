'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Only these operations and sanitized task feedback cross into the desktop process.
contextBridge.exposeInMainWorld('fundsiftDesktop', Object.freeze({
  getState: () => ipcRenderer.invoke('fundsift:get-state'),
  chooseWorkspace: () => ipcRenderer.invoke('fundsift:choose-workspace'),
  listCases: () => ipcRenderer.invoke('fundsift:list-cases'),
  createCase: payload => ipcRenderer.invoke('fundsift:create-case', payload),
  openCase: id => ipcRenderer.invoke('fundsift:open-case', id),
  listRemovedCases: () => ipcRenderer.invoke('fundsift:list-removed-cases'),
  listRecycleBin: () => ipcRenderer.invoke('fundsift:list-recycle-bin'),
  setRecycleCases: (ids, restore) => ipcRenderer.invoke('fundsift:set-recycle-cases', ids, restore),
  setRecycleMaterials: (caseId, ids, restore) => ipcRenderer.invoke('fundsift:set-recycle-materials', caseId, ids, restore),
  emptyRecycleBin: selection => ipcRenderer.invoke('fundsift:empty-recycle-bin', selection),
  removeCase: id => ipcRenderer.invoke('fundsift:remove-case', id),
  restoreCase: id => ipcRenderer.invoke('fundsift:restore-case', id),
  chooseImport: caseId => ipcRenderer.invoke('fundsift:choose-import', caseId),
  chooseBatchImport: (caseId, mode) => ipcRenderer.invoke('fundsift:choose-batch-import', caseId, mode),
  dropBatchImport: (caseId, files) => {
    // Only File objects backed by local files can yield a path in this isolated context.
    // No renderer-supplied path is forwarded to the main process.
    try {
      const paths = Array.isArray(files) ? files.map(file => webUtils.getPathForFile(file)) : [];
      if (paths.length && paths.every(Boolean)) return ipcRenderer.invoke('fundsift:drop-batch-import', caseId, paths);
    } catch (_) { /* Discard invalid browser File objects. */ }
    return Promise.resolve({ ok: false, error: {
      code: 'FS_IMPORT_BATCH_INPUT', message: '请从文件资源管理器拖入本地文件或文件夹。'
    } });
  },
  runBatchImport: (caseId, selection) => ipcRenderer.invoke('fundsift:run-batch-import', caseId, selection),
  cancelBatchImport: (caseId, token) => ipcRenderer.invoke('fundsift:cancel-batch-import', caseId, token),
  retryImport: (caseId, sourceFileId) => ipcRenderer.invoke('fundsift:retry-import', caseId, sourceFileId),
  reimportMaterial: (caseId, sourceFileId, batchId) => ipcRenderer.invoke('fundsift:reimport-material', caseId, sourceFileId, batchId),
  exportWorkpaper: (caseId, options) => ipcRenderer.invoke('fundsift:export-workpaper', caseId, options),
  listMaterials: caseId => ipcRenderer.invoke('fundsift:list-materials', caseId),
  listRemovedMaterials: caseId => ipcRenderer.invoke('fundsift:list-removed-materials', caseId),
  removeMaterial: (caseId, sourceFileId) => ipcRenderer.invoke('fundsift:remove-material', caseId, sourceFileId),
  restoreMaterial: (caseId, sourceFileId) => ipcRenderer.invoke('fundsift:restore-material', caseId, sourceFileId),
  queryFlows: (caseId, options) => ipcRenderer.invoke('fundsift:query-flows', caseId, options),
  queryRelations: (caseId, options) => ipcRenderer.invoke('fundsift:query-relations', caseId, options),
  readFlowSource: (caseId, options) => ipcRenderer.invoke('fundsift:read-flow-source', caseId, options),
  getReview: (caseId, flowId) => ipcRenderer.invoke('fundsift:get-review', caseId, flowId),
  saveReview: (caseId, payload) => ipcRenderer.invoke('fundsift:save-review', caseId, payload),
  listReviewHistory: (caseId, sourceFileId) => ipcRenderer.invoke('fundsift:list-review-history', caseId, sourceFileId),
  onOperationStatus: callback => {
    if (typeof callback !== 'function') throw new TypeError('状态监听需要一个函数。');
    const phases = new Set(['queued', 'running', 'choosing-location', 'confirming-location', 'checking', 'backing-up', 'verifying-backup', 'upgrading', 'saving-settings',
      'choosing-file', 'confirming-import', 'archiving', 'parsing', 'importing', 'verifying-archive', 'publishing', 'reading-source',
      'reading-export', 'writing-export', 'completed', 'failed']);
    const operations = new Set(['get-state', 'list-cases', 'choose-workspace', 'create-case', 'open-case', 'choose-import',
      'choose-batch-import', 'drop-batch-import', 'run-batch-import', 'cancel-batch-import', 'retry-import', 'reimport-material',
      'list-materials', 'query-flows', 'read-flow-source', 'query-relations', 'export-workpaper', 'get-review', 'save-review', 'list-review-history',
      'list-removed-cases', 'remove-case', 'restore-case', 'list-removed-materials', 'remove-material', 'restore-material',
      'list-recycle-bin', 'set-recycle-cases', 'set-recycle-materials', 'empty-recycle-bin']);
    const listener = (_event, value) => {
      if (!value || !Number.isSafeInteger(value.operationId) || value.operationId < 1 ||
          !operations.has(value.operation) || !phases.has(value.phase) ||
          !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 ||
          typeof value.waitingLong !== 'boolean' || typeof value.active !== 'boolean') return;
      if (value.active === ['completed', 'failed'].includes(value.phase) || (!value.active && value.waitingLong)) return;
      let progress;
      if (value.progress !== undefined) {
        if (!value.progress || typeof value.progress !== 'object' || Array.isArray(value.progress)) return;
        progress = {};
        for (const key of ['parsedRows','writtenRows','pendingRows','totalRows','fileIndex','fileCount']) {
          if (value.progress[key] === undefined) continue;
          if (!Number.isSafeInteger(value.progress[key]) || value.progress[key] < 0) return;
          progress[key] = value.progress[key];
        }
        for (const key of ['copiedBytes','totalBytes']) {
          if (value.progress[key] === undefined) continue;
          if (typeof value.progress[key] !== 'string' || !/^(?:0|[1-9]\d{0,19})$/.test(value.progress[key])) return;
          progress[key] = value.progress[key];
        }
        if (progress.totalRows !== undefined && ['writtenRows','parsedRows','pendingRows'].some(key => progress[key] > progress.totalRows) ||
          progress.pendingRows !== undefined && progress.writtenRows !== undefined && progress.pendingRows > progress.writtenRows ||
          progress.copiedBytes !== undefined && progress.totalBytes !== undefined && BigInt(progress.copiedBytes) > BigInt(progress.totalBytes) ||
          (progress.fileIndex !== undefined || progress.fileCount !== undefined) &&
            !(progress.fileIndex >= 1 && progress.fileIndex <= progress.fileCount)) return;
        if (!Object.keys(progress).length) progress = undefined;
      }
      callback({ operationId: value.operationId, operation: value.operation, phase: value.phase,
        elapsedMs: value.elapsedMs, waitingLong: value.waitingLong, active: value.active, ...(progress ? { progress } : {}) });
    };
    ipcRenderer.on('fundsift:operation-status', listener);
    return () => ipcRenderer.removeListener('fundsift:operation-status', listener);
  }
}));
