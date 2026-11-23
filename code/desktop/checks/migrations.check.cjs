'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { WorkspaceStore } = require('../storage.cjs');
const { installCaseV2 } = require('../hardening.cjs');
const { configureFoundation, installCaseV3 } = require('../foundation.cjs');
const { installCaseV4 } = require('../review-schema.cjs');
const { schemaSignature } = require('../migrations.cjs');
const schemaPath = path.resolve(__dirname, '../../ddl_extract_check.sql');
const oldSchema = fs.readFileSync(schemaPath, 'utf8');
const catalogSchema = `CREATE TABLE workspace_case (
    id TEXT PRIMARY KEY, case_no TEXT NOT NULL UNIQUE, case_name TEXT NOT NULL,
    relative_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_opened_at TEXT
  )`;

function setup(t, hooks = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fundsift-upgrade-'));
  fs.mkdirSync(path.join(root, 'cases'));
  const db = new Database(path.join(root, 'workspace.sqlite'));
  db.pragma('journal_mode=WAL');
  db.exec(catalogSchema);
  db.pragma('application_id=1179866963'); // 0x46535753
  db.pragma('user_version=1');
  db.close();
  const store = new WorkspaceStore({ schemaPath, migrationHooks: hooks });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store };
}

function addV1(root, number = 'V1', withData = false) {
  const record = { id: randomUUID(), case_no: number, case_name: '旧案' + number, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-02T00:00:00.000Z', last_opened_at: null };
  record.relative_path = `cases/${record.id}/case.sqlite`;
  const directory = path.join(root, 'cases', record.id);
  fs.mkdirSync(directory); fs.mkdirSync(path.join(directory, 'archive')); fs.mkdirSync(path.join(directory, 'exports'));
  const db = new Database(path.join(directory, 'case.sqlite'));
  db.pragma('journal_mode=WAL'); db.pragma('foreign_keys=ON');
  db.exec(oldSchema);
  db.exec('CREATE TABLE desktop_case_identity (id INTEGER PRIMARY KEY CHECK (id = 1), case_uuid TEXT NOT NULL UNIQUE)');
  db.prepare('INSERT INTO case_info (id,case_no,case_name,created_at) VALUES(1,?,?,?)').run(record.case_no, record.case_name, record.created_at);
  db.prepare('INSERT INTO desktop_case_identity(id,case_uuid) VALUES(1,?)').run(record.id);
  db.pragma('application_id=1179861825'); // 0x46534341
  db.pragma('user_version=1');
  if (withData) {
    db.exec(`
      INSERT INTO format_rule(id,platform,format_key,amount_expr,source_unit,unit_scale) VALUES(1,'test','v1','A','元',100);
      INSERT INTO source_file(id,case_id,file_name,file_sha256,status) VALUES(1,1,'old.csv','oldhash','imported');
      INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status,total_rows,imported_rows,skipped_rows) VALUES(1,1,1,'t','v1','done',1,1,0);
      UPDATE source_file SET first_batch_id=1,current_batch_id=1 WHERE id=1;
      INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,raw_amount_text,amount,direction,status) VALUES(1,1,1,1,1,'row1','123.45',12345,'进','confirmed');
    `);
  }
  const catalog = new Database(path.join(root, 'workspace.sqlite'));
  catalog.prepare(`INSERT INTO workspace_case (id,case_no,case_name,relative_path,created_at,updated_at,last_opened_at)
    VALUES(@id,@case_no,@case_name,@relative_path,@created_at,@updated_at,@last_opened_at)`).run(record);
  catalog.close();
  return { record, db, file: path.join(directory, 'case.sqlite') };
}

function manifests(folder) {
  if (!fs.existsSync(path.join(folder, 'backup'))) return [];
  return fs.readdirSync(path.join(folder, 'backup')).map(name => {
    const dir = path.join(folder, 'backup', name);
    return { dir, data: JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) };
  });
}

