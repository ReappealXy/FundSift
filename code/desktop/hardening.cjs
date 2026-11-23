'use strict';

// v2 protections layer onto the frozen v1 DDL. No financial parsing happens here.
// Guards protect supported SQL writes; a user who drops triggers or edits the
// auxiliary metadata can bypass them. This is not arbitrary-tampering detection.
// Full checks are explicit. Normal business transactions declare source files
// (batch operations) or existing flow IDs (record review), and maintain only
// those contributions. Temporary guards read scope; they never write per-row
// journals or summaries. Callbacks are trusted service code, not arbitrary SQL.
const observations = new WeakMap();

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

const EFFECTIVE_FLOW_FROM = `FROM fund_flow f
  JOIN source_file s ON s.id=f.source_file_id AND s.case_id=f.case_id
  JOIN import_batch b ON b.id=s.current_batch_id AND b.id=f.batch_id
    AND b.source_file_id=s.id AND b.case_id=f.case_id AND b.status='done'
  WHERE f.case_id=1`;

function installCaseV5(db) {
  db.exec('ALTER TABLE source_file ADD COLUMN removed_at TEXT');
}

function activeMaterialPredicate(db, alias = 's') {
  // Legacy validation and migration still run against schemas without the column.
  return db.pragma('user_version', { simple: true }) >= 5 ? `${alias}.removed_at IS NULL` : '1=1';
}

function effectiveFlowFrom(db) {
  return `${EFFECTIVE_FLOW_FROM} AND ${activeMaterialPredicate(db)}`;
}

const AUX_SCHEMA = `
  CREATE TABLE case_data_state (
    id INTEGER PRIMARY KEY CHECK(id=1), case_uuid TEXT NOT NULL,
    data_version INTEGER NOT NULL CHECK(data_version>=0),
    updated_at TEXT NOT NULL, time_source TEXT NOT NULL
  );
  CREATE TABLE case_summary (
    id INTEGER PRIMARY KEY CHECK(id=1), case_uuid TEXT NOT NULL,
    covered_version INTEGER NOT NULL CHECK(covered_version>=0),
    generated_at TEXT NOT NULL, valid INTEGER NOT NULL CHECK(valid IN (0,1)),
    files INTEGER NOT NULL CHECK(files>=0), flows INTEGER, pending INTEGER,
    summary_state TEXT NOT NULL, diagnostics_json TEXT NOT NULL,
    CHECK(flows IS NULL OR flows>=0), CHECK(pending IS NULL OR pending>=0)
  );
  CREATE INDEX idx_batch_source_status ON import_batch(source_file_id,status,id);
`;

function remember(db) {
  observations.set(db, {
    external: db.pragma('data_version', { simple: true }),
    local: db.prepare('SELECT total_changes() AS n').get().n
  });
}

function fileDiagnostics(db, { all = false } = {}) {
  const rows = db.prepare(`SELECT s.id,s.file_name,s.case_id,s.current_batch_id,s.first_batch_id,s.status,
      b.id AS target_id,b.case_id AS batch_case,b.source_file_id AS batch_file,b.status AS batch_status,
      b.total_rows,b.imported_rows,b.skipped_rows,
      first.id AS first_id,first.case_id AS first_case,first.source_file_id AS first_file,
      EXISTS(SELECT 1 FROM import_batch h WHERE h.source_file_id=s.id AND h.case_id=s.case_id AND h.status='done') AS has_done,
      (SELECT h.status FROM import_batch h WHERE h.source_file_id=s.id AND h.case_id=s.case_id ORDER BY h.id DESC LIMIT 1) AS latest_status
    FROM source_file s
    LEFT JOIN import_batch b ON b.id=s.current_batch_id
    LEFT JOIN import_batch first ON first.id=s.first_batch_id
    WHERE ${all ? '1=1' : activeMaterialPredicate(db)}
    ORDER BY s.id`).all();
  const diagnostics = [];
  for (const row of rows) {
    const base = { fileId: row.id, fileName: row.file_name, batchId: row.current_batch_id };
    const add = (code, message, blocking = true) => diagnostics.push({ ...base, code,
      message: `材料“${row.file_name}”（${row.id}），当前批次 ${row.current_batch_id ?? '空'}：${message}`, blocking });
    if (row.case_id !== 1) add('case_mismatch', '材料的案件归属与当前案件不符。');
    if (row.first_batch_id !== null && (row.first_id === null || row.first_case !== row.case_id || row.first_file !== row.id)) {
      add('first_batch_invalid', '首次批次失联或不属于该材料。');
    }
    if (row.current_batch_id === null) {
      if (row.has_done || row.status === 'imported') add('current_missing', '材料已有发布记录，但当前有效批次为空；不会自动选用历史批次。');
      else add('not_published', '材料尚未成功发布，没有可确认的完整流水总数。');
    } else if (row.target_id === null) add('current_missing_target', '当前批次指针指向的批次已失联。');
    else if (row.batch_case !== row.case_id || row.batch_file !== row.id) add('current_ownership', '当前批次不属于该案件或材料。');
    else if (row.batch_status !== 'done') add('current_not_done', `当前批次状态为 ${row.batch_status}，尚未完整发布。`);
    else if (row.total_rows === null || row.imported_rows === null || row.skipped_rows === null) {
      add('batch_counts_missing', '当前批次缺少完整行数核对依据，不能把空计数视为成功结果。');
    }
    if (row.current_batch_id !== null && ['failed','partial'].includes(row.latest_status)) {
      add('latest_import_failed', '最近一次导入未完整成功，仍保留原有效批次。', false);
    }
  }
  return { files: rows.length, diagnostics };
}

