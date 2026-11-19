'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { installCaseV2, beginCaseMutation, runCaseTransaction, runCaseIntegrityTransaction, readSummary } = require('../hardening.cjs');
const { installCaseV3, registerRuleConfig, validateRuleConfig, canonicalJSON } = require('../foundation.cjs');
const { migrate, schemaSignature, logicalSnapshot } = require('../migrations.cjs');
const { WorkspaceStore } = require('../storage.cjs');
const schemaPath = path.resolve(__dirname,'../../ddl_extract_check.sql');
const ddl = fs.readFileSync(schemaPath,'utf8');
const record = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', case_no:'F3',case_name:'合成基础案件',
  created_at:'2020-01-01T00:00:00.000Z',updated_at:'2020-01-01T00:00:00.000Z' };

function fixture(t,{ legacy = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'fundsift-foundation-')), file=path.join(dir,'case.sqlite');
  const db = new Database(file);
  db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL');
  db.exec(ddl);
  db.prepare('INSERT INTO case_info(id,case_no,case_name,created_at) VALUES(1,?,?,?)').run(record.case_no,record.case_name,record.created_at);
  db.exec('CREATE TABLE desktop_case_identity (id INTEGER PRIMARY KEY CHECK (id = 1), case_uuid TEXT NOT NULL UNIQUE)');
  db.prepare('INSERT INTO desktop_case_identity VALUES(1,?)').run(record.id);
  db.transaction(()=>installCaseV2(db,record))();
  db.pragma('user_version=2');
  if (legacy) runCaseIntegrityTransaction(db,record,()=>seed(db,true));
  t.after(()=>{if(db.open)db.close();fs.rmSync(dir,{recursive:true,force:true});});
  return { db,dir,file };
}
function upgrade(db) { db.pragma('foreign_keys=OFF');try { db.transaction(()=>installCaseV3(db,record))();db.pragma('user_version=3'); } finally{db.pragma('foreign_keys=ON');} }
function seed(db,flow=false) {
  db.exec(`INSERT INTO format_rule(id,platform,format_key,amount_expr,unit_scale) VALUES(1,'synthetic','f1','A',100);
    INSERT INTO source_file(id,case_id,file_name,file_sha256) VALUES(1,1,'合成.csv','${'a'.repeat(64)}');
    INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version) VALUES(1,1,1,'t','v1');`);
  if(flow) {
    db.exec(`INSERT INTO fund_flow(id,case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,raw_amount_text,amount,direction)
      VALUES(1,1,1,1,1,1,'row1','92233720368547758.07',9223372036854775807,'进');
      UPDATE import_batch SET status='done',total_rows=1,imported_rows=1,skipped_rows=0 WHERE id=1;
      UPDATE source_file SET first_batch_id=1,current_batch_id=1,status='imported' WHERE id=1;`);
  }
}
function config(extra={}) {
  return { config_version:1,amount_expr:'A',source_unit:'元',unit_scale:100,rounding_rule:'ROUND_HALF_UP',
    direction_map:{},negative_policy:'signed',zero_policy:'pending',zero_direction:null,
    balance_scope:'unknown',balance_same_direction:true,currency_policy:'verified_cny',currency_map:{人民币:'CNY'},
    reversal_note:'合成规则',review:{status:'approved',by:'合成审核人',at:'2026-11-18',reason:'合成测试'},...extra };
}

test('v3重建无CNY默认；旧列类型、int64、原始值及摘要元数据逐表不变',t=>{
  const {db}=fixture(t,{legacy:true}),before=logicalSnapshot(db);
  upgrade(db);
  assert.deepEqual(logicalSnapshot(db,before),before);
  assert.equal(db.pragma('table_info(fund_flow)').find(x=>x.name==='currency').dflt_value,null);
  assert.deepEqual(db.prepare('SELECT currency,currency_evidence,amount FROM fund_flow').safeIntegers().get(),{
    currency:'CNY',currency_evidence:'legacy_unverified',amount:9223372036854775807n });
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
  assert.deepEqual(readSummary(db,record).stats,{files:1,flows:1,pending:0});
});

test('新建案件直接使用 v4、工作区仍用 v2，重开识别已知结构且不重复迁移',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fundsift-foundation-store-'));
  const store=new WorkspaceStore({schemaPath});
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  await store.openWorkspace(root);const made=await store.createCase({name:'合成新案',number:'NEW3'});
  assert.equal(store.caseDb.pragma('user_version',{simple:true}),4);
  assert.equal(store.catalog.pragma('user_version',{simple:true}),2);
  store.close();assert.equal((await store.openWorkspace(root)).cases.find(x=>x.id===made.id).available,true);
  assert.equal(fs.existsSync(path.join(root,'cases',made.id,'backup')),false);
});

