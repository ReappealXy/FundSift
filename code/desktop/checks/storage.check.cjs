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

test('空工作区、建案、每案目录与关闭重开后持久化', t => {
  const { root, store } = setup(t);
  assert.deepEqual(store.openWorkspace(root), { workspacePath: fs.realpathSync(root), cases: [], currentCaseId: null });
  const first = store.createCase({ name: ' 合成案件 ', number: ' TEST-001 ' });
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
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.prepare('SELECT case_no FROM case_info WHERE id = 1').get().case_no, 'TEST-001');
  db.close();
  store.close();
  const reopened = store.openWorkspace(root);
  assert.equal(reopened.cases.length, 1);
  assert.equal(reopened.currentCaseId, first.id);
  assert.equal(reopened.cases[0].id, first.id);
  assert.equal(store.openCase(first.id).number, 'TEST-001');
});

test('编号工作区内精确判重，名称可重名，输入边界不创建目录', t => {
  const { root, store } = setup(t);
  store.openWorkspace(root);
  store.createCase({ name: '同名案件', number: 'A1' });
  assert.throws(() => store.createCase({ name: '另一案', number: ' A1 ' }), errorCode('FS_CASE_DUPLICATE'));
  assert.equal(store.createCase({ name: '同名案件', number: 'a1' }).number, 'a1');
  const before = fs.readdirSync(path.join(root, 'cases')).sort();
  for (const input of [null, {}, { name: '', number: 'B' }, { name: 'x'.repeat(41), number: 'B' },
    { name: '案件', number: ' ' }, { name: '案件', number: 'x'.repeat(31) }]) {
    assert.throws(() => store.createCase(input));
  }
  assert.deepEqual(fs.readdirSync(path.join(root, 'cases')).sort(), before);
  assert.equal(store.listCases().length, 2);
});

