'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const Database = require('better-sqlite3');
const { createOperationStatus } = require('../operation-status.cjs');
const { WorkspaceStore } = require('../storage.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('排队、真实阶段和长等待提醒不改变最终结果；终态停止计时', () => {
  let now = 100, heartbeat, cancelled = false;
  const events = [];
  const status = createOperationStatus({ operationId: 7, operation: 'get-state', publish: value => events.push(value),
    clock: () => now, schedule: callback => { heartbeat = callback; return 3; }, cancel: timer => { assert.equal(timer, 3); cancelled = true; } });
  assert.deepEqual(events[0], { operationId: 7, operation: 'get-state', phase: 'queued', elapsedMs: 0, waitingLong: false, active: true });
  now += 4000; status.update('running'); status.update('choosing-location');
  assert.equal(events.at(-1).phase, 'choosing-location');
  status.update('confirming-location');
  assert.equal(events.at(-1).phase, 'confirming-location');
  status.update('backing-up');
  now += 12000; heartbeat();
  assert.equal(events.at(-1).phase, 'backing-up');
  assert.equal(events.at(-1).waitingLong, true);
  assert.equal(events.at(-1).active, true);
  assert.equal(events.at(-1).elapsedMs, 16000);
  status.finish(true);
  assert.equal(cancelled, true);
  assert.equal(events.at(-1).phase, 'completed');
  assert.equal(events.at(-1).active, false);
  assert.equal(events.at(-1).waitingLong, false);
  const count = events.length;
  status.update('upgrading'); status.finish(false); heartbeat();
  assert.equal(events.length, count);
});

test('界面销毁或反馈回调异常不会打断操作，失败终态不冒称成功', () => {
  let cleaned = false;
  const status = createOperationStatus({ operationId: 1, operation: 'create-case', publish() { throw Error('renderer gone'); },
    schedule: () => 1, cancel: () => { cleaned = true; } });
  assert.doesNotThrow(() => { status.update('upgrading'); status.finish(false); });
  assert.equal(cleaned, true);
});

test('worker中间进度不兑现请求，不丢失关闭等待；未知或迟到消息被忽略', async () => {
  const child = new EventEmitter(), posted = [], phases = [];
  let killed = false, settled = false;
  child.postMessage = message => posted.push(message);
  child.kill = () => { killed = true; child.emit('exit'); };
  const context = { module: { exports: {} }, __dirname: path.resolve(__dirname, '..'), process: { stderr: { write() {} } },
    setTimeout, clearTimeout, require: name => name === 'electron' ? { utilityProcess: { fork: () => child } } : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../worker-client.cjs'), 'utf8'), context);
  const client = new context.module.exports.WorkerClient('fixture.sql', { onProgress: value => phases.push(value.phase) });
  child.emit('message', { ready: true });
  const active = client.request('openWorkspace', 'synthetic').then(value => { settled = true; return value; });
  await tick();
  const id = posted[0].id;
  child.emit('message', { id, type: 'progress', phase: 'backing-up' });
  child.emit('message', { id, type: 'progress', phase: 'unexpected' });
  child.emit('message', { id: id + 50, type: 'progress', phase: 'upgrading' });
  child.emit('message', { id, unrelated: true });
  await tick();
  assert.equal(settled, false);
  assert.equal(client.pending.size, 1);
  assert.deepEqual(phases, ['backing-up']);
  const closing = client.close(); await tick();
  assert.equal(killed, false);
  child.emit('message', { id, type: 'progress', phase: 'verifying-backup' });
  child.emit('message', { id, ok: true, data: { saved: true } });
  assert.equal((await active).saved, true);
  child.emit('message', { id, type: 'progress', phase: 'upgrading' });
  assert.deepEqual(phases, ['backing-up', 'verifying-backup']);
  assert.equal(killed, false);
  child.emit('message', { id: posted[1].id, ok: true });
  await closing;
  assert.equal(killed, true);
});

test('隔离桥只转发允许的状态字段，解绑后不再通知；无任意IPC权限', () => {
  const ipc = new EventEmitter();
  let bridge;
  ipc.invoke = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { ipcRenderer: ipc, contextBridge: {
      exposeInMainWorld(name, value) { assert.equal(name, 'fundsiftDesktop'); bridge = value; }
    } }; }
  });
  const seen = [], unsubscribe = bridge.onOperationStatus(value => seen.push(value));
  const status = { operationId: 1, operation: 'create-case', phase: 'running', elapsedMs: 12, waitingLong: false, active: true };
  ipc.emit('fundsift:operation-status', {}, { ...status, sourcePath: 'private-path', secret: true });
  assert.equal(seen.length, 1);
  for (const phase of ['choosing-location', 'confirming-location']) ipc.emit('fundsift:operation-status', {}, { ...status, operation: 'choose-workspace', phase });
  assert.deepEqual(seen.slice(1).map(value => value.phase), ['choosing-location', 'confirming-location']);
  const acceptedCount = seen.length;
  assert.equal('sourcePath' in seen[0], false);
  assert.equal('secret' in seen[0], false);
  for (const changed of [{ operationId: -1 }, { operation: 'arbitrary-method' }, { phase: 'fake' }, { elapsedMs: NaN }, { active: 'yes' },
    { phase: 'failed' }, { active: false }, { phase: 'completed', active: false, waitingLong: true }]) {
    ipc.emit('fundsift:operation-status', {}, { ...status, ...changed });
  }
  assert.equal(seen.length, acceptedCount);
  unsubscribe(); unsubscribe();
  ipc.emit('fundsift:operation-status', {}, status);
  assert.equal(seen.length, acceptedCount);
  assert.equal(bridge.send, undefined);
});

