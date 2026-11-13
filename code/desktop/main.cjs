'use strict';

const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { WorkerClient } = require('./worker-client.cjs');

const pagePath = path.resolve(__dirname, '../prototype/index.html');
const pageURL = pathToFileURL(pagePath).href;
const schemaPath = path.resolve(__dirname, '../ddl_extract_check.sql');
let window, worker, workspacePath = null, currentCaseId = null, quitReady = false, quitting = false;
let settingsPath, smokeConfig;
let operation = Promise.resolve();

if (process.env.FUNDSIFT_SMOKE_CONFIG) {
  // Only the local CLI smoke runner supplies this file; it uses an isolated temporary profile.
  smokeConfig = JSON.parse(require('node:fs').readFileSync(path.resolve(process.env.FUNDSIFT_SMOKE_CONFIG), 'utf8'));
  app.setPath('userData', smokeConfig.profile);
  app.commandLine.appendSwitch('disable-gpu');
}

app.setName('FundSift');
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

function safeError(error) {
  const known = error.code && /^(FS_|WORKSPACE_|CASE_|INVALID_|DUPLICATE_|SCHEMA_|STORAGE_|WORKER_|SETTINGS_|SQLITE_)/.test(error.code);
  return { code: error.code || 'DESKTOP_ERROR', message: known ? error.message : '操作未完成，请检查目录权限后重试。原有案件不会被替换。' };
}

async function readSettings() {
  try {
    const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    if (settings.version !== 1 || typeof settings.workspacePath !== 'string' || !path.isAbsolute(settings.workspacePath)) {
      throw Object.assign(new Error('数据目录设置格式不兼容，请保留设置文件并联系维护人员。'), { code: 'SETTINGS_INVALID' });
    }
    workspacePath = settings.workspacePath;
    currentCaseId = typeof settings.currentCaseId === 'string' ? settings.currentCaseId : null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw Object.assign(new Error('无法读取数据目录设置，请检查设置文件及访问权限。'), { code: 'SETTINGS_READ' });
  }
}

async function saveSettings(nextWorkspace, nextCase) {
  const tempPath = settingsPath + '.tmp';
  try {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify({ version: 1, workspacePath: nextWorkspace, currentCaseId: nextCase }, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, settingsPath);
  } catch (_) {
    throw Object.assign(new Error('无法保存数据目录设置。本次案件如已创建仍保留在所选目录，请重试读取，勿重复建案。'), { code: 'SETTINGS_WRITE' });
  }
}

async function getState() {
  if (!workspacePath) await readSettings();
  if (!workspacePath) return { needsWorkspace: true, workspacePath: null, cases: [], currentCaseId: null };
  const state = await worker.request('openWorkspace', workspacePath, { allowCreate: false });
  if (currentCaseId && state.cases.some(item => item.id === currentCaseId && item.available)) {
    await worker.request('openCase', currentCaseId);
  } else currentCaseId = null;
  return { ...state, needsWorkspace: false, currentCaseId };
}

function register(name, handler) {
  ipcMain.handle('fundsift:' + name, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== pageURL) {
      return { ok: false, error: { code: 'INVALID_SENDER', message: '请求来源无效。' } };
    }
    const request = operation.then(() => handler(...args));
    operation = request.catch(() => {});
    try { return { ok: true, data: await request }; }
    catch (error) { return { ok: false, error: safeError(error) }; }
  });
}

async function start() {
  settingsPath = path.join(app.getPath('userData'), 'workspace.json');
  worker = new WorkerClient(schemaPath);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: {
    ...details.responseHeaders,
    'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"]
  } }));
  register('get-state', getState);
  register('list-cases', async () => { await getState(); return worker.request('listCases'); });
  register('choose-workspace', async () => {
    if (workspacePath) return getState();
    const selected = await dialog.showOpenDialog(window, { title: '选择案件数据保存目录', properties: ['openDirectory', 'createDirectory'] });
    if (selected.canceled || !selected.filePaths[0]) return { cancelled: true };
    const candidate = path.resolve(selected.filePaths[0]);
    const state = await worker.request('openWorkspace', candidate, { allowCreate: true });
    await saveSettings(candidate, null);
    workspacePath = candidate;
    currentCaseId = null;
    return { ...state, needsWorkspace: false, currentCaseId: null };
  });
  register('create-case', async payload => {
    if (!workspacePath) throw Object.assign(new Error('请先选择案件数据目录。'), { code: 'WORKSPACE_REQUIRED' });
    const created = await worker.request('createCase', payload);
    await saveSettings(workspacePath, created.id);
    currentCaseId = created.id;
    return created;
  });
  register('open-case', async id => {
    if (!workspacePath) throw Object.assign(new Error('请先选择案件数据目录。'), { code: 'WORKSPACE_REQUIRED' });
    const opened = await worker.request('openCase', id);
    await saveSettings(workspacePath, opened.id);
    currentCaseId = opened.id;
    return opened;
  });
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 1024, minHeight: 720, show: false,
    title: '东启勘流', backgroundColor: '#ffffff', autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets/icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true }
  });
  window.removeMenu();
  if (smokeConfig) window.webContents.on('console-message', event => { console.error('Renderer:', event.message); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url.split('#')[0] !== pageURL) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => { if (!smokeConfig) window.show(); });
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

app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitReady || !worker) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  operation.then(() => worker.close()).catch(() => {}).finally(() => { quitReady = true; app.quit(); });
});
if (singleInstance) app.whenReady().then(start).catch(error => { dialog.showErrorBox('无法启动东启勘流', safeError(error).message); app.quit(); });
