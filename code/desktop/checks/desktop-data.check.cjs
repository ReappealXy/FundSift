'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { WorkspaceStore } = require('../storage.cjs');
const { DesktopData } = require('../desktop-data.cjs');
const { HEADERS } = require('../alipay-account.cjs');
const { createOperationStatus, sanitizeProgress, sanitizeReceipt } = require('../operation-status.cjs');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'fundsift-desktop-data-'));
  const store = new WorkspaceStore({ schemaPath: path.resolve(__dirname,'../../ddl_extract_check.sql') });
  t.after(() => { store.close(); fs.rmSync(root,{recursive:true,force:true}); });
  await store.openWorkspace(root);
  const c = await store.createCase({name:'合成桌面导入',number:'DESKTOP-DATA'});
  const rows = [
    ['1','order','2026-01-01 08:00:00','2026-01-01 08:00:01','','source','type','00001(合成身份)','00002(合成对方)','商品','92233720368547758.07','收入','交易成功','way','','',''],
    ['2','order','','','','source','type','00001(合成身份)','00002(合成对方)','商品','1.00','其它','交易中途关闭（未完成）','way','','','']
  ];
  const filePath = path.join(root,'synthetic.csv');
  fs.writeFileSync(filePath,'\ufeff'+[HEADERS,...rows].map(row => row.join(',')).join('\r\n')+'\r\n');
  const events = [], data = new DesktopData(store,{onProgress:event => events.push(event)});
  return {root,store,c,data,filePath,events,input:{filePath,confirmedCny:true,confirmedAt:'2026-11-19T00:00:00.000Z'}};
}

test('桌面接口只接当前案、内部固定规则、逐文件确认人民币，导入后无损查询和核验回源', async t => {
  const f = await fixture(t);
  for (const input of [{...f.input,confirmedCny:false},{...f.input,rule:{}},{...f.input,confirmedAt:'bad'}]) {
    await assert.rejects(() => f.data.importFile(f.c.id,input),{code:'FS_IMPORT_APPROVAL'});
  }
  assert.equal(f.store.caseDb.prepare('SELECT count(*) n FROM source_file').get().n,0);
  await assert.rejects(() => f.data.importFile('other',f.input),{code:'FS_CASE_CONTEXT'});
  const result = await f.data.importFile(f.c.id,f.input);
  assert.equal(result.receipt.importedRows,2); assert.equal(result.receipt.pendingRows,1);
  assert.equal(result.case.stats.flows,2); assert.equal(result.materials.materials[0].importedRows,'2');
  assert.ok(f.events.some(e => e.phase === 'archiving' && typeof e.copiedBytes === 'string'));
  assert.ok(f.events.some(e => e.phase === 'importing' && e.writtenRows === 2));
  const first = f.data.queryFlows(f.c.id,{limit:1});
  assert.equal(first.rows[0].amount,'9223372036854775807'); assert.ok(first.nextCursor);
  const pending = f.data.queryFlows(f.c.id,{filters:{status:'pending'}});
  assert.equal(pending.total,'1'); assert.equal(pending.rows[0].amount,null); assert.ok(pending.rows[0].pendingReasons.length >= 2);
  const source = await f.data.readFlowSource(f.c.id,{flowId:first.rows[0].id,dataVersion:first.dataVersion});
  assert.equal(source.values[10],'92233720368547758.07'); assert.equal(source.standard.amount,'9223372036854775807');
  assert.equal(source.savedDerivation.time_column,'付款时间');
  assert.deepEqual(JSON.parse(JSON.stringify(source)),source);
  f.store.close(); await f.store.openWorkspace(f.root);
  assert.equal(f.data.listMaterials(f.c.id).materials[0].sha256,result.materials.materials[0].sha256);
  assert.equal(f.data.queryFlows(f.c.id).total,'2');
});