function validateIdentity(db, record) {
  const identities = db.prepare('SELECT id,case_no,case_name,created_at FROM case_info').all();
  const desktop = db.prepare('SELECT id,case_uuid FROM desktop_case_identity').all();
  if (identities.length !== 1 || identities[0].id !== 1 || desktop.length !== 1 || desktop[0].id !== 1 ||
      desktop[0].case_uuid !== record.id || identities[0].case_no !== record.case_no ||
      identities[0].case_name !== record.case_name || identities[0].created_at !== record.created_at) {
    fail('FS_CASE_IDENTITY', '案件身份与工作区登记不一致，已停止升级或写入。');
  }
}

function validateCaseV1(db, record) {
  validateIdentity(db, record);
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) {
    fail('FS_CASE_DATA', '案件完整性或外键检查失败；原数据保持不变。');
  }
  const checks = [
    ["SELECT id FROM source_file WHERE case_id IS NOT 1 LIMIT 1", '材料案件归属错误'],
    [`SELECT b.id FROM import_batch b LEFT JOIN source_file s ON s.id=b.source_file_id
      WHERE b.case_id IS NOT 1 OR s.id IS NULL OR b.case_id IS NOT s.case_id LIMIT 1`, '批次与材料归属不一致'],
    [`SELECT f.id FROM fund_flow f LEFT JOIN source_file s ON s.id=f.source_file_id
      LEFT JOIN import_batch b ON b.id=f.batch_id
      WHERE f.case_id IS NOT 1 OR s.id IS NULL OR b.id IS NULL OR
        s.case_id IS NOT f.case_id OR b.case_id IS NOT f.case_id OR b.source_file_id IS NOT f.source_file_id LIMIT 1`, '流水与案件、材料或批次归属不一致'],
    [`SELECT id FROM fund_flow WHERE
      (amount IS NOT NULL AND typeof(amount)<>'integer') OR
      (amount IS NULL AND status IS NOT 'pending') OR
      (amount>0 AND direction IS NOT '进') OR (amount<0 AND direction IS NOT '出') OR
      (balance IS NOT NULL AND typeof(balance)<>'integer') LIMIT 1`, '金额或余额类型、金额方向或空值状态不合法'],
    [`SELECT f.id FROM fund_flow f WHERE
      (f.status='pending' AND NOT EXISTS(SELECT 1 FROM pending_reason p WHERE p.fund_flow_id=f.id AND p.resolved_at IS NULL)) OR
      (f.status='confirmed' AND EXISTS(SELECT 1 FROM pending_reason p WHERE p.fund_flow_id=f.id AND p.resolved_at IS NULL)) LIMIT 1`, '流水待核状态与未解除原因不一致'],
    [`SELECT id FROM import_batch WHERE
      (total_rows IS NOT NULL AND (typeof(total_rows)<>'integer' OR total_rows<0)) OR
      (imported_rows IS NOT NULL AND (typeof(imported_rows)<>'integer' OR imported_rows<0)) OR
      (skipped_rows IS NOT NULL AND (typeof(skipped_rows)<>'integer' OR skipped_rows<0)) OR
      (status='done' AND total_rows IS NOT NULL AND imported_rows IS NOT NULL AND skipped_rows IS NOT NULL
       AND total_rows<>imported_rows+skipped_rows) LIMIT 1`, '批次行数核对不合法'],
    [`SELECT b.id FROM import_batch b WHERE b.status='done' AND b.imported_rows IS NOT NULL AND
      b.imported_rows<>(SELECT count(*) FROM fund_flow f WHERE f.batch_id=b.id) LIMIT 1`, '已发布批次的行数与实际流水不一致']
  ];
  for (const [sql, message] of checks) {
    const row = db.prepare(sql).get();
    if (row) fail('FS_CASE_DATA', `${message}（记录 ${row.id}），已停止操作；不会自动修正或删除。`);
  }
  const invalid = fileDiagnostics(db, { all: true }).diagnostics.find(item => !['not_published','batch_counts_missing','latest_import_failed'].includes(item.code));
  if (invalid) fail('FS_CASE_DATA', `材料“${invalid.fileName}”（${invalid.fileId}）、批次 ${invalid.batchId ?? '空'}：${invalid.message}`);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='format_rule_config'").get()) {
    require('./foundation.cjs').validateFoundationData(db);
  }
  return true;
}

