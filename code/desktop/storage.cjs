'use strict';

// This module is synchronous by design. Only the utility process may load it.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 1;
const WORKSPACE_APP_ID = 0x46535753;
const CASE_APP_ID = 0x46534341;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MARKER = '.fundsift-create.json';
const CATALOG_SCHEMA = `
  CREATE TABLE workspace_case (
    id TEXT PRIMARY KEY,
    case_no TEXT NOT NULL UNIQUE,
    case_name TEXT NOT NULL,
    relative_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_opened_at TEXT
  );
`;

function failure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function wrap(error, code, message) {
  if (error && typeof error.code === 'string' && error.code.startsWith('FS_')) return error;
  return failure(code, message, error);
}

function configure(db) {
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
}

function isDirectory(filePath) {
  try { return fs.lstatSync(filePath).isDirectory(); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertRegularFile(filePath, missingCode, missingMessage) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch (error) {
    if (error.code === 'ENOENT') throw failure(missingCode, missingMessage, error);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw failure('FS_UNSAFE_PATH', '数据库位置不是普通文件，已停止打开。');
  }
}

function validateInput(input) {
  if (!input || typeof input.name !== 'string' || typeof input.number !== 'string') {
    throw failure('FS_CASE_INPUT', '请填写案件名称和案件编号。');
  }
  const name = input.name.trim(), number = input.number.trim();
  if (!name || name.length > 40) throw failure('FS_CASE_NAME', '案件名称不能为空，且不能超过 40 个字符。');
  if (!number || number.length > 30) throw failure('FS_CASE_NUMBER', '案件编号不能为空，且不能超过 30 个字符。');
  return { name, number };
}

class WorkspaceStore {
  constructor({ schemaPath }) {
    this.schemaPath = path.resolve(schemaPath);
    this.workspacePath = null;
    this.catalog = null;
    this.caseDb = null;
    this.currentCaseId = null;
  }

  openWorkspace(rootPath, { allowCreate = true } = {}) {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
      throw failure('FS_WORKSPACE_PATH', '请选择一个完整的数据目录路径。');
    }
    const resolved = path.resolve(rootPath);
    let nextCatalog;
    try {
      // Only an explicit first-time folder choice may create a workspace.
      if (allowCreate) fs.mkdirSync(resolved, { recursive: true });
      else if (!fs.existsSync(resolved)) {
        throw failure('FS_WORKSPACE_MISSING', '已保存的数据目录已失联，请恢复原目录后重试；不会建立空工作区替代。');
      }
      if (!isDirectory(resolved)) throw failure('FS_WORKSPACE_PATH', '选择的位置不是普通目录。');
      const rootReal = fs.realpathSync(resolved);
      const casesPath = path.join(rootReal, 'cases');
      if (fs.existsSync(casesPath) && !isDirectory(casesPath)) {
        throw failure('FS_UNSAFE_PATH', '数据目录中的 cases 位置已被其他文件占用。');
      }
      const catalogPath = path.join(rootReal, 'workspace.sqlite');
      const exists = fs.existsSync(catalogPath);
      if (!exists && !allowCreate) {
        throw failure('FS_WORKSPACE_INDEX_MISSING', '工作区索引已失联，请恢复原文件后重试；不会建立空索引替代。');
      }
      if (!exists && fs.existsSync(casesPath) && fs.readdirSync(casesPath).length) {
        throw failure('FS_WORKSPACE_INDEX_MISSING', '该目录已有案件，但工作区索引已失联；不会建立空索引替代。');
      }
      if (exists) assertRegularFile(catalogPath, 'FS_WORKSPACE_MISSING', '工作区索引已失联。');
      if (!allowCreate && !isDirectory(casesPath)) {
        throw failure('FS_WORKSPACE_CASES_MISSING', '案件数据目录已失联，请恢复原目录后重试。');
      }
      if (this.catalog && this.workspacePath === rootReal) {
        // Refresh without closing the active case connection or resetting its identity.
        const cases = this.listCases();
        if (this.currentCaseId && !cases.some(item => item.id === this.currentCaseId && item.available)) {
          if (this.caseDb) this.caseDb.close();
          this.caseDb = null;
          this.currentCaseId = null;
        }
        return { workspacePath: this.workspacePath, cases, currentCaseId: this.currentCaseId };
      }
      nextCatalog = new Database(catalogPath, { fileMustExist: exists });
      if (exists) {
        if (nextCatalog.pragma('user_version', { simple: true }) !== SCHEMA_VERSION ||
            nextCatalog.pragma('application_id', { simple: true }) !== WORKSPACE_APP_ID) {
          throw failure('FS_WORKSPACE_VERSION', '该工作区版本尚不支持，请选择兼容的数据目录，不能直接覆盖。');
        }
        nextCatalog.prepare('SELECT id, case_no, case_name, relative_path, created_at, updated_at, last_opened_at FROM workspace_case LIMIT 1').all();
      } else {
        configure(nextCatalog);
        nextCatalog.transaction(() => {
          nextCatalog.exec(CATALOG_SCHEMA);
          nextCatalog.pragma(`application_id = ${WORKSPACE_APP_ID}`);
          nextCatalog.pragma(`user_version = ${SCHEMA_VERSION}`);
        })();
      }
      configure(nextCatalog);
      if (allowCreate) fs.mkdirSync(casesPath, { recursive: true });
      if (!isDirectory(casesPath) || fs.realpathSync(casesPath) !== casesPath) {
        throw failure('FS_UNSAFE_PATH', '案件目录不能指向其他位置。');
      }
      // Fully validate the candidate before releasing a previously usable workspace.
      const candidate = new WorkspaceStore({ schemaPath: this.schemaPath });
      candidate.workspacePath = rootReal;
      candidate.catalog = nextCatalog;
      candidate._recoverCreations();
      const cases = candidate.listCases();
      const last = cases.find(item => item.available && item.openedAt);
      if (last) candidate.openCase(last.id);
      this.close();
      this.workspacePath = rootReal;
      this.catalog = nextCatalog;
      this.caseDb = candidate.caseDb;
      this.currentCaseId = candidate.currentCaseId;
      nextCatalog = null;
      return { workspacePath: this.workspacePath, cases, currentCaseId: this.currentCaseId };
    } catch (error) {
      if (nextCatalog) nextCatalog.close();
      throw wrap(error, 'FS_WORKSPACE_OPEN', '数据目录无法打开，请检查位置、权限和剩余空间。');
    }
  }

  _assertOpen() {
    if (!this.catalog) throw failure('FS_WORKSPACE_REQUIRED', '请先选择数据目录。');
  }

  _casePath(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw failure('FS_CASE_ID', '案件身份无效，请重新从案件列表打开。');
    return path.join(this.workspacePath, 'cases', id);
  }

  _caseRecord(id) {
    this._assertOpen();
    this._casePath(id);
    const record = this.catalog.prepare('SELECT * FROM workspace_case WHERE id = ?').get(id);
    if (!record) throw failure('FS_CASE_NOT_FOUND', '未找到该案件，请刷新案件列表。');
    return record;
  }

  _openCaseDatabase(record) {
    const directory = this._casePath(record.id);
    const expected = path.posix.join('cases', record.id, 'case.sqlite');
    if (record.relative_path !== expected) throw failure('FS_CASE_IDENTITY', '案件索引路径与身份不符，已停止打开。');
    if (!isDirectory(directory)) throw failure('FS_CASE_MISSING', '案件目录已失联，请恢复原数据目录后重试。');
    if (fs.realpathSync(directory) !== directory || fs.realpathSync(path.dirname(directory)) !== path.dirname(directory)) {
      throw failure('FS_UNSAFE_PATH', '案件目录不能指向其他位置。');
    }
    const filePath = path.join(directory, 'case.sqlite');
    assertRegularFile(filePath, 'FS_CASE_MISSING', '案件数据库已失联，不会自动创建空库替代。');
    let db;
    try {
      db = new Database(filePath, { fileMustExist: true });
      if (db.pragma('user_version', { simple: true }) !== SCHEMA_VERSION ||
          db.pragma('application_id', { simple: true }) !== CASE_APP_ID) {
        throw failure('FS_CASE_VERSION', '该案件数据库版本尚不支持，不能直接覆盖或升级。');
      }
      const identities = db.prepare('SELECT id, case_no, case_name, created_at FROM case_info').all();
      const desktopIdentity = db.prepare('SELECT case_uuid FROM desktop_case_identity WHERE id = 1').get();
      if (identities.length !== 1 || identities[0].id !== 1 || identities[0].case_no !== record.case_no ||
          identities[0].case_name !== record.case_name || identities[0].created_at !== record.created_at ||
          !desktopIdentity || desktopIdentity.case_uuid !== record.id) {
        throw failure('FS_CASE_IDENTITY', '案件数据库与登记身份不符，已停止打开。');
      }
      configure(db);
      return db;
    } catch (error) {
      if (db) db.close();
      throw wrap(error, 'FS_CASE_OPEN', '案件数据库无法读取，请检查文件是否完整、可用。');
    }
  }

  _dto(record, db) {
    const stats = {
      files: db.prepare('SELECT count(*) AS n FROM source_file WHERE case_id = 1').get().n,
      ...db.prepare(`SELECT count(*) AS flows,
          coalesce(sum(CASE WHEN f.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending
        FROM fund_flow f
        JOIN source_file s ON s.id = f.source_file_id AND s.case_id = f.case_id
        JOIN import_batch b ON b.id = s.current_batch_id AND b.id = f.batch_id
          AND b.source_file_id = s.id AND b.case_id = f.case_id AND b.status = 'done'
        WHERE f.case_id = 1`).get()
    };
    return { id: record.id, name: record.case_name, number: record.case_no,
      createdAt: record.created_at, updatedAt: record.updated_at,
      openedAt: record.last_opened_at || null, available: true, error: null, stats };
  }

  listCases() {
    this._assertOpen();
    try {
      return this.catalog.prepare('SELECT * FROM workspace_case ORDER BY last_opened_at DESC, updated_at DESC, id').all().map(record => {
        let db;
        try {
          db = this._openCaseDatabase(record);
          return this._dto(record, db);
        } catch (error) {
          const known = wrap(error, 'FS_CASE_OPEN', '案件暂时不可读取。');
          return { id: record.id, name: record.case_name, number: record.case_no,
            createdAt: record.created_at, updatedAt: record.updated_at,
            openedAt: record.last_opened_at || null, available: false,
            error: { code: known.code, message: known.message }, stats: null };
        } finally { if (db) db.close(); }
      });
    } catch (error) { throw wrap(error, 'FS_CASE_LIST', '案件列表读取失败，请检查数据目录。'); }
  }

  createCase(input) {
    this._assertOpen();
    const { name, number } = validateInput(input);
    if (this.catalog.prepare('SELECT 1 FROM workspace_case WHERE case_no = ?').get(number)) {
      throw failure('FS_CASE_DUPLICATE', '此案件编号已存在，请使用其他编号。');
    }
    const id = randomUUID();
    const directory = this._casePath(id);
    const timestamp = new Date().toISOString();
    const record = { id, case_no: number, case_name: name,
      relative_path: path.posix.join('cases', id, 'case.sqlite'),
      created_at: timestamp, updated_at: timestamp, last_opened_at: timestamp };
    let created = false, db, registered = false;
    try {
      fs.mkdirSync(directory); // Exclusive: never reuse or overwrite an existing directory.
      created = true;
      fs.writeFileSync(path.join(directory, MARKER), JSON.stringify({ version: 1, ...record }), { flag: 'wx' });
      fs.mkdirSync(path.join(directory, 'archive'));
      fs.mkdirSync(path.join(directory, 'exports'));
      db = new Database(path.join(directory, 'case.sqlite'));
      configure(db);
      const schema = fs.readFileSync(this.schemaPath, 'utf8');
      db.transaction(() => {
        db.exec(schema);
        db.prepare('INSERT INTO case_info (id,case_no,case_name,created_at) VALUES (1,?,?,?)').run(number, name, timestamp);
        db.exec('CREATE TABLE desktop_case_identity (id INTEGER PRIMARY KEY CHECK (id = 1), case_uuid TEXT NOT NULL UNIQUE)');
        db.prepare('INSERT INTO desktop_case_identity (id,case_uuid) VALUES (1,?)').run(id);
        db.pragma(`application_id = ${CASE_APP_ID}`);
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
      db.close(); db = null;
      this.catalog.transaction(() => this.catalog.prepare(`INSERT INTO workspace_case
        (id,case_no,case_name,relative_path,created_at,updated_at,last_opened_at)
        VALUES (@id,@case_no,@case_name,@relative_path,@created_at,@updated_at,@last_opened_at)`).run(record))();
      registered = true;
      // A crash after registration is safe: recovery recognizes the matching catalog row.
      try { fs.unlinkSync(path.join(directory, MARKER)); } catch (_) { /* Retry on next startup. */ }
      return this.openCase(id);
    } catch (error) {
      if (db) db.close();
      if (created && !registered) {
        // Only the exact directory exclusively created by this call can be removed.
        try { fs.rmSync(directory, { recursive: true }); } catch (_) { /* Marker permits recovery. */ }
      }
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw failure('FS_CASE_DUPLICATE', '此案件编号已存在，请使用其他编号。', error);
      throw wrap(error, 'FS_CASE_CREATE', registered ? '案件已保存，但暂时无法打开，请从列表重试。' : '案件创建失败，原有案件保持不变，请检查目录权限或剩余空间。');
    }
  }

  _recoverCreations() {
    // Only a fully created case bearing this app's journal can be registered after a crash.
    const base = path.join(this.workspacePath, 'cases');
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const directory = this._casePath(entry.name), markerPath = path.join(directory, MARKER);
      if (!fs.existsSync(markerPath)) continue;
      try {
        assertRegularFile(markerPath, 'FS_CASE_JOURNAL', '建案恢复记录已失联。');
        const journal = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        if (journal.version !== 1 || journal.id !== entry.name) continue;
        const fields = validateInput({ name: journal.case_name, number: journal.case_no });
        if (fields.name !== journal.case_name || fields.number !== journal.case_no) continue;
        const db = this._openCaseDatabase(journal);
        db.close();
        const prior = this.catalog.prepare('SELECT * FROM workspace_case WHERE id = ?').get(journal.id);
        if (prior) {
          if (prior.relative_path !== journal.relative_path || prior.case_no !== journal.case_no ||
              prior.case_name !== journal.case_name || prior.created_at !== journal.created_at) continue;
        } else {
          this.catalog.prepare(`INSERT INTO workspace_case
            (id,case_no,case_name,relative_path,created_at,updated_at,last_opened_at)
            VALUES (@id,@case_no,@case_name,@relative_path,@created_at,@updated_at,@last_opened_at)`).run({
              id: journal.id, case_no: journal.case_no, case_name: journal.case_name,
              relative_path: journal.relative_path, created_at: journal.created_at,
              updated_at: journal.updated_at, last_opened_at: journal.last_opened_at || null
            });
        }
        fs.unlinkSync(markerPath);
      } catch (_) {
        // Incomplete or conflicting journals remain untouched for explicit recovery.
      }
    }
  }

  openCase(id) {
    const record = this._caseRecord(id);
    let nextDb;
    try {
      nextDb = this._openCaseDatabase(record);
      const result = this._dto(record, nextDb);
      const openedAt = new Date().toISOString();
      this.catalog.prepare('UPDATE workspace_case SET last_opened_at = ? WHERE id = ?').run(openedAt, id);
      if (this.caseDb) this.caseDb.close();
      this.caseDb = nextDb; nextDb = null;
      this.currentCaseId = id;
      return { ...result, openedAt };
    } catch (error) {
      if (nextDb) nextDb.close();
      throw wrap(error, 'FS_CASE_OPEN', '案件无法打开，原先案件保持不变。');
    }
  }

  close() {
    if (this.caseDb) { this.caseDb.close(); this.caseDb = null; }
    if (this.catalog) { this.catalog.close(); this.catalog = null; }
    this.workspacePath = null;
    this.currentCaseId = null;
  }
}

module.exports = { WorkspaceStore };
