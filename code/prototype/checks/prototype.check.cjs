/* Offline DOM integration checks. No browser, navigation, or original case data.
 * Run with jsdom available in NODE_PATH: node checks/prototype.check.cjs
 */
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
let passed=0;
const verify=(condition,message)=>{assert.ok(condition,message);passed++;};
function setup(mutateSeed){
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,url:'https://fundsift.example/'});
  const w=dom.window;w.TextEncoder=TextEncoder;w.Blob=Blob;
  for(const file of ['icons.js','data.js','exporter.js'])w.eval(fs.readFileSync(path.join(root,file),'utf8'));
  if(mutateSeed)mutateSeed(w.FUND_DATA);
  w.eval(fs.readFileSync(path.join(root,'app.js'),'utf8'));
  w.eval(fs.readFileSync(path.join(root,'intro.js'),'utf8'));
  w.FUND_INTRO.enter();
  const $=s=>w.document.querySelector(s),$$=s=>[...w.document.querySelectorAll(s)];
  const click=s=>{const el=$(s);assert.ok(el,'Missing '+s);el.click();};
  const input=(s,value)=>{const el=$(s);assert.ok(el,'Missing '+s);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));};
  const change=(s,value)=>{const el=$(s);assert.ok(el,'Missing '+s);if(el.type==='checkbox')el.checked=!!value;else el.value=value;el.dispatchEvent(new w.Event('change',{bubbles:true}));};
  const action=(name,extra='')=>click(`[data-action="${name}"]${extra}`);
  const nav=r=>click(`#sidebar [data-route="${r}"]`);
  return {dom,w,$,$$,click,input,change,action,nav};
}
async function main(){
  let t=setup();
  verify(t.$('#main h1').textContent==='案件工作台','Home opens');
  verify(t.$$('.case-table tbody tr').length===4,'Four synthetic cases');
  verify(t.$$('.summary-number').map(e=>e.textContent.trim()).join('|')==='4个|14份|55条|6条','All homepage metrics match records');
  for(const route of ['materials','flows','review','exports','home']){t.nav(route);verify(t.$('#main h1').textContent===({materials:'材料管理',flows:'并表流水',review:'异常复核',exports:'结果导出',home:'案件工作台'})[route],route+' page renders');}
  t.input('#case-query','恒舟');verify(t.$$('.case-table tbody tr').length===1,'Case search');
  t.input('#case-query','不存在');verify(t.$$('.case-table tbody tr').length===0&&!!t.$('.empty-state'),'Case empty state');
  t.input('#case-query','');t.action('case-tab','[data-value="archived"]');verify(t.$$('.case-table tbody tr').length===1,'Archived case filter');
  t.action('case-tab','[data-value="all"]');
  const composingInput=t.$('#case-query');composingInput.focus();composingInput.dispatchEvent(new t.w.CompositionEvent('compositionstart',{bubbles:true}));composingInput.value='恒舟';composingInput.dispatchEvent(new t.w.InputEvent('input',{bubbles:true,isComposing:true}));
  verify(t.$('#case-query')===composingInput,'Chinese composition does not replace input');composingInput.dispatchEvent(new t.w.CompositionEvent('compositionend',{bubbles:true}));verify(t.$$('.case-table tbody tr').length===1,'Chinese search applies after composition ends');t.input('#case-query','');
  t.action('task','[data-kind="files"]');verify(t.$$('.data-table tbody tr').length===2&&!!t.$('.status.error'),'Material task includes failed and pending files');
  t.nav('flows');verify(t.$$('.ledger-table tbody tr').length===15,'Ledger pagination limits rows');
  t.action('page','[data-value="2"]');verify(t.$('.row-index').textContent==='16','Second page starts at row 16');
  t.change('#flow-platform','微信支付');verify(t.$$('.ledger-table tbody tr').length===10,'Platform filters actual records');
  t.action('refresh-flows');t.action('flow-tab','[data-value="pending"]');verify(t.$$('.ledger-table tbody tr').length===4,'Pending filter count');
  verify(t.$$('.ledger-table tbody tr td:nth-child(7)').every(e=>e.textContent==='—'),'Pending is blank amount, not zero');
  t.change('#select-page',true);verify(t.$('.ledger-bottom').textContent.includes('已选 4 条'),'Select-page updates selection');
  t.$('#select-page').focus();t.change('#select-page',false);verify(t.w.document.activeElement.id==='select-page','Checkbox focus survives render');
  t.action('refresh-flows');t.input('#flow-query','退款');verify(t.$$('.ledger-table tbody tr').length>0,'Ledger summary search');
  t.action('inspect');verify(!!t.$('.inspector'),'Ledger inspector opens');verify(t.w.document.activeElement.dataset.action==='close-inspector','Inspector receives keyboard focus');
  t.action('source');verify(!!t.$('.source-preview-table .highlight'),'Source row highlighted');t.action('close-modal');
  t.action('close-inspector');t.action('filters');t.change('#date-from','2026-11-01');t.change('#date-to','2026-10-01');t.action('apply-filters');verify(t.$('#form-error').textContent.length>0,'Reversed date range blocked');t.action('close-modal');
  t.action('global-search');t.input('#global-query','南岭');verify(t.$$('.search-result').length>=1,'Global case search');t.action('search-case');verify(t.$('.page-sub').textContent.includes('南岭'),'Search switches correct case');
  t.action('switch-case');t.action('choose-case','[data-id="case-1"]');
  t.nav('review');verify(t.$$('.issue-item').length===6,'Pending and balance queue');
  t.action('select-issue','[data-id="flow-006"]');t.action('confirm-amount');t.action('save-amount');verify(t.$('#form-error').textContent.length>0,'Review requires explicit direction and basis');
  t.change('#review-direction','expense');t.input('#review-amount','12.345');t.input('#review-reason','已核对合成来源');t.action('save-amount');verify(!!t.$('.modal'),'More than two decimals rejected');
  t.input('#review-amount','25000.00');t.action('save-amount');verify(t.$$('.issue-item').length===5,'Amount confirmation removes one queue entry');
  t.nav('flows');t.input('#flow-query','设备预付款');t.action('inspect','[data-id="flow-006"]');verify(t.$('.detail-rule').textContent.includes('-25,000.00'),'Confirmation uses integer cents and chosen direction');
  t.action('source');verify(t.$('.highlight').textContent.includes('25000.00'),'Confirmation preserves original amount');t.action('close-modal');
  t.nav('review');t.action('review-tab','[data-value="balance"]');t.action('select-issue','[data-id="flow-017"]');const before=t.$('.compare-side+div .compare-amount').textContent;
  t.action('accept-balance');t.action('save-balance');verify(!!t.$('#form-error').textContent,'Balance acceptance requires basis');t.input('#balance-reason','合成样例：已检查缺失记录');t.action('save-balance');verify(t.$$('.issue-item').length===1,'Balance acceptance removes only one balance issue');
  t.nav('flows');t.action('refresh-flows');t.input('#flow-query','日常采购');t.action('inspect','[data-id="flow-017"]');verify(t.$('.detail-rule .result').textContent.replace(/\s*元/,'').trim()===before,'Accepting balance keeps signed amount');verify(t.$('.inspector-body').textContent.includes('已接受差异'),'Balance manual status visible');
  t.nav('materials');t.action('file-detail','[data-id="file-1"]');t.action('file-flows');verify(t.$('.quiet-note').textContent.includes('建设银行_基本户'),'File opens correctly filtered ledger');
  t.nav('materials');t.action('demo-import');t.action('add-demo');verify(t.$$('.ledger-table tbody tr').length===3,'Demo import adds three traceable records');t.action('inspect');t.action('source');verify(t.$('.source-preview-table').textContent.includes('记录'),'New source preview works');t.action('close-modal');
  t.nav('materials');const file=new t.w.File(['测试内容'],'自选文件.csv',{type:'text/csv'});Object.defineProperty(t.$('#file-picker'),'files',{configurable:true,value:[file]});t.$('#file-picker').dispatchEvent(new t.w.Event('change',{bubbles:true}));verify(t.$('.modal-body').textContent.includes('不读取文件内容'),'Real file boundary explicit');t.action('register-files');verify(t.$('.data-table tbody').textContent.includes('自选文件.csv'),'File metadata registered pending');
  t.nav('home');t.action('new-case');t.action('save-case');verify(t.$('#form-error').textContent.length>0,'New case requires name and number');t.input('#new-name','新案件');t.input('#new-number','DQ-2026-018');t.action('save-case');verify(t.$('#form-error').textContent.includes('已存在'),'Duplicate case number blocked');
  t.input('#new-name','<img src=x onerror=alert(1)>');t.input('#new-number','DEMO-NEW');t.action('save-case');verify(!t.$('#application img'),'Case name escaped instead of HTML');verify(t.$('#main h1').textContent==='材料管理'&&!!t.$('.empty-state'),'New case has empty materials');
  t.action('switch-case');t.action('choose-case','[data-id="case-2"]');verify(t.$('.data-table tbody').textContent.includes('货款往来'),'Case switching isolates file list');
  t.dom.window.close();
  // Use an untouched session for exported totals, and capture actual Blob bytes.
  t=setup();t.nav('exports');const downloads=[];t.w.FUND_EXPORT.download=(blob,name)=>downloads.push({blob,name});
  t.action('do-export');verify(downloads.length===1&&downloads[0].name.endsWith('.xlsx'),'Export generates actual XLSX Blob');verify(t.$$('.data-table tbody tr').length===2,'Export adds history entry');
  const out=process.env.FUND_CHECK_OUTPUT||path.join(require('node:os').tmpdir(),'fundsift-prototype-check');fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'prototype-export.xlsx'),Buffer.from(await downloads[0].blob.arrayBuffer()));
  t.$('#export-scope-pending').focus();t.change('[name="export-scope"][value="pending"]','pending');verify(t.$('.export-summary').textContent.includes('4'),'Pending scope has four rows');verify(t.w.document.activeElement.id==='export-scope-pending','Radio focus survives render');
  t.change('[name="export-format"][value="csv"]','csv');t.action('do-export');fs.writeFileSync(path.join(out,'prototype-pending.csv'),Buffer.from(await downloads[1].blob.arrayBuffer()));verify(downloads[1].name.endsWith('.csv'),'CSV alternative downloads');
  t.action('download-history');verify(downloads.length===3,'Export history regenerates download');
  const original=t.w.FUND_DATA;verify(original.flows.length===55&&original.files.length===14,'Seed dataset not mutated by demo session');
  t.dom.window.close();
  // One record can carry independent amount and balance concerns.
  t=setup(seed=>{const r=seed.flows.find(r=>r.id==='flow-006');r.balanceStatus='fail';r.balance=100;r.previousBalance=100;});
  t.nav('review');t.action('select-issue','[data-id="flow-006"]');t.action('confirm-amount');t.change('#review-direction','expense');t.input('#review-amount','2.50');t.input('#review-reason','金额核对依据');t.action('save-amount');
  verify(!!t.$('[data-action="select-issue"][data-id="flow-006"]'),'Confirming amount retains existing balance issue');
  t.action('select-issue','[data-id="flow-006"]');verify(t.$('.review-detail-title').textContent.includes('余额'),'Remaining issue is balance only');
  t.action('accept-balance');t.input('#balance-reason','余额差异依据');t.action('save-balance');
  t.nav('exports');let csv;t.w.FUND_EXPORT.download=blob=>{csv=blob;};t.change('[name="export-format"][value="csv"]','csv');t.action('do-export');
  const text=await csv.text();verify(text.includes('金额核对依据')&&text.includes('余额差异依据'),'Amount and balance bases retained separately in export');
  t.dom.window.close();console.log('PASS: '+passed+' offline DOM assertions; export artifacts: '+out);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
