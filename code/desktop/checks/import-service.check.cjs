'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {WorkspaceStore}=require('../storage.cjs');
const {importAlipayAccount,retryFailedImport,readFlowSource,recoverInterruptedImports,PARSER_VERSION}=require('../import-service.cjs');
const {ArchiveStore}=require('../archive-store.cjs');
const {HEADERS,FORMAT_KEY}=require('../alipay-account.cjs');
const {queryFlowPage}=require('../flow-query.cjs');
const schemaPath=path.resolve(__dirname,'../../ddl_extract_check.sql');
function rule(extra={}) {
  return {platform:'支付宝合成',format_key:FORMAT_KEY,rule_version:1,config_version:1,amount_expr:'E',source_unit:'元',unit_scale:100,
    rounding_rule:'ROUND_HALF_UP',direction_map:{收入:'进',支出:'出'},negative_policy:'pending',zero_policy:'pending',zero_direction:null,
    currency_policy:'verified_cny',currency_map:{},balance_scope:'unknown',balance_same_direction:true,reversal_note:'合成边界保守待核',
    review:{status:'approved',by:'合成批准人',at:'2026-11-18',reason:'仅合成测试批准'},...extra};
}
function policy(extra={}) {return {timeColumn:'付款时间',accountIdentityPolicy:'raw_platform_info',businessStatusPolicy:'exact_v1',
  review:{status:'approved',by:'合成批准人',at:'2026-11-18',reason:'仅合成测试批准'},...extra};}
function values(extra={}) {
  const row=['\t000000000000000001','order','2026-01-01 01:02:03','2026-02-28 12:34:56','2026-03-01 01:02:03',
    'source','type','\t0000000000000001(合成身份)','\t0000000000000002(合成对手)','名称,\"引号\"\r\n第二行','1.005','支出','转账成功','方式','clear','备注','协查'];
  for(const [key,value]of Object.entries(extra))row[Number(key)]=value;
  return row;
}
function bytes(rows=[values()],headers=HEADERS) {
  const csv=[headers,...rows].map(row=>row.map(value=>/[",\r\n]/.test(value)?'"'+value.replaceAll('"','""')+'"':value).join(',')).join('\r\n')+'\r\n';
  return Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(csv)]);
}
async function fixture(t,rows=[values()]) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fundsift-import-')),store=new WorkspaceStore({schemaPath});
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  await store.openWorkspace(root);const made=await store.createCase({name:'合成导入案件',number:'IMPORT'});
  const record=store.catalog.prepare('SELECT * FROM workspace_case WHERE id=?').get(made.id);
  const caseDirectory=path.join(root,'cases',made.id),filePath=path.join(root,'synthetic.csv');fs.writeFileSync(filePath,bytes(rows));
  return {root,store,db:store.caseDb,record,caseDirectory,filePath,options:{db:store.caseDb,record,caseDirectory,filePath,rule:rule(),policy:policy()}};
}

test('合成真实链路：归档→规则冻结→分块写入→发布→分页→按逻辑坐标回源',async t=>{
  const first=values(),f=await fixture(t,[first]);
  const result=await importAlipayAccount(f.options);
  assert.equal(result.state,'completed');assert.equal(result.parserVersion,PARSER_VERSION);assert.equal(result.importedRows,1);assert.equal(result.pendingRows,0);
  const rows=queryFlowPage(f.db,{caseId:f.record.id}).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].amount,'-101');assert.equal(rows[0].currency,'CNY');
  assert.equal(rows[0].acct_no,first[7]);assert.equal(rows[0].peer_acct,null);assert.equal(rows[0].peer_name,null);
  assert.deepEqual(JSON.parse(rows[0].raw_record).values,first);
  const source=await readFlowSource({...f.options,flowId:rows[0].id});
  assert.deepEqual(source.values,first);assert.equal(source.sourceLoc,'2');
  assert.equal(f.db.prepare('SELECT frozen FROM format_rule').get().frozen,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM archive_entry').get().n,1);
  assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
});

