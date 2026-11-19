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
  verify(await js('window.FUND_COPY.desktop === true && document.querySelector("#intro-screen").textContent.includes("本地桌面版") && document.querySelector("#intro-screen").textContent.includes("案件管理可用") && document.querySelector("#intro-screen").textContent.includes("三种具体格式导入技术预览")'), 'real preload selects desktop introduction copy');
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
      const targetVersion = folder === config.workspace ? 2 : 3;
      verify(manifest.result === 'upgraded' && manifest.targetVersion === targetVersion && /^[0-9a-f]{64}$/.test(manifest.sha256), 'verified backup manifest for ' + manifest.kind);
    }
    await getState();
    verify((await fs.readdir(path.join(config.workspace, 'backup'))).length === 1, 'current-version refresh does not repeat migration');
    await enterIntro();
  } else if (config.phase === 'create') {
    verify(initial.needsWorkspace && initial.cases.length === 0, 'first launch requires user folder selection');
    await enterIntro();
    await wait('document.querySelector(".desktop-setup [data-action=choose-workspace]") !== null');
    verify(await js('document.querySelector(".desktop-setup h2").textContent === "先选择数据存放位置" && document.querySelector(".desktop-setup [data-action=choose-workspace]").textContent.includes("选择存放文件夹")'), 'first entry shows storage setup before a workspace exists');
    verify(await js('document.querySelector(".setup-input-note").textContent.includes("不会导入文件夹里的流水") && document.querySelector(".setup-status").textContent.includes("具体格式导入")'), 'first-use guidance separates saving cases from importing flows');
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
  await wait('document.querySelector(".desktop-materials .feature-status") !== null && !document.querySelector(".desktop-materials button").disabled');
  verify(await js('document.querySelector(".desktop-materials").textContent.includes("微信 27 列 TXT") && document.querySelector(".preview-note").textContent.includes("完整 G0 尚未完成")'), 'materials names exact preview templates and G0 boundary');
  verify(await js('Boolean(document.querySelector("[data-action=desktop-import]")) && !document.querySelector("#application [data-action=pick-files],#application [data-action=do-export]")'), 'desktop material uses real native import only');
  if(config.phase==='create'){
    for(let index=0;index<3;index++){
      await js('document.querySelector("[data-action=desktop-import]").click()');
      await wait('document.querySelector(".import-receipt")?.textContent.includes("导入已发布") && !document.querySelector("[data-action=desktop-import]").disabled');
      verify(await js('document.querySelectorAll(".desktop-materials tbody tr").length === '+(index+1)), 'native import publishes material '+index);
      verify(await js('document.querySelector(".import-receipt").textContent.includes("写入 2 条") && document.querySelector(".import-receipt").textContent.includes("待核 1 条")'), 'published receipt exact counts '+index);
    }
    await js('document.querySelector("[data-action=desktop-import]").click()');
    await wait('document.querySelector(".desktop-data-error")?.textContent.includes("相同原件")');
    verify(await js('document.querySelectorAll(".desktop-materials tbody tr").length===3 && document.querySelector(".import-receipt").textContent.includes("导入未发布")'), 'duplicate refuses publication with visible receipt');
    await js('document.querySelector("[data-action=desktop-import]").click()');
    await wait('document.querySelector("[data-action=desktop-retry-import]:not(:disabled)") !== null');
    const caseId = (await getState()).currentCaseId;
    const beforeRetry = await worker.request('listMaterials', caseId);
    const failed = beforeRetry.materials.find(material => material.canRetry);
    verify(failed && failed.currentBatchId === null, 'failed material offers retry without a published batch');
    await js('document.querySelector("[data-action=desktop-retry-import]").click()');
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await js('document.querySelector("[data-action=desktop-retry-import]:not(:disabled)") !== null')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const afterRetry = await worker.request('listMaterials', caseId);
    const retried = afterRetry.materials.find(material => material.id === failed.id);
    verify(retried?.canRetry && retried.latestBatchId !== failed.latestBatchId && !retried.currentBatchId,
      'retry reuses the original material and records a new failure without publishing partial rows');
  }
  if(config.phase!=='upgrade'){
    verify(await js('document.querySelectorAll(".desktop-materials tbody tr").length===4'), 'three published materials and the failed material survive reopen');
    await js('document.querySelector("[data-action=nav][data-route=flows]").click()');
    await wait('document.querySelectorAll(".desktop-ledger tbody tr").length===6');
    verify(await js('document.querySelector(".desktop-ledger").textContent.includes("-1.01") && !document.querySelector("[data-action=confirm-amount]")'), 'real DB amount is precise and desktop review cannot edit');
    await js('document.querySelector("[data-action=desktop-source]").click()');
    await wait('document.querySelector(".raw-evidence tbody tr") !== null');
    verify(await js('document.querySelector(".modal").textContent.includes("归档原件已核验") && document.querySelector(".source-hash").textContent.includes("SHA256")'), 'real archive source is verified and viewable');
    await js('document.querySelector(".modal-head [data-action=close-modal]").click()');
    await js('document.querySelector("[data-action=desktop-relations]").click()');
    await wait('document.querySelector(".relation-candidate") !== null');
    verify(await js('document.querySelector(".modal").textContent.includes("同一付款记录候选") && document.querySelector(".modal").textContent.includes("不合并、不去重、不计算净额")'), 'cross-platform candidate evidence keeps source records');
    await js('document.querySelector(".modal-head [data-action=close-modal]").click()');
    await js('document.querySelector("[data-action=nav][data-route=review]").click()');
    await wait('document.querySelectorAll(".desktop-ledger tbody tr").length===3');
    verify(await js('document.querySelector(".desktop-flows").textContent.includes("待核只读清单") && !document.querySelector("[data-action=confirm-amount]")'), 'pending query isolates three real unresolved records');
    if(config.phase==='create'){
      await js('document.querySelector("#toast-root").replaceChildren()');
      window.setContentSize(1024,720);
      await js('document.querySelector("[data-action=nav][data-route=flows]").click()');
      await wait('document.querySelectorAll(".desktop-ledger tbody tr").length===6');
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      verify(await js('document.documentElement.scrollWidth<=innerWidth && document.querySelector(".desktop-ledger").closest(".table-scroll").clientWidth < document.querySelector(".desktop-ledger").scrollWidth'), '1024 layout confines wide ledger scrolling to table');
      verify(await js('(()=>{const button=document.querySelector("[data-action=desktop-source]");const clip=button.closest(".table-scroll").getBoundingClientRect();const rect=button.getBoundingClientRect();return rect.left>=clip.left && rect.right<=clip.right;})()'), '1024 layout keeps the first original-record action visible');
      await fs.writeFile(config.screenshot.replace('.png','-flows1024.png'),(await window.webContents.capturePage()).toPNG());
      await js('document.querySelector("[data-action=desktop-source]").click()');
      await wait('document.querySelector(".raw-evidence tbody tr") !== null');
      verify(await js('(()=>{const body=document.querySelector(".modal-body"),r=document.querySelector(".modal").getBoundingClientRect();body.scrollTop=body.scrollHeight;return body.scrollTop>0 && r.top>=0 && r.bottom<=innerHeight;})()'), '1024 raw evidence modal remains inside viewport and scrolls fully');
      await js('document.querySelector(".modal-body").scrollTop=0;new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await fs.writeFile(config.screenshot.replace('.png','-source1024.png'),(await window.webContents.capturePage()).toPNG());
      await js('document.querySelector(".modal-head [data-action=close-modal]").click()');
      await js('document.querySelector("[data-action=nav][data-route=exports]").click()');
      await wait('document.querySelector("[data-action=desktop-export-workpaper]:not(:disabled)") !== null');
      verify(await js('document.querySelector(".workpaper-panel").textContent.includes("本地 NTFS 文件夹")'), 'export panel explains compatible storage before choosing folder');
      await js('document.querySelector("[data-action=desktop-export-workpaper]").click()');
      await wait('document.querySelector(".workpaper-receipt") !== null');
      const exported = await fs.readdir(config.exportFolder);
      verify(exported.length === 1 && /^流水核对底稿-格式v2-数据v\d+-\d{8}T\d{9}Z\.xlsx$/.test(exported[0]), 'renderer exports one format-v2 XLSX and no temporary file');
      const workbook = new (require('exceljs').Workbook)();
      const workpaper = path.join(config.exportFolder, exported[0]);
      await workbook.xlsx.readFile(workpaper);
      verify(workbook.getWorksheet('流水明细')?.rowCount === 7 && workbook.getWorksheet('导出说明'), 'packaged export reopens with six effective records and the explanation sheet');
      const headers = workbook.getWorksheet('流水明细').getRow(1).values;
      verify(['原始金额单位', '原件收付记载', '原件记载说明', '摘要', '交易类型', '本方名称', '对方名称'].every(header => headers.includes(header)), 'reopened workbook includes the approved v2 evidence columns');
      await fs.copyFile(workpaper, config.screenshot.replace('.png', '-workpaper.xlsx'));
      await fs.writeFile(config.screenshot.replace('.png','-workpaper1024.png'),(await window.webContents.capturePage()).toPNG());
      window.setContentSize(1440,960);
    }
  }
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