test('v1含WAL数据升级，独立备份完整，身份原文和时间不变；新建/升级v5结构一致', async t => {
  const { root, store } = setup(t);
  const old = addV1(root, 'Ab-001', true);
  t.after(() => { if (old.db.open) old.db.close(); });
  assert.ok(fs.statSync(old.file + '-wal').size > 0);
  const state = await store.openWorkspace(root);
  assert.equal(state.cases[0].available, true);
  assert.deepEqual(state.cases[0].stats, { files: 1, flows: 1, pending: 0 });
  assert.equal(state.cases[0].updatedAt, old.record.updated_at);
  const backup = manifests(path.dirname(old.file));
  assert.equal(backup.length, 1);
  assert.equal(backup[0].data.result, 'upgraded');
  assert.equal(backup[0].data.identity.caseUuid, old.record.id);
  assert.equal(backup[0].data.counts.fund_flow, '1');
  const backupFile = path.join(backup[0].dir, backup[0].data.backupFile);
  assert.equal(createHash('sha256').update(fs.readFileSync(backupFile)).digest('hex'), backup[0].data.sha256);
  const copy = new Database(backupFile, { readonly: true });
  assert.equal(copy.pragma('user_version', { simple: true }), 1);
  assert.equal(copy.prepare('SELECT raw_amount_text FROM fund_flow').get().raw_amount_text, '123.45');
  copy.close(); old.db.close();
  const made = await store.createCase({ name: '新案', number: 'NEW' });
  const upgraded = new Database(old.file, { readonly: true });
  const fresh = new Database(path.join(root, 'cases', made.id, 'case.sqlite'), { readonly: true });
  assert.equal(schemaSignature(upgraded), schemaSignature(fresh));
  upgraded.close(); fresh.close(); store.close();
  await store.openWorkspace(root);
  assert.equal(manifests(path.dirname(old.file)).length, 1);
  assert.equal(manifests(root).length, 1);
});

test('上版工作区 v2 和案件 v4 升级后，旧材料保持可见并可移入回收站', async t => {
  const { root, store } = setup(t);
  const old = addV1(root, 'V4', true);
  const catalog = new Database(path.join(root, 'workspace.sqlite'));
  catalog.exec('CREATE UNIQUE INDEX idx_workspace_case_number_nocase ON workspace_case(case_no COLLATE NOCASE); PRAGMA user_version=2');
  catalog.close();
  configureFoundation(old.db);
  old.db.pragma('foreign_keys=OFF');
  old.db.transaction(() => {
    installCaseV2(old.db, old.record);
    installCaseV3(old.db, old.record);
    installCaseV4(old.db);
  })();
  old.db.pragma('user_version=4');
  old.db.close();
  const state = await store.openWorkspace(root);
  assert.equal(state.cases[0].available, true);
  assert.deepEqual(state.cases[0].stats, { files: 1, flows: 1, pending: 0 });
  assert.equal(store.catalog.pragma('user_version', { simple: true }), 3);
  await store.openCase(old.record.id);
  assert.equal(store.caseDb.pragma('user_version', { simple: true }), 5);
  assert.deepEqual(store.caseDb.prepare('SELECT removed_at FROM source_file').get(), { removed_at: null });
  const catalogBackup = manifests(root);
  const caseBackup = manifests(path.dirname(old.file));
  assert.deepEqual(catalogBackup.map(item => [item.data.version, item.data.targetVersion]), [[2, 3]]);
  assert.deepEqual(caseBackup.map(item => [item.data.version, item.data.targetVersion]), [[4, 5]]);
  const { DesktopData } = require('../desktop-data.cjs');
  const data = new DesktopData(store);
  assert.deepEqual(data.removeMaterial(old.record.id, '1').case.stats, { files: 0, flows: 0, pending: 0 });
  assert.deepEqual(data.restoreMaterial(old.record.id, '1').case.stats, { files: 1, flows: 1, pending: 0 });
});

