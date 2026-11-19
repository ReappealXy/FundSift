'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Only these operations and sanitized task feedback cross into the desktop process.
contextBridge.exposeInMainWorld('fundsiftDesktop', Object.freeze({
  getState: () => ipcRenderer.invoke('fundsift:get-state'),
  chooseWorkspace: () => ipcRenderer.invoke('fundsift:choose-workspace'),
  listCases: () => ipcRenderer.invoke('fundsift:list-cases'),
  createCase: payload => ipcRenderer.invoke('fundsift:create-case', payload),
  openCase: id => ipcRenderer.invoke('fundsift:open-case', id),
  chooseImport: caseId => ipcRenderer.invoke('fundsift:choose-import', caseId),
  listMaterials: caseId => ipcRenderer.invoke('fundsift:list-materials', caseId),
  queryFlows: (caseId, options) => ipcRenderer.invoke('fundsift:query-flows', caseId, options),
  queryRelations: (caseId, options) => ipcRenderer.invoke('fundsift:query-relations', caseId, options),
  readFlowSource: (caseId, options) => ipcRenderer.invoke('fundsift:read-flow-source', caseId, options),
  onOperationStatus: callback => {
    if (typeof callback !== 'function') throw new TypeError('状态监听需要一个函数。');
    const phases = new Set(['queued', 'running', 'choosing-location', 'confirming-location', 'checking', 'backing-up', 'verifying-backup', 'upgrading', 'saving-settings',
      'choosing-file', 'confirming-import', 'archiving', 'parsing', 'importing', 'verifying-archive', 'publishing', 'reading-source', 'completed', 'failed']);
    const operations = new Set(['get-state', 'list-cases', 'choose-workspace', 'create-case', 'open-case', 'choose-import', 'list-materials', 'query-flows', 'read-flow-source', 'query-relations']);
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
        for (const key of ['parsedRows','writtenRows','pendingRows','totalRows']) {
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
          progress.copiedBytes !== undefined && progress.totalBytes !== undefined && BigInt(progress.copiedBytes) > BigInt(progress.totalBytes)) return;
        if (!Object.keys(progress).length) progress = undefined;
      }
      callback({ operationId: value.operationId, operation: value.operation, phase: value.phase,
        elapsedMs: value.elapsedMs, waitingLong: value.waitingLong, active: value.active, ...(progress ? { progress } : {}) });
    };
    ipcRenderer.on('fundsift:operation-status', listener);
    return () => ipcRenderer.removeListener('fundsift:operation-status', listener);
  }
}));
