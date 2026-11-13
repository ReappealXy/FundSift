'use strict';
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

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
  verify(await js('typeof require === "undefined" && typeof process === "undefined"'), 'renderer has no Node access');
  verify(await js('Boolean(window.fundsiftDesktop)'), 'isolated preload bridge exists');
  const initial = await getState();
  if (config.phase === 'create') {
    verify(initial.needsWorkspace && initial.cases.length === 0, 'first launch requires user folder selection');
    await worker.request('openWorkspace', config.workspace);
    await saveSettings(config.workspace, null);
    setWorkspace(config.workspace);
    await window.webContents.reload();
    await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    await wait('document.querySelector("[data-action=new-case]") !== null');
    await js('document.querySelector("#enter-workspace").click()');
    await js('document.querySelector("[data-action=new-case]").click()');
    const fields = await js('Array.from(document.querySelectorAll("#modal-root input")).map(e=>({id:e.id,type:e.type}))');
    verify(fields.some(field => field.id === 'new-name') && fields.some(field => field.id === 'new-number'), 'case form shows required fields');
    verify(!await js('Boolean(document.querySelector("#new-type"))'), 'case type is absent');
    await js('document.querySelector("#new-name").value="M0 合成验收案";document.querySelector("#new-number").value="M0-SMOKE-001";document.querySelector("[data-action=save-case]").click()');
    await wait('!document.querySelector("#modal-root .modal") && document.querySelector("#sidebar").textContent.includes("M0-SMOKE-001")');
    const state = await getState();
    verify(state.cases.length === 1 && state.cases[0].name === 'M0 合成验收案', 'renderer create writes real database');
    verify(state.cases[0].stats.flows === 0, 'production starts without synthetic flows');
    const duplicate = await js('window.fundsiftDesktop.createCase({name:"重复合成案",number:"M0-SMOKE-001"})');
    verify(!duplicate.ok, 'duplicate case number is refused');
  } else {
    verify(!initial.needsWorkspace && initial.cases.length === 1, 'workspace selection and case persist on restart');
    verify(initial.cases[0].number === 'M0-SMOKE-001', 'restarted case identity matches');
    const response = await js('window.fundsiftDesktop.openCase(' + JSON.stringify(initial.cases[0].id) + ')');
    verify(response.ok && response.data.id === initial.cases[0].id, 'packaged worker reopens existing SQLite');
    const invalid = await js('window.fundsiftDesktop.openCase("../outside")');
    verify(!invalid.ok, 'path traversal case ID is rejected');
    await js('document.querySelector("#enter-workspace").click()');
  }
  // Navigate back to the real workbench before capturing the shipped interface.
  await js('document.querySelector("[data-action=nav][data-route=home]")?.click()');
  await wait('document.querySelector("#main").textContent.includes("M0 合成验收案")');
  verify(!await js('document.querySelector("#main").textContent.includes("远川商贸")'), 'demo cases are isolated from desktop data');
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
    verify(restored.ok && restored.data.cases.length === 1, 'restored workspace reopens after failure');
  }
  await fs.writeFile(config.result, JSON.stringify({ ok: true, phase: config.phase, packaged: app.isPackaged, versions: process.versions, checks }, null, 2));
}

module.exports = { run };