test('主进程只向合法主页面发布状态，排队事件先于执行；关闭等待最终结果', async () => {
  const handlers = new Map(), events = [], actions = [], app = new EventEmitter();
  let window, worker, release;
  Object.assign(app, { setName() {}, requestSingleInstanceLock: () => true, getPath: () => 'synthetic-profile',
    whenReady: () => Promise.resolve(), quit() { actions.push('quit'); } });
  class FakeWorker {
    constructor(_schema, options) { worker = this; this.progress = options.onProgress; }
    async request(method) {
      actions.push(method);
      if (method === 'openWorkspace') {
        this.progress({ phase: 'checking' });
        await new Promise(resolve => { release = resolve; });
        return { cases: [], workspacePath: path.resolve('synthetic-data') };
      }
      if (method === 'createCase') throw Object.assign(new Error('合成失败'), { code: 'FS_TEST' });
      return [];
    }
    async close() { actions.push('close'); }
  }
  class FakeWindow extends EventEmitter {
    constructor() {
      super(); window = this;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { mainFrame: { url: require('node:url').pathToFileURL(path.resolve(__dirname, '../../prototype/index.html')).href },
        isDestroyed: () => false, send: (_channel, value) => events.push(value), setWindowOpenHandler() {} });
    }
    removeMenu() {}
    async loadFile() {}
  }
  const electron = { app, BrowserWindow: FakeWindow, ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: {},
    session: { defaultSession: { setPermissionRequestHandler() {}, webRequest: { onHeadersReceived() {} } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8'), {
    __dirname: path.resolve(__dirname, '..'), process: { env: {} },
    require: name => name === 'electron' ? electron : name === './worker-client.cjs' ? { WorkerClient: FakeWorker }
      : name === 'node:fs/promises' ? { async readFile() { return JSON.stringify({ version: 1, workspacePath: path.resolve('synthetic-data') }); } }
      : require(name.startsWith('./') ? path.resolve(__dirname, '..', name) : name)
  });
  await tick();
  const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const bad = await handlers.get('fundsift:get-state')({ ...sender, senderFrame: { url: sender.senderFrame.url } });
  assert.equal(bad.error.code, 'INVALID_SENDER');
  assert.equal(events.length, 0);
  const first = handlers.get('fundsift:get-state')(sender);
  const second = handlers.get('fundsift:create-case')(sender, { name: '合成案', number: 'TEST' });
  assert.deepEqual(events.map(value => [value.operationId, value.phase]), [[1, 'queued'], [2, 'queued']]);
  await tick();
  assert.deepEqual(actions, ['openWorkspace']);
  worker.progress({ phase: 'backing-up' });
  assert.equal(events.at(-1).phase, 'backing-up');
  let prevented = false;
  app.emit('before-quit', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.ok(!actions.includes('close'));
  const blocked = await handlers.get('fundsift:get-state')(sender);
  assert.equal(blocked.error.code, 'WORKER_CLOSING');
  release();
  assert.equal((await first).ok, true);
  assert.equal((await second).error.code, 'FS_TEST');
  await tick();
  assert.deepEqual(actions, ['openWorkspace', 'createCase', 'close', 'quit']);
  assert.deepEqual(events.filter(value => !value.active).map(value => [value.operationId, value.phase]), [[1, 'completed'], [2, 'failed']]);
  assert.ok(events.findIndex(value => value.operationId === 2 && value.phase === 'running') >
    events.findIndex(value => value.operationId === 1 && value.phase === 'completed'));
});

function legacyWorkspace(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fundsift-progress-'));
  fs.mkdirSync(path.join(root, 'cases'));
  const db = new Database(path.join(root, 'workspace.sqlite'));
  db.exec(`CREATE TABLE workspace_case (
    id TEXT PRIMARY KEY, case_no TEXT NOT NULL UNIQUE, case_name TEXT NOT NULL,
    relative_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_opened_at TEXT
  )`);
  db.pragma('application_id=1179866963'); db.pragma('user_version=1'); db.close();
  const store = new WorkspaceStore({ schemaPath: path.resolve(__dirname, '../../ddl_extract_check.sql'), ...options });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store };
}

test('真实旧库升级按检查、备份、校验备份、升级顺序发事件；回读不捏造升级阶段', async t => {
  const phases = [], { root, store } = legacyWorkspace(t, { onProgress: phase => phases.push(phase) });
  await store.openWorkspace(root);
  assert.equal(phases[0], 'checking');
  const migrationPhases = phases.filter(phase => phase !== 'checking');
  assert.deepEqual(migrationPhases, ['backing-up', 'verifying-backup', 'upgrading']);
  phases.length = 0;
  await store.openWorkspace(root);
  assert.ok(!phases.includes('backing-up'));
  assert.ok(!phases.includes('upgrading'));
});

test('备份后故障没有虚假的升级阶段且数据库回滚；观察者抛错不影响合法升级', async t => {
  const phases = [], first = legacyWorkspace(t, { onProgress: phase => phases.push(phase), migrationHooks: {
    afterBackup() { throw new Error('synthetic failure'); }
  } });
  await assert.rejects(first.store.openWorkspace(first.root), { code: 'FS_MIGRATION_FAILED' });
  assert.ok(phases.includes('backing-up'));
  assert.ok(!phases.includes('upgrading'));
  const db = new Database(path.join(first.root, 'workspace.sqlite'));
  assert.equal(db.pragma('user_version', { simple: true }), 1); db.close();
  const second = legacyWorkspace(t, { onProgress() { throw new Error('feedback gone'); } });
  await second.store.openWorkspace(second.root);
  assert.equal(second.store.catalog.pragma('user_version', { simple: true }), 2);
});
