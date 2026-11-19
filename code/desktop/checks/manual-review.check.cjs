'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { WorkspaceStore } = require('../storage.cjs');
const { DesktopData } = require('../desktop-data.cjs');
const { importAlipayAccount } = require('../import-service.cjs');
const { EFFECTIVE_FLOW_FROM, runCaseTransaction } = require('../hardening.cjs');
const { getReviewContext, saveReview, listMaterialReviewHistory } = require('../manual-review.cjs');
const { createImportFixtures } = require('../../../scripts/import-smoke-fixtures.cjs');

const schemaPath = path.resolve(__dirname, '../../ddl_extract_check.sql');
const confirmedAt = '2026-11-19T00:00:00.000Z';
const signReason = 'sign_semantics_undefined';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fundsift-review-'));
  const store = new WorkspaceStore({ schemaPath });
  t.after(() => {
    store.close();
    const root = fs.realpathSync(os.tmpdir());
    const target = fs.realpathSync(directory);
    assert.equal(path.dirname(target), root);
    fs.rmSync(target, { recursive: true, force: true });
  });
  await store.openWorkspace(directory);
  const { id: caseId } = await store.createCase({ name: '合成复核案件', number: 'REVIEW' });
  const record = store._caseRecord(caseId);
  const data = new DesktopData(store);
  const inputs = createImportFixtures(path.join(directory, 'fixtures'));
  const importFile = formatKey => data.importFile(caseId, {
    ...inputs.find(item => item.formatKey.startsWith(formatKey)),
    confirmedAt,
    confirmedCny: formatKey !== 'ccb'
  });
  const context = flowId => getReviewContext(store.caseDb, record, String(flowId));
  const save = payload => saveReview(store.caseDb, record, payload);
  return { directory, store, record, data, caseId, importFile, context, save, get db() { return store.caseDb; } };
}

function request(context, action, fields = {}) {
  return {
    flowId: context.flowId, dataVersion: context.dataVersion, requestId: randomUUID(),
    action, operator: '合成复核员', evidence: '合成验收依据', ...fields
  };
}

const refund = db => db.prepare('SELECT * FROM fund_flow WHERE summary=?').get('消费退货');
const readFlow = (db, id) => db.prepare('SELECT * FROM fund_flow WHERE id=?').get(id);

test('现代待核流水回源不一致时保留核验错误', async t => {
  const fix = await fixture(t);
  await fix.importFile('wechat');
  const { id } = fix.db.prepare("SELECT id FROM fund_flow WHERE status='pending'").get();
  assert.equal(fix.context(id).legacyWithoutArchive, false);
  const verified = await fix.data.getReview(fix.caseId, String(id));
  assert.ok(verified.source.values.length);
  const error = Object.assign(new Error('原文封装与归档记录不一致。'), { code: 'FS_IMPORT_SOURCE' });
  t.mock.method(fix.data, 'readFlowSource', async () => { throw error; });
  await assert.rejects(() => fix.data.getReview(fix.caseId, String(id)), error);
});

test('记说明保留流水与全部待核原因，相同请求幂等，过期提交和请求标识冲突拒绝', async t => {
  const fix = await fixture(t);
  await fix.importFile('wechat');
  const original = fix.db.prepare("SELECT * FROM fund_flow WHERE status='pending'").get();
  const readReasons = fix.db.prepare('SELECT * FROM pending_reason WHERE fund_flow_id=?');
  const beforeReasons = readReasons.all(original.id);
  const before = fix.context(original.id);
  assert.equal(before.canNote, true);
  assert.equal(before.resolveReasonId, null);
  assert.equal(before.correctReasonId, null);
  const note = request(before, 'note');
  assert.throws(() => fix.save(request(before, 'resolve', {
    reasonId: before.reasons[0].id, amountText: '0.01', direction: '出'
  })), { code: 'FS_REVIEW_SCOPE' });
  const result = fix.save(note);
  const after = fix.context(original.id);
  assert.equal(BigInt(after.dataVersion), BigInt(before.dataVersion) + 1n);
  assert.equal(after.history.length, 1);
  assert.equal(after.history[0].action, 'note');
  assert.equal(after.history[0].operator, note.operator);
  assert.equal(after.history[0].evidence, note.evidence);
  assert.ok(Number.isFinite(Date.parse(after.history[0].reviewed_at)));
  assert.deepEqual(readFlow(fix.db, original.id), original);
  assert.deepEqual(readReasons.all(original.id), beforeReasons);
  assert.deepEqual(fix.save(note), result);
  assert.throws(() => fix.save({ ...note, evidence: '不同依据' }), { code: 'FS_REVIEW_REQUEST_CONFLICT' });
  assert.throws(() => fix.save(request(before, 'note')), { code: 'FS_REVIEW_STALE' });
  assert.equal(fix.context(original.id).dataVersion, after.dataVersion);
  assert.equal(fix.context(original.id).history.length, 1);
});