const flowValueGuard = `
  SELECT CASE WHEN NEW.amount IS NOT NULL AND typeof(NEW.amount)<>'integer'
    THEN RAISE(ABORT,'标准金额必须是整数分，不能写入小数或非数字文本。') END;
  SELECT CASE WHEN NEW.balance IS NOT NULL AND typeof(NEW.balance)<>'integer'
    THEN RAISE(ABORT,'标准余额必须是整数分。') END;
  SELECT CASE WHEN NEW.amount IS NULL AND NEW.status IS NOT 'pending'
    THEN RAISE(ABORT,'金额未知的流水必须保留待核状态。') END;
  SELECT CASE WHEN (NEW.amount>0 AND NEW.direction IS NOT '进') OR (NEW.amount<0 AND NEW.direction IS NOT '出')
    THEN RAISE(ABORT,'非零标准金额的方向与正负号不一致。') END;
  SELECT CASE WHEN NEW.case_id IS NOT 1 OR NOT EXISTS(
    SELECT 1 FROM source_file s JOIN import_batch b ON b.source_file_id=s.id AND b.case_id=s.case_id
    WHERE s.id=NEW.source_file_id AND b.id=NEW.batch_id AND s.case_id=NEW.case_id)
    THEN RAISE(ABORT,'流水不属于所指定的案件、材料或批次。') END;
`;
const mutationGuard = `SELECT CASE WHEN (SELECT valid FROM case_summary WHERE id=1) IS NOT 0
  THEN RAISE(ABORT,'写入流水前必须先在业务事务中标记统计摘要失效。') END;`;
const sourceGuard = `
  SELECT CASE WHEN NEW.case_id IS NOT 1 OR NOT EXISTS(SELECT 1 FROM case_info WHERE id=NEW.case_id)
    THEN RAISE(ABORT,'材料不属于当前案件。') END;
  SELECT CASE WHEN NEW.current_batch_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM import_batch WHERE id=NEW.current_batch_id AND case_id=NEW.case_id AND source_file_id=NEW.id AND status='done')
    THEN RAISE(ABORT,'当前有效批次必须是本案本材料完整发布的批次。') END;
  SELECT CASE WHEN NEW.first_batch_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM import_batch WHERE id=NEW.first_batch_id AND case_id=NEW.case_id AND source_file_id=NEW.id)
    THEN RAISE(ABORT,'首次批次必须属于本案本材料。') END;
`;
const batchGuard = `
  SELECT CASE WHEN NEW.case_id IS NOT 1 OR NOT EXISTS(SELECT 1 FROM source_file WHERE id=NEW.source_file_id AND case_id=NEW.case_id)
    THEN RAISE(ABORT,'批次不属于所指定的案件或材料。') END;
  SELECT CASE WHEN (NEW.total_rows IS NOT NULL AND (typeof(NEW.total_rows)<>'integer' OR NEW.total_rows<0)) OR
    (NEW.imported_rows IS NOT NULL AND (typeof(NEW.imported_rows)<>'integer' OR NEW.imported_rows<0)) OR
    (NEW.skipped_rows IS NOT NULL AND (typeof(NEW.skipped_rows)<>'integer' OR NEW.skipped_rows<0))
    THEN RAISE(ABORT,'批次行数必须是非负整数。') END;
`;

