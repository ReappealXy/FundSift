'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { installCaseV2, validateCaseV1, readSummary, refreshSummary, beginCaseMutation,
  runCaseTransaction, runCaseIntegrityTransaction, withCaseReadSnapshot } = require('../hardening.cjs');
const ddl = fs.readFileSync(path.resolve(__dirname,'../../ddl_extract_check.sql'),'utf8');
const record = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', case_no:'SYN-1',case_name:'合成保护案件',
  created_at:'2020-01-01T00:00:00.000Z',updated_at:'2020-01-01T00:00:00.000Z' };

function fixture(t, { v1 = false, trace } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'fundsift-hardening-'));
  const file = path.join(directory,'case.sqlite');
  const db = new Database(file,trace ? { verbose: trace } : undefined);
  db.pragma('journal_mode=WAL'); db.pragma('foreign_keys=ON');
  db.exec(ddl);
  db.prepare('INSERT INTO case_info(id,case_no,case_name,created_at) VALUES(1,?,?,?)').run(record.case_no,record.case_name,record.created_at);
  db.exec('CREATE TABLE desktop_case_identity(id INTEGER PRIMARY KEY CHECK(id=1),case_uuid TEXT NOT NULL UNIQUE)');
  db.prepare('INSERT INTO desktop_case_identity VALUES(1,?)').run(record.id);
  if (!v1) db.transaction(() => installCaseV2(db,record))();
  t.after(() => { if (db.open) db.close(); fs.rmSync(directory,{ recursive:true,force:true }); });
  return { db,file };
}
function seed(db) {
  db.exec(`INSERT INTO format_rule(id,platform,format_key,amount_expr,source_unit,unit_scale,verified,frozen)
    VALUES(1,'synthetic','f0','A','元',100,0,0),(2,'synthetic','f1','A','元',100,1,1),(3,'synthetic','f2','A','元',100,2,1);
    INSERT INTO source_file(id,case_id,file_name,file_sha256) VALUES(1,1,'合成.csv','sha-1'),(2,1,'另一材料.csv','sha-2');
    INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version) VALUES(1,1,1,'t','v1'),(2,1,2,'t','v1');`);
}
const insertFlow = db => db.prepare(`INSERT INTO fund_flow(id,case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,
  amount,direction,status) VALUES(?,1,1,1,?,1,?,?,?,?)`);
function pendingReason(db,id,reason) {
  db.prepare("INSERT INTO pending_reason(fund_flow_id,reason_code,created_at) VALUES(?,?,'t')").run(id,reason);
}
function publish(db, { id=1, file=1, count=1, skipped=0 } = {}) {
  db.prepare("UPDATE import_batch SET status='done',total_rows=?,imported_rows=?,skipped_rows=? WHERE id=?").run(count+skipped,count,skipped,id);
  db.prepare("UPDATE source_file SET first_batch_id=coalesce(first_batch_id,?),current_batch_id=?,status='imported' WHERE id=?").run(id,id,file);
}
function chinese(error) { return /[\u3400-\u9fff]/.test(error.message); }

test('v1脏数据升级阻断且不改业务值；合法空案摘要为真实零', t => {
  const { db } = fixture(t,{v1:true});
  seed(db);
  db.exec("INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,amount,direction,status) VALUES(1,1,1,1,1,'1',0.5,'进','confirmed')");
  assert.throws(() => validateCaseV1(db,record),error => error.code==='FS_CASE_DATA' && chinese(error));
  assert.equal(db.prepare('SELECT amount FROM fund_flow').get().amount,0.5);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='case_summary'").get().n,0);
  db.exec('DELETE FROM fund_flow; DELETE FROM import_batch; DELETE FROM source_file');
  db.transaction(() => installCaseV2(db,record))();
  assert.deepEqual(readSummary(db,record).stats,{files:0,flows:0,pending:0});
  assert.equal(readSummary(db,record).updatedAt,record.updated_at);
});

