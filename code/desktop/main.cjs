'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { WorkerClient } = require('./worker-client.cjs');
const { chooseWorkspace } = require('./workspace-choice.cjs');
const { createOperationStatus, sanitizeReceipt } = require('./operation-status.cjs');
const { BATCH_FORMATS, scanBatchImport, createBatchPreview, selectBatchFiles, verifyBatchFile } = require('./batch-import.cjs');

const pagePath = path.resolve(__dirname, '../prototype/index.html');
const pageURL = pathToFileURL(pagePath).href;
const schemaPath = path.resolve(__dirname, '../ddl_extract_check.sql');
const iconPath = path.join(__dirname, 'assets/icon.ico');
let window, tray, worker, workspacePath = null, currentCaseId = null, quitReady = false, quitting = false;
let settingsPath, smokeConfig;
let smokeImportIndex = 0;
let operation = Promise.resolve();
let operationSequence = 0, activeStatus = null;
let pendingBatchImport = null, batchFileProgress = null;

if (process.env.FUNDSIFT_SMOKE_CONFIG) {
  // Only the local CLI smoke runner supplies this file; it uses an isolated temporary profile.
  smokeConfig = JSON.parse(require('node:fs').readFileSync(path.resolve(process.env.FUNDSIFT_SMOKE_CONFIG), 'utf8'));
  app.setPath('userData', smokeConfig.profile);
  app.commandLine.appendSwitch('disable-gpu');
}

app.setName('FundSift');
const packagedWindowsApp = process.platform === 'win32' && app.isPackaged;
const installerQuit = packagedWindowsApp && process.argv.includes('--fundsift-install-quit');
const singleInstance = installerQuit
  ? app.requestSingleInstanceLock({ installerQuit: true, executablePath: process.execPath })
  : app.requestSingleInstanceLock();
if (!singleInstance || installerQuit) app.quit();

function showWindow() {
  if (quitting || !window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createTray() {
  if (process.platform !== 'win32' || smokeConfig) return;
  try {
    tray = new Tray(iconPath);
    tray.setToolTip('东启勘流');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开东启勘流', click: showWindow },
      { type: 'separator' },
      { label: '退出东启勘流', click: () => app.quit() }
    ]));
    tray.on('click', showWindow);
  } catch (error) {
    tray?.destroy();
    tray = undefined;
    console.warn('无法创建东启勘流托盘图标', error);
  }
}

function safeError(error) {
  if (error.code?.startsWith('SQLITE_')) {
    const message = error.code.includes('BUSY') || error.code.includes('LOCKED') ? '数据正在被其他操作使用，请稍后重试。'
      : error.code.includes('FULL') ? '磁盘空间不足，操作未完成，请释放空间后重试。'
      : error.code.includes('READONLY') || error.code.includes('CANTOPEN') ? '数据存放文件夹不可写或无法访问，请检查文件夹权限。'
      : /[\u3400-\u9fff]/.test(error.message) ? error.message : '数据库检查未通过，请保留原文件并检查数据。';
    return { code: error.code, message };
  }
  const known = error.code && /^(FS_|WORKSPACE_|CASE_|INVALID_|DUPLICATE_|SCHEMA_|STORAGE_|WORKER_|SETTINGS_)/.test(error.code);
  const receipt = sanitizeReceipt(error.receipt);
  return { code: error.code || 'DESKTOP_ERROR', message: known ? error.message : '操作未完成，请检查目录权限后重试。原有案件不会被替换。',
    ...(receipt ? { receipt } : {}) };
}

async function readSettings() {
  try {
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    if (settings.version !== 1 || typeof settings.workspacePath !== 'string' || !path.isAbsolute(settings.workspacePath)) {
      throw Object.assign(new Error('数据存放位置设置格式不兼容，请保留设置文件并联系维护人员。'), { code: 'SETTINGS_INVALID' });
    }
    workspacePath = settings.workspacePath;
    currentCaseId = typeof settings.currentCaseId === 'string' ? settings.currentCaseId : null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw Object.assign(new Error('无法读取数据存放位置设置，请检查设置文件及访问权限。'), { code: 'SETTINGS_READ' });
  }
}