test('工作区旧编号NOCASE冲突阻止升级且不自动改名', async t => {
  const { root, store } = setup(t);
  const first = addV1(root, 'A1'), second = addV1(root, 'a1'); first.db.close(); second.db.close();
  await assert.rejects(() => store.openWorkspace(root), { code: 'FS_CASE_NUMBER_CONFLICT' });
  const db = new Database(path.join(root, 'workspace.sqlite'));
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.deepEqual(db.prepare('SELECT case_no FROM workspace_case ORDER BY case_no').all(), [{ case_no: 'A1' }, { case_no: 'a1' }]);
  db.close(); assert.equal(manifests(root).length, 0);
});

test('单案脏金额阻止升级，其他案件正常且保留混合版本待重试', async t => {
  const { root, store } = setup(t);
  const bad = addV1(root, 'BAD', true), good = addV1(root, 'GOOD');
  bad.db.exec('UPDATE fund_flow SET amount=0.5'); bad.db.close(); good.db.close();
  const state = await store.openWorkspace(root);
  assert.equal(state.cases.find(x => x.id === bad.record.id).available, false);
  assert.equal(state.cases.find(x => x.id === bad.record.id).error.code, 'FS_CASE_DATA');
  assert.equal(state.cases.find(x => x.id === good.record.id).available, true);
  const db = new Database(bad.file);
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.equal(db.prepare('SELECT amount FROM fund_flow').get().amount, 0.5); db.close();
  assert.equal(manifests(path.dirname(bad.file)).length, 0);
});

for (const phase of ['beforeBackup', 'afterInstall', 'beforeCommit']) {
  test(`升级${phase}故障回滚并可重试；不留下半v3结构`, async t => {
    let inject = true;
    const { root, store } = setup(t, { [phase]: () => { if (inject) throw new Error('injected failure'); } });
    const old = addV1(root, 'FAIL', true); old.db.close();
    await assert.rejects(() => store.openWorkspace(root), { code: 'FS_MIGRATION_FAILED' });
    const catalog = new Database(path.join(root, 'workspace.sqlite'));
    assert.equal(catalog.pragma('user_version', { simple: true }), 1);
    assert.equal(catalog.prepare("SELECT count(*) n FROM sqlite_master WHERE name='idx_workspace_case_number_nocase'").get().n, 0);
    catalog.close();
    const db = new Database(old.file);
    assert.equal(db.pragma('user_version', { simple: true }), 1); assert.equal(db.prepare('SELECT amount FROM fund_flow').get().amount, 12345); db.close();
    inject = false;
    assert.equal((await store.openWorkspace(root)).cases[0].available, true);
  });
}

test('单案升级安装后失败只回滚该案，兼容案件继续可用，重试生成另一份保留备份', async t => {
  let inject = true;
  const { root, store } = setup(t, { afterInstall: ({ filePath }) => {
    if (inject && filePath.endsWith('case.sqlite')) throw new Error('case install failure');
  } });
  const old = addV1(root, 'CASE-FAIL', true); old.db.close();
  const first = await store.openWorkspace(root);
  assert.equal(first.cases[0].available, false);
  const db = new Database(old.file);
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='case_summary'").get().n, 0);
  assert.equal(db.prepare('SELECT raw_amount_text FROM fund_flow').get().raw_amount_text, '123.45'); db.close();
  assert.equal(manifests(path.dirname(old.file))[0].data.result, 'rolled_back');
  inject = false;
  assert.equal((await store.listCases())[0].available, true);
  assert.equal(manifests(path.dirname(old.file)).length, 2);
});