function installTriggers(db) {
  db.exec(`
    CREATE TRIGGER v2_case_identity_insert BEFORE INSERT ON desktop_case_identity
    WHEN NEW.id IS NOT 1 OR EXISTS(SELECT 1 FROM desktop_case_identity)
    BEGIN SELECT RAISE(ABORT,'案件UUID身份已初始化，不能替换或再次插入。'); END;
    CREATE TRIGGER v2_case_identity_update BEFORE UPDATE ON desktop_case_identity
    BEGIN SELECT RAISE(ABORT,'案件UUID身份不能修改。'); END;
    CREATE TRIGGER v2_case_identity_delete BEFORE DELETE ON desktop_case_identity
    BEGIN SELECT RAISE(ABORT,'案件UUID身份不能删除。'); END;
    CREATE TRIGGER v2_case_info_insert BEFORE INSERT ON case_info
    WHEN NEW.id IS NOT 1 OR EXISTS(SELECT 1 FROM case_info)
    BEGIN SELECT RAISE(ABORT,'案件登记身份不能替换。'); END;
    CREATE TRIGGER v2_case_info_update BEFORE UPDATE ON case_info
    WHEN NEW.id IS NOT OLD.id OR NEW.case_no IS NOT OLD.case_no OR NEW.case_name IS NOT OLD.case_name OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT,'案件身份、名称、编号和创建时间不能原地改写。'); END;
    CREATE TRIGGER v2_case_info_delete BEFORE DELETE ON case_info
    BEGIN SELECT RAISE(ABORT,'案件登记身份不能删除。'); END;

    CREATE TRIGGER v2_source_insert BEFORE INSERT ON source_file BEGIN
      SELECT CASE WHEN EXISTS(SELECT 1 FROM source_file WHERE id=NEW.id OR (case_id=NEW.case_id AND file_sha256=NEW.file_sha256))
        THEN RAISE(ABORT,'原始材料身份不能替换；重导应新建批次。') END;
      ${sourceGuard}
    END;
    CREATE TRIGGER v2_source_update BEFORE UPDATE ON source_file BEGIN
      SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.case_id IS NOT OLD.case_id OR NEW.file_sha256 IS NOT OLD.file_sha256
        THEN RAISE(ABORT,'材料身份、案件归属和原件哈希不能修改。') END;
      SELECT CASE WHEN OLD.first_batch_id IS NOT NULL AND NEW.first_batch_id IS NOT OLD.first_batch_id
        THEN RAISE(ABORT,'首次批次一经登记不能改写或清空。') END;
      ${sourceGuard}
    END;
    CREATE TRIGGER v2_source_delete BEFORE DELETE ON source_file
    WHEN EXISTS(SELECT 1 FROM import_batch WHERE source_file_id=OLD.id) OR EXISTS(SELECT 1 FROM fund_flow WHERE source_file_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'材料仍有批次或流水引用，不能删除。'); END;

    CREATE TRIGGER v2_batch_insert BEFORE INSERT ON import_batch BEGIN
      SELECT CASE WHEN EXISTS(SELECT 1 FROM import_batch WHERE id=NEW.id)
        THEN RAISE(ABORT,'已有批次不能替换；重试应新建批次。') END;
      ${batchGuard}
    END;
    CREATE TRIGGER v2_batch_update BEFORE UPDATE ON import_batch BEGIN
      SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.case_id IS NOT OLD.case_id OR NEW.source_file_id IS NOT OLD.source_file_id
        OR NEW.started_at IS NOT OLD.started_at OR NEW.parser_version IS NOT OLD.parser_version
        THEN RAISE(ABORT,'批次身份、归属和解析器版本不能原地修改。') END;
      SELECT CASE WHEN (OLD.status IN ('done','failed','partial') AND NEW.status IS NOT OLD.status) OR
        (OLD.status='importing' AND NEW.status IN ('pending','parsing')) OR (OLD.status='parsing' AND NEW.status='pending')
        THEN RAISE(ABORT,'批次不能倒退状态或复用终止批次；请新建重试批次。') END;
      SELECT CASE WHEN NEW.status IS NOT 'done' AND EXISTS(SELECT 1 FROM source_file WHERE current_batch_id=OLD.id)
        THEN RAISE(ABORT,'正在使用的有效批次必须保持完整发布状态。') END;
      ${batchGuard}
    END;
    CREATE TRIGGER v2_batch_delete BEFORE DELETE ON import_batch
    WHEN EXISTS(SELECT 1 FROM source_file WHERE current_batch_id=OLD.id OR first_batch_id=OLD.id) OR
      EXISTS(SELECT 1 FROM fund_flow WHERE batch_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'批次仍被有效指针、首次指针或流水引用，不能删除。'); END;

    CREATE TRIGGER v2_flow_insert BEFORE INSERT ON fund_flow BEGIN
      ${mutationGuard}
      SELECT CASE WHEN EXISTS(SELECT 1 FROM fund_flow WHERE id=NEW.id OR
        (batch_id=NEW.batch_id AND source_file_id=NEW.source_file_id AND source_loc=NEW.source_loc))
        THEN RAISE(ABORT,'流水身份和原始位置不能替换。') END;
      ${flowValueGuard}
    END;
    CREATE TRIGGER v2_flow_update BEFORE UPDATE ON fund_flow BEGIN
      ${mutationGuard}
      SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.case_id IS NOT OLD.case_id OR NEW.batch_id IS NOT OLD.batch_id OR
        NEW.source_file_id IS NOT OLD.source_file_id OR NEW.format_rule_id IS NOT OLD.format_rule_id OR
        NEW.rule_version IS NOT OLD.rule_version OR NEW.source_loc IS NOT OLD.source_loc OR
        NEW.raw_amount_text IS NOT OLD.raw_amount_text OR NEW.raw_direction IS NOT OLD.raw_direction OR
        NEW.raw_balance_text IS NOT OLD.raw_balance_text OR NEW.txn_time_text IS NOT OLD.txn_time_text
        THEN RAISE(ABORT,'流水身份、来源坐标、原始字段和规则版本不能原地改写。') END;
      ${flowValueGuard}
    END;
    CREATE TRIGGER v2_flow_delete BEFORE DELETE ON fund_flow BEGIN ${mutationGuard} END;
  `);
  // Only low-volume metadata writes invalidate automatically. A flow guard only
  // reads valid; it never updates a summary for every transaction row.
  for (const table of ['source_file','import_batch','pending_reason','case_info']) {
    for (const event of ['INSERT','UPDATE','DELETE']) {
      db.exec(`CREATE TRIGGER v2_dirty_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
        WHEN (SELECT valid FROM case_summary WHERE id=1)=1 BEGIN
          UPDATE case_data_state SET data_version=data_version+1 WHERE id=1;
          UPDATE case_summary SET valid=0 WHERE id=1;
        END;`);
    }
  }
}

function requireTransaction(db) {
  if (!db.inTransaction) fail('FS_CASE_TRANSACTION', '案件变更和统计刷新必须放在同一数据库事务内。');
}

