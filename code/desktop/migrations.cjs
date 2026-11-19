'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');

function fail(code, message) { return Object.assign(new Error(message), { code }); }

function schemaSignature(db) {
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  return JSON.stringify(objects.map(item => ({ ...item,
    sql: item.sql?.replace(/\s+/g, ' ').trim(),
    columns: item.type === 'table' ? db.pragma(`table_info('${item.name.replaceAll("'", "''")}')`) : undefined,
    foreignKeys: item.type === 'table' ? db.pragma(`foreign_key_list('${item.name.replaceAll("'", "''")}')`) : undefined,
    indexes: item.type === 'table' ? db.pragma(`index_list('${item.name.replaceAll("'", "''")}')`) : undefined
  })));
}

function assertKnownSchema(db, expected, kind) {
  if (schemaSignature(db) !== expected) throw fail('FS_SCHEMA_UNKNOWN', `${kind}的结构与已知版本不符，已停止升级；原数据未更改。`);
}

function checkIntegrity(db) {
  const integrity = db.pragma('integrity_check');
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok' || db.pragma('foreign_key_check').length) {
    throw fail('FS_MIGRATION_INTEGRITY', '数据库完整性或引用关系检查未通过，已停止升级。');
  }
}

function quote(name) { return '"' + name.replaceAll('"','""') + '"'; }

// Lossless, typed logical projection. New columns/tables are intentionally not
// compared with the old schema; every old field is ordered and hashed exactly.
function logicalSnapshot(db, projection) {
  const result = {};
  const tables = projection ? Object.keys(projection) : db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  for (const name of tables) {
    const columns = projection ? projection[name].columns : db.pragma(`table_info(${quote(name)})`).map(row => row.name);
    const hash = createHash('sha256');
    hash.update(JSON.stringify(columns)+'\n');
    let count = 0n;
    const select = columns.map(column => `${quote(column)},typeof(${quote(column)})`).join(',');
    const order = columns.map(quote).join(',');
    for (const row of db.prepare(`SELECT ${select} FROM ${quote(name)} ORDER BY ${order}`).raw().safeIntegers().iterate()) {
      const encoded = [];
      for (let i=0;i<row.length;i+=2) {
        const value = row[i], type = row[i+1];
        let encodedValue = Buffer.isBuffer(value) ? value.toString('hex') : typeof value==='bigint' ? value.toString() : value;
        if (type==='real') { const bytes=Buffer.allocUnsafe(8);bytes.writeDoubleBE(value);encodedValue=bytes.toString('hex'); }
        encoded.push([type,encodedValue]);
      }
      hash.update(JSON.stringify(encoded)+'\n'); count++;
    }
    result[name] = { columns, count: count.toString(), sha256: hash.digest('hex') };
  }
  return result;
}