test('配置schema、内容哈希、批准及冻结联动；直接SQL也拒绝伪造哈希',t=>{
  const {db}=fixture(t);upgrade(db);
  runCaseIntegrityTransaction(db,record,()=>seed(db));
  const got=registerRuleConfig(db,{rule_id:1,rule_version:1,config:config()});
  assert.match(got.config_sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(db.prepare('SELECT verified,frozen FROM format_rule').get(),{verified:1,frozen:1});
  assert.throws(()=>registerRuleConfig(db,{rule_id:1,rule_version:1,config:config()}));
  assert.throws(()=>validateRuleConfig(config({currency_map:{USD:'CNY'}})),{code:'FS_RULE_CONFIG'});
  assert.throws(()=>validateRuleConfig(config({currency_map:{' 人民币':'CNY'}})),{code:'FS_RULE_CONFIG'});
  assert.throws(()=>validateRuleConfig(config({column_negative_policy:{income:'reverse',expense:'pending'}})),{code:'FS_RULE_CONFIG'});
  assert.throws(()=>validateRuleConfig(config({direction_map:{收入:'进'}})),{code:'FS_RULE_CONFIG'});
  assert.throws(()=>validateRuleConfig(config({negative_policy:'reverse'})),{code:'FS_RULE_CONFIG'});
  assert.throws(()=>validateRuleConfig(config({zero_policy:'confirmed',zero_direction:null})),{code:'FS_RULE_CONFIG'});
  db.exec("INSERT INTO format_rule(id,platform,format_key,amount_expr,unit_scale,verified,frozen) VALUES(2,'synthetic','f2','A',100,1,1)");
  assert.throws(()=>db.prepare(`INSERT INTO format_rule_config VALUES(2,1,1,?,?,?, ?,1)`).run(canonicalJSON(config()),'b'.repeat(64),'合成审核人','2026-11-18'));
});

test('配置批准输入不能伪造；不可修改配置覆盖UPDATE DELETE REPLACE UPSERT及替代键',t=>{
  const {db}=fixture(t);upgrade(db);
  runCaseIntegrityTransaction(db,record,()=>seed(db));
  assert.throws(()=>registerRuleConfig(db,{rule_id:1,rule_version:1,config:config(),approved_by:'另一个人'}),{code:'FS_RULE_APPROVAL'});
  assert.deepEqual(db.prepare('SELECT verified,frozen FROM format_rule').get(),{verified:0,frozen:0});
  registerRuleConfig(db,{rule_id:1,rule_version:1,config:config()});
  for(const recursive of [0,1]) {
    db.pragma(`recursive_triggers=${recursive}`);
    for(const sql of ["UPDATE format_rule_config SET approved_by='other'",'DELETE FROM format_rule_config',
      'INSERT OR REPLACE INTO format_rule_config SELECT * FROM format_rule_config',
      `INSERT INTO format_rule_config SELECT * FROM format_rule_config WHERE 1 ON CONFLICT(rule_id,rule_version) DO UPDATE SET approved_by='other'`,
      "INSERT OR REPLACE INTO format_rule(id,platform,format_key,amount_expr,unit_scale,verified,frozen) VALUES(99,'synthetic','f1','A',100,1,1)"])
      assert.throws(()=>db.exec(sql));
  }
});

test('配置与旧规则UPDATE DELETE REPLACE UPSERT均不可绕过，legacy规则不能补配置',t=>{
  const {db}=fixture(t,{legacy:true});upgrade(db);
  assert.throws(()=>registerRuleConfig(db,{rule_id:1,rule_version:1,config:config()}));
  for(const recursive of [0,1]) {
    db.pragma(`recursive_triggers=${recursive}`);
    for(const sql of ["UPDATE format_rule SET amount_expr='B' WHERE id=1",'DELETE FROM format_rule WHERE id=1',
      "INSERT OR REPLACE INTO format_rule(id,platform,format_key,amount_expr,unit_scale) VALUES(1,'synthetic','f1','B',100)",
      "INSERT INTO format_rule(id,platform,format_key,amount_expr,unit_scale) VALUES(1,'synthetic','f1','B',100) ON CONFLICT(id) DO UPDATE SET amount_expr='B'"])
      assert.throws(()=>db.exec(sql));
  }
});

test('新原文不可改、REPLACE不可绕过；无币种证据不默认CNY',t=>{
  const {db}=fixture(t);upgrade(db);
  runCaseIntegrityTransaction(db,record,()=>seed(db));
  runCaseTransaction(db,record,{sourceFileIds:[1]},()=>{
    db.exec(`INSERT INTO fund_flow(id,case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,amount,direction,
      raw_income_text,raw_expense_text,raw_currency_text,raw_record) VALUES(1,1,1,1,1,1,'1',100,'进','1.00','','', '{"source_loc":"1"}')`);
    for(const column of ['raw_income_text','raw_expense_text','raw_currency_text','raw_record','currency_evidence']) {
      assert.throws(()=>db.prepare(`UPDATE fund_flow SET ${column}=? WHERE id=1`).run(column==='raw_record'?'{}':'changed'));
    }
    assert.throws(()=>db.exec("UPDATE fund_flow SET currency='CNY' WHERE id=1"));
    assert.throws(()=>db.exec('INSERT OR REPLACE INTO fund_flow SELECT * FROM fund_flow WHERE id=1'));
  });
  assert.equal(db.prepare('SELECT currency FROM fund_flow').get().currency,null);
});

test('币种证据直接入库按ISO/已批准别名/verified_cny核验，不允许未知默认或ISO改写',t=>{
  const {db}=fixture(t);upgrade(db);
  runCaseIntegrityTransaction(db,record,()=>seed(db));
  registerRuleConfig(db,{rule_id:1,rule_version:1,config:config()});
  runCaseIntegrityTransaction(db,record,()=>{});
  runCaseTransaction(db,record,{sourceFileIds:[1]},()=>{
    const insert=db.prepare(`INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,
      amount,direction,currency,raw_currency_text,currency_evidence) VALUES(1,1,1,1,1,?,100,'进',?,?,?)`);
    insert.run('iso','USD',' usd ','raw_iso');
    insert.run('iso-unicode','USD','\t\u3000usd\u00a0\n','raw_iso');
    insert.run('map','CNY','人民币','approved_map');
    insert.run('rule','CNY',null,'verified_cny');
    for(const [loc,currency,raw,evidence] of [['bad-iso','CNY','usd','raw_iso'],['no-raw','USD',null,'raw_iso'],
      ['bad-map','CNY','156','approved_map'],['iso-map','CNY','USD','approved_map'],['no-evidence','CNY',null,'unknown'],
      ['rule-overwrite','CNY','156','verified_cny'],['fake-legacy','CNY',null,'legacy_unverified']])
      assert.throws(()=>insert.run(loc,currency,raw,evidence));
  });
});

test('归档账本按实际source及历史batch引用保护，核验哈希和引用不能静默改写',t=>{
  const {db}=fixture(t);upgrade(db);
  runCaseIntegrityTransaction(db,record,()=>{
    seed(db);
    db.prepare(`INSERT INTO archive_entry VALUES(1,NULL,'archive/.staging/a','archive/a.csv',?,?,10,'verified','t','t')`).run('a'.repeat(64),'a'.repeat(64));
    db.exec('UPDATE source_file SET archive_entry_id=1 WHERE id=1; UPDATE import_batch SET archive_entry_id=1 WHERE id=1');
  });
  for(const sql of ["UPDATE archive_entry SET status='removed'",'DELETE FROM archive_entry',
    "UPDATE archive_entry SET copied_sha256='"+'b'.repeat(64)+"'",'UPDATE source_file SET archive_entry_id=NULL',
    'UPDATE import_batch SET archive_entry_id=NULL','INSERT OR REPLACE INTO archive_entry SELECT * FROM archive_entry']) assert.throws(()=>db.exec(sql));
  assert.throws(()=>db.prepare(`INSERT INTO archive_entry VALUES(2,NULL,'archive/.staging/b','archive/b.csv',?,NULL,10,'verified','t','t')`).run('b'.repeat(64)));
});

test('范围事务归档归属只认批次正向引用，旧反向列单独存在不能授权',t=>{
  const {db}=fixture(t);upgrade(db);
  runCaseIntegrityTransaction(db,record,()=>{
    seed(db);
    db.prepare(`INSERT INTO archive_entry VALUES(1,NULL,'archive/.staging/a','archive/a.csv',?,?,10,'verified','t','t')`).run('a'.repeat(64),'a'.repeat(64));
    db.exec('UPDATE import_batch SET archive_entry_id=1 WHERE id=1');
  });
  runCaseTransaction(db,record,{sourceFileIds:[1]},()=>{
    assert.throws(()=>registerRuleConfig(db,{rule_id:1,rule_version:1,config:config()}));
    assert.throws(()=>db.prepare(`INSERT INTO archive_entry VALUES(2,NULL,'archive/.staging/b','archive/b.csv',?,NULL,10,'staged','t',NULL)`).run('a'.repeat(64)));
    assert.throws(()=>db.prepare(`INSERT INTO archive_entry VALUES(2,1,'archive/.staging/b','archive/b.csv',?,NULL,10,'staged','t',NULL)`).run('a'.repeat(64)),/超出本次声明范围/);
    db.exec('UPDATE archive_entry SET status=status WHERE id=1');
  });
});

test('材料覆盖未知不能声明完整；取消failed回执及发布计数验证，终态回执不可改',t=>{
  const {db}=fixture(t);upgrade(db);
  runCaseIntegrityTransaction(db,record,()=>seed(db));
  runCaseTransaction(db,record,{sourceFileIds:[1]},()=>{
    assert.throws(()=>db.exec('UPDATE source_file SET coverage_complete=1 WHERE id=1'));
    db.exec('UPDATE source_file SET header_rows=1,data_rows=0,trailer_rows=1,unclassified_rows=0,coverage_complete=1 WHERE id=1');
    assert.throws(()=>db.exec("UPDATE import_batch SET cancel_reason='取消' WHERE id=1"));
    assert.throws(()=>db.exec("UPDATE import_batch SET status='done',total_rows=0,imported_rows=0,skipped_rows=0,pending_rows=1 WHERE id=1"));
    db.exec("UPDATE import_batch SET status='failed',cancel_reason='用户取消',error_code='FS_CANCELLED',total_rows=0,cancelled_rows=0 WHERE id=1");
    assert.throws(()=>db.exec("UPDATE import_batch SET cancel_reason='重写' WHERE id=1"));
    assert.throws(()=>db.exec("UPDATE import_batch SET notes='rewrite policy' WHERE id=1"));
  });
});

test('旧历史批次仍引用归档时不允许清理，未引用孤件可登记removed并保留账本',t=>{
  const {db}=fixture(t);upgrade(db);
  runCaseIntegrityTransaction(db,record,()=>{
    seed(db);
    db.prepare(`INSERT INTO archive_entry VALUES(1,NULL,'archive/.staging/a','archive/a.csv',?,?,10,'verified','t','t')`).run('a'.repeat(64),'a'.repeat(64));
    db.exec('UPDATE import_batch SET archive_entry_id=1 WHERE id=1');
    db.prepare(`INSERT INTO archive_entry VALUES(2,NULL,'archive/.staging/b','archive/b.csv',?,NULL,10,'staged','t',NULL)`).run('b'.repeat(64));
    db.exec("UPDATE archive_entry SET status='removed' WHERE id=2");
    assert.throws(()=>db.exec("UPDATE archive_entry SET status='removed' WHERE id=1"));
  });
  assert.equal(db.prepare('SELECT status FROM archive_entry WHERE id=2').get().status,'removed');
  assert.throws(()=>db.exec("UPDATE archive_entry SET status='staged' WHERE id=2"));
});

test('迁移备份保存并验证旧字段逻辑摘要，v2内容及外键保持完整',async t=>{
  const {db,file,dir}=fixture(t,{legacy:true}),before=logicalSnapshot(db);
  await migrate({db,filePath:file,kind:'合成案件',identity:{caseUuid:record.id},expectedSchema:schemaSignature(db),
    validate:()=>{},install:d=>installCaseV3(d,record),targetVersion:3,rebuildForeignKeys:true});
  assert.equal(db.pragma('foreign_keys',{simple:true}),1);
  const batch=fs.readdirSync(path.join(dir,'backup'))[0];
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'backup',batch,'manifest.json'),'utf8'));
  assert.deepEqual(manifest.logicalTables,before);assert.deepEqual(manifest.preservedLogicalTables,before);
  assert.equal(manifest.result,'upgraded');assert.equal(db.pragma('user_version',{simple:true}),3);
});

test('重建后故障和原字段内容变动均回滚，外键重新开启，原v2结构与数据不变',async t=>{
  for(const corrupt of [false,true]) {
    const {db,file}=fixture(t,{legacy:true}),schema=schemaSignature(db),before=logicalSnapshot(db);
    await assert.rejects(()=>migrate({db,filePath:file,kind:'合成案件',identity:{},expectedSchema:schema,validate:()=>{},
      install:d=>installCaseV3(d,record),targetVersion:3,rebuildForeignKeys:true,
      hooks:{afterInstall:({db:target})=>{if(corrupt){beginCaseMutation(target);target.exec("UPDATE fund_flow SET summary='tampered'");}else throw Error('injected');}}
    }),{code:corrupt?'FS_MIGRATION_CONTENT':'FS_MIGRATION_FAILED'});
    assert.equal(db.pragma('foreign_keys',{simple:true}),1);assert.equal(db.pragma('user_version',{simple:true}),2);
    assert.equal(schemaSignature(db),schema);assert.deepEqual(logicalSnapshot(db),before);
  }
});