async function saveSettings(nextWorkspace, nextCase) {
  activeStatus?.update('saving-settings');
  const tempPath = settingsPath + '.tmp';
  try {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify({ version: 1, workspacePath: nextWorkspace, currentCaseId: nextCase }, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, settingsPath);
  } catch (_) {
    throw Object.assign(new Error('无法保存数据存放位置设置。本次案件如已创建仍保留在所选文件夹，请重试读取，勿重复建案。'), { code: 'SETTINGS_WRITE' });
  }
}

async function getState() {
  activeStatus?.update('checking');
  if (!workspacePath) await readSettings();
  if (!workspacePath) return { needsWorkspace: true, workspacePath: null, cases: [], currentCaseId: null };
  const state = await worker.request('openWorkspace', workspacePath, { allowCreate: false });
  let stagingCleanup = null;
  if (currentCaseId && state.cases.some(item => item.id === currentCaseId && item.available)) {
    stagingCleanup = state.currentCaseId === currentCaseId ? state.stagingCleanup ?? null
      : (await worker.request('openCase', currentCaseId)).stagingCleanup ?? null;
  } else currentCaseId = null;
  return { ...state, needsWorkspace: false, currentCaseId, stagingCleanup };
}

function register(name, handler) {
  ipcMain.handle('fundsift:' + name, async (event, ...args) => {
    if (quitting) return { ok: false, error: { code: 'WORKER_CLOSING', message: '正在保存并关闭软件，请等待当前操作完成。' } };
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== pageURL) {
      return { ok: false, error: { code: 'INVALID_SENDER', message: '请求来源无效。' } };
    }
    const status = createOperationStatus({ operationId: ++operationSequence, operation: name,
      publish: value => {
        if (!event.sender.isDestroyed()) event.sender.send('fundsift:operation-status', value);
      } });
    const request = operation.then(async () => {
      activeStatus = status;
      status.update('running');
      try {
        const result = await handler(...args);
        status.finish(true);
        return result;
      } catch (error) {
        status.finish(false);
        throw error;
      } finally { activeStatus = null; }
    });
    operation = request.catch(() => {});
    try { return { ok: true, data: await request }; }
    catch (error) { return { ok: false, error: safeError(error) }; }
  });
}