test('回源绑定版本与当前批次，跨案查询和旧批次隐藏，重复导入保留失败回执', async t => {
  const f = await fixture(t); await f.data.importFile(f.c.id,f.input);
  const first = f.data.queryFlows(f.c.id), row = first.rows[0];
  await assert.rejects(() => f.data.readFlowSource(f.c.id,{flowId:row.id,dataVersion:'0'}),{code:'FS_QUERY_STALE'});
  await assert.rejects(() => f.data.readFlowSource(f.c.id,{flowId:row.id,dataVersion:first.dataVersion,filePath:'injected'}),{code:'FS_QUERY_INPUT'});
  assert.throws(() => f.data.queryFlows(f.c.id,{caseId:'other'}),{code:'FS_QUERY_INPUT'});
  await assert.rejects(() => f.data.importFile(f.c.id,f.input),error => error.code === 'FS_IMPORT_DUPLICATE' && error.receipt.state === 'failed');
  const record = f.store._caseRecord(f.c.id);
  const storedRule = f.store.caseDb.prepare('SELECT * FROM format_rule').get();
  const config = JSON.parse(f.store.caseDb.prepare('SELECT config_json FROM format_rule_config').get().config_json);
  const policy = JSON.parse(f.store.caseDb.prepare('SELECT notes FROM import_batch WHERE id=1').get().notes).policy;
  await require('../import-service.cjs').importAlipayAccount({db:f.store.caseDb,record,caseDirectory:f.store._casePath(f.c.id),
    filePath:f.filePath,reimport:true,rule:{...config,platform:storedRule.platform,format_key:storedRule.format_key,rule_version:storedRule.rule_version},policy});
  const current = f.data.queryFlows(f.c.id);
  await assert.rejects(() => f.data.readFlowSource(f.c.id,{flowId:row.id,dataVersion:current.dataVersion}),{code:'FS_IMPORT_SOURCE'});
  await f.store.createCase({name:'合成另一案',number:'OTHER'});
  assert.throws(() => f.data.listMaterials(f.c.id),{code:'FS_CASE_CONTEXT'});
});

test('微信已批准规则按整数分写入，重复表头按位置回源，平台身份与卡号分别保留', async t => {
  const f = await fixture(t), {HEADERS:wxHeaders} = require('../wechat-trades.cjs');
  const row=['platform-user','wx-order','large-order','合成名称','出','快捷支付','消费','2026-11-19 08:00:00',
    '101','0','card-0001','bank-link','网联','本方信息','peer-user','合成对方','card-0002','合成银行','peer-link',
    '银联','','非间连','{}','','','备注','末列'];
  const filePath=path.join(f.root,'synthetic.txt');fs.writeFileSync(filePath,[wxHeaders,row].map(values=>values.join('\t')).join('\r\n')+'\r\n');
  const result=await f.data.importFile(f.c.id,{...f.input,filePath,formatKey:'wechat-trades-27col-v1'});
  assert.equal(result.receipt.importedRows,1);assert.equal(result.receipt.pendingRows,0);
  const page=f.data.queryFlows(f.c.id), flow=page.rows[0];
  assert.equal(flow.amount,'-101');assert.equal(flow.acct_no,'platform-user');assert.equal(flow.balance,'0');
  const source=await f.data.readFlowSource(f.c.id,{flowId:flow.id,dataVersion:page.dataVersion});
  assert.deepEqual(source.values,row);assert.equal(source.savedDerivation.money.source_unit,'分');
  assert.equal(source.savedDerivation.account_identity_policy,'raw_platform_user_id');
});

test('进度与失败回执闭合字段，精确字节和计数过界拒绝，不提前发终态', () => {
  assert.deepEqual(sanitizeProgress({copiedBytes:'9007199254740993',totalBytes:'9007199254740994',path:'private'}),
    {copiedBytes:'9007199254740993',totalBytes:'9007199254740994'});
  for (const invalid of [{writtenRows:-1},{writtenRows:3,totalRows:2},{writtenRows:Number.MAX_SAFE_INTEGER+1},
    {copiedBytes:'007'},{copiedBytes:'2',totalBytes:'1'}]) assert.equal(sanitizeProgress(invalid),null);
  assert.deepEqual(sanitizeReceipt({state:'failed',batchId:null,errorCode:'FS_IMPORT_DUPLICATE',secret:'private'}),
    {state:'failed',batchId:null,errorCode:'FS_IMPORT_DUPLICATE'});
  const events = [], status = createOperationStatus({operationId:1,operation:'choose-import',publish:v=>events.push(v),schedule:()=>1,cancel:()=>{}});
  status.update('importing',{writtenRows:1,totalRows:2}); status.update('importing',{writtenRows:2,totalRows:2});
  assert.equal(events.at(-1).progress.writtenRows,2); assert.equal(events.at(-1).active,true);
  status.update('completed',{writtenRows:2,totalRows:2}); assert.equal(events.at(-1).active,true);
  status.finish(true); assert.equal(events.at(-1).active,false);
});

test('preload允许专用导入查询接口且进度不泄漏路径、不接受伪造百分比', async () => {
  const ipc = new EventEmitter(), calls = []; let bridge;
  ipc.invoke = (...args) => { calls.push(args); return Promise.resolve({ok:true}); };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../preload.cjs'),'utf8'),{
    require:() => ({ipcRenderer:ipc,contextBridge:{exposeInMainWorld(_name,value){bridge=value;}}})
  });
  await bridge.chooseImport('case'); await bridge.listMaterials('case'); await bridge.queryFlows('case',{limit:1});
  await bridge.readFlowSource('case',{flowId:'1',dataVersion:'2'});
  assert.deepEqual(calls.map(args=>args[0]),['fundsift:choose-import','fundsift:list-materials','fundsift:query-flows','fundsift:read-flow-source']);
  const seen=[]; bridge.onOperationStatus(value=>seen.push(value));
  const base={operationId:1,operation:'choose-import',phase:'importing',elapsedMs:10,active:true,waitingLong:false};
  ipc.emit('fundsift:operation-status',{}, {...base,progress:{writtenRows:1,totalRows:2,path:'private',percentage:50}});
  assert.equal(seen[0].progress.writtenRows,1); assert.equal(seen[0].progress.path,undefined); assert.equal(seen[0].progress.percentage,undefined);
  ipc.emit('fundsift:operation-status',{}, {...base,progress:{writtenRows:3,totalRows:2}});
  assert.equal(seen.length,1);
});