function beginCaseMutation(db) {
  requireTransaction(db);
  db.prepare('UPDATE case_data_state SET data_version=data_version+1 WHERE id=1').run();
  db.prepare('UPDATE case_summary SET valid=0 WHERE id=1').run();
}

function refreshSummary(db, record, { businessChanged = false, timestamp = new Date().toISOString(), validate = true } = {}) {
  requireTransaction(db);
  if (validate) validateCaseV1(db, record);
  const { files, diagnostics } = fileDiagnostics(db);
  const complete = !diagnostics.some(item => item.blocking);
  // Retain the exact published contribution even when another source has not
  // published yet. Public reads still show unknown totals until all sources are
  // complete; retaining this subtotal permits a later source-scoped publication.
  const values = db.prepare(`SELECT count(*) AS flows,
      coalesce(sum(CASE WHEN f.status='pending' THEN 1 ELSE 0 END),0) AS pending ${effectiveFlowFrom(db)}`).get();
  if (businessChanged) db.prepare("UPDATE case_data_state SET updated_at=?,time_source='business' WHERE id=1").run(timestamp);
  const state = db.prepare('SELECT * FROM case_data_state WHERE id=1').get();
  if (!state || state.case_uuid !== record.id) fail('FS_CASE_IDENTITY', '统计状态的案件身份不一致。');
  db.prepare(`UPDATE case_summary SET case_uuid=?,covered_version=?,generated_at=?,valid=1,
    files=?,flows=?,pending=?,summary_state=?,diagnostics_json=? WHERE id=1`).run(
    record.id,state.data_version,timestamp,files,values.flows,values.pending,
    complete ? 'ready' : 'incomplete',JSON.stringify(diagnostics));
  // Caller commits immediately after returning. This also detects same-connection
  // writes outside the supported transaction helper on the next read.
  remember(db);
  return { stats: { files, ...(complete ? values : { flows: null, pending: null }) }, updatedAt: state.updated_at, summaryState: complete ? 'ready' : 'incomplete', diagnostics };
}

function installCaseV2(db, record) {
  requireTransaction(db);
  validateCaseV1(db, record);
  db.exec(AUX_SCHEMA);
  db.prepare(`INSERT INTO case_data_state VALUES(1,?,0,?,'legacy')`).run(record.id,record.updated_at || record.created_at);
  db.prepare(`INSERT INTO case_summary VALUES(1,?,0,?,0,0,NULL,NULL,'stale','[]')`).run(record.id,new Date().toISOString());
  installTriggers(db);
  return refreshSummary(db, record, { validate: false });
}

function readSummary(db, record, { diagnostics = false } = {}) {
  const state = db.prepare('SELECT * FROM case_data_state WHERE id=1').get();
  const summary = db.prepare('SELECT * FROM case_summary WHERE id=1').get();
  const baseline = observations.get(db);
  const external = db.pragma('data_version', { simple: true });
  const local = db.prepare('SELECT total_changes() AS n').get().n;
  const unexpectedChange = baseline && (baseline.external !== external || baseline.local !== local);
  const good = state && summary && state.case_uuid === record.id && summary.case_uuid === record.id &&
    summary.valid === 1 && summary.covered_version === state.data_version && !unexpectedChange;
  if (!good) {
    return { stats: { files: null, flows: null, pending: null }, updatedAt: state?.updated_at || record.updated_at,
      summaryState: 'stale', diagnostics: [{ code: 'summary_stale', blocking: true,
        message: '统计摘要缺失、已失效或数据版本发生变化；需完整检查后重新生成，不能当作当前总数。' }] };
  }
  if (!baseline) remember(db);
  const messages = diagnostics ? fileDiagnostics(db).diagnostics : JSON.parse(summary.diagnostics_json);
  return { stats: { files: summary.files,
      flows: summary.summary_state === 'ready' ? summary.flows : null,
      pending: summary.summary_state === 'ready' ? summary.pending : null },
    updatedAt: state.updated_at, summaryState: summary.summary_state, diagnostics: messages };
}

function runCaseIntegrityTransaction(db, record, callback) {
  if (db.inTransaction) fail('FS_CASE_TRANSACTION', '请在案件事务入口统一管理写入，不能嵌套业务事务。');
  let result;
  try {
    db.transaction(() => {
      beginCaseMutation(db);
      const before = db.prepare('SELECT total_changes() AS n').get().n;
      result = callback(db);
      if (result && typeof result.then === 'function') fail('FS_CASE_TRANSACTION', '案件事务回调必须同步完成。');
      const changed = db.prepare('SELECT total_changes() AS n').get().n !== before;
      refreshSummary(db, record, { businessChanged: changed });
    }).immediate();
  } finally {
    // SQLite total_changes includes rolled-back statements; resetting this
    // observation after rollback preserves the valid, previously committed row.
    remember(db);
  }
  return result;
}

