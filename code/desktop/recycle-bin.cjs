'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runCaseIntegrityTransaction } = require('./hardening.cjs');

const protectedHistory = [
  'v4_review_event_delete', 'trg_pending_reason_delete', 'trg_balance_history_delete',
  'v2_batch_delete', 'v2_source_delete', 'v3_archive_delete'
];

function listRemovedMaterials(db) {
  return db.prepare('SELECT id,file_name AS fileName,removed_at AS removedAt FROM source_file WHERE removed_at IS NOT NULL')
    .all().map(row => ({ ...row, id: String(row.id) }));
}

function cleanPurgeJournal(db, directory) {
  const journalPath = path.join(directory, '.fundsift-empty-trash.json');
  let files;
  try {
    if (!fs.lstatSync(journalPath).isFile()) throw new Error('Invalid recycle journal');
    files = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!Array.isArray(files) || files.some(file => !/^[a-f0-9]{64}\.bin$/.test(file))) {
    throw new Error('Invalid recycle journal');
  }
  const objects = path.join(directory, 'archive', 'objects');
  for (const name of files) {
    if (db.prepare('SELECT 1 FROM archive_entry WHERE final_relative_path=?').get('archive/objects/' + name)) continue;
    if (fs.realpathSync(objects) !== objects) throw new Error('Archive directory changed');
    try { fs.unlinkSync(path.join(objects, name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  fs.unlinkSync(journalPath);
}

function purgeRemovedMaterials(db, record, directory, expectedIds) {
  try {
    cleanPurgeJournal(db, directory);
    if (!expectedIds.length) return;
    const items = JSON.stringify(expectedIds);
    const files = db.prepare(`SELECT DISTINCT a.final_relative_path AS file
      FROM archive_entry a
      WHERE (a.id IN (SELECT b.archive_entry_id FROM import_batch b JOIN source_file s ON s.id=b.source_file_id WHERE s.removed_at IS NOT NULL AND CAST(s.id AS TEXT) IN (SELECT value FROM json_each(?)))
        OR a.id IN (SELECT archive_entry_id FROM source_file WHERE removed_at IS NOT NULL AND CAST(id AS TEXT) IN (SELECT value FROM json_each(?))))
      AND NOT EXISTS (SELECT 1 FROM source_file s WHERE s.archive_entry_id=a.id AND (s.removed_at IS NULL OR CAST(s.id AS TEXT) NOT IN (SELECT value FROM json_each(?))))
      AND NOT EXISTS (SELECT 1 FROM import_batch b JOIN source_file s ON s.id=b.source_file_id WHERE b.archive_entry_id=a.id AND (s.removed_at IS NULL OR CAST(s.id AS TEXT) NOT IN (SELECT value FROM json_each(?))))`)
      .all(items, items, items, items).map(row => row.file);
    if (files.some(file => !/^archive\/objects\/[a-f0-9]{64}\.bin$/.test(file))) throw new Error('Invalid archive path');
    if (files.length) {
      const journalPath = path.join(directory, '.fundsift-empty-trash.json');
      const fd = fs.openSync(journalPath, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify(files.map(file => path.basename(file)))); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
    runCaseIntegrityTransaction(db, record, () => {
      db.pragma('defer_foreign_keys = ON');
      db.exec(`CREATE TEMP TABLE purge_sources (id INTEGER PRIMARY KEY);
        CREATE TEMP TABLE purge_flows (id INTEGER PRIMARY KEY);
        CREATE TEMP TABLE purge_batches (id INTEGER PRIMARY KEY);`);
      db.prepare(`INSERT INTO temp.purge_sources
        SELECT id FROM source_file WHERE removed_at IS NOT NULL AND CAST(id AS TEXT) IN (SELECT value FROM json_each(?))`).run(items);
      if (db.prepare('SELECT count(*) AS count FROM temp.purge_sources').get().count !== expectedIds.length) {
        throw new Error('Selection changed');
      }
      db.exec(`INSERT INTO temp.purge_flows SELECT id FROM fund_flow WHERE source_file_id IN temp.purge_sources;
        INSERT INTO temp.purge_batches SELECT id FROM import_batch WHERE source_file_id IN temp.purge_sources;`);
      const triggers = protectedHistory.map(name => db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name));
      if (triggers.some(trigger => !trigger?.sql)) throw new Error('Unexpected archive schema');
      for (const trigger of triggers) db.exec('DROP TRIGGER ' + trigger.name);
      if (db.prepare('SELECT 1 FROM balance_check_history WHERE prev_flow_id IN temp.purge_flows AND fund_flow_id NOT IN temp.purge_flows').get()) {
        throw Object.assign(new Error('仍有其他材料的余额历史引用这份流水，无法永久删除。'), { code: 'FS_TRASH_REFERENCED' });
      }
      db.exec(`DELETE FROM review_event WHERE fund_flow_id IN temp.purge_flows;
        DELETE FROM pending_reason WHERE fund_flow_id IN temp.purge_flows;
        DELETE FROM balance_check WHERE fund_flow_id IN temp.purge_flows;
        DELETE FROM balance_check_history WHERE fund_flow_id IN temp.purge_flows;
        DELETE FROM import_check WHERE source_file_id IN temp.purge_sources OR batch_id IN temp.purge_batches;
        DELETE FROM fund_flow WHERE id IN temp.purge_flows;
        DELETE FROM import_batch WHERE id IN temp.purge_batches;
        DELETE FROM source_file WHERE id IN temp.purge_sources;`);
      db.prepare('DELETE FROM archive_entry WHERE final_relative_path IN (SELECT value FROM json_each(?))').run(JSON.stringify(files));
      for (const trigger of triggers) db.exec(trigger.sql);
      db.exec('DROP TABLE temp.purge_flows; DROP TABLE temp.purge_batches; DROP TABLE temp.purge_sources;');
    });
    cleanPurgeJournal(db, directory);
  } catch (error) {
    if (error.code === 'FS_TRASH_REFERENCED') throw error;
    throw Object.assign(new Error('部分材料未能清理。请检查案件目录和归档权限，再打开回收站重试。', { cause: error }), { code: 'FS_TRASH_PURGE' });
  }
}

module.exports = { listRemovedMaterials, purgeRemovedMaterials, cleanPurgeJournal };