test('确认只解除选中的原因，更正追加历史，规则底稿保留初始金额、方向、状态和原因', async t => {
  const fix = await fixture(t);
  await fix.importFile('ccb');
  const original = refund(fix.db);
  runCaseTransaction(fix.db, fix.record, { flowIds: [original.id] }, () => {
    fix.db.prepare('INSERT INTO pending_reason(fund_flow_id,reason_code,detail,created_at) VALUES(?, ?, ?, ?)')
      .run(original.id, 'time_missing', '合成的另一项待核原因', confirmedAt);
  });
  const before = fix.context(original.id);
  const selected = before.reasons.find(reason => reason.reason_code === signReason);
  const untouched = before.reasons.find(reason => reason.reason_code === 'time_missing');
  assert.equal(before.resolveReasonId, selected.id);
  const resolution = request(before, 'resolve', { reasonId: selected.id, amountText: '1.00', direction: '进' });
  assert.throws(() => fix.save({ ...resolution, reasonId: untouched.id }), { code: 'FS_REVIEW_SCOPE' });
  for (const amountText of ['0.00', '-1.00', '1.001', '92233720368547758.09']) {
    assert.throws(() => fix.save({ ...resolution, amountText }), { code: 'FS_REVIEW_INPUT' });
  }
  const result = fix.save(resolution);
  const after = fix.context(original.id);
  assert.equal(after.status, 'pending');
  assert.equal(after.amount, '100');
  assert.equal(after.direction, '进');
  assert.equal(after.resolveReasonId, null);
  assert.equal(after.correctReasonId, selected.id);
  assert.deepEqual(after.reasons.find(reason => reason.id === untouched.id), untouched);
  const resolved = after.reasons.find(reason => reason.id === selected.id);
  assert.equal(resolved.detail, selected.detail);
  assert.ok(resolved.resolved_at);
  assert.ok(resolved.resolution_reason);
  assert.equal(refund(fix.db).raw_record, original.raw_record);
  const priorEvent = fix.db.prepare('SELECT * FROM review_event WHERE id=?').get(result.event.id);
  const correction = fix.save(request(after, 'correct', {
    reasonId: after.correctReasonId, amountText: '0.98', direction: '出', evidence: '合成更正依据'
  }));
  const corrected = fix.context(original.id);
  assert.equal(corrected.amount, '-98');
  assert.equal(corrected.status, 'pending');
  assert.equal(corrected.history.length, 2);
  assert.equal(correction.event.before_amount, '100');
  assert.deepEqual(fix.db.prepare('SELECT * FROM review_event WHERE id=?').get(result.event.id), priorEvent);
  assert.deepEqual(corrected.reasons.find(reason => reason.id === selected.id), resolved);
  assert.deepEqual(corrected.reasons.find(reason => reason.id === untouched.id), untouched);
  assert.deepEqual(fix.save(resolution), result);
  assert.deepEqual(fix.context(original.id), corrected);

  const { dataVersion, fileName } = fix.data.getWorkpaperContext(fix.caseId);
  const filePath = path.join(fix.directory, fileName);
  const exported = await fix.data.exportWorkpaper(fix.caseId, filePath, dataVersion);
  assert.equal(exported.pendingRows, 1);
  assert.equal(exported.unknownAmountRows, 1);
  const Excel = require('exceljs');
  const workbook = new Excel.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet('流水明细');
  const headings = sheet.getRow(1).values;
  const row = [sheet.getRow(2), sheet.getRow(3)].find(row => row.getCell(headings.indexOf('摘要')).value === '消费退货');
  assert.ok(row);
  assert.equal(row.getCell(headings.indexOf('标准金额（元）')).value, original.amount);
  assert.equal(row.getCell(headings.indexOf('标准方向')).value, original.direction);
  assert.equal(row.getCell(headings.indexOf('证据状态（规则）')).value, '待核');
  assert.equal(row.getCell(headings.indexOf('全部待核原因码')).value, `${signReason}\ntime_missing`);
});