function transactionScope(scope) {
  const keys = scope && Object.keys(scope);
  if (!keys || keys.length !== 1 || !['sourceFileIds','flowIds'].includes(keys[0])) {
    fail('FS_CASE_SCOPE', '写入前必须明确本次涉及的材料编号或已有流水编号，不能省略或混用范围。');
  }
  const ids = scope[keys[0]];
  if (!Array.isArray(ids) || !ids.length || ids.length > 10000 ||
      ids.some(id => !Number.isSafeInteger(id) || id < 1)) {
    fail('FS_CASE_SCOPE', '本次写入范围必须包含 1 至 10000 个有效编号。');
  }
  return { source: keys[0] === 'sourceFileIds', ids: [...new Set(ids)] };
}

// These connection-local objects do not alter the case schema or schema version.
// A raw callback must not drop triggers, change pragmas or run schema statements.
// As with the persistent v2 guards, this protects supported service writes, not
// a hostile process with arbitrary access to the SQLite file.
function installScopeGuards(db, scope) {
  db.exec('CREATE TEMP TABLE fundsift_write_scope(id INTEGER PRIMARY KEY)');
  const insert = db.prepare('INSERT INTO temp.fundsift_write_scope VALUES(?)');
  for (const id of scope.ids) insert.run(id);
  const names = [];
  const allowedFlow = row => scope.source
    ? `${row}.source_file_id IN (SELECT id FROM temp.fundsift_write_scope)`
    : `${row}.id IN (SELECT id FROM temp.fundsift_write_scope)`;
  const allowedReference = row => `EXISTS(SELECT 1 FROM main.fund_flow f
    WHERE f.id=${row}.fund_flow_id AND ${allowedFlow('f')})`;
  const allowedSource = row => scope.source ? `${row}.id IN (SELECT id FROM temp.fundsift_write_scope)` : '0';
  const allowedBatch = row => scope.source ? `${row}.source_file_id IN (SELECT id FROM temp.fundsift_write_scope)` : '0';
  const allowedCheck = row => scope.source ? `${row}.case_id=1 AND (
    (${row}.source_file_id IN (SELECT id FROM temp.fundsift_write_scope) AND
      (${row}.batch_id IS NULL OR EXISTS(SELECT 1 FROM main.import_batch b
        WHERE b.id=${row}.batch_id AND b.case_id=1 AND b.source_file_id=${row}.source_file_id))) OR
    (${row}.source_file_id IS NULL AND EXISTS(SELECT 1 FROM main.import_batch b
      WHERE b.id=${row}.batch_id AND b.case_id=1 AND b.source_file_id IN (SELECT id FROM temp.fundsift_write_scope))))` : '0';
  const tables = {
    source_file: allowedSource, import_batch: allowedBatch,
    fund_flow: allowedFlow, pending_reason: allowedReference,
    balance_check: allowedReference, balance_check_history: allowedReference,
    import_check: allowedCheck, format_rule: () => '0', case_info: () => '0',
    desktop_case_identity: () => '0', case_data_state: () => '0', case_summary: () => '0'
  };
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_event'").get()) {
    tables.review_event = scope.source ? () => '0' : allowedReference;
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='format_rule_config'").get()) {
    tables.format_rule_config = () => '0';
    // An unassociated staging ledger is registered through the explicit full
    // integrity entry point. Scoped writes require batch references entirely
    // within the declared material scope. The v3 legacy backreference is not
    // used as ownership because several batches can share one archive.
    tables.archive_entry = row => scope.source ? `EXISTS(SELECT 1 FROM main.import_batch b
      WHERE b.archive_entry_id=${row}.id AND b.source_file_id IN (SELECT id FROM temp.fundsift_write_scope))
      AND NOT EXISTS(SELECT 1 FROM main.import_batch b WHERE b.archive_entry_id=${row}.id
        AND b.source_file_id NOT IN (SELECT id FROM temp.fundsift_write_scope))
      AND NOT EXISTS(SELECT 1 FROM main.source_file s WHERE s.archive_entry_id=${row}.id
        AND s.id NOT IN (SELECT id FROM temp.fundsift_write_scope))` : '0';
  }
  for (const [table, allowed] of Object.entries(tables)) {
    for (const event of ['INSERT','UPDATE','DELETE']) {
      const name = `fundsift_scope_${table}_${event.toLowerCase()}`;
      names.push(name);
      const checks = event === 'INSERT' ? [allowed('NEW')] : event === 'DELETE' ? [allowed('OLD')] : [allowed('OLD'),allowed('NEW')];
      // Record review can change values and reasons, never the row population.
      if (!scope.source && table === 'fund_flow' && event !== 'UPDATE') checks.push('0');
      db.exec(`CREATE TEMP TRIGGER ${name} BEFORE ${event} ON main.${table}
        WHEN NOT coalesce((${checks.map(item => `(${item})`).join(' AND ')}),0)
        BEGIN SELECT RAISE(ABORT,'写入超出本次声明范围，已取消整个案件事务。'); END;`);
    }
  }
  // SQLite REPLACE can delete an existing row without firing its DELETE
  // triggers when recursive_triggers is disabled. Never let an auxiliary
  // INSERT silently replace an existing identity, including an out-of-scope
  // row. Callers must use the supported explicit update path instead.
  for (const table of ['pending_reason','balance_check','balance_check_history','import_check']) {
    const name = `fundsift_scope_${table}_replace`;
    names.push(name);
    db.exec(`CREATE TEMP TRIGGER ${name} BEFORE INSERT ON main.${table}
      WHEN EXISTS(SELECT 1 FROM main.${table} WHERE id=NEW.id)
      BEGIN SELECT RAISE(ABORT,'已有记录不能替换；请使用本次范围内的明确更新操作。'); END;`);
  }
  names.push('fundsift_scope_terminal_batch');
  db.exec(`CREATE TEMP TRIGGER fundsift_scope_terminal_batch BEFORE UPDATE ON main.import_batch
    WHEN OLD.status IN ('done','failed','partial') AND (
      NEW.id IS NOT OLD.id OR NEW.case_id IS NOT OLD.case_id OR NEW.source_file_id IS NOT OLD.source_file_id OR
      NEW.status IS NOT OLD.status OR NEW.started_at IS NOT OLD.started_at OR NEW.finished_at IS NOT OLD.finished_at OR
      NEW.parser_version IS NOT OLD.parser_version OR NEW.total_rows IS NOT OLD.total_rows OR
      NEW.imported_rows IS NOT OLD.imported_rows OR NEW.skipped_rows IS NOT OLD.skipped_rows)
    BEGIN SELECT RAISE(ABORT,'终止批次的身份、状态及行数不能改写；请新建重试批次。'); END;`);
  return () => {
    for (const name of names) db.exec(`DROP TRIGGER temp.${name}`);
    db.exec('DROP TABLE temp.fundsift_write_scope');
  };
}

