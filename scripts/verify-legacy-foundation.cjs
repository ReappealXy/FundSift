'use strict';

// Pass a workspace created by the unmodified 0.1.4 EXE. Verification upgrades
// only its disposable copy; it never opens or mutates the source with SQLite.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const { WorkspaceStore, CASE_SCHEMA_VERSION } = require('../code/desktop/storage.cjs');
const { logicalSnapshot } = require('../code/desktop/migrations.cjs');
function folderHash(root) {
  const digest = createHash('sha256');
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      assert.ok(!stat.isSymbolicLink());
      digest.update(path.relative(root, file).split(path.sep).join('/') + '\0');
      if (stat.isDirectory()) visit(file);
      else { digest.update(fs.readFileSync(file)); digest.update('\0'); }
    }
  }
  visit(root); return digest.digest('hex');
}
(async () => {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node scripts/run-electron-node.cjs scripts/verify-legacy-foundation.cjs SOURCE_WORKSPACE NEW_OUTPUT_DIRECTORY');
  const source = fs.realpathSync(input), target = path.resolve(output);
  assert.ok(!target.startsWith(source + path.sep) && target !== source);
  assert.ok(!fs.existsSync(target), 'Use a new output directory');
  const sourceHash = folderHash(source);
  fs.mkdirSync(target, { recursive: true });
  const workspace = path.join(target, 'workspace');
  fs.cpSync(source, workspace, { recursive: true, errorOnExist: true, force: false });
  const catalog = new Database(path.join(workspace, 'workspace.sqlite'), { readonly: true });
  const records = catalog.prepare('SELECT * FROM workspace_case ORDER BY id').all(); catalog.close();
  assert.ok(records.length > 0, 'Legacy workspace must contain a case');
  const snapshots = [];
  for (const record of records) {
    const file = path.join(workspace, record.relative_path);
    const db = new Database(file, { readonly: true });
    assert.equal(db.pragma('user_version', { simple: true }), 2);
    snapshots.push({ caseId: record.id, path: record.relative_path, before: logicalSnapshot(db) }); db.close();
  }
  const store = new WorkspaceStore({ schemaPath: path.resolve(__dirname, '../code/ddl_extract_check.sql') });
  const result = await store.openWorkspace(workspace);
  assert.ok(result.cases.every(item => item.available), JSON.stringify(result.cases)); store.close();
  for (const item of snapshots) {
    const db = new Database(path.join(workspace, item.path), { readonly: true });
    assert.equal(db.pragma('user_version', { simple: true }), CASE_SCHEMA_VERSION);
    item.after = logicalSnapshot(db, item.before);
    assert.deepEqual(item.after, item.before);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('table_info(fund_flow)').find(c => c.name === 'currency').dflt_value, null);
    item.preserved = true;
    item.historyCurrencies = db.prepare("SELECT currency,currency_evidence,count(*) AS n FROM fund_flow GROUP BY currency,currency_evidence").safeIntegers().all()
      .map(row => ({ ...row, n: row.n.toString() }));
    assert.ok(item.historyCurrencies.every(row => row.currency_evidence === 'legacy_unverified'));
    item.newRawColumnsEmpty = ['raw_income_text', 'raw_expense_text', 'raw_currency_text', 'raw_record'].every(column =>
      db.prepare(`SELECT count(*) n FROM fund_flow WHERE ${column} IS NOT NULL`).get().n === 0);
    assert.ok(item.newRawColumnsEmpty); db.close();
  }
  assert.equal(folderHash(source), sourceHash, 'The original EXE workspace must remain byte-for-byte unchanged');
  const report = { ok: true, provenance: 'workspace created by unmodified 0.1.4 EXE; disposable copy upgraded by current source',
    sourceFolderSha256: sourceHash, sourceUntouched: true, caseCount: snapshots.length, cases: snapshots };
  fs.writeFileSync(path.join(target, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, caseCount: snapshots.length, oldColumnsPreserved: true, sourceUntouched: true, report: path.join(target, 'verification.json') }));
})().catch(error => { console.error(error); process.exitCode = 1; });