test('金额类型和方向覆盖三种规则等级、NULL、零、更新与替换', t => {
  const { db } = fixture(t);
  db.transaction(() => { beginCaseMutation(db); seed(db); })();
  const add=insertFlow(db);
  let id=1;
  for(const rule of [1,2,3]) {
    for(const [amount,direction,status] of [[0.5,'进','confirmed'],['oops','进','confirmed'],[100,'出','confirmed'],[-100,'进','confirmed'],[100,null,'confirmed'],[-100,null,'confirmed'],[null,null,'confirmed']]) {
      assert.throws(() => add.run(id++,rule,String(id),amount,direction,status),chinese);
    }
    add.run(id++,rule,String(id),100,'进','confirmed');
    add.run(id++,rule,String(id),-100,'出','confirmed');
    add.run(id++,rule,String(id),0,null,'pending'); pendingReason(db,id-1,'amount_zero_rule_undefined');
    add.run(id++,rule,String(id),null,null,'pending'); pendingReason(db,id-1,'amount_unknown');
  }
  const existing=db.prepare("SELECT id FROM fund_flow WHERE status='confirmed' LIMIT 1").get().id;
  assert.throws(()=>db.prepare('UPDATE fund_flow SET amount=0.5 WHERE id=?').run(existing),chinese);
  assert.throws(()=>db.prepare("UPDATE fund_flow SET direction=NULL WHERE id=?").run(existing),chinese);
  assert.throws(()=>db.prepare(`INSERT OR REPLACE INTO fund_flow SELECT * FROM fund_flow WHERE id=?`).run(existing),chinese);
  assert.throws(()=>db.prepare(`INSERT INTO fund_flow(id,case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,amount,direction)
    VALUES(?,1,1,1,1,1,'upsert',100,'进') ON CONFLICT(id) DO UPDATE SET amount=0.5`).run(existing),chinese);
  // INTEGER affinity is explicit: these arrive as integer; source parsing remains M1.
  add.run(id++,1,String(id),'100','进','confirmed');
  assert.equal(db.prepare('SELECT typeof(amount) t FROM fund_flow ORDER BY id DESC LIMIT 1').get().t,'integer');
  assert.equal(validateCaseV1(db,record),true);
});

test('UUID与父身份保护在recursive_triggers开关下拒绝UPDATE DELETE REPLACE UPSERT', t => {
  const { db }=fixture(t);
  db.transaction(()=>{beginCaseMutation(db);seed(db);insertFlow(db).run(1,1,'1',100,'进','confirmed');})();
  for(const recursive of [0,1]) {
    db.pragma(`recursive_triggers=${recursive}`);
    for(const sql of [
      "UPDATE desktop_case_identity SET case_uuid='other'",'DELETE FROM desktop_case_identity',
      "INSERT OR REPLACE INTO desktop_case_identity VALUES(1,'other')",
      "INSERT INTO desktop_case_identity VALUES(1,'other') ON CONFLICT(id) DO UPDATE SET case_uuid='other'",
      "UPDATE case_info SET case_no='other'",'DELETE FROM case_info',
      "INSERT OR REPLACE INTO case_info(id,case_no,case_name,created_at) VALUES(1,'x','x','t')",
      "UPDATE source_file SET case_id=2 WHERE id=1","UPDATE source_file SET file_sha256='new' WHERE id=1",
      "UPDATE import_batch SET source_file_id=2 WHERE id=1",'DELETE FROM source_file WHERE id=1',
      'DELETE FROM import_batch WHERE id=1',
      "INSERT OR REPLACE INTO source_file(id,case_id,file_name,file_sha256) VALUES(1,1,'x','sha-new')",
      "INSERT OR REPLACE INTO import_batch(id,case_id,source_file_id,started_at,parser_version) VALUES(1,1,1,'t','v2')"
    ]) assert.throws(()=>db.exec(sql),chinese,sql);
  }
  assert.equal(db.prepare('SELECT case_uuid FROM desktop_case_identity').get().case_uuid,record.id);
});