test('主进程导入原生选择取消不入库，币种确认后才传内部路径，跨案请求不弹窗', async () => {
  const handlers = new Map(), calls = [], dialogs = [], app = new EventEmitter();
  const workspacePath = path.resolve('synthetic-desktop-data');
  Object.assign(app,{setName(){},requestSingleInstanceLock:()=>true,getPath:()=>path.resolve('synthetic-profile'),
    whenReady:()=>Promise.resolve(),quit(){}});
  let window, choice = {canceled:true,filePaths:[]}, confirm = 1, format = 0;
  class FakeWorker {
    constructor() {}
    async request(method,...args) {
      calls.push([method,...args]);
      if(method==='openWorkspace') return {cases:[{id:'case',available:true}],workspacePath};
      if(method==='openCase') return {id:'case'};
      if(method==='importFile') return {receipt:{state:'completed',importedRows:1}};
      return {};
    }
    async close(){}
  }
  class FakeWindow extends EventEmitter {
    constructor(){super();window=this;this.webContents=new EventEmitter();Object.assign(this.webContents,{
      mainFrame:{url:require('node:url').pathToFileURL(path.resolve(__dirname,'../../prototype/index.html')).href},
      isDestroyed:()=>false,send(){},setWindowOpenHandler(){}});}
    removeMenu(){} async loadFile(){}
  }
  const electron={app,BrowserWindow:FakeWindow,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},
    dialog:{async showOpenDialog(_win,options){dialogs.push(options);return choice;},
      async showMessageBox(_win,options){dialogs.push(options);return {response:options.title==='选择材料格式（技术预览）'?format:confirm};}},
    session:{defaultSession:{setPermissionRequestHandler(){},webRequest:{onHeadersReceived(){}}}}};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../main.cjs'),'utf8'),{
    __dirname:path.resolve(__dirname,'..'),process:{env:{}},
    require:name=>name==='electron'?electron:name==='./worker-client.cjs'?{WorkerClient:FakeWorker}:
      name==='node:fs/promises'?{async readFile(){return JSON.stringify({version:1,workspacePath,currentCaseId:'case'});}}:
      require(name.startsWith('./')?path.resolve(__dirname,'..',name):name)
  });
  await new Promise(resolve=>setImmediate(resolve));
  const event={sender:window.webContents,senderFrame:window.webContents.mainFrame};
  await handlers.get('fundsift:get-state')(event);
  const importHandler=handlers.get('fundsift:choose-import');
  assert.equal((await importHandler(event,'other')).error.code,'FS_CASE_CONTEXT');assert.equal(dialogs.length,0);
  format=3;assert.equal((await importHandler(event,'case')).data.cancelled,true);format=0;
  assert.equal((await importHandler(event,'case')).data.cancelled,true);
  assert.equal(calls.filter(([m])=>m==='importFile').length,0);
  choice={filePaths:[path.resolve('synthetic.csv')]};
  assert.equal((await importHandler(event,'case')).data.cancelled,true);
  assert.equal(calls.filter(([m])=>m==='importFile').length,0);
  confirm=0;
  const result=await importHandler(event,'case');assert.equal(result.ok,true);assert.equal(result.data.receipt.importedRows,1);
  const imported=calls.find(([m])=>m==='importFile');assert.equal(imported[1],'case');assert.equal(imported[2].confirmedCny,true);
  assert.equal(imported[2].formatKey,'alipay-account-17col-v1');
  assert.equal(imported[2].filePath,choice.filePaths[0]);assert.equal(imported[2].rule,undefined);
  const confirmation=dialogs.find(d=>d.title==='确认本次材料与处理范围');
  assert.equal(confirmation.defaultId,1);assert.ok(confirmation.detail.includes('完整G0尚未完成'));
  format=1;await importHandler(event,'case');format=2;await importHandler(event,'case');
  const imports=calls.filter(([m])=>m==='importFile');
  assert.equal(imports[1][2].formatKey,'wechat-trades-27col-v1');assert.equal(imports[1][2].confirmedCny,true);
  assert.equal(imports[2][2].formatKey,'ccb-account-32col-v1');assert.equal(imports[2][2].confirmedCny,false);
});