test('非法身份和不存在身份被拒，不能由路径穿越打开文件', t => {
  const { root, store } = setup(t);
  store.openWorkspace(root);
  const item = store.createCase({ name: '路径测试', number: 'P1' });
  for (const id of ['../workspace.sqlite', item.id.toUpperCase(), '', null]) {
    assert.throws(() => store.openCase(id), errorCode('FS_CASE_ID'));
  }
  assert.throws(() => store.openCase('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), errorCode('FS_CASE_NOT_FOUND'));
  assert.equal(store.currentCaseId, item.id);
});

test('案件丢失显示不可用而不是零，打开失败不建立替代空库', t => {
  const { root, store } = setup(t);
  store.openWorkspace(root);
  const first = store.createCase({ name: '仍可用', number: 'M1' });
  const second = store.createCase({ name: '将失联', number: 'M2' });
  store.openCase(first.id);
  fs.renameSync(casePath(root, second.id), casePath(root, second.id) + '.moved');
  const lost = store.listCases().find(item => item.id === second.id);
  assert.equal(lost.available, false);
  assert.equal(lost.stats, null);
  assert.equal(lost.error.code, 'FS_CASE_MISSING');
  assert.throws(() => store.openCase(second.id), errorCode('FS_CASE_MISSING'));
  assert.equal(store.currentCaseId, first.id);
  assert.equal(fs.existsSync(casePath(root, second.id)), false);
});

test('未知工作区版本被拒且旧数据不被覆盖', t => {
  const { temp, root, store } = setup(t);
  fs.mkdirSync(root);
  const file = path.join(root, 'workspace.sqlite');
  const db = new Database(file);
  db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('keep'); PRAGMA user_version = 99;");
  db.close();
  assert.throws(() => store.openWorkspace(root), errorCode('FS_WORKSPACE_VERSION'));
  const verify = new Database(file);
  assert.equal(verify.pragma('user_version', { simple: true }), 99);
  assert.equal(verify.prepare('SELECT value FROM sentinel').get().value, 'keep');
  verify.close();
  assert.equal(fs.readdirSync(temp).length, 1);
});

test('未来案件库版本及缺失UUID身份均不可打开', t => {
  const { root, store } = setup(t);
  store.openWorkspace(root);
  const versioned = store.createCase({ name: '版本用例', number: 'V1' });
  const identity = store.createCase({ name: '身份用例', number: 'V2' });
  store.close();
  let db = new Database(casePath(root, versioned.id));
  db.pragma('user_version = 99'); db.close();
  db = new Database(casePath(root, identity.id));
  db.prepare('UPDATE desktop_case_identity SET case_uuid = ?').run(versioned.id); db.close();
  const items = store.openWorkspace(root).cases;
  assert.equal(items.find(item => item.id === versioned.id).error.code, 'FS_CASE_VERSION');
  assert.equal(items.find(item => item.id === identity.id).error.code, 'FS_CASE_IDENTITY');
  assert.throws(() => store.openCase(versioned.id), errorCode('FS_CASE_VERSION'));
  assert.throws(() => store.openCase(identity.id), errorCode('FS_CASE_IDENTITY'));
});

test('切换到不兼容目录失败后原工作区仍可用', t => {
  const { temp, root, store } = setup(t);
  store.openWorkspace(root);
  const prior = store.createCase({ name: '切换保留', number: 'W1' });
  const rejectedRoot = path.join(temp, 'unsupported');
  fs.mkdirSync(rejectedRoot);
  const db = new Database(path.join(rejectedRoot, 'workspace.sqlite'));
  db.pragma('user_version = 99'); db.close();
  assert.throws(() => store.openWorkspace(rejectedRoot), errorCode('FS_WORKSPACE_VERSION'));
  assert.equal(store.workspacePath, fs.realpathSync(root));
  assert.equal(store.currentCaseId, prior.id);
  assert.equal(store.openCase(prior.id).number, 'W1');
});

test('案件目录路径被改写时拒绝，不允许跳到另案', t => {
  const { root, store } = setup(t);
  store.openWorkspace(root);
  const first = store.createCase({ name: '目录一', number: 'D1' });
  const second = store.createCase({ name: '目录二', number: 'D2' });
  store.close();
  const catalog = new Database(path.join(root, 'workspace.sqlite'));
  catalog.prepare('UPDATE workspace_case SET relative_path = ? WHERE id = ?').run('../elsewhere/case.sqlite', first.id);
  catalog.close();
  store.openWorkspace(root);
  assert.throws(() => store.openCase(first.id), errorCode('FS_CASE_IDENTITY'));
  assert.equal(store.openCase(second.id).id, second.id);
});

test('采用真实DDL的规则冻结与单位配对保护，WAL重开后仍生效', t => {
  const { root, store } = setup(t);
  store.openWorkspace(root);
  const item = store.createCase({ name: '约束测试', number: 'C1' });
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
  assert.equal(store.openWorkspace(root).cases[0].available, true);
});

test('统计只计同案同文件且done的current批次，不重复计历史或失败批次', t => {
  const { root, store } = setup(t);
  store.openWorkspace(root);
  const item = store.createCase({ name: '统计测试', number: 'S1' });
  store.close();
  const db = new Database(casePath(root, item.id));
  db.pragma('foreign_keys = ON');
  db.exec(`
    INSERT INTO format_rule(id,platform,format_key,amount_expr,source_unit,unit_scale) VALUES(1,'test','s','A','元',100);
    INSERT INTO source_file(id,case_id,file_name,file_sha256) VALUES(1,1,'synthetic.csv','hash1');
    INSERT INTO source_file(id,case_id,file_name,file_sha256) VALUES(2,1,'synthetic2.csv','hash2');
    INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status) VALUES(1,1,1,'t','v1','done');
    INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status) VALUES(2,1,1,'t','v1','done');
    INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status) VALUES(3,1,2,'t','v1','failed');
    UPDATE source_file SET current_batch_id=2 WHERE id=1;
    UPDATE source_file SET current_batch_id=3 WHERE id=2;
    INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,status) VALUES(1,1,1,1,1,'old','confirmed');
    INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,status) VALUES(1,2,1,1,1,'new1','confirmed');
    INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,status) VALUES(1,2,1,1,1,'new2','pending');
    INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,status) VALUES(1,3,2,1,1,'failed','pending');
  `);
  db.close();
  assert.deepEqual(store.openWorkspace(root).cases[0].stats, { files: 2, flows: 2, pending: 1 });
});

test('建案中途DDL失败只清理本次新目录，原案和用户文件保持', t => {
  const { temp, root, store } = setup(t);
  store.openWorkspace(root);
  const prior = store.createCase({ name: '原案保留', number: 'F1' });
  const sentinel = path.join(root, 'cases', 'user-notes.txt');
  fs.writeFileSync(sentinel, 'keep');
  const broken = path.join(temp, 'broken.sql');
  fs.writeFileSync(broken, 'THIS IS NOT SQL;');
  const failing = new WorkspaceStore({ schemaPath: broken });
  t.after(() => failing.close());
  failing.openWorkspace(root);
  assert.throws(() => failing.createCase({ name: '失败案', number: 'F2' }), errorCode('FS_CASE_CREATE'));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(path.join(root, 'cases')).sort(), [prior.id, 'user-notes.txt'].sort());
  assert.equal(store.listCases().length, 1);
  assert.equal(store.openCase(prior.id).number, 'F1');
  failing.close();
});

test('工作区索引丢失时不建立假空工作区', t => {
  const { root, store } = setup(t);
  store.openWorkspace(root);
  const item = store.createCase({ name: '索引失联', number: 'L1' });
  store.close();
  fs.renameSync(path.join(root, 'workspace.sqlite'), path.join(root, 'workspace.sqlite.moved'));
  assert.throws(() => store.openWorkspace(root), errorCode('FS_WORKSPACE_INDEX_MISSING'));
  assert.equal(fs.existsSync(path.join(root, 'workspace.sqlite')), false);
  assert.ok(fs.existsSync(casePath(root, item.id)));
});

test('重启恢复仅接纳完整的新案日志，未完成产物保留不误删', t => {
  const { root, store } = setup(t);
  store.openWorkspace(root);
  const item = store.createCase({ name: '恢复测试', number: 'R1' });
  store.close();
  const catalog = new Database(path.join(root, 'workspace.sqlite'));
  const row = catalog.prepare('SELECT * FROM workspace_case WHERE id = ?').get(item.id);
  catalog.prepare('DELETE FROM workspace_case WHERE id = ?').run(item.id);
  catalog.close();
  fs.writeFileSync(path.join(root, 'cases', item.id, '.fundsift-create.json'), JSON.stringify({ version: 1, ...row }));
  const incomplete = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  fs.mkdirSync(path.join(root, 'cases', incomplete));
  fs.writeFileSync(path.join(root, 'cases', incomplete, '.fundsift-create.json'), '{unfinished');
  const state = store.openWorkspace(root);
  assert.equal(state.cases.length, 1);
  assert.equal(state.cases[0].id, item.id);
  assert.equal(fs.existsSync(path.join(root, 'cases', item.id, '.fundsift-create.json')), false);
  assert.ok(fs.existsSync(path.join(root, 'cases', incomplete, '.fundsift-create.json')));
});

test('恢复模式下整目录移动或空工作区索引失联均拒绝，不能重建空数据', t => {
  const { temp, root, store } = setup(t);
  store.openWorkspace(root);
  const item = store.createCase({ name: '目录移动用例', number: 'RESTORE-1' });
  store.close();
  const moved = root + '-moved';
  fs.renameSync(root, moved);
  assert.throws(() => store.openWorkspace(root, { allowCreate: false }), errorCode('FS_WORKSPACE_MISSING'));
  assert.equal(fs.existsSync(root), false);
  assert.ok(fs.existsSync(casePath(moved, item.id)));
  const emptyRoot = path.join(temp, 'empty-data');
  store.openWorkspace(emptyRoot);
  store.close();
  fs.renameSync(path.join(emptyRoot, 'workspace.sqlite'), path.join(emptyRoot, 'workspace.sqlite.moved'));
  assert.throws(() => store.openWorkspace(emptyRoot, { allowCreate: false }), errorCode('FS_WORKSPACE_INDEX_MISSING'));
  assert.equal(fs.existsSync(path.join(emptyRoot, 'workspace.sqlite')), false);
  assert.deepEqual(fs.readdirSync(path.join(emptyRoot, 'cases')), []);
});

test('同工作区刷新保留当前案件连接，恢复后返回真实已打开案件', t => {
  const { root, store } = setup(t);
  store.openWorkspace(root);
  const item = store.createCase({ name: '刷新保留用例', number: 'REFRESH-1' });
  const connection = store.caseDb;
  const catalog = store.catalog;
  const refreshed = store.openWorkspace(root, { allowCreate: false });
  assert.equal(refreshed.currentCaseId, item.id);
  assert.strictEqual(store.caseDb, connection);
  assert.strictEqual(store.catalog, catalog);
  assert.equal(connection.open, true);
  store.close();
  const restored = store.openWorkspace(root, { allowCreate: false });
  assert.equal(restored.currentCaseId, item.id);
  assert.equal(store.currentCaseId, item.id);
  assert.equal(store.caseDb.open, true);
  assert.equal(store.caseDb.prepare('SELECT case_no FROM case_info WHERE id=1').get().case_no, 'REFRESH-1');
  // Even an already-open workspace must check the file still exists before refreshing.
  const catalogPath = path.join(root, 'workspace.sqlite');
  const restoredConnection = store.caseDb, originalExists = fs.existsSync;
  fs.existsSync = candidate => candidate === catalogPath ? false : originalExists(candidate);
  try {
    assert.throws(() => store.openWorkspace(root, { allowCreate: false }), errorCode('FS_WORKSPACE_INDEX_MISSING'));
    assert.strictEqual(store.caseDb, restoredConnection);
  } finally { fs.existsSync = originalExists; }
});