test('跨材料批次错配、非法current/first及终止批次倒退均拒绝；业务可推进状态', t => {
  const { db }=fixture(t);
  db.transaction(()=>{beginCaseMutation(db);seed(db);})();
  for(const sql of [
    "INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version) VALUES(3,2,1,'t','v')",
    'UPDATE source_file SET current_batch_id=2 WHERE id=1',
    'UPDATE source_file SET first_batch_id=2 WHERE id=1',
    "INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,amount,direction) VALUES(1,2,1,1,1,'bad',100,'进')"
  ]) assert.throws(()=>db.exec(sql),chinese);
  db.exec("UPDATE import_batch SET status='parsing' WHERE id=1; UPDATE import_batch SET status='importing' WHERE id=1;");
  publish(db,{count:0});
  assert.throws(()=>db.exec("UPDATE import_batch SET status='failed' WHERE id=1"),chinese);
  assert.throws(()=>db.exec("UPDATE source_file SET first_batch_id=NULL WHERE id=1"),chinese);
  assert.throws(()=>db.exec('DELETE FROM import_batch WHERE id=1'),chinese);
});

test('业务事务共同提交摘要和更新时间，回滚保原结果，不逐行更新摘要', t => {
  const queries=[];
  const { db }=fixture(t,{trace: sql=>queries.push(sql)});
  runCaseIntegrityTransaction(db,record,()=>{
    seed(db); insertFlow(db).run(1,1,'1',100,'进','confirmed');
    db.exec('DELETE FROM import_batch WHERE id=2; DELETE FROM source_file WHERE id=2');
    publish(db);
  });
  const first=readSummary(db,record);
  assert.deepEqual(first.stats,{files:1,flows:1,pending:0});
  assert.notEqual(first.updatedAt,record.updated_at);
  const version=db.prepare('SELECT data_version FROM case_data_state').get().data_version;
  assert.throws(()=>runCaseIntegrityTransaction(db,record,()=>{
    db.exec("UPDATE fund_flow SET amount=200 WHERE id=1"); throw new Error('synthetic rollback');
  }),/synthetic rollback/);
  assert.deepEqual(readSummary(db,record),first);
  assert.equal(db.prepare('SELECT data_version FROM case_data_state').get().data_version,version);
  const flowTriggers=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='fund_flow'").all();
  assert.ok(flowTriggers.length>=3);
  assert.ok(flowTriggers.every(row=>!/UPDATE case_summary|UPDATE case_data_state/.test(row.sql)));
  queries.length=0; readSummary(db,record);
  assert.ok(!queries.some(sql=>/\bfund_flow\b/i.test(sql)),'list summary must never query the flow table');
  runCaseIntegrityTransaction(db,record,()=>{});
  assert.equal(readSummary(db,record).updatedAt,first.updatedAt,'an empty service transaction is not a business update');
  db.transaction(()=>refreshSummary(db,record))();
  assert.equal(readSummary(db,record).updatedAt,first.updatedAt);
});

test('绕过事务改流水被拒，低频元数据变更失效跨重启保留；未知摘要不填零', t => {
  const { db,file }=fixture(t);
  runCaseIntegrityTransaction(db,record,()=>{
    seed(db); insertFlow(db).run(1,1,'1',100,'进','confirmed');
    db.exec('DELETE FROM import_batch WHERE id=2; DELETE FROM source_file WHERE id=2'); publish(db);
  });
  assert.throws(()=>db.exec('UPDATE fund_flow SET amount=200 WHERE id=1'),chinese);
  const external=new Database(file); external.pragma('foreign_keys=ON');
  external.exec("UPDATE source_file SET file_name='改名.csv' WHERE id=1"); external.close();
  assert.equal(readSummary(db,record).summaryState,'stale');
  const reopened=new Database(file);
  assert.deepEqual(readSummary(reopened,record).stats,{files:null,flows:null,pending:null});
  reopened.close();
  db.transaction(()=>refreshSummary(db,record))();
  assert.equal(readSummary(db,record).summaryState,'ready');
  const old=readSummary(db,record).updatedAt;
  db.transaction(()=>{beginCaseMutation(db);db.exec('UPDATE fund_flow SET amount=200 WHERE id=1');})();
  assert.equal(readSummary(db,record).summaryState,'stale');
  assert.equal(readSummary(db,record).updatedAt,old);
});