test('提交后异常重启识别完整v5，不重复升级或自动恢复旧备份', async t => {
  let inject = true;
  const { root, store } = setup(t, { afterCommit: ({ filePath }) => {
    if (inject && filePath.endsWith('case.sqlite')) throw new Error('exit after commit');
  } });
  const old = addV1(root, 'COMMIT', true); old.db.close();
  const first = await store.openWorkspace(root);
  assert.equal(first.cases[0].available, false);
  const db = new Database(old.file);
  assert.equal(db.pragma('user_version', { simple: true }), 5);
  assert.equal(db.prepare('SELECT amount FROM fund_flow').get().amount, 12345); db.close();
  inject = false; store.close();
  assert.equal((await store.openWorkspace(root)).cases[0].available, true);
  assert.equal(manifests(path.dirname(old.file)).length, 1);
  assert.equal(manifests(path.dirname(old.file))[0].data.result, 'committed_followup_failed');
});

test('备份被改成另一案件UUID时身份验证拒绝，原库保持v1', async t => {
  const { root, store } = setup(t, { afterBackup: ({ backupPath }) => {
    const backup = new Database(backupPath);
    if (backup.prepare("SELECT 1 FROM sqlite_master WHERE name='desktop_case_identity'").get()) {
      backup.prepare('UPDATE desktop_case_identity SET case_uuid=?').run(randomUUID());
    }
    backup.close();
  } });
  const old = addV1(root, 'BACKUP-ID', true); old.db.close();
  assert.equal((await store.openWorkspace(root)).cases[0].error.code, 'FS_CASE_IDENTITY');
  const db = new Database(old.file);
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.equal(db.prepare('SELECT case_uuid FROM desktop_case_identity').get().case_uuid, old.record.id); db.close();
});

test('被截断的备份验证失败，原案v1与业务值保留', async t => {
  const { root, store } = setup(t);
  const old = addV1(root, 'CORRUPT', true); old.db.close();
  await store.openWorkspace(root); store.close();
  // Test a new v1 case once the catalog is independently upgraded.
  const next = addV1(root, 'CORRUPT2', true); next.db.close();
  const failing = new WorkspaceStore({ schemaPath, migrationHooks: { afterBackup: ({ backupPath }) => fs.truncateSync(backupPath, 16) } });
  t.after(() => failing.close());
  const state = await failing.openWorkspace(root);
  assert.equal(state.cases.find(x => x.id === next.record.id).available, false);
  const db = new Database(next.file);
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.equal(db.prepare('SELECT amount FROM fund_flow').get().amount, 12345); db.close();
  assert.equal(manifests(path.dirname(next.file))[0].data.result, 'rolled_back');
  failing.close();
});

test('未知v1结构即使版本身份正确也拒绝，不创建备份或改写结构', async t => {
  const { root, store } = setup(t);
  const old = addV1(root, 'UNKNOWN'); old.db.exec('CREATE TABLE unrecognized(value TEXT)'); old.db.close();
  const state = await store.openWorkspace(root);
  assert.equal(state.cases[0].error.code, 'FS_SCHEMA_UNKNOWN');
  assert.equal(manifests(path.dirname(old.file)).length, 0);
});

test('非空新目录取消不写，确认后重查；过期确认不能覆盖新增冲突', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fundsift-folder-'));
  const store = new WorkspaceStore({ schemaPath });
  t.after(() => { store.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(temp, 'notes.txt'), 'keep');
  const inspect = store.inspectWorkspace(temp);
  assert.equal(inspect.needsConfirmation, true);
  await assert.rejects(() => store.openWorkspace(temp), { code: 'FS_WORKSPACE_CONFIRM' });
  assert.deepEqual(fs.readdirSync(temp), ['notes.txt']);
  fs.writeFileSync(path.join(temp, 'later.txt'), 'later');
  await assert.rejects(() => store.openWorkspace(temp, { confirmationToken: inspect.confirmationToken }), { code: 'FS_WORKSPACE_CONFIRM' });
  assert.equal(fs.existsSync(path.join(temp, 'workspace.sqlite')), false);
  const confirmed = store.inspectWorkspace(temp);
  assert.deepEqual((await store.openWorkspace(temp, { confirmationToken: confirmed.confirmationToken })).cases, []);
  assert.equal(fs.readFileSync(path.join(temp, 'notes.txt'), 'utf8'), 'keep');
});
