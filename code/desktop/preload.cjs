'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Only these operations and sanitized task feedback cross into the desktop process.
contextBridge.exposeInMainWorld('fundsiftDesktop', Object.freeze({
  getState: () => ipcRenderer.invoke('fundsift:get-state'),
  chooseWorkspace: () => ipcRenderer.invoke('fundsift:choose-workspace'),
  listCases: () => ipcRenderer.invoke('fundsift:list-cases'),
  createCase: payload => ipcRenderer.invoke('fundsift:create-case', payload),
  openCase: id => ipcRenderer.invoke('fundsift:open-case', id),
  onOperationStatus: callback => {
    if (typeof callback !== 'function') throw new TypeError('状态监听需要一个函数。');
    const phases = new Set(['queued', 'running', 'choosing-location', 'confirming-location', 'checking', 'backing-up', 'verifying-backup', 'upgrading', 'saving-settings', 'completed', 'failed']);
    const operations = new Set(['get-state', 'list-cases', 'choose-workspace', 'create-case', 'open-case']);
    const listener = (_event, value) => {
      if (!value || !Number.isSafeInteger(value.operationId) || value.operationId < 1 ||
          !operations.has(value.operation) || !phases.has(value.phase) ||
          !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 ||
          typeof value.waitingLong !== 'boolean' || typeof value.active !== 'boolean') return;
      if (value.active === ['completed', 'failed'].includes(value.phase) || (!value.active && value.waitingLong)) return;
      callback({ operationId: value.operationId, operation: value.operation, phase: value.phase,
        elapsedMs: value.elapsedMs, waitingLong: value.waitingLong, active: value.active });
    };
    ipcRenderer.on('fundsift:operation-status', listener);
    return () => ipcRenderer.removeListener('fundsift:operation-status', listener);
  }
}));
