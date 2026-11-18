'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { chooseWorkspace } = require('../workspace-choice.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('异步备份中的后续写入和关闭串行等待，失败不会断开队列', async () => {
  const port = new EventEmitter(), messages = [], operations = [];
  port.postMessage = value => messages.push(value);
  let release;
  class Store {
    async openWorkspace() { operations.push('lock'); await new Promise(resolve => { release = resolve; }); operations.push('commit'); return { cases: [] }; }
    createCase() { operations.push('create'); throw Object.assign(new Error('合成建案失败'), { code: 'FS_TEST' }); }
    close() { operations.push('close'); }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../worker.cjs'), 'utf8'), {
    require: name => { assert.equal(name, './storage.cjs'); return { WorkspaceStore: Store }; },
    process: { argv: ['', '', 'fixture.sql'], parentPort: port }
  });
  for (const [id, method] of [[1, 'openWorkspace'], [2, 'createCase'], [3, 'close']]) port.emit('message', { data: { id, method } });
  await tick();
  assert.deepEqual(operations, ['lock']);
  assert.equal(messages[0].ready, true);
  assert.deepEqual(messages.filter(value => value.type === 'progress').map(value => value.id), [1]);
  assert.equal(messages.filter(value => typeof value.ok === 'boolean').length, 0);
  release(); await tick();
  assert.deepEqual(operations, ['lock', 'commit', 'create', 'close']);
  const finals = messages.filter(value => typeof value.ok === 'boolean');
  assert.deepEqual(finals.map(value => [value.id, value.ok]), [[1, true], [2, false], [3, true]]);
  assert.equal(finals[1].error.message, '合成建案失败');
});

test('worker关闭只在已发送的存储请求结束后停止子进程', async () => {
  const child = new EventEmitter(), posted = []; let killed = false;
  child.postMessage = value => posted.push(value);
  child.kill = () => { killed = true; child.emit('exit'); };
  const context = { module: { exports: {} }, __dirname: path.resolve(__dirname, '..'), process: { stderr: { write() {} } }, setTimeout, clearTimeout,
    require: name => name === 'electron' ? { utilityProcess: { fork: () => child } } : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../worker-client.cjs'), 'utf8'), context);
  const client = new context.module.exports.WorkerClient('fixture.sql');
  child.emit('message', { ready: true });
  const active = client.request('openWorkspace', 'fixture'); await tick();
  const closing = client.close(); await tick();
  assert.equal(killed, false);
  assert.deepEqual(posted.map(value => value.method), ['openWorkspace', 'close']);
  await assert.rejects(client.request('createCase', {}), error => error.code === 'WORKER_STOPPED');
  child.emit('message', { id: posted[0].id, ok: true, data: { ok: true } });
  await active;
  assert.equal(killed, false);
  child.emit('message', { id: posted[1].id, ok: true });
  await closing;
  assert.equal(killed, true);
});

test('非空目录取消确认时只有无写入检查，没有创建工作区', async () => {
  const calls = [], steps = [];
  const result = await chooseWorkspace({ window: {}, onProgress: phase => steps.push(phase), dialog: {
    async showOpenDialog(_window, options) { steps.push('dialog'); assert.equal(options.title, '选择数据存放文件夹'); return { filePaths: [path.resolve('synthetic-nonempty')] }; },
    async showMessageBox(_window, options) {
      steps.push('confirmation');
      assert.match(options.detail, /数据存放位置/);
      assert.match(options.detail, /不会导入其中的流水材料/);
      assert.ok(options.detail.includes('workspace.sqlite'));
      assert.deepEqual(options.buttons, ['在此创建', '重新选择', '取消']);
      assert.equal(options.defaultId, 1);
      return { response: 2 };
    }
  }, worker: { async request(method) { steps.push(method); calls.push(method); return { needsConfirmation: true, confirmationToken: 'one' }; } } });
  assert.equal(result.cancelled, true);
  assert.deepEqual(calls, ['inspectWorkspace']);
  assert.deepEqual(steps, ['choosing-location', 'dialog', 'inspectWorkspace', 'confirming-location', 'confirmation']);
});

test('误选案件内部文件夹时立即显示真实检查错误，不进入新建确认或打开', async () => {
  const calls = [];
  let confirmations = 0;
  await assert.rejects(() => chooseWorkspace({ window: {}, dialog: {
    async showOpenDialog() { return { filePaths: [path.resolve('synthetic/cases/case-id')] }; },
    async showMessageBox() { confirmations++; return { response: 0 }; }
  }, worker: { async request(method) {
    calls.push(method);
    throw Object.assign(new Error('请选择保存全部案件的数据存放文件夹。'), { code: 'FS_WORKSPACE_INNER_FOLDER' });
  } } }), { code: 'FS_WORKSPACE_INNER_FOLDER' });
  assert.deepEqual(calls, ['inspectWorkspace']);
  assert.equal(confirmations, 0);
});

test('非空目录确认携带检查令牌，重新选择也不写入被放弃的目录', async () => {
  const calls = [], phases = []; let choice = 0;
  const worker = { async request(method, candidate, options) {
    calls.push({ method, candidate, options });
    return method === 'inspectWorkspace' ? { needsConfirmation: true, confirmationToken: candidate } : { cases: [] };
  } };
  const result = await chooseWorkspace({ window: {}, worker, onProgress: phase => phases.push(phase), dialog: {
    async showOpenDialog() { return { filePaths: [path.resolve('synthetic-' + (++choice))] }; },
    async showMessageBox() { return { response: choice === 1 ? 1 : 0 }; }
  } });
  assert.equal(choice, 2);
  assert.deepEqual(calls.map(value => value.method), ['inspectWorkspace', 'inspectWorkspace', 'openWorkspace']);
  assert.equal(calls[2].options.confirmationToken, result.candidate);
  assert.equal(result.candidate, path.resolve('synthetic-2'));
  assert.deepEqual(phases, ['choosing-location', 'confirming-location', 'choosing-location', 'confirming-location']);
});

test('已有合法工作区无需新目录确认，取消系统选择不发存储请求', async () => {
  let confirmations = 0, requests = 0;
  const dialog = { async showOpenDialog() { return { filePaths: [path.resolve('synthetic-existing')] }; }, async showMessageBox() { confirmations++; } };
  const worker = { async request(method) { requests++; return method === 'inspectWorkspace' ? { exists: true, needsConfirmation: false } : { cases: [] }; } };
  assert.ok((await chooseWorkspace({ window: {}, dialog, worker })).state);
  assert.equal(confirmations, 0); assert.equal(requests, 2);
  dialog.showOpenDialog = async () => ({ canceled: true });
  const phases = [];
  assert.equal((await chooseWorkspace({ window: {}, dialog, worker, onProgress: phase => phases.push(phase) })).cancelled, true);
  assert.deepEqual(phases, ['choosing-location']);
  assert.equal(requests, 2);
});