test('未发布与合法空发布分开；重导失败保旧提示；坏指针诊断不挑历史', t => {
  const { db }=fixture(t);
  runCaseIntegrityTransaction(db,record,()=>{seed(db);});
  const unpublished=readSummary(db,record);
  assert.deepEqual(unpublished.stats,{files:2,flows:null,pending:null});
  assert.ok(unpublished.diagnostics.every(item=>item.code==='not_published'));
  runCaseIntegrityTransaction(db,record,()=>{publish(db,{count:0});publish(db,{id:2,file:2,count:0});});
  assert.deepEqual(readSummary(db,record).stats,{files:2,flows:0,pending:0});
  runCaseIntegrityTransaction(db,record,()=>{
    db.exec("INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status) VALUES(3,1,1,'later','v1','failed')");
  });
  const failed=readSummary(db,record);
  assert.equal(failed.stats.flows,0);
  assert.ok(failed.diagnostics.some(item=>item.code==='latest_import_failed'&&!item.blocking));
  // Damage simulator removes protection explicitly; production never repairs this automatically.
  db.exec('DROP TRIGGER v2_source_update');
  db.exec('UPDATE source_file SET current_batch_id=3 WHERE id=1');
  const diagnostic=readSummary(db,record,{diagnostics:true});
  assert.equal(diagnostic.stats.flows,null);
  assert.throws(()=>validateCaseV1(db,record),/合成.csv.*批次 3/);
  assert.equal(db.prepare('SELECT current_batch_id id FROM source_file WHERE id=1').get().id,3);
});

test('双原因逐项解除保持pending；余额检查不参与整行待核聚合', t => {
  const { db }=fixture(t);
  runCaseIntegrityTransaction(db,record,()=>{
    seed(db);insertFlow(db).run(1,2,'1',null,null,'pending');
    pendingReason(db,1,'amount_unknown'); pendingReason(db,1,'time_unknown');
    db.exec('DELETE FROM import_batch WHERE id=2; DELETE FROM source_file WHERE id=2');publish(db);
  });
  runCaseIntegrityTransaction(db,record,()=>{
    db.exec(`UPDATE fund_flow SET amount=100,direction='进' WHERE id=1;
      UPDATE pending_reason SET resolved_at='resolved',resolution_reason='人工核对' WHERE reason_code='amount_unknown';`);
  });
  assert.equal(readSummary(db,record).stats.pending,1);
  assert.throws(()=>runCaseIntegrityTransaction(db,record,()=>db.exec("UPDATE fund_flow SET status='confirmed' WHERE id=1")),/待核状态/);
  runCaseIntegrityTransaction(db,record,()=>{
    db.exec(`UPDATE pending_reason SET resolved_at='resolved',resolution_reason='人工核对' WHERE reason_code='time_unknown';
      UPDATE fund_flow SET status='confirmed' WHERE id=1;
      INSERT INTO balance_check_history(id,fund_flow_id,input_version,balance_scope,status,checked_at) VALUES(1,1,'v1','unknown','fail','t');
      INSERT INTO balance_check(fund_flow_id,current_history_id) VALUES(1,1);`);
  });
  assert.equal(readSummary(db,record).stats.pending,0);
});

test('一致读事务固定摘要与流水快照，外部提交不会混入读取', t => {
  const { db,file }=fixture(t);
  runCaseIntegrityTransaction(db,record,()=>{
    seed(db);insertFlow(db).run(1,2,'1',100,'进','confirmed');
    db.exec('DELETE FROM import_batch WHERE id=2; DELETE FROM source_file WHERE id=2');publish(db);
  });
  const writer=new Database(file);writer.pragma('foreign_keys=ON');
  const values=withCaseReadSnapshot(db,()=>{
    const summary=readSummary(db,record);
    runCaseIntegrityTransaction(writer,record,()=>writer.exec('UPDATE fund_flow SET amount=200 WHERE id=1'));
    return { summary,amount:db.prepare('SELECT amount FROM fund_flow WHERE id=1').get().amount };
  });
  writer.close();
  assert.equal(values.summary.stats.flows,1);assert.equal(values.amount,100);
  assert.equal(db.prepare('SELECT amount FROM fund_flow WHERE id=1').get().amount,200);
});

