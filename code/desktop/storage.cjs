'use strict';

// SQLite statements stay synchronous in the utility process; upgrades await verified backups.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const { migrate, schemaSignature, assertKnownSchema } = require('./migrations.cjs');
const { installCaseV2, validateCaseV1, readSummary } = require('./hardening.cjs');

const WORKSPACE_SCHEMA_VERSION = 2;
const CASE_SCHEMA_VERSION = 2;
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
const CATALOG_V2_SQL = 'CREATE UNIQUE INDEX idx_workspace_case_number_nocase ON workspace_case(case_no COLLATE NOCASE)';
const BASE_SCHEMA = fs.readFileSync(path.resolve(__dirname, '../ddl_extract_check.sql'), 'utf8');
const signatureCache = new Map();

function knownSignature(kind, version) {
  const key = `${kind}:${version}`;
  if (signatureCache.has(key)) return signatureCache.get(key);
  const sample = new Database(':memory:');
  try {
    if (kind === 'workspace') {
      sample.exec(CATALOG_SCHEMA);
      if (version === 2) sample.exec(CATALOG_V2_SQL);
    } else {
      sample.exec(BASE_SCHEMA);
      sample.exec('CREATE TABLE desktop_case_identity (id INTEGER PRIMARY KEY CHECK (id = 1), case_uuid TEXT NOT NULL UNIQUE)');
      if (version === 2) {
        const record = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', case_no: 'schema', case_name: 'schema', created_at: 'schema', updated_at: 'schema' };
        sample.prepare('INSERT INTO case_info(id,case_no,case_name,created_at) VALUES(1,?,?,?)').run(record.case_no, record.case_name, record.created_at);
        sample.prepare('INSERT INTO desktop_case_identity(id,case_uuid) VALUES(1,?)').run(record.id);
        sample.transaction(() => installCaseV2(sample, record))();
      }
    }
    const signature = schemaSignature(sample);
    signatureCache.set(key, signature);
    return signature;
  } finally { sample.close(); }
}

function assertCaseIdentity(db, record) {
  const identities = db.prepare('SELECT id, case_no, case_name, created_at FROM case_info').all();
  const uuid = db.prepare('SELECT id,case_uuid FROM desktop_case_identity').all();
  if (identities.length !== 1 || identities[0].id !== 1 || identities[0].case_no !== record.case_no ||
      identities[0].case_name !== record.case_name || identities[0].created_at !== record.created_at ||
      uuid.length !== 1 || uuid[0].id !== 1 || uuid[0].case_uuid !== record.id) {
    throw failure('FS_CASE_IDENTITY', '案件数据库与登记身份不符，已停止打开。');
  }
}

function validateCatalog(db) {
  const duplicate = db.prepare('SELECT group_concat(case_no) AS numbers FROM workspace_case GROUP BY case_no COLLATE NOCASE HAVING count(*) > 1 LIMIT 1').get();
  if (duplicate) throw failure('FS_CASE_NUMBER_CONFLICT', `旧工作区存在仅字母大小写不同的重复编号：${duplicate.numbers}。已停止升级，未改名或合并案件。`);
  for (const record of db.prepare('SELECT * FROM workspace_case').all()) {
    const input = validateInput({ name: record.case_name, number: record.case_no });
    if (!UUID.test(record.id) || record.relative_path !== path.posix.join('cases', record.id, 'case.sqlite') ||
        input.name !== record.case_name || input.number !== record.case_no || !record.created_at || !record.updated_at) {
      throw failure('FS_WORKSPACE_IDENTITY', '旧工作区登记的案件身份或路径不完整，已停止升级。');
    }
  }
}

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

