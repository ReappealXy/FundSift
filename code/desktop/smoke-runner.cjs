'use strict';
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function snapshotFolder(folder) {
  const snapshot = [];
  async function visit(relative = '') {
    const entries = await fs.readdir(path.join(folder, relative), { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        snapshot.push([name, 'directory']);
        await visit(name);
      } else {
        const bytes = await fs.readFile(path.join(folder, name));
        snapshot.push([name, 'file', createHash('sha256').update(bytes).digest('hex')]);
      }
    }
  }
  await visit();
  return snapshot;
}

async function run({ app, window, worker, config, getState, saveSettings, setWorkspace }) {
  const checks = [];
  function verify(value, name) { assert.ok(value, name); checks.push(name); }
  const js = async expression => {
    try { return await window.webContents.executeJavaScript(expression, true); }
    catch (error) { throw new Error('Renderer expression: ' + expression + '\n' + error.message); }
  };
  const wait = async expression => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await js(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Renderer did not reach expected state: ' + expression);
  };
  const enterIntro = async () => {
    await js('document.querySelector("#enter-workspace").click()');
    await wait('document.querySelector("#intro-screen").hidden && !document.querySelector("#application").inert && !document.body.classList.contains("intro-departing")');
  };
  verify(await js('typeof require === "undefined" && typeof process === "undefined"'), 'renderer has no Node access');
  verify(await js('Boolean(window.fundsiftDesktop)'), 'isolated preload bridge exists');
  verify(await js('typeof window.fundsiftDesktop.onOperationStatus === "function"'), 'isolated preload exposes task status subscription');
  await wait('window.FUND_INTRO && document.querySelector("#intro-screen [data-action=help]")');
  verify(await js('window.FUND_COPY.desktop === true && document.querySelector("#intro-screen").textContent.includes("本地桌面版") && document.querySelector("#intro-screen").textContent.includes("案件管理可用") && document.querySelector("#intro-screen").textContent.includes("流水导入、复核与导出开发中")'), 'real preload selects desktop introduction copy');
  await js('document.querySelector("#intro-screen [data-action=help]").focus();document.querySelector("#intro-screen [data-action=help]").click()');
  await wait('document.querySelector("#modal-root .modal[data-help=true]") && document.activeElement.closest(".modal") !== null');
  verify(await js('!document.querySelector("#modal-root").hidden && !document.querySelector("#modal-root").inert && document.querySelector("#modal-root .modal").getClientRects().length > 0 && !document.querySelector("#modal-root .modal").closest("[hidden],[inert]")'), 'introduction help is visible and not inert');
  verify(await js('document.querySelector("#modal-root .modal").contains(document.activeElement)'), 'introduction help receives keyboard focus');
  verify(await js('(()=>{const text=document.querySelector("#modal-root .modal").textContent;return ["正常关闭原电脑的软件","整个数据存放文件夹","兼容版本","写入权限","足够空间","不是自动同步","请勿两台电脑同时修改"].every(part=>text.includes(part));})()'), 'help explains complete workspace copying and new computer conditions');
  await js('document.querySelector("#modal-root .modal-head [data-action=close-modal]").click()');
  await wait('!document.querySelector("#modal-root .modal")');
  verify(await js('!document.querySelector("#intro-screen").hidden && !document.querySelector("#intro-screen").inert && document.activeElement === document.querySelector("#intro-screen [data-action=help]")'), 'closing introduction help restores its trigger focus');
  const initial = await getState();
  if (config.phase === 'upgrade') {
    const fixture = JSON.parse(await fs.readFile(path.join(config.profile, 'legacy-fixture.json'), 'utf8'));
    verify(!initial.needsWorkspace && initial.cases.length === 1 && initial.cases[0].available, 'legacy workspace upgrades through real desktop worker');
    const legacy = initial.cases[0];
    verify(legacy.id === fixture.id && legacy.number === 'LEGACY-SMOKE-001', 'legacy UUID and case number remain unchanged');
    verify(legacy.updatedAt === fixture.updated, 'migration preserves business update time');
    verify(legacy.stats.files === 1 && legacy.stats.flows === 1 && legacy.stats.pending === 0, 'legacy flow counts survive migration');
    for (const folder of [config.workspace, path.join(config.workspace, 'cases', fixture.id)]) {
      const backups = await fs.readdir(path.join(folder, 'backup'));
      verify(backups.length === 1, 'one versioned backup for ' + path.basename(folder));
      const manifest = JSON.parse(await fs.readFile(path.join(folder, 'backup', backups[0], 'manifest.json'), 'utf8'));
      verify(manifest.result === 'upgraded' && manifest.targetVersion === 2 && /^[0-9a-f]{64}$/.test(manifest.sha256), 'verified backup manifest for ' + manifest.kind);
    }
    await getState();
    verify((await fs.readdir(path.join(config.workspace, 'backup'))).length === 1, 'v2 refresh does not repeat migration');
    await enterIntro();
  } else if (config.phase === 'create') {
    verify(initial.needsWorkspace && initial.cases.length === 0, 'first launch requires user folder selection');
    await enterIntro();
    await wait('document.querySelector(".desktop-setup [data-action=choose-workspace]") !== null');
    verify(await js('document.querySelector(".desktop-setup h2").textContent === "先选择数据存放位置" && document.querySelector(".desktop-setup [data-action=choose-workspace]").textContent.includes("选择存放文件夹")'), 'first entry shows storage setup before a workspace exists');
    verify(await js('document.querySelector(".setup-input-note").textContent.includes("不会导入文件夹里的流水") && document.querySelector(".setup-status").textContent.includes("流水导入等功能开发中")'), 'first-use guidance separates saving cases from importing flows');
    verify(await js('(()=>{const text=document.querySelector(".setup-details").textContent;return ["原来保存全部案件的文件夹","cases","备份","升级","不要强行关闭"].every(part=>text.includes(part));})()'), 'first-use guidance explains whole-folder selection and upgrade precautions');
    verify((await getState()).needsWorkspace, 'viewing first-use guidance does not select or create a workspace');
    await worker.request('openWorkspace', config.workspace);
    await saveSettings(config.workspace, null);
    setWorkspace(config.workspace);
    const reloaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    window.webContents.reload();
    await reloaded;
    await wait('document.querySelector("[data-action=new-case]") !== null');
    await enterIntro();
    await js('document.querySelector("[data-action=new-case]").click()');
    const fields = await js('Array.from(document.querySelectorAll("#modal-root input")).map(e=>({id:e.id,type:e.type}))');
    verify(fields.some(field => field.id === 'new-name') && fields.some(field => field.id === 'new-number'), 'case form shows required fields');
    verify(!await js('Boolean(document.querySelector("#new-type"))'), 'case type is absent');
    verify(await js('document.querySelector("#new-name").maxLength === 40 && document.querySelector("#new-number").maxLength === 30'), 'case form exposes name and number length limits');
    verify(await js('document.querySelector(".case-save-location span").textContent === ' + JSON.stringify(config.workspace)), 'case form shows the actual workspace save location');
    await js('document.querySelector("#new-name").value="M0 合成验收案";document.querySelector("#new-number").value="M0-SMOKE-001";document.querySelector("[data-action=save-case]").click()');
    await wait('!document.querySelector("#modal-root .modal") && document.querySelector("#sidebar").textContent.includes("M0-SMOKE-001")');
    const state = await getState();
    verify(state.cases.length === 1 && state.cases[0].name === 'M0 合成验收案', 'renderer create writes real database');
    verify(state.cases[0].stats.flows === 0, 'production starts without synthetic flows');
    const duplicate = await js('window.fundsiftDesktop.createCase({name:"重复合成案",number:"m0-smoke-001"})');
    verify(!duplicate.ok, 'duplicate case number is refused');
    await js('document.querySelector("[data-action=nav][data-route=home]").click();document.querySelector("[data-action=new-case]").click()');
    await js('document.querySelector("#new-name").value="切换合成验收案";document.querySelector("#new-number").value="M0-SMOKE-002";document.querySelector("[data-action=save-case]").click()');
    await wait('!document.querySelector("#modal-root .modal") && document.querySelector("#sidebar").textContent.includes("M0-SMOKE-002")');
    const second = (await getState()).cases.find(item => item.number === 'M0-SMOKE-002');
    verify(second && second.id !== state.cases[0].id, 'second case is independently persisted');
    for (const target of [state.cases[0], second, state.cases[0]]) {
      await js('document.querySelector("[data-action=switch-case]").click()');
      await js('document.querySelector(' + JSON.stringify('[data-action=choose-case][data-id="' + target.id + '"]') + ').click()');
      await wait('!document.querySelector("#modal-root .modal") && document.querySelector("#sidebar .case-label").textContent === ' + JSON.stringify(target.number));
      verify((await getState()).currentCaseId === target.id, 'case switching keeps identity for ' + target.number);
    }
    const caseDirectory = path.join(config.workspace, 'cases', state.cases[0].id);
    const internalFolders = [
      ['case directory', caseDirectory],
      ['cases container', path.join(config.workspace, 'cases')],
      ['case archive', path.join(caseDirectory, 'archive')],
      ['case exports', path.join(caseDirectory, 'exports')]
    ];
    for (const [name, folder] of internalFolders) {
      const before = await snapshotFolder(config.workspace);
      let failure;
      try { await worker.request('inspectWorkspace', folder); } catch (error) { failure = error; }
      verify(failure?.code === 'FS_WORKSPACE_INNER_FOLDER' && failure.message.includes('保存全部案件'), 'real desktop worker rejects ' + name + ' as a workspace');
      const after = await snapshotFolder(config.workspace);
      verify(JSON.stringify(after) === JSON.stringify(before), 'refusing ' + name + ' preserves every workspace file');
    }
  } else {
    verify(!initial.needsWorkspace && initial.cases.length === 2, 'workspace selection and both cases persist on restart');
    const first = initial.cases.find(item => item.number === 'M0-SMOKE-001');
    verify(first && initial.cases.some(item => item.number === 'M0-SMOKE-002'), 'restarted case identities match');
    const response = await js('window.fundsiftDesktop.openCase(' + JSON.stringify(first.id) + ')');
    verify(response.ok && response.data.id === first.id, 'packaged worker reopens existing SQLite');
    const invalid = await js('window.fundsiftDesktop.openCase("../outside")');
    verify(!invalid.ok, 'path traversal case ID is rejected');
    await enterIntro();
  }
  await js('document.querySelector("[data-action=nav][data-route=materials]").click()');
  await wait('document.querySelector(".desktop-materials .format-table tbody") !== null');
  verify(await js('JSON.stringify(Array.from(document.querySelectorAll(".format-table tbody tr")).map(row=>Array.from(row.cells).map(cell=>cell.textContent))) === ' + JSON.stringify(JSON.stringify([
    ['建设银行', '.xlsx', '计划接入具体流水模板'],
    ['微信账单', '.txt', '计划接入具体导出格式'],
    ['支付宝账单', '.csv', '计划接入具体导出格式']
  ]))), 'materials lists the three planned source formats');
  verify(await js('document.querySelector(".desktop-materials .feature-status").textContent === "流水导入开发中" && document.querySelector(".desktop-materials .import-disabled").getAttribute("aria-disabled") === "true" && document.querySelector(".desktop-materials").textContent.includes("尚未完成导入验收")'), 'materials explicitly marks import as unavailable and awaiting validation');
  verify(!await js('Boolean(document.querySelector("#application [data-action=pick-files],#application [data-action=do-export]"))'), 'desktop materials exposes no file picker or export action');
  // Navigate back to the real workbench before capturing the shipped interface.
  await js('document.querySelector("[data-action=nav][data-route=home]")?.click()');
  const expectedName = config.phase === 'upgrade' ? '旧版合成验收案' : 'M0 合成验收案';
  await wait('document.querySelector("#main").textContent.includes(' + JSON.stringify(expectedName) + ')');
  await wait('document.querySelector("#intro-screen").hidden && !document.querySelector("#application").inert && !document.body.classList.contains("intro-departing")');
  verify(await js('document.querySelector(".desktop-stats-note").textContent.includes("“—”表示统计尚待检查")'), 'home explains the unknown-statistics dash');
  verify(await js('getComputedStyle(document.querySelector("#application")).display !== "none" && getComputedStyle(document.querySelector("#main")).opacity === "1"'), 'finished workbench is visible and interactive before screenshot');
  verify(!await js('document.querySelector("#main").textContent.includes("远川商贸")'), 'demo cases are isolated from desktop data');
  await js('window.smokeTaskEvents=[];window.smokeStopTaskEvents=window.fundsiftDesktop.onOperationStatus(event=>window.smokeTaskEvents.push(event));true');
  const checked = await js('window.fundsiftDesktop.getState()');
  verify(checked.ok, 'task status observation keeps real get-state result');
  await wait('window.smokeTaskEvents.some(event=>event.phase === "completed")');
  const taskEvents = await js('window.smokeTaskEvents');
  const statusId = taskEvents.find(event => event.operation === 'get-state')?.operationId;
  const ownStatus = taskEvents.filter(event => event.operationId === statusId);
  verify(ownStatus[0]?.phase === 'queued' && ownStatus.some(event => event.phase === 'running') && ownStatus.at(-1)?.phase === 'completed' && ownStatus.at(-1)?.active === false,
    'real IPC task emits queue, start and terminal completion');
  verify(ownStatus.every(event => Number.isSafeInteger(event.operationId) && Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 && typeof event.waitingLong === 'boolean'),
    'real task events contain safe identity and measured waiting time');
  const failedTask = await js('window.fundsiftDesktop.openCase("../invalid-status-probe")');
  verify(!failedTask.ok, 'task status does not turn refused open into success');
  await wait('window.smokeTaskEvents.some(event=>event.operation === "open-case" && event.phase === "failed" && !event.active)');
  verify(await js('!document.querySelector("#desktop-operation-status") || document.querySelector("#desktop-operation-status").hidden'), 'terminal tasks clear active status notice');
  await js('window.smokeStopTaskEvents();window.smokeTaskEventCount=window.smokeTaskEvents.length');
  await js('window.fundsiftDesktop.getState()');
  verify(await js('window.smokeTaskEvents.length === window.smokeTaskEventCount'), 'task status subscription can be removed');
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await new Promise(resolve => setTimeout(resolve, 200));
  const screenshot = await window.webContents.capturePage();
  await fs.writeFile(config.screenshot, screenshot.toPNG());
  if (config.phase === 'reopen') {
    await worker.request('close');
    const moved = config.workspace + '.moved';
    await fs.rename(config.workspace, moved);
    try {
      const lost = await js('window.fundsiftDesktop.getState()');
      verify(!lost.ok, 'missing saved workspace is refused');
      let recreated = false;
      try { await fs.stat(config.workspace); recreated = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      verify(!recreated, 'missing workspace is not silently recreated');
    } finally { await fs.rename(moved, config.workspace); }
    const restored = await js('window.fundsiftDesktop.getState()');
    verify(restored.ok && restored.data.cases.length === 2, 'restored workspace reopens after failure');
  }
  await fs.writeFile(config.result, JSON.stringify({ ok: true, phase: config.phase, packaged: app.isPackaged, versions: process.versions, checks }, null, 2));
}

module.exports = { run };