test('复核历史拒绝改写、删除、按主键替换和按请求标识替换，重开可读', async t => {
  const fix = await fixture(t);
  await fix.importFile('ccb');
  const flow = refund(fix.db);
  const result = fix.save(request(fix.context(flow.id), 'note'));
  const db = fix.db;
  const { id } = result.event;
  const before = db.prepare('SELECT * FROM review_event WHERE id=?').get(id);
  const columns = db.pragma('table_info(review_event)').map(column => column.name).filter(name => name !== 'id').join(',');
  for (const sql of [
    "UPDATE review_event SET evidence='changed' WHERE id=?",
    'DELETE FROM review_event WHERE id=?',
    'REPLACE INTO review_event SELECT * FROM review_event WHERE id=?',
    `INSERT OR REPLACE INTO review_event(${columns}) SELECT ${columns} FROM review_event WHERE id=?`
  ]) {
    assert.throws(() => runCaseTransaction(db, fix.record, { flowIds: [flow.id] }, () => db.prepare(sql).run(id)),
      { code: 'SQLITE_CONSTRAINT_TRIGGER' });
  }
  await fix.store.openCase(fix.caseId);
  assert.deepEqual(fix.db.prepare('SELECT * FROM review_event WHERE id=?').get(id), before);
  assert.equal(fix.context(flow.id).history[0].id, id);
  assert.deepEqual(fix.db.pragma('foreign_key_check'), []);
});

async function importLegacyTransfer(fix) {
  const { FORMAT_KEY, HEADERS } = require('../alipay-account.cjs');
  const filePath = path.join(fix.directory, '合成旧支付宝-划转.csv');
  const source = [
    'txn', 'order', '2026-01-01 01:00:00', '2026-01-01 01:00:00', '', 'source', '即时到账交易',
    '00001(合成用户)', '00001(合成用户)', '\t余额宝-自动转入', '4.28', '其它',
    '交换产品-余额实时转余额宝成功', '余额', '', '', ''
  ];
  fs.writeFileSync(filePath, '\ufeff' + [HEADERS, source].map(row => row.join(',')).join('\r\n') + '\r\n');
  const review = { status: 'approved', by: '合成审批人', at: confirmedAt, reason: '合成材料采用人民币' };
  await importAlipayAccount({
    ...fix.data.context(fix.caseId), filePath,
    rule: { platform: '支付宝', format_key: FORMAT_KEY, rule_version: 1, config_version: 1,
      amount_expr: 'E', source_unit: '元', unit_scale: 100, rounding_rule: 'ROUND_HALF_UP',
      direction_map: { 收入: '进', 支出: '出' }, negative_policy: 'pending', zero_policy: 'pending', zero_direction: null,
      currency_policy: 'verified_cny', currency_map: {}, balance_scope: 'unknown', balance_same_direction: true,
      reversal_note: '负额待核', review },
    policy: { timeColumn: '付款时间', accountIdentityPolicy: 'raw_platform_info', businessStatusPolicy: 'exact_v1', review }
  });
}