function hasPath(filePath) {
  try { fs.lstatSync(filePath); return true; } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

// Read the SQLite header directly: opening a WAL database just to inspect a
// folder can create sidecar files. Folder validation itself must never write.
function isWorkspaceIndex(filePath) {
  let descriptor;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 100) return false;
    descriptor = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(100);
    if (fs.readSync(descriptor, header, 0, 100, 0) !== 100 ||
        !header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) return false;
    if (header.readUInt32BE(68) === WORKSPACE_APP_ID) return true;
    return hasWorkspaceWalHeader(filePath + '-wal');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function hasWorkspaceWalHeader(walPath) {
  let descriptor;
  try {
    const stat = fs.lstatSync(walPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 32) return false;
    descriptor = fs.openSync(walPath, 'r');
    const header = Buffer.alloc(32);
    if (fs.readSync(descriptor, header, 0, 32, 0) !== 32 ||
        ![0x377f0682, 0x377f0683].includes(header.readUInt32BE(0))) return false;
    const pageSize = header.readUInt32BE(8);
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1))) return false;
    const frameSize = pageSize + 24, frame = Buffer.alloc(24), pageHeader = Buffer.alloc(100);
    let committed = false;
    for (let offset = 32 + (Math.floor((stat.size - 32) / frameSize) - 1) * frameSize; offset >= 32; offset -= frameSize) {
      if (fs.readSync(descriptor, frame, 0, 24, offset) !== 24 ||
          frame.readUInt32BE(8) !== header.readUInt32BE(16) || frame.readUInt32BE(12) !== header.readUInt32BE(20)) continue;
      if (frame.readUInt32BE(4) !== 0) committed = true;
      if (committed && frame.readUInt32BE(0) === 1) {
        return fs.readSync(descriptor, pageHeader, 0, 100, offset + 24) === 100 &&
          pageHeader.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) && pageHeader.readUInt32BE(68) === WORKSPACE_APP_ID;
      }
    }
    return false;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function hasCreationJournal(directory) {
  const markerPath = path.join(directory, MARKER);
  try {
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return false;
    const record = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return record.version === 1 && UUID.test(record.id) && record.id === path.basename(directory) &&
      record.relative_path === path.posix.join('cases', record.id, 'case.sqlite');
  } catch (error) {
    if (error instanceof SyntaxError || error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function isCasesContainer(directory) {
  if (path.basename(directory).toLowerCase() !== 'cases' || !isDirectory(directory)) return false;
  if (isWorkspaceIndex(path.join(path.dirname(directory), 'workspace.sqlite'))) return true;
  // Also protect a recognizable cases tree whose workspace index was lost.
  return fs.readdirSync(directory, { withFileTypes: true }).some(entry => entry.isDirectory() && UUID.test(entry.name) &&
    (hasPath(path.join(directory, entry.name, 'case.sqlite')) || hasCreationJournal(path.join(directory, entry.name))));
}

function assertWorkspaceLocation(rootPath) {
  let current = path.resolve(rootPath);
  for (;;) {
    if (hasPath(path.join(current, 'case.sqlite')) || hasCreationJournal(current) || isCasesContainer(current)) {
      throw failure('FS_WORKSPACE_INNER_FOLDER', '这个文件夹属于软件内部的案件数据。请选择保存全部案件的数据存放文件夹，不要选择 cases、单个案件或其内部文件夹。');
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
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
  constructor({ schemaPath, migrationHooks = {}, onProgress = () => {} }) {
    this.schemaPath = path.resolve(schemaPath);
    this.migrationHooks = migrationHooks;
    // Progress observers must never affect the success/rollback of storage.
    this.onProgress = phase => { try { onProgress(phase); } catch (_) {} };
    this.workspacePath = null;
    this.catalog = null;
    this.caseDb = null;
    this.currentCaseId = null;
  }

  inspectWorkspace(rootPath) {
    this.onProgress('checking');
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) throw failure('FS_WORKSPACE_PATH', '请选择完整的数据存放文件夹路径。');
    const resolved = path.resolve(rootPath);
    assertWorkspaceLocation(resolved);
    if (!fs.existsSync(resolved)) return { exists: false, hasWorkspace: false, needsConfirmation: false, entries: [], confirmationToken: null };
    if (!isDirectory(resolved)) throw failure('FS_WORKSPACE_PATH', '选择的位置不是普通文件夹。');
    const names = fs.readdirSync(resolved).sort();
    const entries = names.map(name => {
      const stat = fs.lstatSync(path.join(resolved, name));
      return { name, kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', size: stat.size, modified: stat.mtimeMs };
    });
    const hasWorkspace = names.includes('workspace.sqlite');
    return { exists: true, hasWorkspace, needsConfirmation: !hasWorkspace && names.length > 0, entries: names,
      confirmationToken: createHash('sha256').update(JSON.stringify({ root: fs.realpathSync(resolved), entries })).digest('hex') };
  }

  async openWorkspace(rootPath, { allowCreate = true, confirmationToken } = {}) {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
      throw failure('FS_WORKSPACE_PATH', '请选择完整的数据存放文件夹路径。');
    }
    const resolved = path.resolve(rootPath);
    let nextCatalog;
    try {
      const inspection = this.inspectWorkspace(resolved);
      const existingCases = path.join(resolved, 'cases');
      if (inspection.exists && fs.existsSync(existingCases) && !isDirectory(existingCases)) {
        throw failure('FS_UNSAFE_PATH', '数据存放文件夹中的 cases 位置已被其他文件占用。');
      }
      if (!inspection.hasWorkspace && isDirectory(existingCases) && fs.readdirSync(existingCases).length) {
        throw failure('FS_WORKSPACE_INDEX_MISSING', '该目录已有案件，但工作区索引已失联；不会建立空索引替代。');
      }
      if (allowCreate && inspection.needsConfirmation && confirmationToken !== inspection.confirmationToken) {
        throw failure('FS_WORKSPACE_CONFIRM', '所选文件夹已有文件，请确认允许在这里保存案件；内容若已变化，请重新选择并确认。');
      }
      // Recheck after inspection/confirmation and immediately before the first
      // write, including when a previously absent target gained a case tree.
      assertWorkspaceLocation(resolved);
      // Only an explicit first-time folder choice may create a workspace.
      if (allowCreate) fs.mkdirSync(resolved, { recursive: true });
      else if (!fs.existsSync(resolved)) {
        throw failure('FS_WORKSPACE_MISSING', '暂时无法访问原数据存放位置，请恢复原文件夹后重试；不会建立空数据替代。');
      }
      if (!isDirectory(resolved)) throw failure('FS_WORKSPACE_PATH', '选择的位置不是普通文件夹。');
      const rootReal = fs.realpathSync(resolved);
      const casesPath = path.join(rootReal, 'cases');
      if (fs.existsSync(casesPath) && !isDirectory(casesPath)) {
        throw failure('FS_UNSAFE_PATH', '数据存放文件夹中的 cases 位置已被其他文件占用。');
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
        throw failure('FS_WORKSPACE_CASES_MISSING', '案件数据文件夹已失联，请恢复原保存位置后重试。');
      }
      if (this.catalog && this.workspacePath === rootReal) {
        // Refresh without closing the active case connection or resetting its identity.
        const cases = await this.listCases();
        if (this.currentCaseId && !cases.some(item => item.id === this.currentCaseId && item.available)) {
          if (this.caseDb) this.caseDb.close();
          this.caseDb = null;
          this.currentCaseId = null;
        }
        return { workspacePath: this.workspacePath, cases, currentCaseId: this.currentCaseId };
      }
      nextCatalog = new Database(catalogPath, { fileMustExist: exists });
      if (exists) {
        const version = nextCatalog.pragma('user_version', { simple: true });
        if (![1, WORKSPACE_SCHEMA_VERSION].includes(version) || nextCatalog.pragma('application_id', { simple: true }) !== WORKSPACE_APP_ID) {
          throw failure('FS_WORKSPACE_VERSION', '该工作区版本尚不支持，请选择兼容的数据目录，不能直接覆盖。');
        }
        assertKnownSchema(nextCatalog, knownSignature('workspace', version), '工作区');
        if (version === 1) {
          configure(nextCatalog);
          await migrate({ db: nextCatalog, filePath: catalogPath, kind: '工作区', identity: { workspacePath: rootReal },
            expectedSchema: knownSignature('workspace', 1), validate: validateCatalog,
            install: database => database.exec(CATALOG_V2_SQL), hooks: this.migrationHooks, onProgress: this.onProgress });
        }
      } else {
        configure(nextCatalog);
        nextCatalog.transaction(() => {
          nextCatalog.exec(CATALOG_SCHEMA);
          nextCatalog.exec(CATALOG_V2_SQL);
          nextCatalog.pragma(`application_id = ${WORKSPACE_APP_ID}`);
          nextCatalog.pragma(`user_version = ${WORKSPACE_SCHEMA_VERSION}`);
        })();
      }
      configure(nextCatalog);
      if (allowCreate) fs.mkdirSync(casesPath, { recursive: true });
      if (!isDirectory(casesPath) || fs.realpathSync(casesPath) !== casesPath) {
        throw failure('FS_UNSAFE_PATH', '案件文件夹不能指向其他位置。');
      }
      // Fully validate the candidate before releasing a previously usable workspace.
      const candidate = new WorkspaceStore({ schemaPath: this.schemaPath, migrationHooks: this.migrationHooks, onProgress: this.onProgress });
      candidate.workspacePath = rootReal;
      candidate.catalog = nextCatalog;
      await candidate._recoverCreations();
      const cases = await candidate.listCases();
      const last = cases.find(item => item.available && item.openedAt);
      if (last) await candidate.openCase(last.id);
      this.close();
      this.workspacePath = rootReal;
      this.catalog = nextCatalog;
      this.caseDb = candidate.caseDb;
      this.currentCaseId = candidate.currentCaseId;
      nextCatalog = null;
      return { workspacePath: this.workspacePath, cases, currentCaseId: this.currentCaseId };
    } catch (error) {
      if (nextCatalog) nextCatalog.close();
      throw wrap(error, 'FS_WORKSPACE_OPEN', '数据存放文件夹无法打开，请检查位置、访问权限和剩余空间。');
    }
  }

  _assertOpen() {
    if (!this.catalog) throw failure('FS_WORKSPACE_REQUIRED', '请先选择数据存放文件夹。');
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

  async _openCaseDatabase(record) {
    this.onProgress('checking');
    const directory = this._casePath(record.id);
    const expected = path.posix.join('cases', record.id, 'case.sqlite');
    if (record.relative_path !== expected) throw failure('FS_CASE_IDENTITY', '案件索引路径与身份不符，已停止打开。');
    if (!isDirectory(directory)) throw failure('FS_CASE_MISSING', '案件文件夹已失联，请恢复原数据存放位置后重试。');
    if (fs.realpathSync(directory) !== directory || fs.realpathSync(path.dirname(directory)) !== path.dirname(directory)) {
      throw failure('FS_UNSAFE_PATH', '案件文件夹不能指向其他位置。');
    }
    const filePath = path.join(directory, 'case.sqlite');
    assertRegularFile(filePath, 'FS_CASE_MISSING', '案件数据库已失联，不会自动创建空库替代。');
    let db;
    try {
      db = new Database(filePath, { fileMustExist: true });
      const version = db.pragma('user_version', { simple: true });
      if (![1, CASE_SCHEMA_VERSION].includes(version) || db.pragma('application_id', { simple: true }) !== CASE_APP_ID) {
        throw failure('FS_CASE_VERSION', '该案件数据库版本尚不支持，不能直接覆盖或升级。');
      }
      assertKnownSchema(db, knownSignature('case', version), '案件数据库');
      assertCaseIdentity(db, record);
      if (version === 1) {
        configure(db);
        await migrate({ db, filePath, kind: '案件', identity: { caseUuid: record.id, caseNumber: record.case_no, caseName: record.case_name },
          expectedSchema: knownSignature('case', 1),
          validate: database => { assertCaseIdentity(database, record); validateCaseV1(database, record); },
          install: database => installCaseV2(database, record), hooks: this.migrationHooks, onProgress: this.onProgress });
      }
      configure(db);
      return db;
    } catch (error) {
      if (db) db.close();
      throw wrap(error, 'FS_CASE_OPEN', '案件数据库无法读取，请检查文件是否完整、可用。');
    }
  }

  _dto(record, db, diagnostics = false) {
    const summary = readSummary(db, record, { diagnostics });
    return { id: record.id, name: record.case_name, number: record.case_no,
      createdAt: record.created_at, updatedAt: summary.updatedAt,
      openedAt: record.last_opened_at || null, available: true, error: null, ...summary };
  }

  async listCases() {
    this._assertOpen();
    try {
      const result = [];
      for (const record of this.catalog.prepare('SELECT * FROM workspace_case ORDER BY last_opened_at DESC, updated_at DESC, id').all()) {
        let db;
        try {
          db = await this._openCaseDatabase(record);
          result.push(this._dto(record, db));
        } catch (error) {
          const known = wrap(error, 'FS_CASE_OPEN', '案件暂时不可读取。');
          result.push({ id: record.id, name: record.case_name, number: record.case_no,
            createdAt: record.created_at, updatedAt: record.updated_at,
            openedAt: record.last_opened_at || null, available: false,
            error: { code: known.code, message: known.message }, stats: null });
        } finally { if (db) db.close(); }
      }
      return result;
    } catch (error) { throw wrap(error, 'FS_CASE_LIST', '案件列表读取失败，请检查数据存放文件夹。'); }
  }

  async createCase(input) {
    this._assertOpen();
    const { name, number } = validateInput(input);
    if (this.catalog.prepare('SELECT 1 FROM workspace_case WHERE case_no = ? COLLATE NOCASE').get(number)) {
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
        installCaseV2(db, record);
        db.pragma(`user_version = ${CASE_SCHEMA_VERSION}`);
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
      throw wrap(error, 'FS_CASE_CREATE', registered ? '案件已保存，但暂时无法打开，请从列表重试。' : '案件创建失败，原有案件保持不变，请检查文件夹权限或剩余空间。');
    }
  }

  async _recoverCreations() {
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
        const db = await this._openCaseDatabase(journal);
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

  async openCase(id) {
    const record = this._caseRecord(id);
    let nextDb;
    try {
      nextDb = await this._openCaseDatabase(record);
      const result = this._dto(record, nextDb, true);
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

module.exports = { WorkspaceStore, WORKSPACE_SCHEMA_VERSION, CASE_SCHEMA_VERSION };
