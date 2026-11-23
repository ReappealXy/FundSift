'use strict';

// Filesystem journal and SQLite publication are deliberately separate. This
// module never publishes a batch or deletes final archives during recovery.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fail(code, message) { return Object.assign(new Error(message), { code }); }
async function hashFile(file, { signal } = {}) {
  const digest = createHash('sha256');
  for await (const bytes of fs.createReadStream(file, { signal })) digest.update(bytes);
  return digest.digest('hex');
}
function sourceIdentity(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':'); }

class ArchiveStore {
  constructor(caseDirectory) {
    this.root = path.resolve(caseDirectory);
    const stat = fs.lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(this.root) !== this.root) {
      throw fail('FS_ARCHIVE_PATH', '案件归档位置不是普通目录。');
    }
    for (const relative of ['archive', 'archive/.staging', 'archive/.journal', 'archive/objects']) {
      const folder = path.join(this.root, relative);
      if (!fs.existsSync(folder)) fs.mkdirSync(folder);
      const entry = fs.lstatSync(folder);
      if (!entry.isDirectory() || entry.isSymbolicLink() || fs.realpathSync(folder) !== folder) {
        throw fail('FS_ARCHIVE_PATH', '归档子目录不能指向其他位置。');
      }
    }
    this.active = new Set();
  }
  _path(relative) {
    if (typeof relative !== 'string' || !/^archive\/(?:\.staging\/[a-f0-9-]+\.tmp|\.journal\/[a-f0-9-]+\.json|objects\/[a-f0-9]{64}\.bin)$/.test(relative)) {
      throw fail('FS_ARCHIVE_PATH', '归档记录路径无效。');
    }
    const absolute = path.resolve(this.root, relative);
    const parent = path.dirname(absolute);
    if (fs.realpathSync(parent) !== parent || !parent.startsWith(this.root + path.sep)) {
      throw fail('FS_ARCHIVE_PATH', '归档记录越出案件位置。');
    }
    if (fs.existsSync(absolute)) {
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw fail('FS_ARCHIVE_PATH', '归档记录不是普通文件。');
    }
    return absolute;
  }
  _journal(record, first = false) {
    const target = this._path(`archive/.journal/${record.taskId}.json`);
    const text = JSON.stringify(record, null, 2);
    if (first) {
      const descriptor = fs.openSync(target, 'wx');
      try { fs.writeFileSync(descriptor, text); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    }
    else {
      const temporary = target + '.new';
      // A crashed write may leave this disposable journal sibling. The main
      // journal remains authoritative; only this exact, regular sibling is
      // removed, and active operations are serialized by the owning worker.
      if (fs.existsSync(temporary)) {
        const stat = fs.lstatSync(temporary);
        if (!stat.isFile() || stat.isSymbolicLink()) throw fail('FS_ARCHIVE_PATH', '归档日志临时位置异常，已停止恢复。');
        fs.unlinkSync(temporary);
      }
      const descriptor = fs.openSync(temporary, 'wx');
      try { fs.writeFileSync(descriptor, text); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      try { fs.renameSync(temporary, target); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
    }
  }
  async stage(source, { expectedSha256 = null, expectedSourceIdentity = null, signal, onProgress = () => {} } = {}) {
    if (expectedSha256 !== null && !SHA.test(expectedSha256)) throw fail('FS_ARCHIVE_INPUT', '预期文件哈希无效。');
    const original = path.resolve(source), stat = fs.lstatSync(original, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail('FS_ARCHIVE_SOURCE', '请选择普通原始文件。');
    if (expectedSourceIdentity !== null && (sourceIdentity(stat) !== expectedSourceIdentity ||
        path.relative(original, await fsp.realpath(original)) !== '')) {
      throw fail('FS_IMPORT_BATCH_CHANGED', '原件自生成清单后已经变化，请重新选择这份材料。');
    }
    const taskId = randomUUID();
    this.active.add(taskId);
    let record;
    try {
      signal?.throwIfAborted();
      const expected = await hashFile(original, { signal });
      if (expectedSha256 && expectedSha256 !== expected || sourceIdentity(stat) !== sourceIdentity(fs.statSync(original, { bigint: true }))) {
        throw fail('FS_ARCHIVE_CHANGED', '原始文件已变化，请重新选择。');
      }
      record = { version: 1, taskId, state: 'copying', createdAt: new Date().toISOString(),
        stagingRelativePath: `archive/.staging/${taskId}.tmp`, finalRelativePath: `archive/objects/${expected}.bin`,
        expectedSha256: expected, copiedSha256: null, sizeBytes: stat.size.toString(), copiedBytes: '0' };
      this._journal(record, true);
      const digest = createHash('sha256');
      let copied = 0n;
      const count = new Transform({ transform(chunk, _encoding, callback) {
        digest.update(chunk); copied += BigInt(chunk.length);
        try { onProgress({ phase: 'archiving', copiedBytes: copied.toString(), totalBytes: stat.size.toString() }); callback(null, chunk); }
        catch (error) { callback(error); }
      } });
      const staging = this._path(record.stagingRelativePath);
      await pipeline(fs.createReadStream(original), count, fs.createWriteStream(staging, { flags: 'wx' }), { signal });
      record.copiedSha256 = digest.digest('hex'); record.copiedBytes = copied.toString();
      if (record.copiedSha256 !== expected || copied !== stat.size ||
          sourceIdentity(stat) !== sourceIdentity(fs.statSync(original, { bigint: true }))) {
        throw fail('FS_ARCHIVE_CHANGED', '复制期间原始文件发生变化，归档未发布。');
      }
      const handle = fs.openSync(staging, 'r+');
      try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      if (await hashFile(staging, { signal }) !== expected) throw fail('FS_ARCHIVE_HASH', '归档副本复验未通过。');
      record.state = 'verified'; record.verifiedAt = new Date().toISOString(); this._journal(record);
      signal?.throwIfAborted();
      const destination = this._path(record.finalRelativePath);
      if (fs.existsSync(destination)) {
        if (fs.statSync(destination, { bigint: true }).size !== stat.size || await hashFile(destination, { signal }) !== expected) {
          throw fail('FS_ARCHIVE_HASH', '已有归档身份不符，不会覆盖。');
        }
      } else {
        // Exclusive link avoids rename replacing an existing final file. Both
        // paths are on the case filesystem. A crash may leave both links; the
        // staging link can be removed without deleting the final archive.
        try { fs.linkSync(staging, destination); }
        catch (error) {
          if (error.code !== 'EEXIST' || await hashFile(this._path(record.finalRelativePath), { signal }) !== expected) throw error;
        }
      }
      fs.unlinkSync(staging);
      record.state = 'ready'; record.readyAt = new Date().toISOString(); this._journal(record);
      return { ...record };
    } catch (error) {
      if (record) {
        record.state = 'failed'; record.errorCode = error.name === 'AbortError' ? 'FS_USER_CANCELLED' : error.code || 'FS_ARCHIVE_FAILED';
        try { this._journal(record); } catch (_) { /* Prior durable journal remains for recovery. */ }
      }
      if (error.code === 'ENOSPC') throw fail('FS_ARCHIVE_SPACE', '数据存放位置的磁盘空间不足。');
      throw error.code?.startsWith('FS_') ? error : fail(error.name === 'AbortError' ? 'FS_USER_CANCELLED' : 'FS_ARCHIVE_FAILED',
        error.name === 'AbortError' ? '已取消归档，未发布导入结果。' : '归档未完成，请检查原件、权限和剩余空间。');
    } finally { this.active.delete(taskId); }
  }
  _inspectJournal(taskId) {
    const file = this._path(`archive/.journal/${taskId}.json`);
    if (fs.statSync(file).size > 65536) throw fail('FS_ARCHIVE_JOURNAL', '归档恢复记录过大。');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.version !== 1 || record.taskId !== taskId || !SHA.test(record.expectedSha256) ||
        !Number.isFinite(Date.parse(record.createdAt)) ||
        !['copying','verified','ready','failed','staging_cleaned'].includes(record.state) ||
        record.stagingRelativePath !== `archive/.staging/${record.taskId}.tmp` ||
        record.finalRelativePath !== `archive/objects/${record.expectedSha256}.bin`) {
      throw fail('FS_ARCHIVE_JOURNAL', '归档恢复记录身份无效。');
    }
    let interruptedJournal=false;
    try {
      const stat=fs.lstatSync(file + '.new');
      if (!stat.isFile() || stat.isSymbolicLink()) throw fail('FS_ARCHIVE_PATH', '归档日志临时位置异常。');
      interruptedJournal=true;
    } catch (error) { if (error.code!=='ENOENT') throw error; }
    return { ...record, active: this.active.has(record.taskId), interruptedJournal,
      stagingExists: fs.existsSync(this._path(record.stagingRelativePath)),
      finalExists: fs.existsSync(this._path(record.finalRelativePath)) };
  }
  inspectRecovery() {
    const results = [];
    for (const name of fs.readdirSync(path.join(this.root, 'archive/.journal'))) {
      if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
      try { results.push(this._inspectJournal(name.slice(0, -5))); }
      catch (_) { results.push({ journal: name, state: 'invalid', requiresReview: true }); }
    }
    return results;
  }
  // Caller supplies a synchronous database reference check and serializes this
  // with imports. Final objects are always retained; cleanup is staging-only.
  cleanupStaging(taskId, { isReferenced, graceMs = 86400000, now = Date.now() } = {}) {
    if (!ID.test(taskId) || typeof isReferenced !== 'function' || !Number.isSafeInteger(graceMs) || graceMs < 0 ||
        !Number.isFinite(new Date(now).getTime())) {
      throw fail('FS_ARCHIVE_INPUT', '清理参数无效。');
    }
    let entry;
    try { entry=this._inspectJournal(taskId); }
    catch (_) { throw fail('FS_ARCHIVE_JOURNAL', '归档恢复记录无效。'); }
    if (this.active.size || isReferenced(entry) !== false) throw fail('FS_ARCHIVE_REFERENCED', '归档仍被引用或存在进行中的任务，不能清理。');
    if (now - Date.parse(entry.createdAt) < graceMs || !Number.isFinite(Date.parse(entry.createdAt))) {
      throw fail('FS_ARCHIVE_GRACE', '归档尚处保留期，暂不清理。');
    }
    if (entry.stagingExists) fs.unlinkSync(this._path(entry.stagingRelativePath));
    entry.state = 'staging_cleaned'; entry.cleanedAt = new Date(now).toISOString(); this._journal(entry);
    return { taskId, stagingRemoved: entry.stagingExists, journalTemporaryRemoved: entry.interruptedJournal, finalRetained: entry.finalExists };
  }
}

module.exports = { ArchiveStore, hashFile };