test('支付宝按批准规则重导后，按原文坐标与哈希关联旧说明，当前状态只来自新规则', async t => {
  const fix = await fixture(t);
  await importLegacyTransfer(fix);
  const read = () => fix.db.prepare(`SELECT f.* ${EFFECTIVE_FLOW_FROM}`).get();
  const before = fix.context(read().id);
  assert.equal(before.reasons.length, 2);
  assert.equal(before.resolveReasonId, null);
  const note = fix.save(request(before, 'note'));
  await fix.data.reimportMaterial(fix.caseId, before.sourceFileId, before.batchId);
  const current = fix.context(read().id);
  assert.notEqual(current.flowId, before.flowId);
  assert.notEqual(current.batchId, before.batchId);
  assert.equal(current.sourceLoc, before.sourceLoc);
  assert.equal(current.rawSha256, before.rawSha256);
  assert.equal(current.internalTransfer, true);
  assert.equal(current.resolveReasonId, null);
  assert.equal(current.status, 'pending');
  assert.deepEqual(current.reasons.map(reason => reason.reason_code), ['direction_unknown']);
  assert.equal(current.history.length, 1);
  assert.equal(current.history[0].is_current_batch, false);
  const material = listMaterialReviewHistory(fix.db, fix.record, current.sourceFileId);
  assert.equal(material.oldReviewCount, 1);
  assert.equal(material.history[0].id, note.event.id);
  assert.equal(material.history[0].current_flow_id, current.flowId);
  assert.throws(() => fix.save(request(current, 'note', { flowId: before.flowId })), { code: 'FS_REVIEW_SCOPE' });
});

test('进程在流水、原因和历史写入之后且提交之前被终止，重开无半保存', { timeout: 15000 }, async t => {
  const fix = await fixture(t);
  await fix.importFile('ccb');
  const original = refund(fix.db);
  const before = fix.context(original.id);
  const payload = request(before, 'resolve', { reasonId: before.resolveReasonId, amountText: '1.00', direction: '进' });
  fix.store.close();
  // Stop inside the real transaction, after the three individual writes.
  // The hook exists only on the child connection and signals before it blocks.
  const childCode = `
    const fs = require('node:fs');
    const { WorkspaceStore } = require('./code/desktop/storage.cjs');
    const { saveReview } = require('./code/desktop/manual-review.cjs');
    const [schemaPath, workspace, caseId, rawPayload] = process.argv.slice(1);
    (async () => {
      const store = new WorkspaceStore({schemaPath});
      await store.openWorkspace(workspace, {allowCreate: false});
      await store.openCase(caseId);
      const db = store.caseDb;
      db.function('stop_before_review_commit', () => {
        if (!db.inTransaction) throw new Error('missing transaction');
        fs.writeSync(1, 'READY\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      });
      db.exec(\`CREATE TEMP TRIGGER abort_test AFTER UPDATE OF valid ON case_summary
        WHEN NEW.valid=1 AND EXISTS(SELECT 1 FROM review_event e
          JOIN fund_flow f ON f.id=e.fund_flow_id
          JOIN pending_reason p ON p.id=e.reason_id
          WHERE e.action='resolve' AND p.resolved_at IS NOT NULL AND f.amount=100 AND f.status='confirmed')
        BEGIN SELECT stop_before_review_commit(); END;\`);
      saveReview(db, store._caseRecord(caseId), JSON.parse(rawPayload));
      process.exitCode = 77;
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
  const child = spawn(process.execPath, ['-e', childCode, schemaPath, fix.directory, fix.caseId, JSON.stringify(payload)], {
    cwd: path.resolve(__dirname, '../../..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill('SIGKILL'));
  const exit = once(child, 'close');
  let stdout = '', stderr = '', deliberatelyKilled = false;
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.includes('READY\n') && !deliberatelyKilled) {
      deliberatelyKilled = child.kill('SIGKILL');
    }
  });
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 12000);
  try { await exit; } finally { clearTimeout(killTimer); }
  assert.equal(deliberatelyKilled, true, stderr);
  await fix.store.openWorkspace(fix.directory, { allowCreate: false });
  await fix.store.openCase(fix.caseId);
  const after = fix.context(original.id);
  assert.deepEqual(after, before);
  assert.deepEqual(refund(fix.db), original);
  assert.equal(fix.db.prepare('SELECT count(*) FROM review_event').pluck().get(), 0);
  assert.equal(fix.save(payload).event.after_status, 'confirmed');
  assert.equal(fix.context(original.id).history.length, 1);
});
