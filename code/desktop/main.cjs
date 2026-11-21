'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { WorkerClient } = require('./worker-client.cjs');
const { chooseWorkspace } = require('./workspace-choice.cjs');
const { createOperationStatus, sanitizeReceipt } = require('./operation-status.cjs');

const pagePath = path.resolve(__dirname, '../prototype/index.html');
const pageURL = pathToFileURL(pagePath).href;
const schemaPath = path.resolve(__dirname, '../ddl_extract_check.sql');
const iconPath = path.join(__dirname, 'assets/icon.ico');
let window, tray, worker, workspacePath = null, currentCaseId = null, quitReady = false, quitting = false;
let settingsPath, smokeConfig;
let smokeImportIndex = 0;
let operation = Promise.resolve();
let operationSequence = 0, activeStatus = null;

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
  worker = new WorkerClient(schemaPath, { onProgress: ({ phase, progress }) => activeStatus?.update(phase, progress) });
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
    currentCaseId = created.id;
    return created;
  });
  register('open-case', async id => {
    if (!workspacePath) throw Object.assign(new Error('请先选择数据存放文件夹。'), { code: 'WORKSPACE_REQUIRED' });
    const opened = await worker.request('openCase', id);
    await saveSettings(workspacePath, opened.id);
    currentCaseId = opened.id;
    return opened;
  });
  function requireCurrentCase(id) {
    if (!workspacePath || typeof id !== 'string' || !currentCaseId || id !== currentCaseId) {
      throw Object.assign(new Error('当前案件已变化，请重新打开案件后操作。'), { code: 'FS_CASE_CONTEXT' });
    }
  }
  register('list-materials', async caseId => { requireCurrentCase(caseId); return worker.request('listMaterials', caseId); });
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
  register('export-workpaper', async caseId => {
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
    return worker.request('exportWorkpaper', caseId, path.join(choice.filePaths[0], prepared.fileName), prepared.dataVersion);
  });
  register('choose-import', async caseId => {
    requireCurrentCase(caseId);
    const fixture = smokeConfig?.importFixtures ? smokeConfig.importFixtures[smokeImportIndex++] : null;
    if (smokeConfig?.importFixtures && (!fixture || typeof fixture.filePath !== 'string' || !path.isAbsolute(fixture.filePath))) {
      throw Object.assign(new Error('隔离烟测导入夹具无效或已用完。'), { code: 'FS_SMOKE_INPUT' });
    }
    activeStatus?.update('confirming-import');
    const formats = [
      {key:'alipay-account-17col-v1',name:'17列支付宝账户明细',extension:'csv'},
      {key:'wechat-trades-27col-v1',name:'27列微信交易明细',extension:'txt'},
      {key:'ccb-account-32col-v1',name:'32列建行账户交易明细',extension:'xlsx'}
    ];
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
    const bank = format.key === 'ccb-account-32col-v1';
    const policy = bank ? '采用交易日期加交易时间、元转分、借记出贷记进；负额、零额和未知值保留待核。账号与卡号分开保留。原始币种“人民币元”按批准映射记为CNY，其它币种依证据处理；余额仅保留，不做余额链校验。'
      : format.key === 'wechat-trades-27col-v1' ? '采用交易时间、主金额按分、入记进出记出；主金额与收款金额不符等异常保留待核，完整平台用户ID原文保留。余额仅保留，不做余额链校验。'
      : '采用支付宝账户规则 v2。使用付款时间、元转分，收入记进、支出记出。证据明确的同主体余额转余额宝记录标为内部划转，保留账户变动证据，排除经济收支。无法确认的方向和关闭交易继续待核。';
    const confirmation = fixture ? {response:0} : await dialog.showMessageBox(window, { type: 'question', title: '确认本次材料与处理范围',
      message: bank ? '请确认采用本格式的保守处理规则。' : '请确认所选材料中的金额全部为人民币。',
      detail: `文件：${path.basename(choice.filePaths[0])}\n格式：${format.name}\n\n${policy}\n\n技术预览：完整G0尚未完成。导入结果的待核原因可在异常复核页查看。${bank ? '币种按原文与批准映射处理。' : '请根据材料来源核实币种为人民币。'}`,
      buttons: [bank ? '按此规则导入' : '确认人民币并导入', '取消'], defaultId: 1, cancelId: 1, noLink: true });
    if (confirmation.response !== 0) return { cancelled: true };
    requireCurrentCase(caseId);
    return worker.request('importFile', caseId, { filePath: choice.filePaths[0], formatKey: format.key, confirmedCny: !bank, confirmedAt: new Date().toISOString() });
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
