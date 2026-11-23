'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { scanBatchImport, createBatchPreview, selectBatchFiles, verifyBatchFile } = require('../batch-import.cjs');

function makeFiles(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fundsift-batch-import-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'materials');
  fs.mkdirSync(folder);
  const nested = path.join(folder, 'nested');
  fs.mkdirSync(nested);
  const alipay = path.join(folder, '01-alipay.CSV');
  const wechat = path.join(folder, '02-wechat.txt');
  const ccb = path.join(nested, '03-ccb.xlsx');
  const ignored = path.join(nested, 'readme.pdf');
  for (const file of [alipay, wechat, ccb, ignored]) fs.writeFileSync(file, 'synthetic test metadata');
  return { root, folder, alipay, wechat, ccb, ignored };
}

test('批量清单递归、过滤链接和不支持类型，按案件和令牌验证勾选，原件变动后拒绝进入导入', async t => {
  const { root, folder, ccb, alipay } = makeFiles(t);
  const target = path.join(root, 'outside');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'outside.csv'), 'outside');
  fs.symlinkSync(target, path.join(folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

  const files = await scanBatchImport([folder, ccb], 'drop');
  assert.equal(files.length, 5);
  assert.equal(files.some(file => file.name === 'outside.csv'), false);
  assert.equal(files.find(file => file.name === 'linked').status, 'skipped');
  assert.equal(files.find(file => file.name === 'readme.pdf').status, 'skipped');
  assert.equal(files.find(file => file.name === '03-ccb.xlsx').relativePath, path.join('materials', 'nested', '03-ccb.xlsx'));
  assert.equal((await scanBatchImport([folder], 'files'))[0].status, 'skipped');

  const batch = createBatchPreview('case-a', root, files);
  assert.equal(batch.preview.files.some(file => 'filePath' in file || 'identity' in file), false);
  const selection = { token: batch.token, fileIds: [1] };
  assert.equal(selectBatchFiles(batch, 'case-a', root, selection)[0].filePath, alipay);
  assert.throws(() => selectBatchFiles(batch, 'case-b', root, selection), { code: 'FS_IMPORT_BATCH_STALE' });
  assert.throws(() => selectBatchFiles(batch, 'case-a', folder, selection), { code: 'FS_IMPORT_BATCH_STALE' });
  assert.throws(() => selectBatchFiles(batch, 'case-a', root, { ...selection, fileIds: [1, 1] }), { code: 'FS_IMPORT_BATCH_INPUT' });
  await verifyBatchFile(files[0]);
  fs.appendFileSync(alipay, 'modified after preview');
  await assert.rejects(verifyBatchFile(files[0]), { code: 'FS_IMPORT_BATCH_CHANGED' });
});