function scopedContribution(db, scope) {
  const from = effectiveFlowFrom(db).replace('fund_flow f', scope.source
    ? 'fund_flow f INDEXED BY idx_ff_source_batch' : 'fund_flow f NOT INDEXED');
  return db.prepare(`SELECT count(*) AS flows,
    coalesce(sum(CASE WHEN f.status='pending' THEN 1 ELSE 0 END),0) AS pending
    ${from} AND f.${scope.source ? 'source_file_id' : 'id'} IN (SELECT id FROM temp.fundsift_write_scope)`).get();
}

function validateScope(db, record, scope) {
  validateIdentity(db, record);
  const clause = `f.${scope.source ? 'source_file_id' : 'id'} IN (SELECT id FROM temp.fundsift_write_scope)`;
  const invalid = db.prepare(`SELECT f.id FROM fund_flow f
    LEFT JOIN source_file s ON s.id=f.source_file_id
    LEFT JOIN import_batch b ON b.id=f.batch_id
    LEFT JOIN format_rule r ON r.id=f.format_rule_id AND r.rule_version=f.rule_version
    WHERE ${clause} AND (f.case_id IS NOT 1 OR s.id IS NULL OR b.id IS NULL OR r.id IS NULL OR
      s.case_id IS NOT f.case_id OR b.case_id IS NOT f.case_id OR b.source_file_id IS NOT f.source_file_id OR
      (f.amount IS NOT NULL AND typeof(f.amount)<>'integer') OR
      (f.amount IS NULL AND f.status IS NOT 'pending') OR
      (f.amount>0 AND f.direction IS NOT '进') OR (f.amount<0 AND f.direction IS NOT '出') OR
      (f.balance IS NOT NULL AND typeof(f.balance)<>'integer') OR
      (f.status='pending' AND NOT EXISTS(SELECT 1 FROM pending_reason p WHERE p.fund_flow_id=f.id AND p.resolved_at IS NULL)) OR
      (f.status='confirmed' AND EXISTS(SELECT 1 FROM pending_reason p WHERE p.fund_flow_id=f.id AND p.resolved_at IS NULL))) LIMIT 1`).get();
  if (invalid) fail('FS_CASE_DATA', `本次流水的归属、金额或待核状态不一致（记录 ${invalid.id}），已回滚。`);
  if (!scope.source && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_event'").get()) {
    const incompleteReview = db.prepare(`SELECT f.id FROM fund_flow f
      JOIN review_event e ON e.id=(SELECT latest.id FROM review_event latest
        WHERE latest.fund_flow_id=f.id ORDER BY latest.id DESC LIMIT 1)
      WHERE ${clause} AND (e.after_amount IS NOT f.amount OR e.after_direction IS NOT f.direction OR
        e.after_status IS NOT f.status OR EXISTS(SELECT 1 FROM review_event resolved
          JOIN pending_reason p ON p.id=resolved.reason_id
          WHERE resolved.fund_flow_id=f.id AND resolved.action='resolve' AND p.resolved_at IS NOT resolved.reviewed_at)) LIMIT 1`).get();
    if (incompleteReview) fail('FS_CASE_DATA', `本次复核结果与流水或待核原因不一致（记录 ${incompleteReview.id}），已回滚。`);
  }
  if (scope.source) {
    const invalidBatch = db.prepare(`SELECT b.id FROM import_batch b
      WHERE b.source_file_id IN (SELECT id FROM temp.fundsift_write_scope) AND b.status='done' AND (
        b.total_rows IS NULL OR b.imported_rows IS NULL OR b.skipped_rows IS NULL OR
        b.total_rows<>b.imported_rows+b.skipped_rows OR b.imported_rows<>(
          SELECT count(*) FROM fund_flow f WHERE f.source_file_id=b.source_file_id AND f.batch_id=b.id)) LIMIT 1`).get();
    if (invalidBatch) fail('FS_CASE_DATA', `本次已发布批次的行数核对不一致（批次 ${invalidBatch.id}），已回滚。`);
  }
}

