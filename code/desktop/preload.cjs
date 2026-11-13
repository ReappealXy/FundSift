'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Only these five operations cross into the desktop process; no generic IPC or filesystem access.
contextBridge.exposeInMainWorld('fundsiftDesktop', Object.freeze({
  getState: () => ipcRenderer.invoke('fundsift:get-state'),
  chooseWorkspace: () => ipcRenderer.invoke('fundsift:choose-workspace'),
  listCases: () => ipcRenderer.invoke('fundsift:list-cases'),
  createCase: payload => ipcRenderer.invoke('fundsift:create-case', payload),
  openCase: id => ipcRenderer.invoke('fundsift:open-case', id)
}));