function snapshot(db, identity) {
  const counts = {};
  const identityRows = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    counts[name] = db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).safeIntegers().get().n.toString();
    if (['workspace_case', 'case_info', 'desktop_case_identity'].includes(name)) {
      identityRows[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY id`).all();
    }
  }
  return { version: db.pragma('user_version', { simple: true }), applicationId: db.pragma('application_id', { simple: true }), identity, identityRows, counts,
    logicalTables: logicalSnapshot(db) };
}

function writeManifest(file, data, first = false) {
  const text = JSON.stringify(data, null, 2);
  if (first) fs.writeFileSync(file, text, { flag: 'wx' });
  else {
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, text, { flag: 'wx' });
    fs.renameSync(temporary, file);
  }
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

// The caller serializes all storage requests. No source write occurs before the
// independent reader has finished and verified this committed WAL snapshot.
async function migrate({ db, filePath, kind, identity, expectedSchema, validate, install, targetVersion = 2,
  rebuildForeignKeys = false, hooks = {}, onProgress = () => {} }) {
  const progress = phase => { try { onProgress(phase); } catch (_) {} };
  progress('checking');
  assertKnownSchema(db, expectedSchema, kind);
  validate(db);
  checkIntegrity(db);
  let manifest, manifestPath, reader;
  let committed = false;
  const foreignKeys = db.pragma('foreign_keys',{simple:true});
  if (rebuildForeignKeys) {
    if (db.inTransaction) throw fail('FS_MIGRATION_TRANSACTION','结构重建不能嵌套已有事务。');
    db.pragma('foreign_keys=OFF');
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    assertKnownSchema(db, expectedSchema, kind);
    validate(db);
    checkIntegrity(db);
    const before = snapshot(db, identity);
    await hooks.beforeBackup?.({ db, filePath });
    const backupRoot = path.join(path.dirname(filePath), 'backup');
    if (fs.existsSync(backupRoot)) {
      const entry = fs.lstatSync(backupRoot);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw fail('FS_BACKUP_PATH', '升级备份位置不是普通目录，已停止升级。');
    } else fs.mkdirSync(backupRoot);
    const batch = path.join(backupRoot, `v${before.version}-to-v${targetVersion}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
    fs.mkdirSync(batch);
    const backupPath = path.join(batch, 'database.sqlite');
    manifestPath = path.join(batch, 'manifest.json');
    manifest = { formatVersion: 1, kind, sourceFile: path.basename(filePath), ...before,
      targetVersion, startedAt: new Date().toISOString(), result: 'backup_started', backupFile: 'database.sqlite' };
    writeManifest(manifestPath, manifest, true);
    reader = new Database(filePath, { readonly: true, fileMustExist: true });
    progress('backing-up');
    await reader.backup(backupPath);
    reader.close(); reader = null;
    await hooks.afterBackup?.({ db, backupPath, manifestPath });
    progress('verifying-backup');
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      assertKnownSchema(backup, expectedSchema, kind);
      validate(backup);
      checkIntegrity(backup);
      if (JSON.stringify(snapshot(backup, identity)) !== JSON.stringify(before)) {
        throw fail('FS_BACKUP_VERIFY', '升级备份与原库的身份、版本或行数不一致，已停止升级。');
      }
    } finally { backup.close(); }
    manifest.sha256 = await hashFile(backupPath);
    manifest.backupVerifiedAt = new Date().toISOString();
    manifest.result = 'backup_verified';
    writeManifest(manifestPath, manifest);
    progress('upgrading');
    install(db);
    await hooks.afterInstall?.({ db, filePath, backupPath });
    checkIntegrity(db);
    await hooks.beforeCommit?.({ db, filePath });
    checkIntegrity(db);
    const after = logicalSnapshot(db,before.logicalTables);
    if (JSON.stringify(after) !== JSON.stringify(before.logicalTables)) {
      throw fail('FS_MIGRATION_CONTENT','升级前后原有业务字段的逻辑摘要不一致，已回滚。');
    }
    manifest.preservedLogicalTables = after;
    manifest.logicalVerifiedAt = new Date().toISOString();
    db.pragma(`user_version = ${targetVersion}`);
    db.exec('COMMIT'); committed = true;
    manifest.result = 'upgraded'; manifest.completedAt = new Date().toISOString();
    try { writeManifest(manifestPath, manifest); } catch (_) { /* A verified backup remains recoverable; never undo a committed upgrade. */ }
    await hooks.afterCommit?.({ db, filePath });
  } catch (error) {
    if (!committed && db.inTransaction) db.exec('ROLLBACK');
    if (manifest) {
      manifest.result = committed ? 'committed_followup_failed' : 'rolled_back';
      manifest.completedAt = new Date().toISOString();
      manifest.error = { code: error.code || 'MIGRATION_ERROR', message: error.message };
      try { writeManifest(manifestPath, manifest); } catch (_) { /* Preserve the prior manifest and backup on disk failure. */ }
    }
    if (error.code?.startsWith('FS_')) throw error;
    throw fail('FS_MIGRATION_FAILED', committed ? '数据库升级已提交，后续记录未完成；请重新打开检查，不能用旧备份自动覆盖。' : '数据库升级未完成，已回滚；原有业务数据保留，请检查备份位置、权限和剩余空间后重试。');
  } finally {
    if (reader) reader.close();
    if (rebuildForeignKeys) db.pragma(`foreign_keys=${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

module.exports = { migrate, schemaSignature, assertKnownSchema, checkIntegrity, logicalSnapshot };