test('三条合法待核可完整发布；64位整数金额不另设业务上限', t => {
  const { db }=fixture(t);
  runCaseIntegrityTransaction(db,record,()=>{
    seed(db);
    const add=insertFlow(db);
    add.run(1,1,'1',null,null,'pending');pendingReason(db,1,'time_unknown');
    add.run(2,2,'2',0,null,'pending');pendingReason(db,2,'amount_zero_rule_undefined');
    add.run(3,3,'3',null,null,'pending');pendingReason(db,3,'unknown_vocabulary');
    add.run(4,2,'4',9223372036854775807n,'进','confirmed');
    add.run(5,3,'5',-9223372036854775808n,'出','confirmed');
    db.exec('DELETE FROM import_batch WHERE id=2; DELETE FROM source_file WHERE id=2');
    publish(db,{count:5});
  });
  assert.deepEqual(readSummary(db,record).stats,{files:1,flows:5,pending:3});
  const money=db.prepare('SELECT amount FROM fund_flow WHERE id IN (4,5) ORDER BY id').safeIntegers().all();
  assert.deepEqual(money.map(row=>row.amount),[9223372036854775807n,-9223372036854775808n]);
  assert.throws(()=>runCaseIntegrityTransaction(db,record,()=>insertFlow(db).run(6,1,'6','9223372036854775808','进','confirmed')),chinese);
});

test('摘要缺行、失效或covered_version错配均显示未知，不在读取时全案重算', t => {
  const { db }=fixture(t);
  for(const mutate of [
    'UPDATE case_summary SET covered_version=covered_version+1',
    'UPDATE case_summary SET valid=0',
    'DELETE FROM case_summary'
  ]) {
    db.transaction(()=>{
      const previous=db.prepare('SELECT * FROM case_summary').get();
      db.exec(mutate);
      assert.equal(readSummary(db,record).summaryState,'stale');
      assert.deepEqual(readSummary(db,record).stats,{files:null,flows:null,pending:null});
      if(!db.prepare('SELECT 1 FROM case_summary').get()) {
        db.prepare(`INSERT INTO case_summary(id,case_uuid,covered_version,generated_at,valid,files,flows,pending,summary_state,diagnostics_json)
          VALUES(@id,@case_uuid,@covered_version,@generated_at,@valid,@files,@flows,@pending,@summary_state,@diagnostics_json)`).run(previous);
      }
      refreshSummary(db,record);
    })();
    assert.equal(readSummary(db,record).summaryState,'ready');
  }
});

function publishedPair(db, { unrelatedRows = 1 } = {}) {
  runCaseIntegrityTransaction(db,record,()=>{
    seed(db);
    insertFlow(db).run(1,2,'1',100,'进','confirmed');
    const add = db.prepare(`INSERT INTO fund_flow(id,case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,amount,direction)
      VALUES(?,1,2,2,2,1,?,100,'进')`);
    for(let id=2;id<unrelatedRows+2;id++) add.run(id,String(id));
    publish(db); publish(db,{id:2,file:2,count:unrelatedRows});
  });
}