test('主进程批量确认先于写入，逐份处理、呈现重复结果和进度，令牌不可重放', async t => {
  const { root, folder, alipay, wechat, ccb } = makeFiles(t);
  const events = [], requests = [], handlers = new Map(), nativePrompts = [];
  const app = new EventEmitter();
  Object.assign(app, { setName() {}, requestSingleInstanceLock: () => true, getPath: () => root,
    whenReady: () => Promise.resolve(), quit() {} });
  let currentWindow, approvals = [], selectedPaths = [folder], diskFull = false;
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      currentWindow = this;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: require('node:url').pathToFileURL(path.resolve(__dirname, '../../prototype/index.html')).href },
        isDestroyed: () => false, setWindowOpenHandler() {}, send(_name, entry) { events.push(entry); }
      });
    }
    removeMenu() {}
    async loadFile() {}
  }
  class FakeWorker {
    constructor(_schema, { onProgress }) { this.onProgress = onProgress; }
    async request(method, ...args) {
      requests.push([method, ...args]);
      if (method === 'openWorkspace') return { cases: [{ id: 'case-a', available: true }], workspacePath: root, currentCaseId: 'case-a' };
      if (method === 'importFileReceipt') {
        this.onProgress({ phase: 'importing', progress: { writtenRows: 1 } });
        if (diskFull) throw Object.assign(new Error('数据存放位置的磁盘空间不足。'), { code: 'FS_ARCHIVE_SPACE' });
        if (args[1].filePath === wechat) throw Object.assign(new Error('重复文件'), { code: 'FS_IMPORT_DUPLICATE' });
        return { state: 'completed', importedRows: 1 };
      }
      if (method === 'getBatchImportState') return { materials: { materials: [] }, case: { id: 'case-a' } };
      return {};
    }
  }
  const electron = {
    app, BrowserWindow: FakeWindow,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: {
      async showOpenDialog(_window, options) { nativePrompts.push(options); return { filePaths: selectedPaths }; },
      async showMessageBox(_window, options) { nativePrompts.push(options); return { response: approvals.shift() }; }
    },
    session: { defaultSession: { setPermissionRequestHandler() {}, webRequest: { onHeadersReceived() {} } } }
  };
  const desktopDir = path.resolve(__dirname, '..');
  vm.runInNewContext(fs.readFileSync(path.join(desktopDir, 'main.cjs'), 'utf8'), {
    __dirname: desktopDir, process: { env: {} },
    require: name => name === 'electron' ? electron : name === './worker-client.cjs' ? { WorkerClient: FakeWorker }
      : name === 'node:fs/promises' ? { readFile: async () => JSON.stringify({ version: 1, workspacePath: root, currentCaseId: 'case-a' }) }
        : require(name.startsWith('./') ? path.resolve(desktopDir, name) : name)
  });
  await new Promise(resolve => setImmediate(resolve));
  const event = { sender: currentWindow.webContents, senderFrame: currentWindow.webContents.mainFrame };
  const call = (name, ...args) => handlers.get('fundsift:' + name)(event, ...args);
  await call('get-state');
  assert.equal((await call('choose-batch-import', 'case-b', 'folder')).error.code, 'FS_CASE_CONTEXT');
  const { data: preview } = await call('choose-batch-import', 'case-a', 'folder');
  assert.equal(nativePrompts[0].properties[0], 'openDirectory');
  const selection = { token: preview.token, fileIds: preview.files.filter(file => file.status === 'ready').map(file => file.id) };
  approvals = [0, 1];
  assert.equal((await call('run-batch-import', 'case-a', selection)).data.cancelled, true);
  assert.equal(requests.some(([method]) => method === 'importFileReceipt'), false);
  approvals = [0, 0, 0];
  const { data: outcome } = await call('run-batch-import', 'case-a', selection);
  assert.deepEqual(Array.from(outcome.results, item => item.status), ['imported', 'duplicate', 'imported']);
  assert.equal(outcome.case.id, 'case-a');
  const imports = requests.filter(([method]) => method === 'importFileReceipt');
  assert.deepEqual(imports.map(([, , input]) => input.filePath), [alipay, wechat, ccb]);
  assert.deepEqual(imports.map(([, , input]) => input.confirmedCny), [true, true, false]);
  assert.deepEqual(events.filter(entry => entry.phase === 'importing').map(entry => entry.progress.fileIndex), [1, 2, 3]);
  assert.equal((await call('run-batch-import', 'case-a', selection)).error.code, 'FS_IMPORT_BATCH_STALE');
  selectedPaths = [alipay, wechat];
  const { data: multi } = await call('choose-batch-import', 'case-a', 'files');
  assert.equal(multi.files.length, 2);
  assert.equal(nativePrompts.at(-1).properties.includes('multiSelections'), true);
  diskFull = true;
  approvals = [0, 0];
  const { data: interrupted } = await call('run-batch-import', 'case-a', { token: multi.token, fileIds: multi.files.map(file => file.id) });
  assert.deepEqual(Array.from(interrupted.results, item => item.status), ['failed', 'not-processed']);
  assert.match(interrupted.results[0].reason, /磁盘空间不足/);
  assert.equal(requests.filter(([method]) => method === 'importFileReceipt').length, 4);
});
