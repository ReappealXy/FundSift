'use strict';
// Standalone Electron rendering. The desktop bridge below uses synthetic data;
// the packaged smoke separately validates the actual preload and storage worker.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const out = path.join(root, 'artifacts', `ui-02-${version}-render`, `run-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
// Fix the test scale so Windows fractional DPI does not round the requested
// CSS viewport by a pixel. Packaged smoke retains the machine's native scale.
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.on('window-all-closed', () => {});
const preload = path.join(out, 'synthetic-preload.cjs');
fs.writeFileSync(preload, `const {contextBridge}=require('electron');
let location=null,cases=[];
const ok=data=>({ok:true,data});
const state=()=>ok({needsWorkspace:!location,workspacePath:location,cases,currentCaseId:cases[0]?.id||null});
contextBridge.exposeInMainWorld('fundsiftDesktop',{
getState:async()=>state(),chooseWorkspace:async()=>{location='D:\\\\SyntheticOnboarding';return state();},
createCase:async input=>{const c={id:'render-case',name:input.name,number:input.number,available:true,createdAt:'2026-11-14',updatedAt:'2026-11-14',stats:{files:0,flows:0,pending:0}};cases.push(c);return ok(c);},
openCase:async id=>ok(cases.find(c=>c.id===id)),listCases:async()=>ok(cases)
});`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let checks = 0;
function verify(value, message) { assert.ok(value, message); checks++; }
async function js(win, source) { return win.webContents.executeJavaScript(source, true); }
async function until(win, source) {
  for (let i = 0; i < 100; i++) { if (await js(win, source)) return; await pause(30); }
  throw new Error('Timed out: ' + source);
}
async function screenshot(win, name) { await pause(100); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
function createWindow(mode, width, height) {
  const win = new BrowserWindow({ width, height, frame:false, useContentSize:true, show: false, autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false,
      ...(mode === 'desktop' ? { preload } : {}) } });
  win.removeMenu();
  return win;
}
async function press(win, keyCode, modifiers = []) {
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (keyCode === 'Enter') win.webContents.sendInputEvent({ type:'char', keyCode:'\r', modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await pause(45);
}
async function checkHelp(win, name) {
  // Native keyboard defaults require a focused top-level Electron window.
  // This is a standalone process, never the Codex in-app browser.
  win.show(); win.focus(); await pause(100);
  await js(win, 'document.querySelector("#intro-help").focus()');
  await press(win, 'Enter');
  await until(win, 'document.querySelector(".modal") && document.querySelector(".modal").contains(document.activeElement)');
  verify(await js(win, `(()=>{const el=document.querySelector('.modal'),r=el.getBoundingClientRect();return !el.closest('[hidden],[inert]')&&r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;})()`), name + ' help visible inside viewport');
  verify(await js(win, `(()=>{const el=document.querySelector('.modal-head button'),r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===el;})()`), name + ' help is above introduction');
  await js(win, 'document.querySelector(".modal-body").scrollTop=100000');
  verify(await js(win, `(()=>{const r=document.querySelector('.modal-foot').getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0;})()`), name + ' help footer stays visible while body scrolls');
  // Native Chromium order, including details/summary. jsdom does not reliably
  // preserve order for every compound selector, so exercise actual Tab events.
  await js(win, `(()=>{const details=document.createElement('details');details.id='keyboard-check';details.innerHTML='<summary>键盘检查</summary><input aria-label="展开后的输入">';document.querySelector('.modal-foot').append(details);document.querySelector('.modal-head button').focus();})()`);
  await press(win, 'Tab', ['shift']);
  verify(await js(win, 'document.activeElement.tagName==="SUMMARY"'), name + ' closed details includes summary as last focus target');
  await press(win, 'Enter');
  verify(await js(win, 'document.querySelector("#keyboard-check").open'), name + ' Enter expands native details');
  await js(win, 'document.querySelector(".modal-head button").focus()');
  await press(win, 'Tab', ['shift']);
  verify(await js(win, 'document.activeElement===document.querySelector("#keyboard-check input")'), name + ' expanded details includes input in native focus order');
  await js(win, 'document.querySelector("#keyboard-check").remove();document.querySelector(".modal-body").scrollTop=0');
  await screenshot(win, name + '-help');
  await press(win, 'Escape');
  verify(await js(win, '!document.querySelector(".modal") && document.activeElement.id==="intro-help" && !document.querySelector("#intro-screen").inert && document.querySelector("#application").inert'), name + ' Esc closes help and restores introduction focus');
}
app.whenReady().then(async () => {
  const results = []; let win;
  try {
    for (const mode of ['desktop', 'demo']) {
      for (const [width, height] of [[1024,720],[1440,960],[1920,1080],[390,844],[1024,560],[1280,600]]) {
        win = createWindow(mode, width, height);
        await win.loadFile(path.join(root, 'code/prototype/index.html'));
        await until(win, 'window.FUND_INTRO && window.FUND_COPY && document.querySelector("#intro-help")');
        await pause(100);
        const metrics = await js(win, `(()=>{
          const screen=document.querySelector('#intro-screen'),rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
          const elements=[...document.querySelectorAll('.intro-header,.intro-copy,.intro-capabilities,.intro-workflow,.intro-footer,#enter-workspace,#intro-help,.intro-status')].map(e=>({name:e.id||e.className,...rect(e)}));
          const textElements=[...document.querySelectorAll('.intro-description,.intro-status,.intro-capability-list p,.intro-workflow p,.intro-footer p')].map(e=>({name:e.className,text:e.textContent,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,...rect(e)}));
          screen.scrollTop=100;window.scrollTo(0,100);
          return {mode:window.FUND_COPY.desktop?'desktop':'demo',viewport:{width:innerWidth,height:innerHeight},scrollHeight:screen.scrollHeight,clientHeight:screen.clientHeight,scrollTop:screen.scrollTop,pageScroll:scrollY,visibility:getComputedStyle(screen).visibility,elements,textElements};
        })()`);
        verify(metrics.mode === mode, mode + ' mode selected by actual bridge presence');
        verify(metrics.viewport.width === width && metrics.viewport.height === height, JSON.stringify({mode,expected:{width,height},actual:metrics.viewport}));
        verify(metrics.scrollHeight === metrics.clientHeight && !metrics.scrollTop && !metrics.pageScroll, mode + ' introduction fits without scroll');
        verify(metrics.visibility === 'visible', mode + ' copy is initialized before showing intro');
        for (const r of [...metrics.elements, ...metrics.textElements]) {
          verify(r.y >= -1 && r.bottom <= metrics.viewport.height + 1 && r.x >= -1 && r.right <= metrics.viewport.width + 1, JSON.stringify({ mode, width, height, clipped:r }));
        }
        for (const r of metrics.textElements) verify(r.scrollHeight <= r.clientHeight + 1, 'text is not internally clipped: ' + r.text);
        await screenshot(win, `${mode}-${width}x${height}`);
        results.push({ mode, width, height, metrics });
        if (width === 1024 && height === 720) await checkHelp(win, mode + '-1024x720');
        if (mode === 'desktop' && width === 1024 && height === 720) {
          await js(win, 'document.querySelector("#enter-workspace").click()');
          await until(win, 'document.querySelector("#intro-screen").hidden && !document.querySelector("#application").inert');
          await pause(150);
          verify(await js(win, 'Boolean(document.querySelector(".desktop-setup"))'), 'desktop first-use setup shown');
          await screenshot(win, 'desktop-setup');
          await js(win, 'document.querySelector(".setup-details summary").focus()'); await press(win, 'Enter');
          verify(await js(win, 'document.querySelector(".setup-details").open'), 'setup upgrade details expands with keyboard');
          await screenshot(win, 'desktop-setup-expanded');
          await js(win, 'document.querySelector("[data-action=choose-workspace]").click()');
          await until(win, 'document.querySelector("[data-action=new-case]")');
          await js(win, 'document.querySelector("[data-action=new-case]").click()');
          await pause(50); await screenshot(win, 'desktop-new-case');
          verify(await js(win, 'document.querySelector(".case-save-location").textContent.includes("SyntheticOnboarding")'), 'form shows actual save location');
          await js(win, 'document.querySelector("#new-name").value="界面检查合成案件";document.querySelector("#new-number").value="LAYOUT-01";document.querySelector("[data-action=save-case]").click()');
          await until(win, 'document.querySelector(".format-table")');
          await screenshot(win, 'desktop-materials');
          await js(win, 'document.querySelector(".prepare-guide summary").focus()'); await press(win, 'Enter');
          verify(await js(win, 'document.querySelector(".prepare-guide").open'), 'material preparation uses keyboard-operable details');
          await screenshot(win, 'desktop-materials-expanded');
        }
        win.destroy(); win = null;
      }
    }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ ok:true, checks, bridge:'synthetic; actual packaged preload covered by smoke', results }, null, 2));
    console.log(`PASS: ${checks} rendering assertions; screenshots and measurements: ${out}`);
  } catch (error) {
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ ok:false, checks, error:error.stack, results }, null, 2));
    console.error(error); console.error('Evidence:', out); process.exitCode=1;
  } finally { if (win) win.destroy(); app.exit(process.exitCode || 0); }
});