test('材料范围导入分段维护已发布小计，未发布仍显示未知；新批次切换不叠加历史', t => {
  const { db }=fixture(t);
  runCaseIntegrityTransaction(db,record,()=>db.exec(`INSERT INTO format_rule(id,platform,format_key,amount_expr,source_unit,unit_scale)
    VALUES(1,'synthetic','f0','A','元',100)`));
  runCaseTransaction(db,record,{sourceFileIds:[1]},()=>db.exec(`
    INSERT INTO source_file(id,case_id,file_name,file_sha256) VALUES(1,1,'合成.csv','hash1');
    INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status) VALUES(1,1,1,'t','v1','importing');
    INSERT INTO fund_flow(id,case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,amount,direction)
      VALUES(1,1,1,1,1,1,'1',100,'进');`));
  assert.deepEqual(readSummary(db,record).stats,{files:1,flows:null,pending:null});
  assert.deepEqual(db.prepare('SELECT flows,pending FROM case_summary').get(),{flows:0,pending:0});
  runCaseTransaction(db,record,{sourceFileIds:[1]},()=>publish(db));
  assert.deepEqual(readSummary(db,record).stats,{files:1,flows:1,pending:0});
  runCaseTransaction(db,record,{sourceFileIds:[1]},()=>db.exec(`
    INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status) VALUES(3,1,1,'later','v1','importing');
    INSERT INTO fund_flow(id,case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,amount,direction)
      VALUES(3,1,3,1,1,1,'1',200,'进'),(4,1,3,1,1,1,'2',300,'进');`));
  assert.equal(readSummary(db,record).stats.flows,1);
  runCaseTransaction(db,record,{sourceFileIds:[1]},()=>publish(db,{id:3,count:2}));
  assert.equal(readSummary(db,record).stats.flows,2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM fund_flow').get().n,3);
  const state=readSummary(db,record);
  assert.throws(()=>runCaseTransaction(db,record,{sourceFileIds:[1]},()=>
    db.exec("UPDATE import_batch SET imported_rows=3,total_rows=3 WHERE id=3")),/终止批次/);
  assert.deepEqual(readSummary(db,record),state);
  assert.throws(()=>runCaseTransaction(db,record,{sourceFileIds:[1]},()=>db.exec(`
    INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status,total_rows,imported_rows,skipped_rows)
      VALUES(4,1,1,'later','v1','done',1,1,0)`)),/行数核对/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM import_batch WHERE id=4').get().n,0);
  runCaseTransaction(db,record,{sourceFileIds:[1]},()=>db.exec(`
    INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status) VALUES(4,1,1,'later','v1','failed')`));
  assert.equal(readSummary(db,record).stats.flows,2);
  assert.ok(readSummary(db,record).diagnostics.some(item=>item.code==='latest_import_failed'));
});

test('单笔复核只调整该笔待核贡献，逐项解除原因后才能确认，余额历史不改计数', t => {
  const { db }=fixture(t);publishedPair(db);
  runCaseTransaction(db,record,{flowIds:[1]},()=>{
    db.exec("UPDATE fund_flow SET amount=NULL,direction=NULL,status='pending' WHERE id=1");
    pendingReason(db,1,'amount_unknown');pendingReason(db,1,'time_unknown');
  });
  assert.equal(readSummary(db,record).stats.pending,1);
  assert.throws(()=>runCaseTransaction(db,record,{flowIds:[1]},()=>db.exec(`
    UPDATE fund_flow SET amount=100,direction='进',status='confirmed' WHERE id=1;
    UPDATE pending_reason SET resolved_at='t2',resolution_reason='核对金额' WHERE reason_code='amount_unknown'`)),/待核状态/);
  assert.equal(db.prepare("SELECT resolved_at FROM pending_reason WHERE reason_code='amount_unknown'").get().resolved_at,null);
  runCaseTransaction(db,record,{flowIds:[1]},()=>db.exec(`
    UPDATE fund_flow SET amount=100,direction='进' WHERE id=1;
    UPDATE pending_reason SET resolved_at='t2',resolution_reason='核对金额' WHERE reason_code='amount_unknown'`));
  assert.equal(readSummary(db,record).stats.pending,1);
  runCaseTransaction(db,record,{flowIds:[1]},()=>db.exec(`
    UPDATE pending_reason SET resolved_at='t3',resolution_reason='核对时间' WHERE reason_code='time_unknown';
    UPDATE fund_flow SET status='confirmed' WHERE id=1;
    INSERT INTO balance_check_history(id,fund_flow_id,input_version,status,checked_at) VALUES(1,1,'v1','fail','t3');
    INSERT INTO balance_check(fund_flow_id,current_history_id) VALUES(1,1)`));
  assert.deepEqual(readSummary(db,record).stats,{files:2,flows:2,pending:0});
});

test('声明遗漏材料或记录的变更被拒并回滚，临时范围保护不遗留', t => {
  const { db }=fixture(t);publishedPair(db);
  const initial=readSummary(db,record);
  for(const [scope,sql] of [
    [{sourceFileIds:[1]},'UPDATE fund_flow SET amount=200 WHERE id=2'],
    [{flowIds:[1]},'UPDATE fund_flow SET amount=200 WHERE id=2'],
    [{flowIds:[1]},"INSERT INTO pending_reason(fund_flow_id,reason_code,created_at) VALUES(2,'outside','t')"],
    [{flowIds:[1]},"UPDATE source_file SET file_name='outside' WHERE id=1"],
    [{sourceFileIds:[1]},"UPDATE source_file SET file_name='outside' WHERE id=2"],
    [{sourceFileIds:[1]},"UPDATE format_rule SET source_evidence='outside' WHERE id=1"],
    [{sourceFileIds:[1]},'UPDATE case_summary SET flows=999'],
    [{sourceFileIds:[1]},"INSERT INTO import_check(case_id,check_type,status) VALUES(1,'outside','open')"],
    [{flowIds:[1]},'DELETE FROM fund_flow WHERE id=1']
  ]) {
    assert.throws(()=>runCaseTransaction(db,record,scope,()=>{
      db.exec('UPDATE fund_flow SET amount=300 WHERE id=1');db.exec(sql);
    }),/超出本次声明范围/);
    assert.deepEqual(readSummary(db,record),initial);
    assert.equal(db.prepare('SELECT amount FROM fund_flow WHERE id=1').get().amount,100);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_temp_master WHERE name LIKE 'fundsift_%'").get().n,0);
  }
  assert.throws(()=>runCaseTransaction(db,record,{flowIds:[999]},()=>{}),/已失联/);
  assert.throws(()=>runCaseTransaction(db,record,()=>{}),error=>error.code==='FS_CASE_SCOPE');
  assert.throws(()=>runCaseTransaction(db,record,{sourceFileIds:[1],flowIds:[1]},()=>{}),/不能省略或混用/);
  runCaseTransaction(db,record,{flowIds:[1]},()=>db.exec('UPDATE fund_flow SET amount=200 WHERE id=1'));
  assert.equal(readSummary(db,record).stats.flows,2);
});

test('失效或旧版未知摘要不能作增量基线；拒绝后未知状态保持，可显式检查恢复', t => {
  const { db }=fixture(t);publishedPair(db);
  db.exec("UPDATE source_file SET file_name='外部元数据变更' WHERE id=1");
  let called=false;
  for(let attempt=0;attempt<2;attempt++) {
    assert.throws(()=>runCaseTransaction(db,record,{flowIds:[1]},()=>{called=true;}),error=>error.code==='FS_SUMMARY_BASELINE');
    assert.equal(readSummary(db,record).summaryState,'stale');
  }
  assert.equal(called,false);
  db.transaction(()=>refreshSummary(db,record))();
  runCaseTransaction(db,record,{flowIds:[1]},()=>{});
  db.exec("UPDATE case_summary SET flows=NULL,pending=NULL,summary_state='incomplete'");
  assert.throws(()=>runCaseTransaction(db,record,{flowIds:[1]},()=>{}),error=>error.code==='FS_SUMMARY_BASELINE');
  db.transaction(()=>refreshSummary(db,record))();
  assert.equal(readSummary(db,record).summaryState,'ready');
});

test('范围内INSERT OR REPLACE不能隐式删除范围外附属记录，包括关闭递归触发器时', t => {
  const { db }=fixture(t);publishedPair(db);
  runCaseIntegrityTransaction(db,record,()=>db.exec(`
    UPDATE fund_flow SET status='pending' WHERE id IN (1,2);
    INSERT INTO pending_reason(id,fund_flow_id,reason_code,created_at) VALUES(1,1,'own','t'),(2,2,'outside','t');
    INSERT INTO balance_check_history(id,fund_flow_id,input_version,status,checked_at) VALUES(1,1,'v1','fail','t'),(2,2,'v1','fail','t');
    INSERT INTO balance_check(id,fund_flow_id,current_history_id) VALUES(2,2,2);
    INSERT INTO import_check(id,case_id,source_file_id,batch_id,check_type) VALUES(2,1,2,2,'outside')`));
  const initial=readSummary(db,record);
  for(const recursive of [0,1]) {
    db.pragma(`recursive_triggers=${recursive}`);
    for(const sql of [
      "INSERT OR REPLACE INTO pending_reason(id,fund_flow_id,reason_code,created_at) VALUES(2,1,'replace','t2')",
      "INSERT OR REPLACE INTO balance_check(id,fund_flow_id,current_history_id) VALUES(2,1,1)",
      "INSERT OR REPLACE INTO balance_check_history(id,fund_flow_id,input_version,status,checked_at) VALUES(2,1,'v1','fail','t2')",
      "INSERT OR REPLACE INTO import_check(id,case_id,source_file_id,batch_id,check_type) VALUES(2,1,1,1,'replace')"
    ]) {
      assert.throws(()=>runCaseTransaction(db,record,{sourceFileIds:[1]},()=>db.exec(sql)),chinese);
      assert.deepEqual(readSummary(db,record),initial);
      assert.equal(db.prepare('SELECT fund_flow_id FROM pending_reason WHERE id=2').get().fund_flow_id,2);
      assert.equal(db.prepare('SELECT fund_flow_id FROM balance_check WHERE id=2').get().fund_flow_id,2);
      assert.equal(db.prepare('SELECT source_file_id FROM import_check WHERE id=2').get().source_file_id,2);
    }
  }
});

test('外部连接修改在写锁内判基线并拒绝，异步事务和中途失败均不提交', t => {
  const { db,file }=fixture(t);publishedPair(db);
  const external=new Database(file);external.pragma('foreign_keys=ON');
  runCaseIntegrityTransaction(external,record,()=>external.exec('UPDATE fund_flow SET amount=200 WHERE id=1'));
  external.close();
  assert.throws(()=>runCaseTransaction(db,record,{flowIds:[1]},()=>{}),error=>error.code==='FS_SUMMARY_BASELINE');
  db.transaction(()=>refreshSummary(db,record))();
  const initial=readSummary(db,record);
  assert.throws(()=>runCaseTransaction(db,record,{flowIds:[1]},()=>{
    db.exec('UPDATE fund_flow SET amount=300 WHERE id=1');throw new Error('synthetic rollback');
  }),/synthetic rollback/);
  assert.deepEqual(readSummary(db,record),initial);
  assert.throws(()=>runCaseTransaction(db,record,{flowIds:[1]},()=>Promise.resolve()),/必须同步/);
  assert.deepEqual(readSummary(db,record),initial);
});

test('材料及单笔范围不运行整库检查，查询计划走已有索引，不遍历两万条无关流水', t => {
  const queries=[];
  const { db }=fixture(t,{trace:sql=>queries.push(sql)});publishedPair(db,{unrelatedRows:20000});
  const before=db.prepare('SELECT sum(amount) AS amount,count(*) AS n FROM fund_flow WHERE source_file_id=2').get();
  for(const scope of [{flowIds:[1]},{sourceFileIds:[1]}]) {
    queries.length=0;
    runCaseTransaction(db,record,scope,()=>db.exec('UPDATE fund_flow SET amount=200 WHERE id=1'));
    const flowQueries=queries.filter(sql=>/^SELECT/i.test(sql.trim())&&/\bfund_flow\b/.test(sql));
    assert.ok(flowQueries.length>0);
    assert.ok(!queries.some(sql=>/PRAGMA (integrity_check|foreign_key_check)/i.test(sql)));
    assert.ok(flowQueries.every(sql=>/fundsift_write_scope/.test(sql)), 'every flow query must be bounded to the declared IDs');
    db.exec('CREATE TEMP TABLE fundsift_write_scope(id INTEGER PRIMARY KEY); INSERT INTO temp.fundsift_write_scope VALUES(1)');
    for(const sql of flowQueries) {
      const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all();
      assert.ok(!plan.some(step=>/^SCAN (f|fund_flow)\b/.test(step.detail)),JSON.stringify(plan));
      assert.ok(plan.some(step=>/SEARCH (f|fund_flow) USING (INTEGER PRIMARY KEY|.*idx_ff_source_batch)/.test(step.detail)),JSON.stringify(plan));
    }
    db.exec('DROP TABLE temp.fundsift_write_scope');
    // The test's temporary write above deliberately invalidates the observation,
    // so explicitly recover before checking a second scoped operation.
    db.transaction(()=>refreshSummary(db,record))();
    assert.deepEqual(db.prepare('SELECT sum(amount) AS amount,count(*) AS n FROM fund_flow WHERE source_file_id=2').get(),before);
    assert.deepEqual(readSummary(db,record).stats,{files:2,flows:20001,pending:0});
  }
});
