'use strict';

// Pass an isolated full workspace copy and an existing private output directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WorkspaceStore } = require('../code/desktop/storage.cjs');
const { DesktopData } = require('../code/desktop/desktop-data.cjs');
const { EFFECTIVE_FLOW_FROM } = require('../code/desktop/hardening.cjs');

async function run(workspace, output) {
  const store = new WorkspaceStore({ schemaPath: path.resolve(__dirname, '../code/ddl_extract_check.sql') });
  try {
    const state = await store.openWorkspace(path.resolve(workspace), { allowCreate: false });
    assert.equal(state.cases.length, 1);
    const caseId = state.cases[0].id;
    await store.openCase(caseId);
    const data = new DesktopData(store);
    let materials = data.listMaterials(caseId).materials;
    const material = materials.find(m => m.canReimport);
    assert.ok(material && material.ruleVersion === '1');
    const read = () => store.caseDb.prepare(`SELECT f.id,f.platform,f.source_file_id,f.source_loc,f.amount,f.direction,f.status,
      f.currency,f.txn_time,f.raw_record, f.rule_version ${EFFECTIVE_FLOW_FROM} ORDER BY f.source_file_id, f.source_loc`).safeIntegers().all();
    const reasons = store.caseDb.prepare('SELECT reason_code FROM pending_reason WHERE fund_flow_id=? AND resolved_at IS NULL ORDER BY reason_code');
    const snapshot = () => read().map(row => ({...row, raw:JSON.parse(row.raw_record), reasons:reasons.all(row.id).map(r => r.reason_code)}));
    const before = snapshot();
    assert.equal(before.length, 8105);
    const receipt = (await data.reimportMaterial(caseId, material.id, material.currentBatchId)).receipt;
    assert.equal(receipt.importedRows, 607);
    const after = snapshot();
    assert.equal(after.length, before.length);
    let classified = 0;
    for (let index = 0; index < before.length; index++) {
      const old = before[index], row = after[index];
      for (const key of ['source_file_id','source_loc','txn_time','currency','amount','direction','status']) assert.equal(row[key], old[key]);
      assert.deepEqual(row.raw.values, old.raw.values);
      const v = old.raw.values;
      const expected = old.platform === '支付宝' && v[12] === '交换产品-余额实时转余额宝成功';
      if (!expected) {
        assert.equal(row.raw.derivation.internal_transfer, undefined);
        assert.deepEqual(row.reasons, old.reasons);
        if (old.platform !== '支付宝') assert.equal(row.id, old.id);
        continue;
      }
      assert.equal(v[7], v[8]);
      assert.equal(v[11], '其它');
      assert.equal(row.rule_version, 2n);
      assert.equal(row.amount, null);
      assert.equal(row.direction, null);
      const transfer = row.raw.derivation.internal_transfer;
      assert.ok(transfer?.account_change && !transfer.economic_inclusion);
      const [whole, fraction = ''] = v[10].trim().split('.');
      assert.match(fraction, /^\d{0,2}$/);
      assert.equal(transfer.amount_minor, String(BigInt(whole) * 100n + BigInt(fraction.padEnd(2,'0'))));
      assert.deepEqual(row.reasons, old.reasons.filter(code => code !== 'business_status_unknown'));
      classified++;
    }
    assert.equal(classified, 16);
    const pending = after.filter(row => row.status === 'pending').length;
    const blank = after.filter(row => row.amount === null).length;
    const unresolved = after.reduce((n,row) => n + row.reasons.length, 0);
    assert.deepEqual([pending, blank, unresolved], [36, 18, 39]);
    materials = data.listMaterials(caseId).materials;
    const current = materials.find(m => m.id === material.id);
    assert.equal(current.ruleVersion, '2');
    assert.equal(current.sha256, material.sha256);
    assert.notEqual(current.currentBatchId, material.currentBatchId);
    const oldBatch = store.caseDb.prepare('SELECT status, imported_rows FROM import_batch WHERE id=?').get(material.currentBatchId);
    assert.deepEqual(oldBatch, {status:'done',imported_rows:607});
    await store.openCase(caseId);
    const context = data.getWorkpaperContext(caseId);
    const file = path.join(path.resolve(output), context.fileName);
    await data.exportWorkpaper(caseId, file, context.dataVersion);
    assert.ok(fs.statSync(file).size > 0);
    console.log(JSON.stringify({ rows:after.length, classified, pending, blank, unresolved, fileName:context.fileName, dataVersion:context.dataVersion }));
  } finally { store.close(); }
}

run(...process.argv.slice(2)).catch(error => {
  // Assertions over private rows can contain identifiers in the exception payload.
  console.error(error instanceof assert.AssertionError ? '私有样本核对失败：' + error.stack.split('\n').find(line => line.includes('verify-alipay-transfer-v2.cjs'))
    : (error.code || 'VERIFY_FAILED') + ': ' + error.message);
  process.exitCode = 1;
});
