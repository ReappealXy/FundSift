/* Renderer contract checks with a mock preload bridge. No disk database or browser. */
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
let passed=0;
const verify=(condition,message)=>{assert.ok(condition,message);passed++;};
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
const success=data=>({ok:true,data});
const failure=message=>({ok:false,error:{code:'MOCK_ERROR',message}});
const caseRow=(id,name,number)=>({id,name,number,createdAt:'2026-11-13T08:00:00Z',updatedAt:'2026-11-13T08:00:00Z',available:true,error:null,stats:{files:0,flows:0,pending:0}});
function bridgeState(cases=[],pathValue='D:\\SyntheticWorkspace'){
  const state={cases,workspacePath:pathValue,currentCaseId:null,createCalls:0,openCalls:[],chooseCalls:0};
  const bridge={
    async getState(){return success({needsWorkspace:!state.workspacePath,workspacePath:state.workspacePath,cases:state.cases,currentCaseId:state.currentCaseId});},
    async chooseWorkspace(){state.chooseCalls++;state.workspacePath='D:\\ChosenWorkspace';return bridge.getState();},
    async createCase(value){state.createCalls++;const c=caseRow('new-case-id',value.name,value.number);state.cases.push(c);state.currentCaseId=c.id;return success(c);},
    async openCase(id){state.openCalls.push(id);const c=state.cases.find(c=>c.id===id);if(!c||c.available===false)return failure(c?.error||'案件不存在');state.currentCaseId=id;return success(c);},
    async listCases(){return success(state.cases);}
  };
  return {bridge,state};
}
function setup(bridge){
  const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{runScripts:'outside-only',pretendToBeVisual:true,url:'https://fundsift.example/'});
  const w=dom.window;w.TextEncoder=TextEncoder;w.Blob=Blob;w.fundsiftDesktop=bridge;
  const runtimeErrors=[];w.addEventListener('error',event=>runtimeErrors.push(event.error||event.message));
  for(const f of ['icons.js','data.js','exporter.js','app.js','intro.js'])w.eval(fs.readFileSync(path.join(root,f),'utf8'));
  w.FUND_INTRO.enter();
  const $=s=>w.document.querySelector(s),$$=s=>[...w.document.querySelectorAll(s)];
  const action=(name,extra='')=>{const el=$(`[data-action="${name}"]${extra}`);assert.ok(el,`Missing action ${name}${extra}`);el.click();};
  const input=(s,v)=>{const el=$(s);assert.ok(el,`Missing input ${s}`);el.value=v;el.dispatchEvent(new w.Event('input',{bubbles:true}));};
  const nav=route=>action('nav',`[data-route="${route}"]`);
  return {dom,w,$,$$,action,input,nav,close:()=>{assert.deepEqual(runtimeErrors,[],'Renderer must not raise window errors');dom.window.close();}};
}
async function main(){
  let fixture=bridgeState([],null),t=setup(fixture.bridge);await settle();
  verify(t.$('#main').textContent.includes('先选择案件数据保存目录'),'First use asks for data directory');
  verify(t.$$('.case-table tbody tr').length===0&&!t.$('#main').textContent.includes('远川'),'Seed cases never enter desktop workspace');
  verify(t.$('#sidebar [data-route="materials"]').disabled,'Case pages disabled before workspace');
  fixture.bridge.chooseWorkspace=async()=>{fixture.state.chooseCalls++;return success({cancelled:true});};
  t.action('choose-workspace');await settle();
  verify(t.$('#main').textContent.includes('尚未选择数据目录')&&!t.$('[data-action="new-case"]'),'Cancelled folder dialog leaves setup usable');
  fixture.bridge.chooseWorkspace=async()=>{fixture.state.chooseCalls++;fixture.state.workspacePath='D:\\ChosenWorkspace';return fixture.bridge.getState();};
  t.action('choose-workspace');await settle();
  verify(t.$('#main').textContent.includes('还没有案件'),'Chosen empty workspace has real empty state');
  verify(t.$('.desktop-path').textContent==='D:\\ChosenWorkspace','Chosen data path displayed');
  verify(!t.$('[data-action="choose-workspace"]'),'No implicit workspace switching after initial setup');
  verify(t.$('#main').textContent.includes('重启后可继续打开'),'Desktop status describes local persistence');
  t.action('new-case');verify(!t.$('#new-type')&&t.$$('input.text-input').length===2,'Desktop case form only name and number');
  t.action('save-case');verify(t.$('#form-error').textContent.includes('请填写')&&fixture.state.createCalls===0,'Empty form does not invoke create');
  t.input('#new-name','  合成案件  ');t.input('#new-number','  TEST-01  ');
  let resolveCreate;
  fixture.bridge.createCase=value=>{fixture.state.createCalls++;verify(value.name==='合成案件'&&value.number==='TEST-01','Create payload trims both inputs');return new Promise(resolve=>{resolveCreate=()=>{const c=caseRow('new-case-id',value.name,value.number);fixture.state.cases.push(c);fixture.state.currentCaseId=c.id;resolve(success(c));};});};
  t.action('save-case');t.action('save-case');
  verify(fixture.state.createCalls===1&&t.$('[data-action="save-case"]').disabled,'Create request prevents duplicate submission');
  verify(!t.$('#toast-root').textContent.includes('已保存')&&!!t.$('.modal'),'No success shown before backend commit reply');
  t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  verify(!!t.$('.modal'),'Escape cannot discard saving form');
  resolveCreate();await settle();
  verify(t.$('#main h1').textContent==='材料管理'&&t.$('#main').textContent.includes('案件名称与编号已保存'),'Successful creation opens saved case');
  verify(t.$('#toast-root').textContent.includes('案件已保存'),'Success message follows backend reply');
  verify(t.$('#main').textContent.includes('尚未接入')&&!t.$('[data-action="pick-files"]')&&!t.$('[data-action="demo-import"]'),'Production materials cannot simulate import');
  for(const route of ['flows','review','exports']){
    t.nav(route);
    verify(t.$('#main').textContent.includes('尚未接入')&&!t.$('.ledger-table')&&!t.$('[data-action="do-export"]'),'Unconnected '+route+' page has no synthetic results or writes');
  }
  const rogue=t.w.document.createElement('button');rogue.dataset.action='add-demo';t.w.document.body.append(rogue);rogue.click();rogue.remove();
  t.nav('home');verify(t.$$('.case-table tbody tr').length===1&&t.$('.summary-number').textContent==='1个','Injected demo action cannot populate desktop data');
  t.action('new-case');t.input('#new-name','重复编号');t.input('#new-number','TEST-01');t.action('save-case');
  verify(t.$('#form-error').textContent.includes('已存在')&&fixture.state.createCalls===1,'Known duplicate number blocked');t.action('close-modal');
  t.action('global-search');verify(t.$('.modal-body').textContent.includes('搜索范围：当前工作区的案件名称与编号'),'Search scope explicit');
  t.input('#global-query','远川');verify(t.$$('.search-result').length===0,'Global search excludes synthetic seed cases');
  t.input('#global-query','TEST-01');verify(t.$$('.search-result').length===1,'Global search finds persisted case number');
  t.action('search-case');await settle();verify(fixture.state.openCalls.at(-1)==='new-case-id'&&t.$('#main h1').textContent==='材料管理','Search opening validates case through backend');
  t.action('help');verify(t.$('.modal-body').textContent.includes('D:\\ChosenWorkspace')&&t.$('.modal-body').textContent.includes('尚未接入'),'Help distinguishes actual storage and future features');t.action('close-modal');
  const calls=fixture.state.createCalls;t.close();
  t=setup(fixture.bridge);await settle();
  verify(t.$$('.case-table tbody tr').length===1&&t.$('.case-table tbody').textContent.includes('合成案件'),'New renderer session loads backend case list');
  verify(fixture.state.createCalls===calls,'Reload does not recreate saved case');
  fixture.bridge.createCase=async()=>{fixture.state.createCalls++;return failure('磁盘不可写，请检查保存目录。');};
  t.action('new-case');t.input('#new-name','保存失败');t.input('#new-number','TEST-02');t.action('save-case');await settle();
  verify(t.$('#form-error').textContent.includes('磁盘不可写')&&t.$('#new-name').value==='保存失败','Backend creation failure preserves input and message');
  verify(!t.$('[data-action="save-case"]').disabled,'Failed create can be retried');t.action('close-modal');
  verify(t.$$('.case-table tbody tr').length===1,'Failed create does not add phantom case');
  fixture.bridge.openCase=async id=>{fixture.state.openCalls.push(id);return failure('案件数据库已失联。');};
  t.action('open-case');await settle();
  verify(t.$('#main h1').textContent==='案件工作台'&&t.$('.status.error').textContent.includes('暂不可用'),'Unreachable case is marked unavailable');
  verify([...t.$$('.case-table tbody tr td')].slice(1,4).every(td=>td.textContent==='—'),'Unavailable counts are unknown, not false zero');
  verify(t.$$('.summary-number').slice(1).every(el=>el.textContent.startsWith('—')),'All unreadable workspace does not show zero record totals');
  verify(t.$('.desktop-unavailable').textContent.includes('不代表工作区全部结果'),'Workspace totals disclose unreadable case exclusion');
  verify(t.$('#sidebar [data-route="materials"]').disabled,'Unavailable case cannot show normal empty business page');
  t.close();
  const unavailable=caseRow('missing','失联合成案件','MISSING-01');unavailable.available=false;unavailable.stats=null;unavailable.error={code:'CASE_MISSING',message:'案件库文件不存在，请检查目录。'};
  fixture=bridgeState([unavailable]);t=setup(fixture.bridge);await settle();
  verify(t.$('.desktop-case-error').textContent.includes('案件库文件不存在')&&!t.$('#main').textContent.includes('[object Object]'),'Structured backend errors display their human message');
  t.close();
  fixture=bridgeState([caseRow('a','案件甲','A-01')]);
  let attempts=0;fixture.bridge.getState=async()=>{attempts++;return attempts===1?failure('工作区无法读取'):success({needsWorkspace:false,workspacePath:fixture.state.workspacePath,cases:fixture.state.cases,currentCaseId:null});};
  t=setup(fixture.bridge);await settle();
  verify(t.$('#main').textContent.includes('工作区读取失败')&&!t.$('.case-table'),'Read failure cannot appear as an empty workspace');
  t.action('retry-workspace');await settle();verify(t.$$('.case-table tbody tr').length===1,'Read failure has a working retry path');
  t.action('open-case');await settle();verify(t.$('#main h1').textContent==='材料管理','Valid existing case opens');
  const file=new t.w.File(['synthetic'],'test.csv',{type:'text/csv'});Object.defineProperty(t.$('#file-picker'),'files',{configurable:true,value:[file]});
  t.$('#file-picker').dispatchEvent(new t.w.Event('change',{bubbles:true}));
  verify(!t.$('.modal')&&t.$('#toast-root').textContent.includes('未读取或登记文件'),'File picker event cannot bypass unimplemented import guard');
  t.close();
  console.log(`PASS: ${passed} desktop renderer contract assertions (mock bridge, no worker/database acceptance)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
