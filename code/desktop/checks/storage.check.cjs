'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { WorkspaceStore } = require('../storage.cjs');

const schemaPath = path.resolve(__dirname, '../../ddl_extract_check.sql');
const newStore = () => new WorkspaceStore({ schemaPath });
const casePath = (root, id) => path.join(root, 'cases', id, 'case.sqlite');

function setup(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fundsift-m0-'));
  const root = path.join(temp, 'data');
  const store = newStore();
  t.after(() => { store.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  return { temp, root, store };
}

function errorCode(code) { return error => error.code === code && /[\u3400-\u9fff]/.test(error.message); }

function fileTree(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => ({
    name: entry.name,
    content: entry.isDirectory() ? fileTree(path.join(directory, entry.name)) : fs.readFileSync(path.join(directory, entry.name)).toString('base64')
  }));
}

test('空工作区、建案、每案目录与关闭重开后持久化', async t => {
  const { root, store } = setup(t);
  assert.deepEqual((await store.openWorkspace(root)), { workspacePath: fs.realpathSync(root), cases: [], currentCaseId: null });
  const first = (await store.createCase({ name: ' 合成案件 ', number: ' TEST-001 ' }));
  assert.equal(first.name, '合成案件');
  assert.equal(first.number, 'TEST-001');
  assert.equal(first.available, true);
  assert.deepEqual(first.stats, { files: 0, flows: 0, pending: 0 });
  assert.equal(first.error, null);
  assert.ok(first.openedAt);
  assert.ok(fs.statSync(path.join(root, 'cases', first.id, 'archive')).isDirectory());
  assert.ok(fs.statSync(path.join(root, 'cases', first.id, 'exports')).isDirectory());
  assert.doesNotThrow(() => JSON.stringify(first));
  const db = new Database(casePath(root, first.id));
  assert.equal(db.pragma('user_version', { simple: true }), 3);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.prepare('SELECT case_no FROM case_info WHERE id = 1').get().case_no, 'TEST-001');
  db.close();
  store.close();
  const reopened = (await store.openWorkspace(root));
  assert.equal(reopened.cases.length, 1);
  assert.equal(reopened.currentCaseId, first.id);
  assert.equal(reopened.cases[0].id, first.id);
  assert.equal((await store.openCase(first.id)).number, 'TEST-001');
});

test('编号工作区内仅ASCII大小写判重，名称可重名，输入边界不创建目录', async t => {
  const { root, store } = setup(t);
  (await store.openWorkspace(root));
  (await store.createCase({ name: '同名案件', number: 'A1' }));
  await assert.rejects(() => store.createCase({ name: '另一案', number: ' A1 ' }), errorCode('FS_CASE_DUPLICATE'));
  await assert.rejects(() => store.createCase({ name: '同名案件', number: 'a1' }), errorCode('FS_CASE_DUPLICATE'));
  assert.equal((await store.createCase({ name: '同名案件', number: 'Ä' })).number, 'Ä');
  assert.equal((await store.createCase({ name: '同名案件', number: 'ä' })).number, 'ä');
  assert.equal((await store.createCase({ name: '同名案件', number: 'Ａ1' })).number, 'Ａ1');
  const before = fs.readdirSync(path.join(root, 'cases')).sort();
  for (const input of [null, {}, { name: '', number: 'B' }, { name: 'x'.repeat(41), number: 'B' },
    { name: '案件', number: ' ' }, { name: '案件', number: 'x'.repeat(31) }]) {
    await assert.rejects(() => store.createCase(input));
  }
  assert.deepEqual(fs.readdirSync(path.join(root, 'cases')).sort(), before);
  assert.equal((await store.listCases()).length, 4);
});