test('未批准规则/业务口径不动DB或归档，不借技术预览自动批准',async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>importAlipayAccount({...f.options,rule:rule({review:{status:'unreviewed',by:null,at:null,reason:null}})}),{code:'FS_IMPORT_APPROVAL'});
  await assert.rejects(()=>importAlipayAccount({...f.options,policy:policy({review:{status:'unreviewed'}})}),{code:'FS_IMPORT_APPROVAL'});
  assert.equal(f.db.prepare('SELECT count(*) n FROM source_file').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM format_rule').get().n,0);
  assert.equal(fs.existsSync(path.join(f.caseDirectory,'archive/.journal')),false);
});

test('异常行保留且多原因待核，金额未知/零/负数/关闭/缺时间不混入confirmed',async t=>{
  const f=await fixture(t,[values(),values({10:'N/A',3:''}),values({10:'0'}),values({10:'-1.00'}),values({12:'交易中途关闭（未完成）'}),values({7:''})]);
  const result=await importAlipayAccount(f.options);
  assert.equal(result.importedRows,6);assert.equal(result.pendingRows,5);assert.equal(result.unquantifiableRows,2);
  const pending=queryFlowPage(f.db,{caseId:f.record.id,filters:{status:'pending'}});
  assert.equal(pending.total,'5');assert.ok(pending.rows.every(row=>row.pendingReasons.length>0));
  const unknown=pending.rows.find(row=>row.raw_amount_text==='N/A');assert.equal(unknown.amount,null);
  assert.ok(unknown.pendingReasons.some(reason=>reason.reason_code==='amount_unparseable'));
  assert.ok(!unknown.pendingReasons.some(reason=>reason.reason_code==='amount_missing'));
  assert.ok(unknown.pendingReasons.some(reason=>reason.reason_code==='time_missing'));
});