// Explicit alternative to runCaseIntegrityTransaction: no integrity_check or
// all-case flow scan. A source scope covers batch publication/switch/failure;
// a flow scope covers review of existing records and their pending reasons.
function runCaseTransaction(db, record, declaredScope, callback, { preflight } = {}) {
  if (db.inTransaction) fail('FS_CASE_TRANSACTION', '请在案件事务入口统一管理写入，不能嵌套业务事务。');
  const scope = transactionScope(declaredScope);
  if (typeof callback !== 'function' || (preflight !== undefined && typeof preflight !== 'function')) {
    fail('FS_CASE_TRANSACTION', '案件事务需要同步校验及写入操作。');
  }
  if (db.pragma('foreign_keys', { simple: true }) !== 1) fail('FS_CASE_TRANSACTION', '案件写入前必须开启外键保护。');
  let result, accepted = false;
  try {
    db.transaction(() => {
      if (preflight) {
        result = preflight(db);
        if (result && typeof result.then === 'function') fail('FS_CASE_TRANSACTION', '案件事务回调必须同步完成。');
        if (result !== undefined) return;
      }
      const previous = readSummary(db, record);
      const baseline = db.prepare('SELECT * FROM case_summary WHERE id=1').get();
      if (previous.summaryState === 'stale' || !baseline ||
          !Number.isSafeInteger(baseline.flows) || !Number.isSafeInteger(baseline.pending)) {
        fail('FS_SUMMARY_BASELINE', '统计摘要已失效或缺少可用基线，不能增量写入；请先通过显式完整检查重新生成摘要。');
      }
      accepted = true;
      validateIdentity(db, record);
      beginCaseMutation(db);
      const removeGuards = installScopeGuards(db, scope);
      if (!scope.source && db.prepare(`SELECT count(*) AS n FROM fund_flow
        WHERE id IN (SELECT id FROM temp.fundsift_write_scope)`).get().n !== scope.ids.length) {
        fail('FS_CASE_SCOPE', '待复核的流水已失联，不能按不存在的记录维护统计。');
      }
      const beforeContribution = scopedContribution(db, scope);
      const beforeChanges = db.prepare('SELECT total_changes() AS n').get().n;
      result = callback(db);
      if (result && typeof result.then === 'function') fail('FS_CASE_TRANSACTION', '案件事务回调必须同步完成。');
      const changed = db.prepare('SELECT total_changes() AS n').get().n !== beforeChanges;
      validateScope(db, record, scope);
      const afterContribution = scopedContribution(db, scope);
      const { files, diagnostics } = fileDiagnostics(db);
      const invalidSource = diagnostics.find(item => !['not_published','batch_counts_missing','latest_import_failed'].includes(item.code));
      if (invalidSource) fail('FS_CASE_DATA', invalidSource.message);
      const flows = baseline.flows + afterContribution.flows - beforeContribution.flows;
      const pending = baseline.pending + afterContribution.pending - beforeContribution.pending;
      if (!Number.isSafeInteger(flows) || !Number.isSafeInteger(pending) || pending < 0 || flows < pending) {
        fail('FS_SUMMARY_BASELINE', '统计增量不符合计数边界，已回滚；请执行显式完整检查。');
      }
      removeGuards();
      const timestamp = new Date().toISOString();
      if (changed) db.prepare("UPDATE case_data_state SET updated_at=?,time_source='business' WHERE id=1").run(timestamp);
      const state = db.prepare('SELECT * FROM case_data_state WHERE id=1').get();
      const complete = !diagnostics.some(item => item.blocking);
      db.prepare(`UPDATE case_summary SET covered_version=?,generated_at=?,valid=1,
        files=?,flows=?,pending=?,summary_state=?,diagnostics_json=? WHERE id=1`).run(
        state.data_version,timestamp,files,flows,pending,complete ? 'ready' : 'incomplete',JSON.stringify(diagnostics));
    }).immediate();
  } finally {
    // Do not erase pre-existing unexpected-write evidence on baseline rejection.
    // For an accepted transaction, rollback also rolls back the temporary guards.
    if (accepted) remember(db);
  }
  return result;
}

function withCaseReadSnapshot(db, callback) {
  if (db.inTransaction) return callback(db);
  db.exec('BEGIN DEFERRED');
  try {
    const result = callback(db);
    if (result && typeof result.then === 'function') fail('FS_CASE_TRANSACTION', '一致快照读取必须在同步读事务内完成。');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { installCaseV2, installCaseV5, validateCaseV1, readSummary, refreshSummary, rememberCaseState: remember,
  beginCaseMutation, runCaseTransaction, runCaseIntegrityTransaction, withCaseReadSnapshot,
  activeMaterialPredicate, effectiveFlowFrom, EFFECTIVE_FLOW_FROM };
