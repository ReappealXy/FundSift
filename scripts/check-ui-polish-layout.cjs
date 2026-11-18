'use strict';
// Standalone Electron layout evidence with a synthetic, memory-only bridge.
// This does not verify storage, the packaged preload, or real business data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const out = path.join(root, 'artifacts', `ui-polish-${version}-render`, `run-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('window-all-closed', () => {});

const preload = path.join(out, 'synthetic-preload.cjs');
fs.writeFileSync(preload, `const {contextBridge}=require('electron');
const listeners=new Set();
const state=()=>({ok:true,data:{needsWorkspace:true,workspacePath:null,cases:[],currentCaseId:null}});
contextBridge.exposeInMainWorld('fundsiftDesktop',{
getState:async()=>state(),listCases:async()=>({ok:true,data:[]}),
onOperationStatus:callback=>{listeners.add(callback);return()=>listeners.delete(callback);}
});
contextBridge.exposeInMainWorld('fundsiftUiTest',{
emitOperationStatus:event=>{for(const callback of listeners)callback(event);}
});`);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = {};
let checks = 0;
let shownForKeyboard = false;
function verify(value, message) { assert.ok(value, message); checks++; }
async function js(win, source) { return win.webContents.executeJavaScript(source, true); }
async function until(win, source) {
  for (let i = 0; i < 100; i++) {
    if (await js(win, source)) return;
    await pause(30);
  }
  throw new Error('Timed out: ' + source);
}
async function press(win, keyCode) {
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  await pause(60);
}
async function focusMetrics(win, selector) {
  return js(win, `(()=>{
    const e=document.querySelector(${JSON.stringify(selector)}),s=getComputedStyle(e);
    return {selector:${JSON.stringify(selector)},active:document.activeElement===e,
      focusVisible:e.matches(':focus-visible'),outlineStyle:s.outlineStyle,
      outlineWidth:s.outlineWidth,outlineColor:s.outlineColor};
  })()`);
}
async function keyboardEntryFocus(win) {
  await js(win, 'document.querySelector("#intro-title").focus({preventScroll:true})');
  await press(win, 'Tab');
  if (await js(win, 'document.activeElement.id==="enter-workspace" && document.activeElement.matches(":focus-visible")')) return;
  // Some Windows/Electron combinations require a focused native window for Tab.
  // This is a standalone renderer, never the Codex in-app browser.
  win.show(); win.focus(); shownForKeyboard = true;
  await pause(100);
  await js(win, 'document.querySelector("#intro-title").focus({preventScroll:true})');
  await press(win, 'Tab');
}
async function feedbackMetrics(win) {
  return js(win, `(()=>{
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const panel=document.querySelector('#desktop-operation-status'),stack=document.querySelector('#feedback-root');
    return {viewport:{width:innerWidth,height:innerHeight},feedback:rect(stack),
      panel:{hidden:panel.hidden,text:panel.textContent,...rect(panel)},
      toasts:[...document.querySelectorAll('#toast-root .toast')].map(e=>{
        const range=document.createRange();range.selectNodeContents(e.lastElementChild);
        return {text:e.textContent,textLines:range.getClientRects().length,...rect(e)};
      })};
  })()`);
}
function inside(r, viewport) {
  return r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && r.right <= viewport.width && r.bottom <= viewport.height;
}
function separate(a, b) {
  return a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y;
}
async function screenshot(win, name) {
  // A hidden native window may capture its previous compositor frame even when
  // DOM measurements already describe the workspace. Present the standalone
  // Electron window without activating it, then wait for two painted frames.
  win.showInactive();
  await js(win, 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await pause(150);
  const file = path.join(out, name + '.png');
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  return file;
}

app.whenReady().then(async () => {
  let win;
  try {
    win = new BrowserWindow({ width:1024,height:720,frame:false,useContentSize:true,show:false,autoHideMenuBar:true,
      webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,preload} });
    win.removeMenu();
    await win.loadFile(path.join(root, 'code/prototype/index.html'));
    await until(win, 'window.FUND_INTRO && window.fundsiftUiTest && document.querySelector("#desktop-operation-status")');
    verify(await js(win, 'innerWidth===1024 && innerHeight===720 && window.FUND_COPY.desktop'), 'Actual desktop viewport is 1024 by 720');

    await keyboardEntryFocus(win);
    results.buttonFocus = await focusMetrics(win, '#enter-workspace');
    verify(results.buttonFocus.active && results.buttonFocus.focusVisible, 'Native Tab focuses the real entry button visibly');
    verify(results.buttonFocus.outlineStyle !== 'none' && parseFloat(results.buttonFocus.outlineWidth) >= 2, 'Real button retains its keyboard outline');

    await js(win, 'document.querySelector("#intro-title").focus({preventScroll:true})');
    results.introFocus = await focusMetrics(win, '#intro-title');
    verify(results.introFocus.active && results.introFocus.focusVisible, 'Introduction title is tested under actual focus-visible state');
    verify(results.introFocus.outlineStyle === 'none' || parseFloat(results.introFocus.outlineWidth) === 0, 'Introduction title has no outline');

    await js(win, 'document.querySelector("#enter-workspace").click()');
    await until(win, 'document.querySelector("#intro-screen").hidden && !document.querySelector("#application").inert && document.querySelector(".desktop-setup")');
    results.mainFocus = await focusMetrics(win, '#main');
    verify(results.mainFocus.active && results.mainFocus.focusVisible, 'Workspace arrival retains focus-visible programmatic focus');
    verify(results.mainFocus.outlineStyle === 'none' || parseFloat(results.mainFocus.outlineWidth) === 0, 'Workspace has no outer blue outline');
    results.footer = await js(win, '({text:document.querySelector("#statusbar").textContent,right:document.querySelector("#statusbar .last").textContent})');
    verify(results.footer.right.trim() === '', 'Unset-location footer has no repeated right-hand message');

    await js(win, `window.fundsiftUiTest.emitOperationStatus({operationId:1,operation:'create-case',phase:'running',active:true,elapsedMs:18000,waitingLong:true});
      for(let i=1;i<=3;i++){
        const e=document.createElement('div');e.className='toast';
        const icon=document.createElement('span');icon.setAttribute('aria-hidden','true');icon.innerHTML=window.icon('checkCircle',17);
        const text=document.createElement('span');text.textContent='合成布局检查 '+i+'：这是一条用于验证多行通知布局的合成消息。材料与案件均未读取，不代表真实操作成功。请同时核对状态提示与三条通知的间距及完整显示。';
        e.append(icon,text);document.querySelector('#toast-root').append(e);
      }`);
    await pause(220);
    results.withFeedback = await feedbackMetrics(win);
    verify(!results.withFeedback.panel.hidden && results.withFeedback.panel.text.includes('正在处理'), 'Actual status subscriber renders an active operation');
    verify(results.withFeedback.toasts.length === 3, 'Three simultaneous toasts are rendered');
    const boxes = [results.withFeedback.panel, ...results.withFeedback.toasts];
    for (const [index, box] of boxes.entries()) verify(inside(box, results.withFeedback.viewport), 'Feedback box ' + index + ' fits the viewport');
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) verify(separate(boxes[i], boxes[j]), 'Feedback boxes ' + i + ' and ' + j + ' do not overlap');
    }
    for (const [index, toast] of results.withFeedback.toasts.entries()) verify(toast.textLines >= 2, 'Toast ' + index + ' exercises wrapped text');
    results.screenshot = await screenshot(win, 'desktop-1024x720-focus-and-feedback');

    await js(win, `window.fundsiftUiTest.emitOperationStatus({operationId:1,operation:'create-case',phase:'completed',active:false,elapsedMs:18000,waitingLong:false});`);
    results.afterTerminal = await feedbackMetrics(win);
    verify(results.afterTerminal.panel.hidden && results.afterTerminal.panel.height === 0, 'Terminal operation leaves no status box');
    for (const toast of results.afterTerminal.toasts) verify(inside(toast, results.afterTerminal.viewport), 'Remaining toast fits after status clears');
    await js(win, 'document.querySelector("#toast-root").replaceChildren()');
    results.afterClear = await feedbackMetrics(win);
    verify(results.afterClear.toasts.length === 0 && results.afterClear.feedback.height === 0, 'Cleared feedback leaves no empty floating container');
    verify(await js(win, 'document.activeElement.id==="main" && !document.querySelector("#application").inert'), 'Feedback updates preserve workspace focus and availability');

    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ok:true,checks,version,shownForKeyboard,
      bridge:'Synthetic memory-only desktop bridge; real packaged preload and storage are covered separately by smoke.',
      notifications:'Three synthetic multiline messages generated only for layout evidence; no real case data or successful operations are claimed.',results}, null, 2));
    console.log(`PASS: ${checks} focused rendering assertions; screenshot and measurements: ${out}`);
  } catch (error) {
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ok:false,checks,version,shownForKeyboard,
      bridge:'Synthetic memory-only bridge and synthetic notifications; no real case data.',error:error.stack,results}, null, 2));
    console.error(error);console.error('Evidence:', out);process.exitCode=1;
  } finally { if (win) win.destroy();app.exit(process.exitCode || 0); }
});