test('同hash默认拒绝，不增加batch；显式重导复用source/archive、旧批次保留而不叠加',async t=>{
  const f=await fixture(t);const first=await importAlipayAccount(f.options);
  await assert.rejects(()=>importAlipayAccount(f.options),{code:'FS_IMPORT_DUPLICATE'});
  assert.equal(f.db.prepare('SELECT count(*) n FROM import_batch').get().n,1);
  const second=await importAlipayAccount({...f.options,reimport:true});
  assert.notEqual(first.batchId,second.batchId);assert.equal(first.sourceFileId,second.sourceFileId);
  assert.equal(f.db.prepare('SELECT count(*) n FROM archive_entry').get().n,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM fund_flow').get().n,2);
  assert.equal(queryFlowPage(f.db,{caseId:f.record.id}).total,'1');
  assert.equal(f.db.prepare('SELECT current_batch_id FROM source_file').get().current_batch_id,second.batchId);
  assert.equal(f.db.prepare('SELECT archive_entry_id FROM import_batch WHERE id=?').get(first.batchId).archive_entry_id,
    f.db.prepare('SELECT archive_entry_id FROM import_batch WHERE id=?').get(second.batchId).archive_entry_id);
});

test('重新导入取消保留旧current，已写块未发布，failed回执及原因冻结',async t=>{
  const f=await fixture(t,Array.from({length:501},(_,i)=>values({0:String(i)})));
  const first=await importAlipayAccount(f.options),controller=new AbortController();
  await assert.rejects(()=>importAlipayAccount({...f.options,reimport:true,signal:controller.signal,
    onProgress:event=>{if(event.phase==='importing'&&event.writtenRows===250)controller.abort();}}),{code:'FS_USER_CANCELLED'});
  assert.equal(f.db.prepare('SELECT current_batch_id FROM source_file').get().current_batch_id,first.batchId);
  const failed=f.db.prepare('SELECT * FROM import_batch ORDER BY id DESC LIMIT 1').get();
  assert.equal(failed.status,'failed');assert.equal(failed.imported_rows,250);assert.equal(failed.cancelled_rows,251);
  assert.equal(failed.error_code,'FS_USER_CANCELLED');assert.equal(failed.cancel_reason,'用户取消');
  assert.equal(queryFlowPage(f.db,{caseId:f.record.id}).total,'501');
  await assert.rejects(()=>retryFailedImport({...f.options,sourceFileId:String(first.sourceFileId)}),{code:'FS_IMPORT_RETRY_STATE'});
  assert.equal(f.db.prepare('SELECT count(*) n FROM import_batch').get().n,2);
  assert.throws(()=>f.db.exec("UPDATE import_batch SET notes='rewrite' WHERE id="+failed.id));
});

test('结构错误记录failed及错误码，不发布空成功；有效旧材料仍可查询',async t=>{
  const f=await fixture(t);await importAlipayAccount(f.options);
  const malformed=path.join(f.root,'bad.csv');fs.writeFileSync(malformed,bytes([values()],[...HEADERS].reverse()));
  await assert.rejects(()=>importAlipayAccount({...f.options,filePath:malformed}),{code:'FS_FORMAT_UNSUPPORTED'});
  const bad=f.db.prepare('SELECT * FROM import_batch ORDER BY id DESC LIMIT 1').get();
  assert.equal(bad.status,'failed');assert.equal(bad.error_code,'FS_FORMAT_UNSUPPORTED');assert.equal(bad.imported_rows,0);
  assert.equal(queryFlowPage(f.db,{caseId:f.record.id}).total,'1');
  assert.equal(f.db.prepare('SELECT current_batch_id FROM source_file WHERE id=?').get(bad.source_file_id).current_batch_id,null);
  await assert.rejects(()=>retryFailedImport({...f.options,sourceFileId:String(bad.source_file_id)}),
    error=>error.code==='FS_FORMAT_UNSUPPORTED' && error.receipt.sourceFileId===bad.source_file_id && error.receipt.batchId!==bad.id);
  assert.equal(f.db.prepare('SELECT count(*) n FROM import_batch WHERE source_file_id=?').get(bad.source_file_id).n,2);
  assert.equal(queryFlowPage(f.db,{caseId:f.record.id}).total,'1');
});

test('首批临时失败后从同一归档及冻结规则显式重试，保留失败历史和正向归档引用',async t=>{
  const f=await fixture(t),controller=new AbortController();
  let first;
  await assert.rejects(()=>importAlipayAccount({...f.options,signal:controller.signal,
    onProgress:event=>{if(event.phase==='parsing')controller.abort();}}),error=>{
    first=error.receipt;
    return error.code==='FS_USER_CANCELLED' && first.batchId===1;
  });
  const before=f.db.prepare('SELECT notes,archive_entry_id,status FROM import_batch WHERE id=?').get(first.batchId);
  const journals=fs.readdirSync(path.join(f.caseDirectory,'archive/.journal'));
  fs.unlinkSync(f.filePath);
  const retry=await retryFailedImport({...f.options,sourceFileId:String(first.sourceFileId)});
  assert.equal(retry.sourceFileId,first.sourceFileId);
  assert.equal(retry.importedRows,1);
  assert.deepEqual(f.db.prepare('SELECT notes,archive_entry_id,status FROM import_batch WHERE id=?').get(first.batchId),before);
  const published=f.db.prepare('SELECT notes,archive_entry_id,status FROM import_batch WHERE id=?').get(retry.batchId);
  assert.deepEqual(published,{...before,status:'done'});
  assert.deepEqual(fs.readdirSync(path.join(f.caseDirectory,'archive/.journal')),journals);
  assert.equal(queryFlowPage(f.db,{caseId:f.record.id}).total,'1');
  await assert.rejects(()=>retryFailedImport({...f.options,sourceFileId:String(first.sourceFileId)}),{code:'FS_IMPORT_RETRY_STATE'});
  assert.equal(f.db.prepare('SELECT count(*) n FROM import_batch').get().n,2);
});

test('规则版本冲突拒绝复写；新版本重新导入仍保持旧配置与批次policy快照',async t=>{
  const f=await fixture(t);const first=await importAlipayAccount(f.options);
  await assert.rejects(()=>importAlipayAccount({...f.options,reimport:true,rule:rule({currency_policy:'unverified'})}),{code:'FS_RULE_VERSION_CONFLICT'});
  const second=await importAlipayAccount({...f.options,reimport:true,rule:rule({rule_version:2,currency_policy:'unverified'})});
  assert.equal(second.pendingRows,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM format_rule_config').get().n,2);
  assert.equal(f.db.prepare('SELECT rule_version FROM fund_flow WHERE batch_id=?').get(first.batchId).rule_version,1);
  assert.equal(f.db.prepare('SELECT rule_version FROM fund_flow WHERE batch_id=?').get(second.batchId).rule_version,2);
  assert.equal(JSON.parse(f.db.prepare('SELECT notes FROM import_batch WHERE id=?').get(first.batchId).notes).policy.review.status,'approved');
});

test('归档被改后回源拒绝；解析后归档变化也在发布前复验挡下',async t=>{
  const f=await fixture(t,Array.from({length:251},(_,i)=>values({0:String(i)})));
  await assert.rejects(()=>importAlipayAccount({...f.options,onProgress:event=>{
    if(event.phase==='importing'&&event.writtenRows===250){const relative=f.db.prepare('SELECT final_relative_path FROM archive_entry').get().final_relative_path;fs.appendFileSync(path.join(f.caseDirectory,relative),'changed');}
  }}),{code:'FS_ARCHIVE_HASH'});
  assert.equal(f.db.prepare('SELECT current_batch_id FROM source_file').get().current_batch_id,null);
  const flow=f.db.prepare('SELECT id FROM fund_flow LIMIT 1').get();
  await assert.rejects(()=>readFlowSource({...f.options,flowId:flow.id}),{code:'FS_ARCHIVE_HASH'});
});

test('同案件并发导入拒绝，开始前取消不创建材料或批次',async t=>{
  const f=await fixture(t),controller=new AbortController();controller.abort();
  await assert.rejects(()=>importAlipayAccount({...f.options,signal:controller.signal}),{code:'FS_USER_CANCELLED'});
  assert.equal(f.db.prepare('SELECT count(*) n FROM import_batch').get().n,0);
  const running=importAlipayAccount(f.options);
  await assert.rejects(()=>importAlipayAccount(f.options),{code:'FS_IMPORT_BUSY'});
  await running;
});

test('中断重启只终止本服务可识别批次，保旧current/原文/归档；未知旧批次仅诊断',async t=>{
  const f=await fixture(t);const first=await importAlipayAccount(f.options);
  const {runCaseTransaction}=require('../hardening.cjs');
  const notes=f.db.prepare('SELECT notes FROM import_batch WHERE id=?').get(first.batchId).notes;
  runCaseTransaction(f.db,f.record,{sourceFileIds:[first.sourceFileId]},()=>{
    const archive=f.db.prepare('SELECT archive_entry_id FROM import_batch WHERE id=?').get(first.batchId).archive_entry_id;
    f.db.prepare(`INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status,archive_entry_id,notes)
      VALUES(2,1,?,'t',?,'importing',?,?)`).run(first.sourceFileId,PARSER_VERSION,archive,notes);
    f.db.prepare(`INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status) VALUES(3,1,?,'t','legacy-demo','pending')`).run(first.sourceFileId);
    f.db.exec(`INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,amount,direction,
      currency,currency_evidence,raw_record) SELECT case_id,2,source_file_id,format_rule_id,rule_version,source_loc,amount,direction,
      currency,currency_evidence,raw_record FROM fund_flow WHERE batch_id=1`);
  });
  const file=path.join(f.caseDirectory,'archive',fs.readdirSync(path.join(f.caseDirectory,'archive'))[0]);
  // A list refresh leaves interrupted work untouched. An explicit reopen
  // invokes recovery on the new connection, as production startup does.
  await f.store.listCases();
  assert.equal(f.db.prepare('SELECT status FROM import_batch WHERE id=2').get().status,'importing');
  await f.store.openCase(f.record.id);
  f.db=f.store.caseDb;
  const recovery=f.store.importRecovery;
  assert.equal(recovery.recovered.length,1);assert.equal(recovery.recovered[0].batchId,2);assert.equal(recovery.recovered[0].importedRows,1);
  assert.equal(recovery.diagnostics.length,1);assert.equal(recovery.diagnostics[0].batchId,3);
  assert.equal(f.db.prepare('SELECT status,error_code FROM import_batch WHERE id=2').get().error_code,'FS_IMPORT_INTERRUPTED');
  assert.equal(f.db.prepare('SELECT status FROM import_batch WHERE id=3').get().status,'pending');
  assert.equal(f.db.prepare('SELECT current_batch_id FROM source_file').get().current_batch_id,first.batchId);
  assert.equal(queryFlowPage(f.db,{caseId:f.record.id}).total,'1');
  assert.equal(f.db.prepare('SELECT count(*) n FROM fund_flow').get().n,2);assert.ok(recovery.archive.length>0);assert.ok(fs.existsSync(file));
});

test('重开后原文和生成时解释仍可回源，source旧大小为空使用批次归档大小核验',async t=>{
  const first=values(),f=await fixture(t,[first]);await importAlipayAccount(f.options);
  const before=f.db.prepare('SELECT id,raw_record FROM fund_flow').get();
  const saved=JSON.parse(before.raw_record).derivation;
  assert.equal(saved.money.amount_expr,'E');assert.equal(saved.time_column,'付款时间');
  assert.equal(saved.account_identity_policy,'raw_platform_info');assert.equal(saved.business_status_policy,'exact_v1');
  const {runCaseTransaction}=require('../hardening.cjs');
  runCaseTransaction(f.db,f.record,{sourceFileIds:[1]},()=>f.db.exec('UPDATE source_file SET file_size=NULL WHERE id=1'));
  f.store.close();await f.store.openWorkspace(f.root);const db=f.store.caseDb;
  assert.ok(db);assert.equal(db.prepare('SELECT raw_record FROM fund_flow WHERE id=?').get(before.id).raw_record,before.raw_record);
  const read=await readFlowSource({...f.options,db,flowId:before.id});
  assert.deepEqual(read.values,first);assert.deepEqual(read.savedDerivation,saved);
});

test('空案恢复无归档journal时不新增文件夹',async t=>{
  const f=await fixture(t);const initial=fs.readdirSync(path.join(f.caseDirectory,'archive'));
  const result=recoverInterruptedImports(f.options);
  assert.deepEqual(result,{recovered:[],diagnostics:[],archive:[],stagingCleanup:{removed:0,warnings:0}});
  assert.deepEqual(fs.readdirSync(path.join(f.caseDirectory,'archive')),initial);
});

test('打开案件只清超期且无引用的有效暂存，保留失效日志及材料归档',async t=>{
  const f=await fixture(t);
  const imported=await importAlipayAccount(f.options);
  const archive=new ArchiveStore(f.caseDirectory);
  const linked=archive.inspectRecovery()[0];
  const eligible=await archive.stage(f.filePath);
  const recent=await archive.stage(f.filePath);
  const damaged=await archive.stage(f.filePath);
  const active=await archive.stage(f.filePath);
  const journal=entry=>path.join(f.caseDirectory,'archive/.journal',entry.taskId+'.json');
  const staging=entry=>path.join(f.caseDirectory,entry.stagingRelativePath);
  for (const entry of [linked,eligible,recent,damaged,active]) {
    const saved=JSON.parse(fs.readFileSync(journal(entry),'utf8'));
    fs.writeFileSync(staging(entry),'合成未完成暂存');
    fs.writeFileSync(journal(entry),JSON.stringify({...saved,state:'failed',
      createdAt:entry===recent?new Date().toISOString():'2020-01-01T00:00:00.000Z'}));
  }
  fs.writeFileSync(journal(damaged),'{"broken":');
  fs.writeFileSync(journal(eligible)+'.new','合成中断日志');
  const {runCaseTransaction}=require('../hardening.cjs');
  runCaseTransaction(f.db,f.record,{sourceFileIds:[imported.sourceFileId]},()=>{
    f.db.prepare(`INSERT INTO import_batch(case_id,source_file_id,started_at,parser_version,status,notes)
      VALUES(1,?,'t','legacy-demo','pending',?)`).run(imported.sourceFileId,JSON.stringify({archiveTaskId:active.taskId}));
  });
  await f.store.listCases();
  assert.ok(fs.existsSync(staging(eligible)));
  const before=f.db.prepare('SELECT data_version FROM case_data_state').get().data_version;
  const opened=await f.store.openCase(f.record.id);
  assert.deepEqual(opened.stagingCleanup,{removed:1,warnings:1});
  assert.equal(fs.existsSync(staging(eligible)),false);
  assert.equal(fs.existsSync(journal(eligible)+'.new'),false);
  assert.equal(JSON.parse(fs.readFileSync(journal(eligible),'utf8')).state,'staging_cleaned');
  assert.ok([linked,recent,damaged,active].every(entry=>fs.existsSync(staging(entry)) && fs.existsSync(journal(entry))));
  assert.equal(fs.readFileSync(journal(damaged),'utf8'),'{"broken":');
  assert.deepEqual(fs.readFileSync(path.join(f.caseDirectory,linked.finalRelativePath)),fs.readFileSync(f.filePath));
  assert.equal(f.store.caseDb.prepare('SELECT current_batch_id FROM source_file').get().current_batch_id,imported.batchId);
  assert.equal(f.store.caseDb.prepare('SELECT data_version FROM case_data_state').get().data_version,before);
  assert.deepEqual((await f.store.openCase(f.record.id)).stagingCleanup,{removed:0,warnings:1});
});

test('重导新版规则中断按批次固定规则恢复250已写与0行批次，不依赖source旧规则指针',async t=>{
  const f=await fixture(t,Array.from({length:501},(_,i)=>values({0:String(i)})));
  const first=await importAlipayAccount(f.options);
  const {runCaseIntegrityTransaction,runCaseTransaction}=require('../hardening.cjs');
  const {registerRuleConfig,canonicalJSON}=require('../foundation.cjs');
  const newRule=rule({rule_version:2}),{platform,format_key,rule_version,...config}=newRule;
  let registered;
  runCaseIntegrityTransaction(f.db,f.record,()=>{
    f.db.prepare(`INSERT INTO format_rule(id,platform,format_key,rule_version,amount_expr,direction_source,source_unit,unit_scale,
      rounding_rule,balance_scope) VALUES(2,?,?,2,'E','direction_col','元',100,'ROUND_HALF_UP','unknown')`).run(platform,format_key);
    registered=registerRuleConfig(f.db,{rule_id:2,rule_version:2,config});
  });
  const old=f.db.prepare('SELECT * FROM import_batch WHERE id=?').get(first.batchId),notes=JSON.parse(old.notes);
  Object.assign(notes,{rule_id:2,rule_version:2,config_sha256:registered.config_sha256});
  runCaseTransaction(f.db,f.record,{sourceFileIds:[first.sourceFileId]},()=>{
    for(const batch of [2,3])f.db.prepare(`INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status,
      archive_entry_id,notes,total_rows) VALUES(?,1,?,'t',?,'importing',?,?,501)`).run(batch,first.sourceFileId,PARSER_VERSION,old.archive_entry_id,canonicalJSON(notes));
    f.db.exec(`INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,amount,direction,
      currency,currency_evidence,raw_record) SELECT case_id,2,source_file_id,2,2,source_loc,amount,direction,
      currency,currency_evidence,raw_record FROM fund_flow WHERE batch_id=1 ORDER BY id LIMIT 250`);
  });
  assert.equal(f.db.prepare('SELECT format_rule_id FROM source_file').get().format_rule_id,1);
  const result=recoverInterruptedImports(f.options);
  assert.deepEqual(result.recovered.map(item=>[item.batchId,item.importedRows]),[[2,250],[3,0]]);
  assert.deepEqual(result.diagnostics,[]);
  assert.equal(f.db.prepare('SELECT current_batch_id FROM source_file').get().current_batch_id,first.batchId);
});
