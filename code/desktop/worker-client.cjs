'use strict';

const path = require('node:path');
const { utilityProcess } = require('electron');
const { PHASES, sanitizeProgress, sanitizeReceipt } = require('./operation-status.cjs');

class WorkerClient {
  constructor(schemaPath, { onProgress = () => {} } = {}) {
    this.onProgress = onProgress;
    this.sequence = 0;
    this.pending = new Map();
    this.closed = false;
    this.closing = false;
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
      if (message.type === 'progress') {
        const progress = sanitizeProgress(message.progress);
        if (PHASES.has(message.phase) && !['completed','failed','queued'].includes(message.phase) && progress !== null) {
          try { this.onProgress({ phase: message.phase, ...(progress ? { progress } : {}) }); } catch (_) { /* Feedback is not part of the write transaction. */ }
        }
        return;
      }
      if (typeof message.ok !== 'boolean') return;
      this.pending.delete(message.id);
      if (message.ok) request.resolve(message.data);
      else request.reject(Object.assign(new Error(message.error?.message || '本地数据操作失败。'), {
        code: message.error?.code || 'STORAGE_ERROR',
        ...(sanitizeReceipt(message.error?.receipt) ? { receipt: sanitizeReceipt(message.error.receipt) } : {})
      }));
    });
    this.child.on('exit', () => {
      this.closed = true;
      clearTimeout(this.startupTimer);
      const error = Object.assign(new Error('本地数据进程已停止。请退出并重新打开软件，已有案件不会被清空。'), { code: 'WORKER_STOPPED' });
      this.rejectReady(error);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
    this.child.stderr?.on('data', chunk => process.stderr.write(chunk));
  }

  async request(method, ...args) {
    if (this.closed || this.closing) throw Object.assign(new Error('本地数据进程不可用或正在关闭，请重新打开软件。'), { code: 'WORKER_STOPPED' });
    return this._request(method, args);
  }

  async _request(method, args) {
    await this.ready;
    if (this.closed) throw Object.assign(new Error('本地数据进程已停止，请重新打开软件。'), { code: 'WORKER_STOPPED' });
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      // Never abandon an accepted migration/write after an arbitrary deadline:
      // close must still await its commit or rollback before stopping the child.
      this.pending.set(id, { resolve, reject });
      try { this.child.postMessage({ id, method, args }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  async close() {
    if (this.closed) return;
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this._request('close', []).finally(() => this.child.kill());
    return this.closePromise;
  }
}

module.exports = { WorkerClient };