async function start() {
  settingsPath = path.join(app.getPath('userData'), 'workspace.json');
  worker = new WorkerClient(schemaPath, { onProgress: ({ phase, progress }) =>
    activeStatus?.update(phase, batchFileProgress ? { ...progress, ...batchFileProgress } : progress) });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: {
    ...details.responseHeaders,
    'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"]
  } }));
  register('get-state', getState);
  register('list-cases', async () => { await getState(); return worker.request('listCases'); });
  register('choose-workspace', async () => {
    if (workspacePath) return getState();
    const choice = await chooseWorkspace({ window, dialog, worker, onProgress: phase => activeStatus?.update(phase) });
    if (choice.cancelled) return choice;
    const { candidate, state } = choice;
    await saveSettings(candidate, null);
    workspacePath = candidate;
    currentCaseId = null;
    return { ...state, needsWorkspace: false, currentCaseId: null };
  });
  register('create-case', async payload => {
    if (!workspacePath) throw Object.assign(new Error('请先选择数据存放文件夹。'), { code: 'WORKSPACE_REQUIRED' });
    const created = await worker.request('createCase', payload);
    await saveSettings(workspacePath, created.id);
    pendingBatchImport = null;
    currentCaseId = created.id;
    return created;
  });
  register('open-case', async id => {
    if (!workspacePath) throw Object.assign(new Error('请先选择数据存放文件夹。'), { code: 'WORKSPACE_REQUIRED' });
    const opened = await worker.request('openCase', id);
    await saveSettings(workspacePath, opened.id);
    if (opened.id !== currentCaseId) pendingBatchImport = null;
    currentCaseId = opened.id;
    return opened;
  });
  register('list-removed-cases', async () => {
    await getState();
    if (!workspacePath) return [];
    return worker.request('listRemovedCases');
  });
  register('remove-case', async id => {
    if (!workspacePath) throw Object.assign(new Error('请先选择数据存放文件夹。'), { code: 'WORKSPACE_REQUIRED' });
    const result = await worker.request('removeCase', id);
    let settingsWarning;
    if (currentCaseId === id) {
      currentCaseId = null;
      try { await saveSettings(workspacePath, null); }
      catch (_) { settingsWarning = '案件已移入回收站。本机上次打开的案件设置未能更新。'; }
    }
    return { ...result, currentCaseId, settingsWarning };
  });
  register('restore-case', async id => {
    if (!workspacePath) throw Object.assign(new Error('请先选择数据存放文件夹。'), { code: 'WORKSPACE_REQUIRED' });
    return { ...await worker.request('restoreCase', id), currentCaseId };
  });
  register('list-recycle-bin', () => worker.request('listRecycleBin'));
  register('set-recycle-cases', async (ids, restore) => {
    const result = await worker.request('setRecycleCases', ids, restore === true);
    if (!restore && ids.includes(currentCaseId)) {
      currentCaseId = null;
      try { await saveSettings(workspacePath, null); }
      catch (_) { result.settingsWarning = '案件已移入回收站。本机上次打开的案件设置未能更新。'; }
    }
    return { ...result, currentCaseId };
  });
  register('set-recycle-materials', (caseId, ids, restore) => {
    if (!restore) requireCurrentCase(caseId);
    return worker.request('setRecycleMaterials', caseId, ids, restore === true);
  });
  register('empty-recycle-bin', async selection => {
    const count = (Array.isArray(selection?.caseIds) ? selection.caseIds.length : 0) +
      (Array.isArray(selection?.materialIds) ? selection.materialIds.length : 0);
    if (!count) return { removed: 0, failures: [] };
    const confirmation = smokeConfig ? { response: 0 } : await dialog.showMessageBox(window, {
      type: 'warning', title: '清空回收站',
      message: `永久删除回收站中的 ${count} 项？`,
      detail: '案件、归档副本及对应的流水和复核记录将删除，无法恢复。',
      buttons: ['取消', '永久清空'], defaultId: 0, cancelId: 0, noLink: true
    });
    if (confirmation.response !== 1 && !smokeConfig) return { cancelled: true };
    return worker.request('emptyRecycleBin', selection);
  });
  function requireCurrentCase(id) {
    if (!workspacePath || typeof id !== 'string' || !currentCaseId || id !== currentCaseId) {
      throw Object.assign(new Error('当前案件已变化，请重新打开案件后操作。'), { code: 'FS_CASE_CONTEXT' });
    }
  }
  register('list-materials', async caseId => { requireCurrentCase(caseId); return worker.request('listMaterials', caseId); });
  register('list-removed-materials', caseId => { requireCurrentCase(caseId); return worker.request('listRemovedMaterials', caseId); });
  register('remove-material', (caseId, sourceFileId) => { requireCurrentCase(caseId); return worker.request('removeMaterial', caseId, sourceFileId); });
  register('restore-material', (caseId, sourceFileId) => { requireCurrentCase(caseId); return worker.request('restoreMaterial', caseId, sourceFileId); });
  register('query-flows', async (caseId, options) => { requireCurrentCase(caseId); return worker.request('queryFlows', caseId, options); });
  register('query-relations', async (caseId, options) => { requireCurrentCase(caseId); return worker.request('queryRelations', caseId, options); });
  register('read-flow-source', async (caseId, options) => { requireCurrentCase(caseId); return worker.request('readFlowSource', caseId, options); });
  register('get-review', (caseId, flowId) => { requireCurrentCase(caseId); return worker.request('getReview', caseId, flowId); });
  register('save-review', (caseId, payload) => { requireCurrentCase(caseId); return worker.request('saveReview', caseId, payload); });
  register('list-review-history', (caseId, sourceFileId) => { requireCurrentCase(caseId); return worker.request('listReviewHistory', caseId, sourceFileId); });
  register('retry-import', async (caseId, sourceFileId) => {
    requireCurrentCase(caseId);
    return worker.request('retryImport', caseId, sourceFileId);
  });
  register('reimport-material', async (caseId, sourceFileId, batchId) => {
    requireCurrentCase(caseId);
    const { materials } = await worker.request('listMaterials', caseId);
    const material = materials.find(item => item.id === sourceFileId && item.currentBatchId === batchId && item.canReimport);
    if (!material) throw Object.assign(new Error('当前材料已变化，请刷新后重新选择。'), { code: 'FS_IMPORT_REIMPORT_STATE' });
    activeStatus?.update('confirming-import');
    const confirmation = smokeConfig ? { response: 0 } : await dialog.showMessageBox(window, {
      type: 'question', title: '按支付宝账户规则 v2 重导', message: '应用新版内部划转规则？',
      detail: `材料：${material.fileName}\n\n软件会从原件归档重导。新批次完整核对通过后才成为当前结果，旧规则和旧批次继续留档。${material.reviewedRows !== '0' ? `\n\n当前批次有 ${material.reviewedRows} 条流水留有人工记录，可在重导后的材料历史中查看。新批次按新规则处理。` : ''}`,
      buttons: ['按新规则重导', '取消'], defaultId: 1, cancelId: 1, noLink: true
    });
    if (confirmation.response !== 0) return { cancelled: true };
    requireCurrentCase(caseId);
    return worker.request('reimportMaterial', caseId, sourceFileId, batchId);
  });
  register('export-workpaper', async (caseId, options) => {
    requireCurrentCase(caseId);
    const prepared = await worker.request('getWorkpaperContext', caseId);
    const filename = /^流水核对底稿-格式v([1-9]\d*)-数据v(0|[1-9]\d*)-\d{8}T\d{9}Z\.xlsx(?![\s\S])/u.exec(prepared.fileName);
    if (prepared.caseId !== caseId || filename?.[1] !== String(prepared.formatVersion) || filename?.[2] !== prepared.dataVersion) {
      throw Object.assign(new Error('底稿文件名无法核验，请重新导出。'), { code: 'FS_EXPORT_NAME' });
    }
    activeStatus?.update('choosing-location');
    const choice = smokeConfig?.exportFolder ? { filePaths: [smokeConfig.exportFolder] }
      : await dialog.showOpenDialog(window, { title: '选择底稿保存位置', buttonLabel: '导出 Excel 底稿',
        properties: ['openDirectory', 'createDirectory'] });
    if (choice.canceled || !choice.filePaths?.length) return { cancelled: true };
    if (choice.filePaths.length !== 1 || !path.isAbsolute(choice.filePaths[0])) {
      throw Object.assign(new Error('请选择一个本地文件夹。'), { code: 'FS_EXPORT_PATH' });
    }
    requireCurrentCase(caseId);
    return worker.request('exportWorkpaper', caseId, path.join(choice.filePaths[0], prepared.fileName), prepared.dataVersion, options?.highlightRepairs !== false);
  });
  register('choose-import', async caseId => {
    requireCurrentCase(caseId);
    const fixture = smokeConfig?.importFixtures ? smokeConfig.importFixtures[smokeImportIndex++] : null;
    if (smokeConfig?.importFixtures && (!fixture || typeof fixture.filePath !== 'string' || !path.isAbsolute(fixture.filePath))) {
      throw Object.assign(new Error('隔离烟测导入夹具无效或已用完。'), { code: 'FS_SMOKE_INPUT' });
    }
    activeStatus?.update('confirming-import');
    const formats = BATCH_FORMATS;
    const formatChoice = fixture ? {response:formats.findIndex(item=>item.key===fixture.formatKey)} : await dialog.showMessageBox(window, { type: 'question', title: '选择材料格式（技术预览）',
      message: '本次要导入哪一种材料？', detail: '仅支持列结构与已批准规则一致的材料。完整G0尚未完成。支付宝余额明细不属于账户明细格式。',
      buttons: ['支付宝账户 CSV', '微信交易 TXT', '建行账户 XLSX', '取消'], defaultId: 3, cancelId: 3, noLink: true });
    const format = formats[formatChoice.response];
    if (fixture && !format) throw Object.assign(new Error('隔离烟测格式无效。'), { code:'FS_SMOKE_INPUT' });
    if (!format) return { cancelled: true };
    activeStatus?.update('choosing-file');
    const choice = fixture ? {filePaths:[fixture.filePath]} : await dialog.showOpenDialog(window, { title: `导入${format.name}（技术预览）`,
      buttonLabel: '选择材料', properties: ['openFile'], filters: [{ name: format.name, extensions: [format.extension] }] });
    if (choice.canceled || !choice.filePaths?.length) return { cancelled: true };
    if (choice.filePaths.length !== 1 || typeof choice.filePaths[0] !== 'string' || !path.isAbsolute(choice.filePaths[0])) {
      throw Object.assign(new Error('请选择一份本地材料。'), { code: 'FS_IMPORT_INPUT' });
    }
    activeStatus?.update('confirming-import');
    const bank = !format.confirmedCny;
    const confirmation = fixture ? {response:0} : await dialog.showMessageBox(window, { type: 'question', title: '确认本次材料与处理范围',
      message: bank ? '请确认采用本格式的保守处理规则。' : '请确认所选材料中的金额全部为人民币。',
      detail: `文件：${path.basename(choice.filePaths[0])}\n格式：${format.name}\n\n${format.policy}\n\n技术预览：完整G0尚未完成。导入结果的待核原因可在异常复核页查看。${bank ? '币种按原文与批准映射处理。' : '请根据材料来源核实币种为人民币。'}`,
      buttons: [bank ? '按此规则导入' : '确认人民币并导入', '取消'], defaultId: 1, cancelId: 1, noLink: true });
    if (confirmation.response !== 0) return { cancelled: true };
    requireCurrentCase(caseId);
    return worker.request('importFile', caseId, { filePath: choice.filePaths[0], formatKey: format.key, confirmedCny: format.confirmedCny, confirmedAt: new Date().toISOString() });
  });
  async function prepareBatchImport(caseId, paths, mode) {
    requireCurrentCase(caseId);
    if (!Array.isArray(paths) || !paths.length || paths.some(file => typeof file !== 'string' || !path.isAbsolute(file))) {
      throw Object.assign(new Error('请选择本地文件或文件夹。'), { code: 'FS_IMPORT_BATCH_INPUT' });
    }
    activeStatus?.update('checking');
    const files = await scanBatchImport(paths, mode);
    pendingBatchImport = createBatchPreview(caseId, workspacePath, files);
    return pendingBatchImport.preview;
  }

  register('choose-batch-import', async (caseId, mode) => {
    requireCurrentCase(caseId);
    if (mode !== 'files' && mode !== 'folder') {
      throw Object.assign(new Error('请选择文件或文件夹。'), { code: 'FS_IMPORT_BATCH_INPUT' });
    }
    activeStatus?.update(mode === 'folder' ? 'choosing-location' : 'choosing-file');
    const fixture = mode === 'folder' ? (smokeConfig?.batchFolder && [smokeConfig.batchFolder]) : smokeConfig?.batchFiles;
    const choice = fixture ? { filePaths: fixture } : await dialog.showOpenDialog(window, mode === 'folder'
      ? { title: '选择包含流水的文件夹', buttonLabel: '扫描文件夹', properties: ['openDirectory'] }
      : { title: '选择流水材料', buttonLabel: '添加到清单', properties: ['openFile', 'multiSelections'],
        filters: [{ name: '支持的文件类型', extensions: BATCH_FORMATS.map(format => format.extension) }] });
    if (choice.canceled || !choice.filePaths?.length) return { cancelled: true };
    return prepareBatchImport(caseId, choice.filePaths, mode);
  });
  register('drop-batch-import', (caseId, paths) => prepareBatchImport(caseId, paths, 'drop'));
  register('cancel-batch-import', (caseId, token) => {
    requireCurrentCase(caseId);
    if (pendingBatchImport?.caseId === caseId && pendingBatchImport.token === token) pendingBatchImport = null;
    return { cancelled: true };
  });
  register('run-batch-import', async (caseId, selection) => {
    requireCurrentCase(caseId);
    const files = selectBatchFiles(pendingBatchImport, caseId, workspacePath, selection);
    const approvals = new Map();
    activeStatus?.update('confirming-import');
    for (const format of BATCH_FORMATS) {
      const count = files.filter(file => file.formatKey === format.key).length;
      if (!count) continue;
      const confirmation = (smokeConfig?.batchFolder || smokeConfig?.batchFiles)
        ? { response: 0 } : await dialog.showMessageBox(window, {
        type: 'question', title: '确认导入规则',
        message: format.confirmedCny ? `${format.name} · 确认这 ${count} 份材料均为人民币` : `${format.name} · 确认这 ${count} 份材料的处理规则`,
        detail: format.policy + (format.confirmedCny ? '\n\n请根据材料来源核实币种。' : ''),
        buttons: [format.confirmedCny ? '确认人民币' : '确认处理规则', '取消'], defaultId: 1, cancelId: 1, noLink: true
      });
      if (confirmation.response !== 0) return { cancelled: true };
      approvals.set(format.key, { formatKey: format.key, confirmedCny: format.confirmedCny, confirmedAt: new Date().toISOString() });
    }
    requireCurrentCase(caseId);
    pendingBatchImport = null;
    const results = [];
    let stopped = false;
    try {
      for (const [index, file] of files.entries()) {
        const result = { id: file.id, name: file.name, relativePath: file.relativePath, formatKey: file.formatKey };
        if (stopped) {
          results.push({ ...result, status: 'not-processed', reason: '批量导入已停止。' });
          continue;
        }
        batchFileProgress = { fileIndex: index + 1, fileCount: files.length };
        activeStatus?.update('checking', batchFileProgress);
        try {
          await verifyBatchFile(file);
          const input = { filePath: file.filePath, ...approvals.get(file.formatKey) };
          const receipt = await worker.request('importFileReceipt', caseId, input, file.identity);
          results.push({ ...result, status: 'imported', receipt });
        } catch (error) {
          const { code, message, receipt } = safeError(error);
          const unknown = code === 'WORKER_STOPPED';
          stopped = code === 'FS_ARCHIVE_SPACE' || code === 'FS_ARCHIVE_PATH' ||
            /^(WORKER_|FS_CASE_|CASE_|SQLITE_(FULL|NOTADB|CORRUPT|CANTOPEN|READONLY|IOERR))/.test(code);
          const reason = /^FS_FORMAT_(CSV|TSV|STRUCTURE|UNSUPPORTED)$/.test(code)
            ? `文件内容与“${file.formatName}”的受支持模板不符。`
            : unknown ? '本地数据进程已停止，重新打开软件后请查看材料列表核实结果。' : message;
          const status = code === 'FS_IMPORT_DUPLICATE' ? 'duplicate' : unknown ? 'unknown' : 'failed';
          results.push({ ...result, status, reason, ...(receipt ? { receipt } : {}) });
        }
      }
    } finally {
      batchFileProgress = null;
    }
    try {
      const state = await worker.request('getBatchImportState', caseId);
      return { results, ...state };
    } catch (error) {
      return { results, refreshError: safeError(error).message };
    }
  });
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 1024, minHeight: 720, show: false,
    title: '东启勘流', backgroundColor: '#ffffff', autoHideMenuBar: true,
    icon: iconPath,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      ...(smokeConfig ? { offscreen: true, backgroundThrottling: false } : {}) }
  });
  createTray();
  window.on('close', event => {
    if (quitting || !tray || tray.isDestroyed()) return;
    event.preventDefault();
    window.hide();
  });
  window.removeMenu();
  if (smokeConfig) window.webContents.on('console-message', event => { console.error('Renderer:', event.message); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url.split('#')[0] !== pageURL) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => { if (!smokeConfig && !quitting) window.show(); });
  await window.loadFile(pagePath);
  if (smokeConfig) {
    try {
      await require('./smoke-runner.cjs').run({ app, window, worker, config: smokeConfig, getState, saveSettings, setWorkspace: value => { workspacePath = value; } });
    } catch (error) {
      await fs.writeFile(smokeConfig.result, JSON.stringify({ ok: false, error: error.stack || error.message }));
      process.exitCode = 1;
    } finally { app.quit(); }
  }
}

app.on('second-instance', (_event, _argv, _workingDirectory, data) => {
  if (quitting) return;
  if (data?.installerQuit === true) {
    // The portable and installed builds can share an application profile.
    // Only the active instance of the very same executable should exit.
    if (packagedWindowsApp && typeof data.executablePath === 'string' &&
        path.win32.normalize(data.executablePath).toLowerCase() === path.win32.normalize(process.execPath).toLowerCase()) {
      app.quit();
    }
    return;
  }
  showWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitReady || !worker) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  operation.then(() => worker.close()).catch(() => {}).finally(() => { quitReady = true; app.quit(); });
});
app.on('will-quit', () => { tray?.destroy(); });
if (singleInstance && !installerQuit) {
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('无法启动东启勘流', safeError(error).message); app.quit(); });
}
