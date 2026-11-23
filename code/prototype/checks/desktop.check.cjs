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
    async listCases(){return success(state.cases);},
    async listMaterials(id){return success({caseId:id,dataVersion:'0',materials:[]});},
    async queryFlows(id){return success({caseId:id,dataVersion:'0',total:'0',rows:[],nextCursor:null});}
  };
  return {bridge,state};
}
function setup(bridge){
  const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{runScripts:'outside-only',pretendToBeVisual:true,url:'https://fundsift.example/'});
  const w=dom.window;w.TextEncoder=TextEncoder;w.Blob=Blob;w.fundsiftDesktop=bridge;
  const runtimeErrors=[];w.addEventListener('error',event=>runtimeErrors.push(event.error||event.message));
  for(const f of ['icons.js','data.js','exporter.js','copy.js','app.js','intro.js'])w.eval(fs.readFileSync(path.join(root,f),'utf8'));
  w.FUND_INTRO.enter();
  const $=s=>w.document.querySelector(s),$$=s=>[...w.document.querySelectorAll(s)];
  const action=(name,extra='')=>{const el=$(`[data-action="${name}"]${extra}`);assert.ok(el,`Missing action ${name}${extra}`);el.click();};
  const input=(s,v)=>{const el=$(s);assert.ok(el,`Missing input ${s}`);el.value=v;el.dispatchEvent(new w.Event('input',{bubbles:true}));};
  const nav=route=>action('nav',`[data-route="${route}"]`);
  return {dom,w,$,$$,action,input,nav,close:()=>{assert.deepEqual(runtimeErrors,[],'Renderer must not raise window errors');dom.window.close();}};
}
async function main(){
  let fixture=bridgeState([],null),t=setup(fixture.bridge);await settle();
  verify(t.$('#main').textContent.includes('先选择数据存放位置'),'First use asks for data directory');
  verify(t.$$('.case-table tbody tr').length===0&&!t.$('#main').textContent.includes('远川'),'Seed cases never enter desktop workspace');
  verify(t.$('#sidebar [data-route="materials"]').disabled,'Case pages disabled before workspace');
  fixture.bridge.chooseWorkspace=async()=>{fixture.state.chooseCalls++;return success({cancelled:true});};
  t.action('choose-workspace');await settle();
  verify(t.$('#main').textContent.includes('已取消选择')&&!t.$('[data-action="new-case"]'),'Cancelled folder dialog leaves setup usable');
  fixture.bridge.chooseWorkspace=async()=>{fixture.state.chooseCalls++;fixture.state.workspacePath='D:\\ChosenWorkspace';return fixture.bridge.getState();};
  t.action('choose-workspace');await settle();
  verify(t.$('#main').textContent.includes('还没有案件'),'Chosen empty workspace has real empty state');
  verify(t.$('.desktop-path').textContent==='D:\\ChosenWorkspace','Chosen data path displayed');
  verify(!t.$('[data-action="choose-workspace"]'),'No implicit workspace switching after initial setup');
  verify(t.$('#main').textContent.includes('下次可从案件列表继续打开'),'Desktop status describes local persistence');
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
  verify(t.$('#main').textContent.includes('开发中')&&!t.$('[data-action="pick-files"]')&&!t.$('[data-action="demo-import"]'),'Production materials uses native import and exposes no demo actions');
  for(const route of ['flows','review','exports']){
    t.nav(route);
    verify(t.$('#main').textContent.includes('开发中')&&!t.$('.ledger-table')&&!t.$('[data-action="do-export"]'),'Unconnected '+route+' page has no synthetic results or writes');
  }
  const rogue=t.w.document.createElement('button');rogue.dataset.action='add-demo';t.w.document.body.append(rogue);rogue.click();rogue.remove();
  t.nav('home');verify(t.$$('.case-table tbody tr').length===1&&t.$('.summary-number').textContent==='1个','Injected demo action cannot populate desktop data');
  t.action('new-case');t.input('#new-name','重复编号');t.input('#new-number','test-01');t.action('save-case');
  verify(t.$('#form-error').textContent.includes('已存在')&&fixture.state.createCalls===1,'Known duplicate number blocked');t.action('close-modal');
  t.action('global-search');verify(t.$('.modal-body').textContent.includes('搜索范围：这个数据存放位置内的案件名称与编号'),'Search scope explicit');
  t.input('#global-query','远川');verify(t.$$('.search-result').length===0,'Global search excludes synthetic seed cases');
  t.input('#global-query','TEST-01');verify(t.$$('.search-result').length===1,'Global search finds persisted case number');
  t.action('search-case');await settle();verify(fixture.state.openCalls.at(-1)==='new-case-id'&&t.$('#main h1').textContent==='材料管理','Search opening validates case through backend');
  t.action('help');verify(t.$('.modal-body').textContent.includes('D:\\ChosenWorkspace')&&t.$('.modal-body').textContent.includes('开发中'),'Help distinguishes actual storage and future features');t.action('close-modal');
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
  verify(t.$('.desktop-unavailable').textContent.includes('不代表全部结果'),'Workspace totals disclose unreadable case exclusion');
  verify(t.$('#sidebar [data-route="materials"]').disabled,'Unavailable case cannot show normal empty business page');
  t.close();
  const unavailable=caseRow('missing','失联合成案件','MISSING-01');unavailable.available=false;unavailable.stats=null;unavailable.error={code:'CASE_MISSING',message:'案件库文件不存在，请检查目录。'};
  fixture=bridgeState([unavailable]);t=setup(fixture.bridge);await settle();
  verify(t.$('.desktop-case-error').textContent.includes('案件库文件不存在')&&!t.$('#main').textContent.includes('[object Object]'),'Structured backend errors display their human message');
  t.close();
  const incomplete=caseRow('pending-stats','统计尚待检查','STATS-01');
  incomplete.stats={files:1,flows:null,pending:null};
  incomplete.diagnostics=[{message:'文件 synthetic.csv 的 current 批次 3 不存在，未选择历史批次替代。'}];
  fixture=bridgeState([caseRow('valid','正常案件','VALID-01'),incomplete]);t=setup(fixture.bridge);await settle();
  verify(t.$$('.summary-number')[1].textContent==='1份','Known material count remains visible with unknown flow count');
  verify(t.$$('.summary-number').slice(2).every(el=>el.textContent.startsWith('—')),'Any incomplete case makes workspace flow totals unknown');
  verify(t.$('.desktop-case-error').textContent.includes('synthetic.csv')&&t.$('.desktop-case-error').textContent.includes('批次 3'),'Statistics diagnosis identifies file and batch');
  verify(t.$$('.case-table tbody tr').some(el=>el.textContent.includes('统计待检查')),'Readable case with uncertain statistics has distinct state');
  t.close();
  fixture=bridgeState([caseRow('a','案件甲','A-01')]);
  let attempts=0;fixture.bridge.getState=async()=>{attempts++;return attempts===1?failure('工作区无法读取'):success({needsWorkspace:false,workspacePath:fixture.state.workspacePath,cases:fixture.state.cases,currentCaseId:null});};
  t=setup(fixture.bridge);await settle();
  verify(t.$('#main').textContent.includes('案件数据暂时无法读取')&&!t.$('.case-table'),'Read failure cannot appear as an empty workspace');
  t.action('retry-workspace');await settle();verify(t.$$('.case-table tbody tr').length===1,'Read failure has a working retry path');
  t.action('open-case');await settle();verify(t.$('#main h1').textContent==='材料管理','Valid existing case opens');
  const file=new t.w.File(['synthetic'],'test.csv',{type:'text/csv'});Object.defineProperty(t.$('#file-picker'),'files',{configurable:true,value:[file]});
  t.$('#file-picker').dispatchEvent(new t.w.Event('change',{bubbles:true}));
  verify(!t.$('.modal')&&t.$('#toast-root').textContent.includes('未读取或登记文件'),'File picker event cannot bypass unimplemented import guard');
  t.close();

  // Database timestamps stay in UTC; display follows the computer's timezone.
  const previousTimezone=process.env.TZ;
  try{
    for(const [zone,expectedUtc,expectedLate] of [
      ['Asia/Shanghai','2026-11-13 16:00','2026-11-14 04:30'],
      ['America/New_York','2026-11-13 03:00','2026-11-13 15:30']
    ]){
      process.env.TZ=zone;
      const timestamps=[['utc','2026-11-13T08:00:00Z'],['late','2026-11-13T20:30:00.000Z'],['offset','2026-11-13T08:00:00+02:00'],['missing',null],['malformed','not a timestamp'],['bad-day','2026-02-30T08:00:00Z']];
      fixture=bridgeState(timestamps.map(([id,value])=>({...caseRow(id,id,id),updatedAt:value})));
      t=setup(fixture.bridge);await settle();
      const displayed=id=>t.$(`tr[data-id="${id}"] td:nth-child(6)`).textContent;
      verify(displayed('utc')===expectedUtc,zone+' converts UTC into local time');
      verify(displayed('late')===expectedLate,zone+' applies local calendar date at a UTC day boundary');
      verify(displayed('offset')===(zone==='Asia/Shanghai'?'2026-11-13 14:00':'2026-11-13 01:00'),zone+' respects explicit source offsets');
      verify(['missing','malformed','bad-day'].every(id=>displayed(id)==='—'),zone+' missing and malformed timestamps remain unknown');
      verify(fixture.state.cases[0].updatedAt==='2026-11-13T08:00:00Z','Rendering never rewrites stored UTC timestamp');
      t.close();
    }
  }finally{if(previousTimezone===undefined)delete process.env.TZ;else process.env.TZ=previousTimezone;}

  fixture=bridgeState([caseRow('status-case','状态检查案件','STATUS-01')]);
  let receiveStatus,unsubscribed=0;
  fixture.bridge.onOperationStatus=callback=>{receiveStatus=callback;return()=>{unsubscribed++;};};
  t=setup(fixture.bridge);await settle();
  const panel=t.$('#desktop-operation-status');
  const emit=(operationId,phase,extra={})=>receiveStatus({operationId,operation:'create-case',phase,active:!['completed','failed'].includes(phase),elapsedMs:0,waitingLong:false,...extra});
  verify(panel.hidden&&panel.getAttribute('role')==='status'&&panel.getAttribute('aria-live')==='polite','Operation feedback starts hidden and has a polite live region');
  t.w.FUND_INTRO.show();
  emit(1,'backing-up',{operation:'get-state',elapsedMs:18000,waitingLong:true});
  verify(!panel.hidden&&!panel.closest('#application')&&panel.textContent.includes('正在备份旧版数据'),'Real operation feedback remains available while introduction is shown');
  verify(panel.textContent.includes('18 秒')&&panel.textContent.includes('尚未返回结果')&&!panel.textContent.includes('失败'),'Long wait reports last known stage and elapsed time without claiming ongoing progress or failure');
  emit(1,'completed');
  verify(panel.hidden&&panel.textContent==='','Terminal result clears operation feedback');
  t.w.FUND_INTRO.enter();
  t.action('new-case');t.input('#new-name','保留填写内容');t.input('#new-number','STATUS-02');
  const nameInput=t.$('#new-name');nameInput.focus();nameInput.setSelectionRange(1,3);
  emit(2,'queued');emit(2,'running');emit(2,'checking',{elapsedMs:2000});
  verify(t.$('#new-name')===nameInput&&nameInput.value==='保留填写内容'&&t.w.document.activeElement===nameInput&&nameInput.selectionStart===1&&nameInput.selectionEnd===3,'Progress updates preserve form nodes, entered data, focus and selection');
  emit(3,'queued');
  verify(panel.dataset.operationId==='2','Queued later operation does not hide the operation executing now');
  emit(2,'completed');
  verify(!panel.hidden&&panel.dataset.operationId==='3'&&panel.textContent.includes('等待前面的操作完成'),'Completing one operation leaves the queued operation visible');
  emit(3,'running');emit(2,'backing-up');emit(2,'completed');
  verify(panel.dataset.operationId==='3'&&!panel.hidden,'Late progress and terminal events cannot overwrite a newer active operation');
  emit(3,'completed');
  const rejectedBefore=t.$('#form-error').textContent;
  receiveStatus({operationId:4,operation:'create-case',phase:'<script>bad</script>',active:true,elapsedMs:0,waitingLong:false});
  verify(panel.hidden&&t.$('#form-error').textContent===rejectedBefore,'Malformed status does not produce UI or change form result');
  let rejectCreate;
  fixture.bridge.createCase=()=>new Promise(resolve=>{rejectCreate=()=>resolve(failure('合成保存故障，原案件不变。'));});
  t.action('save-case');emit(4,'running');emit(4,'saving-settings',{elapsedMs:16000,waitingLong:true});
  verify(!t.$('#toast-root').textContent.includes('已保存')&&t.$('[data-action="save-case"]').disabled,'Long operation feedback never acknowledges save or enables duplicate submission');
  emit(4,'failed');
  verify(panel.hidden&&t.$('[data-action="save-case"]').disabled,'Terminal status does not replace the authoritative RPC result');
  rejectCreate();await settle();
  verify(t.$('#form-error').textContent.includes('合成保存故障')&&t.$('#new-name').value==='保留填写内容'&&!t.$('[data-action="save-case"]').disabled,'RPC failure preserves inputs and enables deliberate retry after terminal feedback');
  emit(5,'running');emit(6,'queued');emit(6,'failed');
  verify(panel.dataset.operationId==='5'&&!panel.hidden,'A later operation terminal removes only its own feedback');
  emit(5,'checking');
  verify(panel.textContent.includes('正在检查数据'),'An existing earlier operation can still report its real phase');
  emit(5,'completed');
  verify(panel.hidden,'Out-of-order terminal results eventually clear all active operations');
  for(const phase of ['choosing-location','confirming-location']){
    emit(7,phase,{operation:'choose-workspace',elapsedMs:30000,waitingLong:true});
    verify(panel.textContent.includes('请在系统窗口中完成选择或取消')&&!panel.textContent.includes('继续等待'),'Native dialog '+phase+' prompts the user to choose or cancel even after long wait');
  }
  emit(7,'completed');
  t.w.dispatchEvent(new t.w.Event('pagehide'));
  verify(unsubscribed===1&&!t.$('#desktop-operation-status'),'Page teardown unsubscribes operation events and removes feedback');
  t.close();
  fixture=bridgeState([caseRow('imports','真实接口合成案','IMPORT-01')]);
  const material={id:'1',fileName:'<img src=x onerror=bad()>.csv',sha256:'a'.repeat(64),formatKey:'alipay-account-17col-v1',currentBatchId:'1',batchStatus:'done',importedRows:'2',pendingRows:'1',diagnosticRows:'1'};
  const failedMaterial={id:'2',fileName:'上次失败.txt',sha256:'b'.repeat(64),formatKey:'wechat-trades-27col-v1',
    currentBatchId:null,status:'failed',latestErrorCode:'FS_IMPORT_PARSE',canRetry:true};
  const ledgerRow={id:'1',source_file_name:material.fileName,source_loc:'2',txn_time:'2026-01-01 08:00:00',acct_no:'00001(合成身份)',peer_name:null,peer_acct:null,summary:'测试',raw_amount_text:'92233720368547758.07',raw_direction:'收入',amount:'9223372036854775807',currency:'CNY',status:'confirmed',pendingReasons:[]};
  let imported=false,hasFailedMaterial=false,queryOptions=[],sourceCalls=0;
  const materials=()=>[...(imported?[material]:[]),...(hasFailedMaterial?[failedMaterial]:[])];
  const successReceipt=()=>success({receipt:{state:'completed',importedRows:2,pendingRows:1,unquantifiableRows:1,diagnosticRows:1},materials:{materials:materials()},case:{...fixture.state.cases[0],stats:{files:1,flows:2,pending:1}}});
  fixture.bridge.listMaterials=async id=>success({caseId:id,dataVersion:'1',materials:materials()});
  fixture.bridge.chooseImport=async()=>{imported=true;return successReceipt();};
  fixture.bridge.retryImport=async (id,sourceFileId)=>{
    verify(id==='imports'&&sourceFileId==='2','Retry only sends current case and failed material identity');
    hasFailedMaterial=false;
    return successReceipt();
  };
  fixture.bridge.openCase=async id=>success({...fixture.state.cases.find(item=>item.id===id),stagingCleanup:{removed:2,warnings:1}});
  fixture.bridge.queryFlows=async(id,opt)=>{queryOptions.push(opt);return success({caseId:id,dataVersion:'1',total:opt.filters.status==='pending'?'1':'2',rows:opt.filters.status==='pending'?[{...ledgerRow,id:'2',amount:null,status:'pending',pendingReasons:[{reason_code:'direction_unknown',detail:'方向未知'}]}]:opt.cursor?[{...ledgerRow,id:'2',amount:'-9223372036854775808'}]:[ledgerRow],nextCursor:opt.cursor||opt.filters.status==='pending'?null:'page2'});};
  fixture.bridge.readFlowSource=async(id,opt)=>{sourceCalls++;verify(id==='imports'&&opt.dataVersion==='1'&&opt.flowId==='1','Source request pins current case, flow and version');return success({standard:{...ledgerRow,amount:'-101',raw_amount_text:'1.005',raw_direction:'支出',direction:'出'},fileName:material.fileName,sourceLoc:'2',sourceSha256:'a'.repeat(64),fields:{'原始文本':'<script>x</script>\u202e原文'},savedDerivation:{money:{source_unit:'元',rounding:[{field:'raw_amount_text',rounded:true}]}}});};
  fixture.bridge.queryRelations=async()=>success({rows:[],eligibleRows:'2',truncated:false,limitations:['不自动去重']});
  t=setup(fixture.bridge);await settle();t.action('open-case');await settle();
  verify(t.$('[data-action="desktop-import"]')&&!t.$('[data-action="demo-import"]'),'Connected materials exposes only real import');
  verify(t.$('.staging-cleanup').textContent.includes('已清理 2 份')&&t.$('.staging-cleanup').textContent.includes('1 项暂存需检查'),'Case-open cleanup reports actual removal and warning counts');
  t.action('desktop-import');await settle();
  verify(t.$('.import-receipt').textContent.includes('写入 2 条')&&t.$('.import-receipt').textContent.includes('待核 1 条'),'Published receipt uses authoritative counts');
  verify(t.$('.import-receipt').textContent.includes('附加诊断涉及 1 条')&&t.$('.desktop-materials tbody').textContent.includes('附加诊断涉及 1 条'),'Supplementary diagnostics are shown separately from pending');
  verify(t.$('.desktop-materials tbody').textContent.includes('支付宝账户 CSV')&&!t.$('.desktop-materials tbody').textContent.includes('alipay-account-17col-v1'),'Material format is shown in Chinese');
  verify(!t.$('[data-action="desktop-retry-import"]'),'Published material has no failure retry action');
  hasFailedMaterial=true;
  t.nav('materials');await settle();
  verify(t.$$('[data-action="desktop-retry-import"]').length===1,'Only the unpublished failed material has a retry action');
  t.action('desktop-retry-import');await settle();
  verify(t.$('.import-receipt').textContent.includes('导入已发布')&&!t.$('[data-action="desktop-retry-import"]'),'Successful retry refreshes materials and uses the import receipt');
  verify(t.$('.desktop-materials tbody').textContent.includes('<img')&&!t.$('.desktop-materials img'),'Untrusted material filename is escaped');
  t.action('material-flows');await settle();
  verify(t.$('.desktop-ledger').textContent.includes('+92,233,720,368,547,758.07'),'Signed int64 maximum renders without Number loss');
  verify(t.$$('.desktop-ledger thead th').slice(0,12).map(el=>el.textContent.trim()).join('|')===
    '渠道|本方|本方账号 / 标识|对手方|对手方账号 / 标识|交易时间|收支|金额（元）|交易类型|备注 1|备注 2|交易单号',
    'Desktop ledger uses independent evidence columns');
  verify(t.$('td.ledger-account').textContent==='00001(合成身份)'&&t.$('td.ledger-counterpartyAccount').textContent==='—',
    'Ledger preserves composite source identifier and displays a dash for the absent counterparty identifier');
  verify(queryOptions.at(-1).filters.sourceFileId===1,'Material drilldown scopes source server side');
  t.action('desktop-source');await settle();
  verify(sourceCalls===1&&t.$('.raw-evidence').textContent.includes('<script>')&&!t.$('.raw-evidence script'),'Verified source values render as text');
  verify(t.$('.source-money-explanation').textContent.includes('1.005 元 → 1.01 元')&&t.$('.source-money-explanation').textContent.includes('支出记负数'),'Human-readable amount explanation states the actual rounding and sign');
  verify(t.$('.raw-evidence').textContent.includes('\\u202e'),'Bidi control rendered visibly without overwriting stored original');
  verify(!t.$('.modal [data-action="confirm-amount"]')&&!t.$('.modal input'),'Source modal has no amount editing path');t.action('close-modal');
  t.action('desktop-next');await settle();verify(t.$('.desktop-ledger').textContent.includes('-92,233,720,368,547,758.08'),'Int64 minimum renders exactly on next page');
  t.action('desktop-prev');await settle();verify(queryOptions.at(-1).cursor===null,'Previous page restores original cursor context');
  t.nav('review');await settle();verify(queryOptions.at(-1).filters.status==='pending'&&t.$('.desktop-ledger').textContent.includes('方向未知'),'Read-only review uses pending server filter and explicit reason');
  verify(t.$('.desktop-ledger').textContent.includes('—')&&!t.$('[data-action="confirm-amount"]'),'Unknown amount stays dash and cannot be saved');
  t.action('desktop-relations');await settle();verify(t.$('.modal').textContent.includes('不合并、不去重、不计算净额'),'Candidate relation modal discloses read-only meaning');t.action('close-modal');
  fixture.bridge.queryFlows=async()=>({ok:false,error:{code:'FS_QUERY_STALE',message:'数据已更新，请刷新列表后继续查看。'}});
  t.action('refresh-data');await settle();verify(t.$('.desktop-data-error').textContent.includes('数据已更新')&&t.$$('.desktop-ledger tbody tr').length===0,'Stale response clears old rows and offers refresh');
  t.nav('materials');await settle();fixture.bridge.chooseImport=async()=>({ok:false,error:{code:'FS_IMPORT_DUPLICATE',message:'相同原件已登记',receipt:{state:'failed',importedRows:0,pendingRows:0}}});
  t.action('desktop-import');await settle();verify(t.$('.desktop-data-error').textContent.includes('相同原件')&&t.$('.import-receipt').textContent.includes('导入未发布'),'Import failure receipt remains visible with actionable error');
  verify(t.$$('.desktop-materials tbody tr').length===1,'Refused duplicate never adds phantom material');
  let exportCalls=0,completeExport;
  fixture.bridge.exportWorkpaper=caseId=>{
    verify(caseId==='imports','Export is bound to the active case');
    exportCalls++;
    return new Promise(resolve=>{completeExport=resolve;});
  };
  t.nav('exports');
  const workpaperPanel=t.$('.workpaper-panel').textContent;
  verify(workpaperPanel.includes('Excel 底稿仅含规则结果')&&workpaperPanel.includes('修改底稿不计为复核')&&!t.$('[data-action="do-export"]'),'Desktop export explains that the rule-only workpaper excludes manual reviews');
  verify(workpaperPanel.includes('本地 NTFS 文件夹'),'Desktop export displays the save folder requirement before the dialog');
  t.action('desktop-export-workpaper');t.action('desktop-export-workpaper');
  verify(exportCalls===1&&t.$('.workpaper-panel').getAttribute('aria-busy')==='true','Export stays locked while native selection is pending');
  completeExport(success({cancelled:true}));await settle();
  verify(!t.$('.workpaper-receipt')&&!t.$('[data-action="desktop-export-workpaper"]').disabled,'Cancelled export offers another attempt without a fake receipt');
  t.action('desktop-export-workpaper');
  completeExport(failure('数据已更新，请重新导出。'));await settle();
  verify(t.$('.desktop-data-error').textContent.includes('数据已更新')&&!t.$('.workpaper-receipt'),'Export failure explains why and creates no success receipt');
  t.action('desktop-export-workpaper');
  completeExport(success({filePath:'D:\\SyntheticExports\\底稿.xlsx',dataVersion:'31',totalRows:2,confirmedRows:1,pendingRows:1,unknownAmountRows:1}));await settle();
  const workpaper=t.$('.workpaper-receipt');
  verify(workpaper.dataset.version==='31'&&workpaper.textContent.includes('底稿.xlsx')&&workpaper.querySelectorAll('dd')[0].textContent==='2','Successful export shows the written file, snapshot version and receipt counts');
  t.close();

  fixture=bridgeState([caseRow('reviews','人工复核合成案件','REVIEW-01')]);
  const refund={...ledgerRow,id:'71',amount:null,direction:null,status:'pending',source_loc:'工作表!51',raw_amount_text:'-1.34',raw_direction:'借',summary:'消费退货',raw_record:JSON.stringify({derivation:{money:{source_unit:'元'}}})};
  const transfer={...refund,id:'72',rule_version:'2',source_loc:'52',raw_amount_text:'15.0',raw_direction:'其它',summary:'余额宝自动转入',raw_record:JSON.stringify({format_key:'alipay-account-17col-v1',derivation:{money:{source_unit:'元'},internal_transfer:{kind:'balance_to_yuebao'}}})};
  const sign={id:'700',reason_code:'sign_semantics_undefined',detail:'负额符号待核',resolved_at:null};
  const other={id:'701',reason_code:'time_missing',detail:'交易时间待核',resolved_at:null};
  const direction={id:'702',reason_code:'direction_unknown',detail:'方向未知',resolved_at:null};
  const oldEvent={id:'30',action:'note',operator:'旧批次操作人',evidence:'旧依据',reviewed_at:'2026-11-18T01:00:00.000Z',batch_id:'1',rule_version:'1',source_loc:refund.source_loc,current_flow_id:'71'};
  const pendingSaves=[];
  let version='11',resolved=false,corrected=false;
  const histories={'71':[oldEvent],'72':[]};
  const activeMaterial=()=>({...material,fileName:'合成建行.xlsx',currentBatchId:'3',reviewedRows:'0',previousReviewedRows:'1'});
  const reviewRows=()=>[
    {...refund,amount:corrected?'135':resolved?'134':null,direction:resolved?'进':null,pendingReasons:resolved?[other]:[sign,other],
      review:{canNote:true,canResolve:!resolved,hasHistory:true}},
    {...transfer,pendingReasons:[direction],review:{canNote:true,canResolve:false,hasHistory:histories['72'].length>0}}
  ];
  fixture.bridge.listMaterials=async id=>success({caseId:id,dataVersion:version,materials:[activeMaterial()]});
  fixture.bridge.queryFlows=async id=>success({caseId:id,dataVersion:version,total:'2',rows:reviewRows(),nextCursor:null});
  fixture.bridge.getReview=async (caseId,flowId)=>{
    assert.equal(caseId,'reviews');
    const row=reviewRows().find(item=>item.id===flowId);
    const canResolve=row===undefined?false:row.id==='71';
    const signReason=resolved?{...sign,resolved_at:'2026-11-18T02:00:00Z'}:sign;
    return success({
      caseId,flowId,dataVersion:version,batchId:'3',status:row.status,amount:row.amount,direction:row.direction,
      canNote:true,resolveReasonId:canResolve&&!resolved?'700':null,correctReasonId:canResolve&&resolved?'700':null,
      internalTransfer:!canResolve,reasons:canResolve?[signReason,other]:[direction],history:histories[flowId],
      source:{fileName:'合成建行.xlsx',sourceLoc:row.source_loc,standard:{...row,initialRule:canResolve&&resolved?{amount:null,direction:null,status:'pending'}:null},
        fieldEntries:[{column:13,header:'摘要',value:row.summary}]}
    });
  };
  fixture.bridge.saveReview=(caseId,payload)=>new Promise(resolve=>{
    assert.equal(caseId,'reviews');
    pendingSaves.push({payload,finish:result=>resolve(result)});
  });
  fixture.bridge.listReviewHistory=async()=>success({currentBatchId:'3',oldReviewCount:1,history:[oldEvent]});
  const commitReview=(entry,change={})=>{
    const {payload}=entry;
    histories[payload.flowId].unshift({
      id:String(Number(version)+30),action:payload.action,operator:payload.operator,evidence:payload.evidence,
      before_amount:null,after_amount:payload.action==='resolve'?'134':payload.action==='correct'?'135':null,
      after_direction:payload.direction,reviewed_at:'2026-11-18T02:00:00Z',batch_id:'3',rule_version:'1',...change
    });
    version=String(Number(version)+1);
    entry.finish(success({case:fixture.state.cases[0],materials:{materials:[activeMaterial()]}}));
  };
  t=setup(fixture.bridge);await settle();t.action('open-case');await settle();
  verify(t.$('.material-review-notice').textContent.includes('1 条流水有旧批次复核记录')&&t.$('[data-action="desktop-review-material-history"]'),'Historical reviews stay accessible after reimport with no current review');
  t.action('desktop-review-material-history');await settle();
  verify(t.$('.modal').textContent.includes('当前批次有相符记录')&&t.$('.modal').textContent.includes('本批次未继承'),'Material history identifies old evidence matching the current batch');
  t.action('close-modal');t.nav('review');await settle();
  verify(t.$('.desktop-ledger').textContent.includes('业务性质已定（内部划转），方向待定'),'Internal transfer displays the known classification and remaining uncertainty');
  verify(t.$('[data-action="desktop-review-open"][data-id="72"][data-mode="note"]').textContent.includes('记录核查说明')&&
    t.$('[data-action="desktop-review-open"][data-id="71"][data-mode="resolve"]').textContent.includes('确认金额和方向'),
    'Ledger names the available action before a record is opened');
  t.action('desktop-review-open','[data-id="72"][data-mode="note"]');await settle();
  verify(t.$('.modal').textContent.includes('本笔只能记说明')&&!t.$('#manual-review-amount'),'Ineligible reasons receive a note form without value controls');
  t.action('desktop-review-save');
  verify(t.$('#manual-review-error').textContent.includes('请填写')&&pendingSaves.length===0,'Empty form never submits a review');
  t.input('#manual-review-operator','核查一');t.input('#manual-review-evidence','<img src=x> 已核对原文');
  t.action('desktop-review-save');t.action('desktop-review-save');
  verify(pendingSaves.length===1&&pendingSaves[0].payload.action==='note'&&!Object.hasOwn(pendingSaves[0].payload,'reasonId'),'A note sends no reason mutation and repeated clicks do not resubmit');
  pendingSaves[0].finish(failure('读取响应中断，请重试。'));await settle();
  t.action('desktop-review-save');commitReview(pendingSaves[1]);await settle();
  verify(pendingSaves[0].payload.requestId===pendingSaves[1].payload.requestId,'Retrying an identical payload reuses request identity');
  verify(t.$('#manual-review-result').textContent==='说明已保存。'&&t.$('.manual-review-reasons').textContent.includes('仍待核')&&t.$('.manual-review-evidence').textContent.includes('<img')&&!t.$('.modal img'),'Note shows exact escaped evidence with remaining status');
  t.action('close-modal');t.action('desktop-review-open','[data-id="71"][data-mode="history"]');await settle();
  verify(t.$('#modal-title').textContent==='查看复核历史'&&!t.$('#manual-review-form')&&t.$('.modal').textContent.includes('旧批次复核历史'),
    'History action opens the evidence as read-only until the user chooses a review action');
  t.action('close-modal');t.action('desktop-review-open','[data-id="71"][data-mode="resolve"]');await settle();
  verify(t.$('.modal').textContent.includes('消费退货')&&t.$('.modal').textContent.includes('-1.34 元')&&t.$('.modal').textContent.includes('旧批次复核历史'),'Review provides refund source fields and prior-batch history');
  verify(t.$('#manual-review-amount')&&t.$('#modal-title').textContent==='确认金额和方向',
    'Refund action opens directly in confirmation mode');
  t.input('#manual-review-operator','核查二');t.input('#manual-review-evidence','余额由 0.73 变为 2.07。');
  t.input('#manual-review-amount','-1.34');t.input('#manual-review-direction','进');
  t.action('desktop-review-save');
  verify(t.$('#manual-review-error').textContent.includes('不含正负号')&&pendingSaves.length===2,'Signed amount is rejected by the form');
  t.input('#manual-review-amount','1.34');
  t.action('desktop-review-save');
  verify(pendingSaves[2].payload.reasonId==='700'&&pendingSaves[2].payload.action==='resolve'&&pendingSaves[2].payload.dataVersion==='12','Confirmation targets a single reason using the snapshot version');
  version='13';
  pendingSaves[2].finish({ok:false,error:{code:'FS_REVIEW_STALE',message:'数据已更新，请重新读取。'}});await settle();
  verify(t.$('[data-action="desktop-review-save"]').disabled&&!t.$('#manual-review-refresh').hidden&&t.$('#manual-review-evidence').value.includes('2.07'),'Stale submission is blocked with entered evidence preserved');
  t.action('desktop-review-refresh');await settle();t.action('desktop-review-save');
  resolved=true;commitReview(pendingSaves[3]);await settle();
  verify(pendingSaves[3].payload.dataVersion==='13'&&pendingSaves[3].payload.requestId!==pendingSaves[2].payload.requestId,'Refresh requires explicit resubmission at the new version');
  verify(t.$('.manual-review-facts').textContent.includes('原规则结果')&&t.$('.manual-review-facts').textContent.includes('+1.34 元 / 进'),'Confirmed amount appears alongside original rule result');
  verify(t.$('.manual-review-reasons').textContent.includes('已解除负额符号待核')&&t.$('.manual-review-reasons').textContent.includes('仍待核交易时间待核'),'Resolved and remaining reasons are visible independently');
  t.action('desktop-review-correct');
  t.input('#manual-review-amount','1.35');t.input('#manual-review-direction','进');t.input('#manual-review-evidence','追加更正的依据。');
  t.action('desktop-review-save');
  corrected=true;commitReview(pendingSaves[4],{before_amount:'134',before_direction:'进'});await settle();
  verify(pendingSaves[4].payload.action==='correct'&&t.$$('.manual-review-history')[0].querySelectorAll('.manual-review-evidence').length===2,'Correction appends history and preserves original confirmation evidence');
  t.close();

  console.log(`PASS: ${passed} desktop renderer contract assertions (mock bridge, no worker/database acceptance)`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
