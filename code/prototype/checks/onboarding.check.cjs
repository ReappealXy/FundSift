/* New-user flow checks with synthetic bridge data. No originals, disk databases, or browser. */
'use strict';
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
let passed=0;
const verify=(condition,message)=>{assert.ok(condition,message);passed++;};
const tick=()=>new Promise(resolve=>setTimeout(resolve,25));
const success=data=>({ok:true,data});
const failure=(code,message)=>({ok:false,error:{code,message}});
const row=(id='case-a',name='合成核查案件',number='TEST-A')=>({id,name,number,createdAt:'2026-11-14T08:00:00Z',updatedAt:'2026-11-14T08:00:00Z',available:true,stats:{files:0,flows:0,pending:0}});
function fixture({location=null,cases=[]}={}){
  const state={location,cases,chooseCalls:0,createCalls:0};
  const bridge={
    getState:async()=>success({needsWorkspace:!state.location,workspacePath:state.location,cases:state.cases,currentCaseId:null}),
    chooseWorkspace:async()=>{state.chooseCalls++;state.location='D:\\SyntheticChosen';return bridge.getState();},
    createCase:async value=>{state.createCalls++;const valueRow=row('new-case',value.name,value.number);state.cases.push(valueRow);return success(valueRow);},
    openCase:async id=>success(state.cases.find(c=>c.id===id)),
    listCases:async()=>success(state.cases),
    listMaterials:async id=>success({caseId:id,dataVersion:'0',materials:[]}),
    queryFlows:async id=>success({caseId:id,dataVersion:'0',total:'0',rows:[],nextCursor:null})
  };
  return {state,bridge};
}
function setup(bridge,{blockedStorage=false}={}){
  const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{runScripts:'outside-only',pretendToBeVisual:true,url:'https://fundsift.example/'});
  const w=dom.window;w.TextEncoder=TextEncoder;w.Blob=Blob;
  if(bridge)w.fundsiftDesktop=bridge;
  if(blockedStorage)Object.defineProperty(w,'localStorage',{get(){throw new w.DOMException('Storage unavailable','SecurityError');}});
  const errors=[];w.addEventListener('error',event=>errors.push(event.error||event.message));
  for(const file of ['icons.js','data.js','exporter.js','copy.js','app.js','intro.js'])w.eval(fs.readFileSync(path.join(root,file),'utf8'));
  const $=selector=>w.document.querySelector(selector),$$=selector=>[...w.document.querySelectorAll(selector)];
  const click=selector=>{const el=$(selector);assert.ok(el,'Missing '+selector);el.click();};
  const action=(name,extra='')=>click(`[data-action="${name}"]${extra}`);
  const input=(selector,value)=>{const el=$(selector);assert.ok(el,selector);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));};
  const key=(keyValue,options={})=>{const event=new w.KeyboardEvent('keydown',{key:keyValue,bubbles:true,cancelable:true,...options});w.document.activeElement.dispatchEvent(event);return event;};
  return {w,dom,$,$$,click,action,input,key,close(){assert.deepEqual(errors,[],'No renderer errors');dom.window.close();}};
}
async function main(){
  const declaredPage=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'));
  const declaredScripts=[...declaredPage.window.document.scripts].map(script=>script.getAttribute('src'));declaredPage.window.close();
  verify(declaredScripts.includes('copy.js')&&declaredScripts.indexOf('copy.js')<declaredScripts.indexOf('app.js')&&declaredScripts.indexOf('copy.js')<declaredScripts.indexOf('intro.js'),'Shipped page loads shared copy before both consumers');
  // The same introductory page and help choose facts for the active environment.
  for(const mode of ['desktop','demo']){
    const f=fixture(),t=setup(mode==='desktop'?f.bridge:undefined);await tick();
    const intro=t.$('#intro-screen');
    verify(t.$('.intro-edition').textContent.includes(mode==='desktop'?'本地桌面版':'网页交互演示'),mode+' introduction names actual mode');
    verify(intro.textContent.includes(mode==='desktop'?'案件管理可用':'合成数据'),mode+' introduction identifies usable capability');
    verify(!intro.textContent.includes('HTML 交互原型'),mode+' removes stale prototype label');
    verify(intro.textContent.includes('概念示意'),mode+' retains honest illustration label');
    const help=t.$('#intro-screen [data-action="help"]');assert.ok(help,'Introduction has help');help.focus();help.click();await tick();
    verify(!!t.$('.modal')&&!t.$('#modal-root').hidden&&!t.$('#modal-root').inert,mode+' introduction help is interactive');
    verify(t.$('#intro-screen').inert&&t.$('#application').inert,mode+' help protects background');
    verify(t.$('.modal').contains(t.w.document.activeElement),mode+' help receives focus');
    const body=t.$('.modal-body').textContent;
    verify(body.includes(mode==='desktop'?'创建、打开和切换案件':'刷新后恢复初始状态'),mode+' help describes actual persistence');
    verify(mode==='desktop'?body.includes('复制整个数据存放文件夹'):!t.$('.desktop-workspace-info'),mode+' does not promise other mode storage');
    t.key('Escape');
    verify(!t.$('.modal')&&t.$('#modal-root').hidden&&t.$('#modal-root').inert,mode+' Esc closes intro help and restores hidden layer');
    verify(!t.$('#intro-screen').inert&&t.$('#application').inert,mode+' closing keeps workspace inactive');
    verify(t.w.document.activeElement===help,mode+' help closes back to its opener');
    t.close();
    const blocked=setup(mode==='desktop'?f.bridge:undefined,{blockedStorage:true});await tick();
    const blockedHelp=blocked.$('#intro-screen [data-action="help"]');blockedHelp.focus();blockedHelp.click();await tick();
    verify(blocked.$('.modal').contains(blocked.w.document.activeElement)&&!blocked.w.document.activeElement.disabled,mode+' unavailable startup storage does not strand dialog focus on disabled preference');blocked.close();
  }
  let f=fixture(),t=setup(f.bridge);await tick();t.w.FUND_INTRO.enter();
  verify(t.$('#main').textContent.includes('不会导入文件夹里的流水'),'Setup distinguishes save folder from source files');
  verify(!t.$('.setup-details').open,'Rare upgrade guidance starts collapsed');
  const summary=t.$('.setup-details > summary');verify(!!summary,'Upgrade guidance uses keyboard-operable native summary');
  f.bridge.chooseWorkspace=async()=>{f.state.chooseCalls++;return success({cancelled:true});};
  t.action('choose-workspace');await tick();
  verify(t.$('#main').textContent.includes('已取消选择')&&!!t.$('[data-action="choose-workspace"]'),'Cancel offers a real retry');
  f.bridge.chooseWorkspace=async()=>{f.state.chooseCalls++;return failure('FS_WORKSPACE_NESTED_CASE','这是某个案件自己的文件夹，请选择保存全部案件的位置。');};
  t.action('choose-workspace');await tick();
  verify(t.$('#main').textContent.includes('某个案件自己的文件夹')&&!t.$('.case-table'),'Wrong case folder remains an error, not empty workspace');
  verify(!!t.$('[data-action="choose-workspace"]'),'Known unconfigured state permits choosing a different folder');
  f.bridge.chooseWorkspace=async()=>{f.state.chooseCalls++;f.state.location='D:\\NewLocation';return f.bridge.getState();};
  t.action('choose-workspace');await tick();
  verify(f.state.chooseCalls===3&&t.$('.desktop-path').textContent==='D:\\NewLocation','After cancel and bad choice a successful new selection is used');
  verify(!t.$('[data-action="choose-workspace"]'),'Configured location does not promise unsupported relocation');
  t.close();

  // Native details must remain in the modal focus loop; collapsed descendants stay out.
  f=fixture({location:'D:\\KeyboardChecks'});t=setup(f.bridge);await tick();t.w.FUND_INTRO.enter();t.action('help');await tick();
  const dialog=t.$('.modal'),first=t.$('.modal-head button');
  const details=t.w.document.createElement('details');details.innerHTML='<summary>键盘检查说明</summary><input aria-label="仅展开可用"><button disabled>不可用</button>';
  const hidden=t.w.document.createElement('div');hidden.hidden=true;hidden.innerHTML='<button>隐藏按钮</button>';
  dialog.append(details,hidden);
  first.focus();t.key('Tab',{shiftKey:true});
  verify(t.w.document.activeElement===details.querySelector('summary'),'Reverse tab reaches native summary and skips collapsed/hidden controls');
  t.key('Tab');verify(t.w.document.activeElement===first,'Tab from final summary wraps to first control');
  // Expanded-details ordering is checked in standalone Electron. jsdom 27's
  // compound selector result groups inputs before summaries rather than DOM order.
  t.key('Escape');verify(!t.$('.modal')&&!t.$('#application').inert,'Workspace help closes and restores background');t.close();

  // Source format guidance is visible without revealing preparation notes or creating an import path.
  f=fixture({location:'D:\\SyntheticMaterials',cases:[row()]});t=setup(f.bridge);await tick();t.w.FUND_INTRO.enter();t.action('open-case');await tick();
  verify(t.$('#main h1').textContent==='材料管理'&&t.$('.feature-status').textContent.includes('技术预览'),'Material heading and capability state are separate');
  verify(t.$('.preview-note').textContent.includes('完整 G0 尚未完成'),'Preview clearly discloses unfinished G0');
  verify(t.$('.desktop-materials').textContent.includes('微信 27 列 TXT')&&t.$('.desktop-materials').textContent.includes('建行 32 列 XLSX'),'Supported templates are precise');
  verify(!!t.$('[data-action="desktop-import"]')&&!t.$('[data-action="pick-files"]'),'Desktop import uses native selection only');
  verify(t.$('.desktop-materials').textContent.includes('不删行或改表头'),'Material preparation preserves originals');
  verify(t.$('.desktop-materials').textContent.includes('重复导入会被拒绝'),'Duplicate guard is explained');
  verify(!t.$('[data-action="confirm-amount"]'),'Preview exposes no manual amount save');
  let fileReads=0;const file={get name(){fileReads++;return 'test.csv';}};
  const drop=new t.w.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'dataTransfer',{value:{files:[file]}});t.$('.desktop-materials').dispatchEvent(drop);
  verify(drop.defaultPrevented&&fileReads===0&&!t.$('.modal'),'Disabled desktop drop does not even read file metadata');
  verify(t.$('#toast-root').textContent.includes('未读取或登记文件'),'Drop explains actual non-import result');t.close();

  // Untrusted dynamic names/paths stay text, including the save destination in the form.
  const longPath='D:\\'+('较长文件夹\\'.repeat(18))+'<img src=x onerror=alert(1)>';
  f=fixture({location:longPath,cases:[row('escaped','<img src=x onerror=alert(1)>','A-01')]});t=setup(f.bridge);await tick();t.w.FUND_INTRO.enter();
  verify(t.$('.desktop-path').textContent===longPath&&!t.$('#application img'),'Long and HTML-like saved location remains plain text');
  verify(t.$('.case-table tbody').textContent.includes('<img src=x')&&!t.$('.case-table img'),'Case names cannot inject markup');
  t.action('new-case');verify(t.$('.case-save-location').textContent.includes(longPath)&&!t.$('.modal img'),'Create form shows full escaped destination');
  verify(t.$('.modal-body').textContent.includes('A–Z')&&t.$('.modal-body').textContent.includes('相同名称'),'Creation rules clarify case-insensitive numbers and reusable names');
  t.input('#new-name','合成保存不确定');t.input('#new-number','UNCERTAIN-01');
  f.bridge.createCase=async()=>failure('SETTINGS_WRITE','无法保存数据存放位置设置。本次案件如已创建仍保留在所选文件夹，请重试读取，勿重复建案。');
  t.action('save-case');await tick();
  verify(t.$('#form-error').textContent.includes('勿重复建案')&&!t.$('#toast-root').textContent.includes('案件已保存'),'Uncertain save keeps warning and never reports success');
  verify(t.$('#new-name').value==='合成保存不确定','Uncertain save retains user input');t.close();

  for(const [code,message] of [
    ['SQLITE_FULL','磁盘空间不足，操作未完成，请释放空间后重试。'],
    ['SQLITE_READONLY','数据存放位置不可写或无法访问，请检查文件夹权限。']
  ]){
    f=fixture({location:'D:\\SyntheticWriteError'});t=setup(f.bridge);await tick();t.w.FUND_INTRO.enter();t.action('new-case');
    t.input('#new-name','合成写入失败');t.input('#new-number','WRITE-01');f.bridge.createCase=async()=>failure(code,message);
    t.action('save-case');await tick();
    verify(t.$('#form-error').textContent.includes(message),code+' keeps the specific recoverable backend error');
    verify(t.$('#new-name').value==='合成写入失败'&&!t.$('[data-action="save-case"]').disabled,code+' preserves input and permits retry after remedy');
    verify(!t.$('#toast-root').textContent.includes('案件已保存'),code+' never shows false save success');t.close();
  }

  // A failed initial load does not establish that no prior save location exists.
  f=fixture({location:'D:\\MissingOldLocation'});f.bridge.getState=async()=>failure('FS_WORKSPACE_MISSING','原数据存放位置已失联，请恢复原位置后重试。');
  t=setup(f.bridge);await tick();t.w.FUND_INTRO.enter();
  verify(t.$('#main').textContent.includes('原数据存放位置已失联')&&!t.$('.case-table'),'Initial missing location remains explicit error');
  verify(!t.$('[data-action="choose-workspace"]')&&!!t.$('[data-action="retry-workspace"]'),'Initial load failure offers retry, never a fake relocate action');
  t.action('help');verify(!t.$('[data-action="choose-workspace"]'),'Help also avoids offering relocation after unknown initial state');t.close();
  console.log(`PASS: ${passed} new-user flow and accessibility assertions (mock bridge)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
