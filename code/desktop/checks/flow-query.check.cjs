'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { installCaseV2, runCaseIntegrityTransaction, runCaseTransaction } = require('../hardening.cjs');
const { queryFlowPage } = require('../flow-query.cjs');
const record = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', case_no: 'SYN-Q', case_name: '合成分页', created_at: 't', updated_at: 't' };
function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys=ON');
  db.exec(fs.readFileSync(path.resolve(__dirname, '../../ddl_extract_check.sql'), 'utf8'));
  db.exec('CREATE TABLE desktop_case_identity(id INTEGER PRIMARY KEY CHECK(id=1),case_uuid TEXT NOT NULL UNIQUE)');
  db.prepare('INSERT INTO case_info VALUES(1,?,?,NULL,?)').run(record.case_no, record.case_name, record.created_at);
  db.prepare('INSERT INTO desktop_case_identity VALUES(1,?)').run(record.id);
  db.transaction(() => installCaseV2(db, record))();
  runCaseIntegrityTransaction(db, record, () => {
    db.exec(`INSERT INTO format_rule(id,platform,format_key,amount_expr,source_unit,unit_scale,verified,frozen)
      VALUES(1,'synthetic','q','A','分',1,1,1);
      INSERT INTO source_file(id,case_id,file_name,file_sha256) VALUES(1,1,'synthetic.csv','hash');
      INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version) VALUES(1,1,1,'t','test');`);
    const add = db.prepare(`INSERT INTO fund_flow(id,case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,txn_time,amount,direction,status)
      VALUES(?,1,1,1,1,1,?,?,?,?,?)`);
    for (let id = 1; id <= 11; id++) {
      const pending = id > 8;
      add.run(id, String(id), pending ? null : '2026-11-18 08:00:00', id === 1 ? 9223372036854775807n : 100n, '进', pending ? 'pending' : 'confirmed');
      if (pending) db.prepare("INSERT INTO pending_reason(fund_flow_id,reason_code,created_at) VALUES(?,'time_missing','t')").run(id);
    }
    db.exec("UPDATE import_batch SET status='done',total_rows=11,imported_rows=11,skipped_rows=0 WHERE id=1; UPDATE source_file SET first_batch_id=1,current_batch_id=1,status='imported' WHERE id=1");
  });
  return db;
}
test('同秒与空时间keyset分页全序无漏重，金额经JSON仍为无损整数文本', t => {
  const db = fixture(t), ids = [], amounts = [];
  let cursor = null;
  do {
    const page = queryFlowPage(db, { caseId: record.id, limit: 3, cursor });
    assert.equal(page.total, '11');
    assert.deepEqual(JSON.parse(JSON.stringify(page)), page);
    ids.push(...page.rows.map(row => row.id)); amounts.push(...page.rows.map(row => row.amount));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(new Set(ids).size, 11);
  assert.equal(ids.length, 11);
  assert.equal(amounts[0], '9223372036854775807');
  assert.deepEqual(ids.slice(-3), ['10', '11', '9']);
});
test('同批次标准金额改变也使旧分页失效，拒绝混读', t => {
  const db = fixture(t), first = queryFlowPage(db, { caseId: record.id, limit: 2 });
  runCaseTransaction(db, record, { flowIds: [2] }, () => db.prepare('UPDATE fund_flow SET amount=101 WHERE id=2').run());
  assert.throws(() => queryFlowPage(db, { caseId: record.id, limit: 2, cursor: first.nextCursor }), { code: 'FS_QUERY_STALE' });
  assert.notEqual(queryFlowPage(db, { caseId: record.id }).dataVersion, first.dataVersion);
});
test('翻页绑定案件和筛选，只有当前done批次与未解除原因可见', t => {
  const db = fixture(t);
  const page = queryFlowPage(db, { caseId: record.id, filters: { status: 'pending' }, limit: 1 });
  assert.equal(page.total, '3');
  assert.equal(page.rows[0].pendingReasons[0].reason_code, 'time_missing');
  assert.deepEqual(page.rows[0].review, { canNote: false, canResolve: false, hasHistory: false });
  assert.throws(() => queryFlowPage(db, { caseId: record.id, cursor: page.nextCursor }), { code: 'FS_QUERY_CONTEXT' });
  assert.throws(() => queryFlowPage(db, { caseId: 'other' }), { code: 'FS_CASE_IDENTITY' });
  assert.throws(() => queryFlowPage(db, { caseId: record.id, cursor: 'garbage' }), { code: 'FS_QUERY_CURSOR' });
  runCaseTransaction(db, record, { sourceFileIds: [1] }, () => {
    db.exec(`INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version) VALUES(2,1,1,'t','test2');
      INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,amount,direction)
      VALUES(1,2,1,1,1,'not-published',100,'进')`);
  });
  assert.equal(queryFlowPage(db, { caseId: record.id }).total, '11');
});