test('非法身份和不存在身份被拒，不能由路径穿越打开文件', async t => {
  const { root, store } = setup(t);
  (await store.openWorkspace(root));
  const item = (await store.createCase({ name: '路径测试', number: 'P1' }));
  for (const id of ['../workspace.sqlite', item.id.toUpperCase(), '', null]) {
    await assert.rejects(() => store.openCase(id), errorCode('FS_CASE_ID'));
  }
  await assert.rejects(() => store.openCase('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), errorCode('FS_CASE_NOT_FOUND'));
  assert.equal(store.currentCaseId, item.id);
});

test('案件丢失显示不可用而不是零，打开失败不建立替代空库', async t => {
  const { root, store } = setup(t);
  (await store.openWorkspace(root));
  const first = (await store.createCase({ name: '仍可用', number: 'M1' }));
  const second = (await store.createCase({ name: '将失联', number: 'M2' }));
  (await store.openCase(first.id));
  fs.renameSync(casePath(root, second.id), casePath(root, second.id) + '.moved');
  const lost = (await store.listCases()).find(item => item.id === second.id);
  assert.equal(lost.available, false);
  assert.equal(lost.stats, null);
  assert.equal(lost.error.code, 'FS_CASE_MISSING');
  await assert.rejects(() => store.openCase(second.id), errorCode('FS_CASE_MISSING'));
  assert.equal(store.currentCaseId, first.id);
  assert.equal(fs.existsSync(casePath(root, second.id)), false);
});

test('未知工作区版本被拒且旧数据不被覆盖', async t => {
  const { temp, root, store } = setup(t);
  fs.mkdirSync(root);
  const file = path.join(root, 'workspace.sqlite');
  const db = new Database(file);
  db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('keep'); PRAGMA user_version = 99;");
  db.close();
  await assert.rejects(() => store.openWorkspace(root), errorCode('FS_WORKSPACE_VERSION'));
  const verify = new Database(file);
  assert.equal(verify.pragma('user_version', { simple: true }), 99);
  assert.equal(verify.prepare('SELECT value FROM sentinel').get().value, 'keep');
  verify.close();
  assert.equal(fs.readdirSync(temp).length, 1);
});

test('未来案件库版本及缺失UUID身份均不可打开', async t => {
  const { root, store } = setup(t);
  (await store.openWorkspace(root));
  const versioned = (await store.createCase({ name: '版本用例', number: 'V1' }));
  const identity = (await store.createCase({ name: '身份用例', number: 'V2' }));
  store.close();
  let db = new Database(casePath(root, versioned.id));
  db.pragma('user_version = 99'); db.close();
  db = new Database(casePath(root, identity.id));
  assert.throws(() => db.prepare('UPDATE desktop_case_identity SET case_uuid = ?').run(versioned.id));
  // Deliberately remove a protection to simulate an already damaged external DB.
  db.exec('DROP TRIGGER v2_case_identity_update');
  db.prepare('UPDATE desktop_case_identity SET case_uuid = ?').run(versioned.id);
  db.close();
  const items = (await store.openWorkspace(root)).cases;
  assert.equal(items.find(item => item.id === versioned.id).error.code, 'FS_CASE_VERSION');
  assert.equal(items.find(item => item.id === identity.id).error.code, 'FS_SCHEMA_UNKNOWN');
  await assert.rejects(() => store.openCase(versioned.id), errorCode('FS_CASE_VERSION'));
  await assert.rejects(() => store.openCase(identity.id), errorCode('FS_SCHEMA_UNKNOWN'));
});

test('切换到不兼容目录失败后原工作区仍可用', async t => {
  const { temp, root, store } = setup(t);
  (await store.openWorkspace(root));
  const prior = (await store.createCase({ name: '切换保留', number: 'W1' }));
  const rejectedRoot = path.join(temp, 'unsupported');
  fs.mkdirSync(rejectedRoot);
  const db = new Database(path.join(rejectedRoot, 'workspace.sqlite'));
  db.pragma('user_version = 99'); db.close();
  await assert.rejects(() => store.openWorkspace(rejectedRoot), errorCode('FS_WORKSPACE_VERSION'));
  assert.equal(store.workspacePath, fs.realpathSync(root));
  assert.equal(store.currentCaseId, prior.id);
  assert.equal((await store.openCase(prior.id)).number, 'W1');
});

test('案件目录路径被改写时拒绝，不允许跳到另案', async t => {
  const { root, store } = setup(t);
  (await store.openWorkspace(root));
  const first = (await store.createCase({ name: '目录一', number: 'D1' }));
  const second = (await store.createCase({ name: '目录二', number: 'D2' }));
  store.close();
  const catalog = new Database(path.join(root, 'workspace.sqlite'));
  catalog.prepare('UPDATE workspace_case SET relative_path = ? WHERE id = ?').run('../elsewhere/case.sqlite', first.id);
  catalog.close();
  (await store.openWorkspace(root));
  await assert.rejects(() => store.openCase(first.id), errorCode('FS_CASE_IDENTITY'));
  assert.equal((await store.openCase(second.id)).id, second.id);
});

test('采用真实DDL的规则冻结与单位配对保护，WAL重开后仍生效', async t => {
  const { root, store } = setup(t);
  (await store.openWorkspace(root));
  const item = (await store.createCase({ name: '约束测试', number: 'C1' }));
  store.close();
  let db = new Database(casePath(root, item.id));
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO format_rule(id,platform,format_key,amount_expr,source_unit,unit_scale,verified,frozen)
    VALUES(1,'synthetic','f1','A','元',100,1,1)`).run();
  db.prepare(`INSERT INTO format_rule(id,platform,format_key,amount_expr,source_unit,unit_scale)
    VALUES(2,'synthetic','f2','E','元',100)`).run();
  assert.throws(() => db.exec("UPDATE format_rule SET frozen=0 WHERE id=1"), /frozen/);
  assert.throws(() => db.exec('DELETE FROM format_rule WHERE id=1'), /frozen/);
  assert.throws(() => db.exec("UPDATE format_rule SET source_unit='分' WHERE id=2"), /mismatch/);
  db.close();
  db = new Database(casePath(root, item.id));
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.prepare('SELECT count(*) AS n FROM format_rule').get().n, 2);
  assert.throws(() => db.exec("UPDATE format_rule SET amount_expr='B' WHERE id=1"), /frozen/);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  db.close();
  assert.equal((await store.openWorkspace(root)).cases[0].available, true);
});

test('坏current写入被拒；受控业务事务统计只计当前done，不叠加历史批次', async t => {
  const { runCaseIntegrityTransaction } = require('../hardening.cjs');
  const { root, store } = setup(t);
  await store.openWorkspace(root);
  const item = await store.createCase({ name: '统计测试', number: 'S1' });
  store.close();
  const db = new Database(casePath(root, item.id));
  require('../foundation.cjs').configureFoundation(db);
  db.pragma('foreign_keys=ON');
  const record = { id:item.id, case_no:item.number, case_name:item.name, created_at:item.createdAt, updated_at:item.updatedAt };
  runCaseIntegrityTransaction(db,record,()=>{
    db.exec(`
      INSERT INTO format_rule(id,platform,format_key,amount_expr,source_unit,unit_scale) VALUES(1,'test','s','A','元',100);
      INSERT INTO source_file(id,case_id,file_name,file_sha256) VALUES(1,1,'synthetic.csv','hash1');
      INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status) VALUES(1,1,1,'t','v1','done');
      INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status) VALUES(2,1,1,'t','v1','done');
      INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status) VALUES(3,1,1,'t','v1','failed');
      UPDATE import_batch SET total_rows=1,imported_rows=1,skipped_rows=0 WHERE id=1;
      UPDATE import_batch SET total_rows=2,imported_rows=2,skipped_rows=0 WHERE id=2;
      UPDATE source_file SET current_batch_id=2, first_batch_id=1, status='imported' WHERE id=1;
      INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,amount,direction,status) VALUES(1,1,1,1,1,'old',100,'进','confirmed');
      INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,amount,direction,status) VALUES(1,2,1,1,1,'new1',100,'进','confirmed');
      INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,status) VALUES(1,2,1,1,1,'new2','pending');
      INSERT INTO pending_reason(fund_flow_id,reason_code,created_at) VALUES(3,'synthetic','t');
    `);
  });
  assert.throws(()=>db.exec('UPDATE source_file SET current_batch_id=3 WHERE id=1'));
  db.close();
  assert.deepEqual((await store.openWorkspace(root)).cases[0].stats,{files:1,flows:2,pending:1});
});

test('建案中途DDL失败只清理本次新目录，原案和用户文件保持', async t => {
  const { temp, root, store } = setup(t);
  (await store.openWorkspace(root));
  const prior = (await store.createCase({ name: '原案保留', number: 'F1' }));
  const sentinel = path.join(root, 'cases', 'user-notes.txt');
  fs.writeFileSync(sentinel, 'keep');
  const broken = path.join(temp, 'broken.sql');
  fs.writeFileSync(broken, 'THIS IS NOT SQL;');
  const failing = new WorkspaceStore({ schemaPath: broken });
  t.after(() => failing.close());
  (await failing.openWorkspace(root));
  await assert.rejects(() => failing.createCase({ name: '失败案', number: 'F2' }), errorCode('FS_CASE_CREATE'));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(path.join(root, 'cases')).sort(), [prior.id, 'user-notes.txt'].sort());
  assert.equal((await store.listCases()).length, 1);
  assert.equal((await store.openCase(prior.id)).number, 'F1');
  failing.close();
});

test('工作区索引丢失时不建立假空工作区', async t => {
  const { root, store } = setup(t);
  (await store.openWorkspace(root));
  const item = (await store.createCase({ name: '索引失联', number: 'L1' }));
  store.close();
  fs.renameSync(path.join(root, 'workspace.sqlite'), path.join(root, 'workspace.sqlite.moved'));
  await assert.rejects(() => store.openWorkspace(root), errorCode('FS_WORKSPACE_INDEX_MISSING'));
  assert.equal(fs.existsSync(path.join(root, 'workspace.sqlite')), false);
  assert.ok(fs.existsSync(casePath(root, item.id)));
});

test('重启恢复仅接纳完整的新案日志，未完成产物保留不误删', async t => {
  const { root, store } = setup(t);
  (await store.openWorkspace(root));
  const item = (await store.createCase({ name: '恢复测试', number: 'R1' }));
  store.close();
  const catalog = new Database(path.join(root, 'workspace.sqlite'));
  const row = catalog.prepare('SELECT * FROM workspace_case WHERE id = ?').get(item.id);
  catalog.prepare('DELETE FROM workspace_case WHERE id = ?').run(item.id);
  catalog.close();
  fs.writeFileSync(path.join(root, 'cases', item.id, '.fundsift-create.json'), JSON.stringify({ version: 1, ...row }));
  const incomplete = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  fs.mkdirSync(path.join(root, 'cases', incomplete));
  fs.writeFileSync(path.join(root, 'cases', incomplete, '.fundsift-create.json'), '{unfinished');
  const state = (await store.openWorkspace(root));
  assert.equal(state.cases.length, 1);
  assert.equal(state.cases[0].id, item.id);
  assert.equal(fs.existsSync(path.join(root, 'cases', item.id, '.fundsift-create.json')), false);
  assert.ok(fs.existsSync(path.join(root, 'cases', incomplete, '.fundsift-create.json')));
});

test('恢复模式下整目录移动或空工作区索引失联均拒绝，不能重建空数据', async t => {
  const { temp, root, store } = setup(t);
  (await store.openWorkspace(root));
  const item = (await store.createCase({ name: '目录移动用例', number: 'RESTORE-1' }));
  store.close();
  const moved = root + '-moved';
  fs.renameSync(root, moved);
  await assert.rejects(() => store.openWorkspace(root, { allowCreate: false }), errorCode('FS_WORKSPACE_MISSING'));
  assert.equal(fs.existsSync(root), false);
  assert.ok(fs.existsSync(casePath(moved, item.id)));
  const emptyRoot = path.join(temp, 'empty-data');
  (await store.openWorkspace(emptyRoot));
  store.close();
  fs.renameSync(path.join(emptyRoot, 'workspace.sqlite'), path.join(emptyRoot, 'workspace.sqlite.moved'));
  await assert.rejects(() => store.openWorkspace(emptyRoot, { allowCreate: false }), errorCode('FS_WORKSPACE_INDEX_MISSING'));
  assert.equal(fs.existsSync(path.join(emptyRoot, 'workspace.sqlite')), false);
  assert.deepEqual(fs.readdirSync(path.join(emptyRoot, 'cases')), []);
});

test('同工作区刷新保留当前案件连接，恢复后返回真实已打开案件', async t => {
  const { root, store } = setup(t);
  (await store.openWorkspace(root));
  const item = (await store.createCase({ name: '刷新保留用例', number: 'REFRESH-1' }));
  const connection = store.caseDb;
  const catalog = store.catalog;
  const refreshed = (await store.openWorkspace(root, { allowCreate: false }));
  assert.equal(refreshed.currentCaseId, item.id);
  assert.strictEqual(store.caseDb, connection);
  assert.strictEqual(store.catalog, catalog);
  assert.equal(connection.open, true);
  store.close();
  const restored = (await store.openWorkspace(root, { allowCreate: false }));
  assert.equal(restored.currentCaseId, item.id);
  assert.equal(store.currentCaseId, item.id);
  assert.equal(store.caseDb.open, true);
  assert.equal(store.caseDb.prepare('SELECT case_no FROM case_info WHERE id=1').get().case_no, 'REFRESH-1');
  // Even an already-open workspace must check the file still exists before refreshing.
  const catalogPath = path.join(root, 'workspace.sqlite');
  const restoredConnection = store.caseDb, originalExists = fs.existsSync;
  fs.existsSync = candidate => candidate === catalogPath ? false : originalExists(candidate);
  try {
    await assert.rejects(() => store.openWorkspace(root, { allowCreate: false }), errorCode('FS_WORKSPACE_INDEX_MISSING'));
    assert.strictEqual(store.caseDb, restoredConnection);
  } finally { fs.existsSync = originalExists; }
});

test('误选cases、单案或archive/exports及其后代时检查和打开均拒绝，原文件无变化', async t => {
  const { temp, root, store } = setup(t);
  await store.openWorkspace(root);
  const item = await store.createCase({ name: '内部位置保护', number: 'INNER-1' });
  store.close();
  const caseDirectory = path.join(root, 'cases', item.id);
  const sourceOnly = path.join(temp, 'copied-case');
  fs.mkdirSync(sourceOnly);
  fs.copyFileSync(path.join(caseDirectory, 'case.sqlite'), path.join(sourceOnly, 'case.sqlite'));
  const before = fileTree(temp);
  for (const target of [path.join(root, 'cases'), caseDirectory,
    path.join(caseDirectory, 'archive'), path.join(caseDirectory, 'exports'),
    path.join(caseDirectory, 'archive', 'not-created'), path.join(root, 'cases', 'not-created'), sourceOnly]) {
    assert.throws(() => store.inspectWorkspace(target), errorCode('FS_WORKSPACE_INNER_FOLDER'));
    await assert.rejects(() => store.openWorkspace(target, { confirmationToken: 'forced' }), errorCode('FS_WORKSPACE_INNER_FOLDER'));
    await assert.rejects(() => store.openWorkspace(target, { allowCreate: false }), errorCode('FS_WORKSPACE_INNER_FOLDER'));
  }
  assert.deepEqual(fileTree(temp), before);
});

test('空工作区身份尚在WAL时也阻止选择cases，检查不生成或修改任何文件', async t => {
  const { temp, root, store } = setup(t);
  await store.openWorkspace(root);
  const header = fs.readFileSync(path.join(root, 'workspace.sqlite'));
  assert.equal(header.readUInt32BE(68), 0);
  assert.ok(fs.existsSync(path.join(root, 'workspace.sqlite-wal')));
  const before = fileTree(temp);
  const fresh = newStore();
  try {
    assert.throws(() => fresh.inspectWorkspace(path.join(root, 'cases')), errorCode('FS_WORKSPACE_INNER_FOLDER'));
    await assert.rejects(() => fresh.openWorkspace(path.join(root, 'cases')), errorCode('FS_WORKSPACE_INNER_FOLDER'));
    assert.deepEqual(fileTree(temp), before);
  } finally { fresh.close(); }
});

test('索引失联或建案未完成时，确证案件结构仍不能被当作新的存放位置', async t => {
  const { temp, root, store } = setup(t);
  await store.openWorkspace(root);
  const item = await store.createCase({ name: '失联位置保护', number: 'INNER-2' });
  store.close();
  fs.renameSync(path.join(root, 'workspace.sqlite'), path.join(root, 'workspace.sqlite.moved'));
  const incomplete = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const incompletePath = path.join(root, 'cases', incomplete);
  fs.mkdirSync(incompletePath);
  fs.mkdirSync(path.join(incompletePath, 'archive'));
  fs.writeFileSync(path.join(incompletePath, '.fundsift-create.json'), JSON.stringify({
    version: 1, id: incomplete, relative_path: `cases/${incomplete}/case.sqlite`
  }));
  const before = fileTree(temp);
  for (const target of [path.join(root, 'cases'), path.join(root, 'cases', item.id), incompletePath, path.join(incompletePath, 'archive')]) {
    assert.throws(() => store.inspectWorkspace(target), errorCode('FS_WORKSPACE_INNER_FOLDER'));
    await assert.rejects(() => store.openWorkspace(target), errorCode('FS_WORKSPACE_INNER_FOLDER'));
  }
  assert.deepEqual(fileTree(temp), before);
});

test('仅同名cases/archive/exports的普通文件夹和合法根位置仍可选择', async t => {
  const { temp, store } = setup(t);
  const generic = path.join(temp, 'ordinary');
  fs.mkdirSync(generic);
  for (const name of ['cases', 'archive', 'exports']) {
    const target = path.join(generic, name);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'user-notes.txt'), 'keep');
    const inspection = store.inspectWorkspace(target);
    assert.equal(inspection.needsConfirmation, true);
    assert.deepEqual((await store.openWorkspace(target, { confirmationToken: inspection.confirmationToken })).cases, []);
    assert.equal(store.inspectWorkspace(target).hasWorkspace, true);
    store.close();
    assert.deepEqual((await store.openWorkspace(target, { allowCreate: false })).cases, []);
    store.close();
    assert.equal(fs.readFileSync(path.join(target, 'user-notes.txt'), 'utf8'), 'keep');
  }
});

test('确认期间目标新增case.sqlite或检查后变为案件内部时，写入前复查拒绝', async t => {
  const { temp, store } = setup(t);
  const target = path.join(temp, 'confirmation-target');
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'notes.txt'), 'keep');
  const inspection = store.inspectWorkspace(target);
  fs.writeFileSync(path.join(target, 'case.sqlite'), 'existing case data');
  let before = fileTree(temp);
  await assert.rejects(() => store.openWorkspace(target, { confirmationToken: inspection.confirmationToken }), errorCode('FS_WORKSPACE_INNER_FOLDER'));
  assert.deepEqual(fileTree(temp), before);
  fs.unlinkSync(path.join(target, 'case.sqlite'));
  const inspect = store.inspectWorkspace.bind(store);
  store.inspectWorkspace = (...args) => {
    const result = inspect(...args);
    fs.writeFileSync(path.join(target, 'case.sqlite'), 'case appeared after inspection');
    before = fileTree(temp);
    return result;
  };
  await assert.rejects(() => store.openWorkspace(target, { confirmationToken: inspection.confirmationToken }), errorCode('FS_WORKSPACE_INNER_FOLDER'));
  assert.deepEqual(fileTree(temp), before);
  assert.equal(fs.existsSync(path.join(target, 'workspace.sqlite')), false);
  assert.equal(fs.existsSync(path.join(target, 'cases')), false);
});

test('系统确认完成后目标变为单案文件夹，实际选择流程拒绝且不创建嵌套案件', async t => {
  const { chooseWorkspace } = require('../workspace-choice.cjs');
  const { temp, store } = setup(t);
  const target = path.join(temp, 'dialog-target');
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'notes.txt'), 'keep');
  let before;
  await assert.rejects(() => chooseWorkspace({ window: {},
    worker: { request: (method, ...args) => store[method](...args) },
    dialog: {
      async showOpenDialog(_window, options) {
        assert.equal(options.title, '选择数据存放文件夹');
        return { filePaths: [target] };
      },
      async showMessageBox(_window, options) {
        assert.equal(options.defaultId, 1);
        assert.deepEqual(options.buttons, ['在此创建', '重新选择', '取消']);
        assert.match(options.detail, /数据存放位置/);
        fs.writeFileSync(path.join(target, 'case.sqlite'), 'newly appeared case');
        before = fileTree(temp);
        return { response: 0 };
      }
    }
  }), errorCode('FS_WORKSPACE_INNER_FOLDER'));
  assert.deepEqual(fileTree(temp), before);
});

test('关闭后整份工作区复制到新根，新Store读取身份和业务统计保持一致', async t => {
  const { runCaseIntegrityTransaction } = require('../hardening.cjs');
  const { temp, root, store } = setup(t);
  await store.openWorkspace(root);
  const item = await store.createCase({ name: '整份复制验证', number: 'COPY-1' });
  store.close();
  const db = new Database(casePath(root, item.id));
  require('../foundation.cjs').configureFoundation(db);
  db.pragma('foreign_keys=ON');
  const record = { id: item.id, case_no: item.number, case_name: item.name, created_at: item.createdAt, updated_at: item.updatedAt };
  runCaseIntegrityTransaction(db, record, () => db.exec(`
    INSERT INTO format_rule(id,platform,format_key,amount_expr,source_unit,unit_scale) VALUES(1,'test','copy','A','元',100);
    INSERT INTO source_file(id,case_id,file_name,file_sha256) VALUES(1,1,'copy.csv','copyhash');
    INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status,total_rows,imported_rows,skipped_rows) VALUES(1,1,1,'t','v1','done',1,1,0);
    INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,amount,direction) VALUES(1,1,1,1,1,'row1',12345,'进');
    UPDATE source_file SET first_batch_id=1,current_batch_id=1,status='imported' WHERE id=1;
  `));
  db.close();
  const original = (await store.openWorkspace(root)).cases;
  store.close();
  const copied = path.join(temp, 'copied-data');
  fs.cpSync(root, copied, { recursive: true, errorOnExist: true, force: false });
  const fresh = newStore();
  try {
    const moved = await fresh.openWorkspace(copied, { allowCreate: false });
    assert.equal(moved.workspacePath, fs.realpathSync(copied));
    const view = rows => rows.map(({ id, name, number, createdAt, updatedAt, available, stats, summaryState }) =>
      ({ id, name, number, createdAt, updatedAt, available, stats, summaryState }));
    assert.deepEqual(view(moved.cases), view(original));
    assert.deepEqual(moved.cases[0].stats, { files: 1, flows: 1, pending: 0 });
    assert.equal((await fresh.openCase(item.id)).id, item.id);
  } finally { fresh.close(); }
});
