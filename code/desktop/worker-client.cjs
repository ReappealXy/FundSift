'use strict';

const path = require('node:path');
const { utilityProcess } = require('electron');

class WorkerClient {
  constructor(schemaPath) {
    this.sequence = 0;
    this.pending = new Map();
    this.closed = false;
    this.child = utilityProcess.fork(path.join(__dirname, 'worker.cjs'), [schemaPath], {
      serviceName: 'FundSift local data worker', stdio: 'pipe'
    });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.startupTimer = setTimeout(() => {
      this.rejectReady(Object.assign(new Error('本地数据进程未能启动，请重新打开软件。'), { code: 'WORKER_STARTUP' }));
      this.child.kill();
    }, 15000);
    // A rejected startup is reported by callers, even if the first request has not arrived yet.
    this.ready.catch(() => {});
    this.child.on('message', message => {
      if (message?.ready) { clearTimeout(this.startupTimer); this.resolveReady(); return; }
      const request = this.pending.get(message?.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.ok) request.resolve(message.data);
      else request.reject(Object.assign(new Error(message.error?.message || '本地数据操作失败。'), {
        code: message.error?.code || 'STORAGE_ERROR'
      }));
    });
    this.child.on('exit', () => {
      this.closed = true;
      clearTimeout(this.startupTimer);
      const error = Object.assign(new Error('本地数据进程已停止。请退出并重新打开软件，已有案件不会被清空。'), { code: 'WORKER_STOPPED' });
      this.rejectReady(error);
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
      this.pending.clear();
    });
    this.child.stderr?.on('data', chunk => process.stderr.write(chunk));
  }

  async request(method, ...args) {
    if (this.closed) throw Object.assign(new Error('本地数据进程不可用，请重新打开软件。'), { code: 'WORKER_STOPPED' });
    await this.ready;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('本地数据操作尚未返回。请稍后刷新案件列表，避免重复创建。'), { code: 'WORKER_TIMEOUT' }));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.postMessage({ id, method, args });
    });
  }

  async close() {
    if (this.closed) return;
    try { await this.request('close'); } finally { this.child.kill(); }
  }
}

module.exports = { WorkerClient };
