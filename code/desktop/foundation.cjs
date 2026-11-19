'use strict';

// v3 is an additive installation layer over the immutable v1/v2 definitions.
// It contains storage contracts only; it never parses a financial source file.
const { createHash } = require('node:crypto');
const { validateCaseV1, readSummary, rememberCaseState } = require('./hardening.cjs');
const { validateMoneyRule } = require('./money.cjs');

const choices = values => ({ enum: values });
const text = { type: 'string', minLength: 1, pattern: '\\S' };
const RULE_CONFIG_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['config_version','amount_expr','source_unit','unit_scale','rounding_rule','direction_map',
    'negative_policy','zero_policy','zero_direction','balance_scope','balance_same_direction',
    'currency_policy','currency_map','reversal_note','review'],
  properties: {
    config_version: { const: 1 }, amount_expr: choices(['A','B','C','D','E','F']),
    source_unit: choices(['元','分']), unit_scale: choices([1,100]), rounding_rule: { const: 'ROUND_HALF_UP' },
    direction_map: { type: 'object', propertyNames: text, additionalProperties: choices(['进','出']) },
    negative_policy: choices(['signed','reverse','magnitude','column_defined','pending']),
    zero_policy: choices(['pending','confirmed']), zero_direction: choices(['进','出',null]),
    balance_scope: choices(['asset_ledger','debt','available','unknown']), balance_same_direction: { type: 'boolean' },
    currency_policy: choices(['explicit','verified_cny','unverified']),
    currency_map: { type: 'object', propertyNames: { type: 'string', minLength: 1,
      pattern: '^\\S(?:[\\s\\S]*\\S)?(?![\\s\\S])', not: { pattern: '^[A-Za-z]{3}$' } },
      additionalProperties: { type: 'string', pattern: '^[A-Z]{3}(?![\\s\\S])' } },
    reversal_note: text,
    business_status_policy: { const: 'exact_v2' },
    review: { type: 'object', additionalProperties: false, required: ['status','by','at','reason'], properties: {
      status: choices(['unreviewed','approved']), by: { anyOf: [text,{ type: 'null' }] },
      at: { anyOf: [text,{ type: 'null' }] }, reason: { anyOf: [text,{ type: 'null' }] }
    } },
    columns: { type: 'object', propertyNames: text, additionalProperties: text },
    column_negative_policy: { type: 'object', additionalProperties: false, required: ['income','expense'],
      properties: { income: choices(['reverse','magnitude','pending']), expense: choices(['reverse','magnitude','pending']) } }
  }
};

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

// Small, closed JSON-schema vocabulary, kept here so packaged Electron has no
// dependency on development-only Ajv. Every keyword used above is implemented.
function matches(value, schema) {
  if (schema.anyOf && !schema.anyOf.some(item => matches(value,item))) return false;
  if (schema.not && matches(value,schema.not)) return false;
  if (Object.hasOwn(schema,'const') && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null' && value !== null) return false;
  if (schema.type === 'string' && typeof value !== 'string') return false;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
  if (schema.type === 'object' && !object(value)) return false;
  if (schema.minLength && (typeof value !== 'string' || [...value].length < schema.minLength)) return false;
  if (schema.pattern && (typeof value !== 'string' || !new RegExp(schema.pattern).test(value))) return false;
  if (schema.type === 'object') {
    if (schema.required?.some(key => !Object.hasOwn(value,key))) return false;
    for (const [key,item] of Object.entries(value)) {
      if (schema.propertyNames && !matches(key,schema.propertyNames)) return false;
      const child = schema.properties && Object.hasOwn(schema.properties,key) ? schema.properties[key] : undefined;
      if (child ? !matches(item,child) : schema.additionalProperties === false ||
          (object(schema.additionalProperties) && !matches(item,schema.additionalProperties))) return false;
    }
  }
  return true;
}

function validateRuleConfig(config) {
  if (!matches(config,RULE_CONFIG_SCHEMA)) fail('FS_RULE_CONFIG','规则配置与 v1 契约不符，不能登记。');
  try { validateMoneyRule(config); }
  catch (error) { fail('FS_RULE_CONFIG',`规则配置不能被金额引擎执行：${error.message}。`); }
  if ((config.source_unit === '元' ? 100 : 1) !== config.unit_scale) fail('FS_RULE_CONFIG','规则的单位与倍率不一致。');
  if (config.column_negative_policy && (config.amount_expr !== 'D' || config.negative_policy !== 'column_defined')) {
    fail('FS_RULE_CONFIG','双列负数策略只能用于 D 类 column_defined 规则。');
  }
  if (config.review.status === 'approved' && ['by','at','reason'].some(key => !config.review[key]?.trim())) {
    fail('FS_RULE_APPROVAL','批准的规则必须有批准人、时间和依据。');
  }
  return config;
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonicalJSON(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function configMatchesRule(config, rule) {
  return ['amount_expr','source_unit','unit_scale','rounding_rule','balance_scope'].every(key=>config[key]===rule[key]);
}

function configureFoundation(db) {
  db.function('fundsift_trim',{ deterministic: true },value => typeof value==='string'?value.trim():null);
  db.function('fundsift_sha256',{ deterministic: true },value => typeof value === 'string' ? sha256(value) : null);
  db.function('fundsift_config_valid',{ deterministic: true },value => {
    try { const parsed = JSON.parse(value); validateRuleConfig(parsed); return canonicalJSON(parsed) === value ? 1 : 0; }
    catch (_) { return 0; }
  });
}

function registerRuleConfig(db, input) {
  configureFoundation(db);
  if (!input || !Number.isSafeInteger(input.rule_id) || input.rule_id < 1 ||
      !Number.isSafeInteger(input.rule_version) || input.rule_version < 1) fail('FS_RULE_CONFIG','规则身份无效。');
  const config = validateRuleConfig(input.config);
  const approved = config.review.status === 'approved';
  if ((input.approved_by !== undefined && input.approved_by !== config.review.by) ||
      (input.approved_at !== undefined && input.approved_at !== config.review.at)) fail('FS_RULE_APPROVAL','批准输入与规则卡不一致。');
  const execute = () => {
    const rule = db.prepare('SELECT * FROM format_rule WHERE id=? AND rule_version=?').get(input.rule_id,input.rule_version);
    if (!rule) fail('FS_RULE_CONFIG','关联的格式规则不存在。');
    if (!configMatchesRule(config,rule)) fail('FS_RULE_CONFIG','规则配置与已登记的基础字段不一致。');
    if (!rule.frozen) db.prepare('UPDATE format_rule SET frozen=1,verified=? WHERE id=?').run(approved ? 1 : rule.verified,rule.id);
    else if (approved && rule.verified < 1) fail('FS_RULE_APPROVAL','已冻结但未批准的旧规则不能原地批准，请新增版本。');
    const json = canonicalJSON(config), hash = sha256(json);
    db.prepare(`INSERT INTO format_rule_config(rule_id,rule_version,config_version,config_json,config_sha256,approved_by,approved_at,frozen)
      VALUES(?,?,1,?,?,?,?,1)`).run(input.rule_id,input.rule_version,json,hash,
        approved ? config.review.by : null,approved ? config.review.at : null);
    return { rule_id: input.rule_id, rule_version: input.rule_version, config_sha256: hash };
  };
  // better-sqlite3 makes nested transaction wrappers a savepoint: failure cannot
  // accidentally leave a newly frozen base rule without its configuration.
  return db.transaction(execute)();
}

const V3_SCHEMA = `
  CREATE TABLE format_rule_config (
    rule_id INTEGER NOT NULL, rule_version INTEGER NOT NULL,
    config_version INTEGER NOT NULL CHECK(config_version=1),
    config_json TEXT NOT NULL CHECK(json_valid(config_json)),
    config_sha256 TEXT NOT NULL CHECK(length(config_sha256)=64 AND config_sha256 NOT GLOB '*[^0-9a-f]*'),
    approved_by TEXT, approved_at TEXT, frozen INTEGER NOT NULL CHECK(frozen=1),
    PRIMARY KEY(rule_id,rule_version),
    FOREIGN KEY(rule_id,rule_version) REFERENCES format_rule(id,rule_version),
    CHECK((approved_by IS NULL AND approved_at IS NULL) OR
      (length(trim(approved_by))>0 AND length(trim(approved_at))>0))
  );
  CREATE TABLE archive_entry (
    id INTEGER PRIMARY KEY, batch_id INTEGER REFERENCES import_batch(id),
    staging_relative_path TEXT NOT NULL UNIQUE, final_relative_path TEXT NOT NULL UNIQUE,
    expected_sha256 TEXT NOT NULL CHECK(length(expected_sha256)=64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),
    copied_sha256 TEXT CHECK(copied_sha256 IS NULL OR (length(copied_sha256)=64 AND copied_sha256 NOT GLOB '*[^0-9a-f]*')),
    size_bytes INTEGER NOT NULL CHECK(typeof(size_bytes)='integer' AND size_bytes>=0),
    status TEXT NOT NULL CHECK(status IN ('staged','verified','orphaned','removed')),
    created_at TEXT NOT NULL, verified_at TEXT,
    CHECK(length(staging_relative_path)>0 AND instr(staging_relative_path,'..')=0 AND instr(staging_relative_path,':')=0
      AND instr(staging_relative_path,char(92))=0 AND substr(staging_relative_path,1,1)<>'/'),
    CHECK(length(final_relative_path)>0 AND instr(final_relative_path,'..')=0 AND instr(final_relative_path,':')=0
      AND instr(final_relative_path,char(92))=0 AND substr(final_relative_path,1,1)<>'/'),
    CHECK(status<>'verified' OR (copied_sha256 IS NOT NULL AND copied_sha256=expected_sha256 AND verified_at IS NOT NULL AND length(trim(verified_at))>0))
  );
  ALTER TABLE source_file ADD COLUMN archive_entry_id INTEGER REFERENCES archive_entry(id);
  ALTER TABLE source_file ADD COLUMN perspective TEXT NOT NULL DEFAULT 'unknown'
    CHECK(perspective IN ('unknown','transaction','account_ledger','mirror'));
  ALTER TABLE source_file ADD COLUMN encoding_observed TEXT;
  ALTER TABLE source_file ADD COLUMN format_observed TEXT;
  ALTER TABLE source_file ADD COLUMN account_observed TEXT;
  ALTER TABLE source_file ADD COLUMN declared_coverage_json TEXT CHECK(declared_coverage_json IS NULL OR json_valid(declared_coverage_json));
  ALTER TABLE source_file ADD COLUMN observations_json TEXT CHECK(observations_json IS NULL OR json_valid(observations_json));
  ALTER TABLE source_file ADD COLUMN header_rows INTEGER CHECK(header_rows IS NULL OR (typeof(header_rows)='integer' AND header_rows>=0));
  ALTER TABLE source_file ADD COLUMN data_rows INTEGER CHECK(data_rows IS NULL OR (typeof(data_rows)='integer' AND data_rows>=0));
  ALTER TABLE source_file ADD COLUMN trailer_rows INTEGER CHECK(trailer_rows IS NULL OR (typeof(trailer_rows)='integer' AND trailer_rows>=0));
  ALTER TABLE source_file ADD COLUMN unclassified_rows INTEGER CHECK(unclassified_rows IS NULL OR (typeof(unclassified_rows)='integer' AND unclassified_rows>=0));
  ALTER TABLE source_file ADD COLUMN coverage_complete INTEGER NOT NULL DEFAULT 0 CHECK(coverage_complete IN (0,1));
  ALTER TABLE import_batch ADD COLUMN archive_entry_id INTEGER REFERENCES archive_entry(id);
  ALTER TABLE import_batch ADD COLUMN pending_rows INTEGER CHECK(pending_rows IS NULL OR (typeof(pending_rows)='integer' AND pending_rows>=0));
  ALTER TABLE import_batch ADD COLUMN unquantifiable_rows INTEGER CHECK(unquantifiable_rows IS NULL OR (typeof(unquantifiable_rows)='integer' AND unquantifiable_rows>=0));
  ALTER TABLE import_batch ADD COLUMN error_rows INTEGER CHECK(error_rows IS NULL OR (typeof(error_rows)='integer' AND error_rows>=0));
  ALTER TABLE import_batch ADD COLUMN cancelled_rows INTEGER CHECK(cancelled_rows IS NULL OR (typeof(cancelled_rows)='integer' AND cancelled_rows>=0));
  ALTER TABLE import_batch ADD COLUMN error_code TEXT;
  ALTER TABLE import_batch ADD COLUMN cancel_reason TEXT;
  CREATE INDEX idx_ff_stable_order ON fund_flow(case_id,(txn_time IS NULL),txn_time,source_file_id,source_loc,id);
  CREATE INDEX idx_ff_batch_stable_order ON fund_flow(source_file_id,batch_id,(txn_time IS NULL),txn_time,source_loc,id);
  CREATE INDEX idx_sf_archive ON source_file(archive_entry_id);
  CREATE INDEX idx_batch_archive ON import_batch(archive_entry_id);
  CREATE INDEX idx_archive_batch ON archive_entry(batch_id);
`;

function installV3Triggers(db) {
  db.exec(`
    CREATE TRIGGER v3_config_insert BEFORE INSERT ON format_rule_config BEGIN
      SELECT CASE WHEN fundsift_config_valid(NEW.config_json)<>1 OR fundsift_sha256(NEW.config_json) IS NOT NEW.config_sha256
        THEN RAISE(ABORT,'规则配置必须符合契约并匹配内容哈希。') END;
      SELECT CASE WHEN EXISTS(SELECT 1 FROM format_rule_config WHERE rule_id=NEW.rule_id AND rule_version=NEW.rule_version)
        THEN RAISE(ABORT,'配置版本不能替换，请新增规则版本。') END;
      SELECT CASE WHEN EXISTS(SELECT 1 FROM fund_flow WHERE format_rule_id=NEW.rule_id AND rule_version=NEW.rule_version)
        THEN RAISE(ABORT,'历史流水引用的规则不能补写配置，请新增版本。') END;
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM format_rule r WHERE r.id=NEW.rule_id AND r.rule_version=NEW.rule_version AND r.frozen=1
        AND r.amount_expr=json_extract(NEW.config_json,'$.amount_expr') AND r.source_unit=json_extract(NEW.config_json,'$.source_unit')
        AND r.unit_scale=json_extract(NEW.config_json,'$.unit_scale') AND r.rounding_rule=json_extract(NEW.config_json,'$.rounding_rule')
        AND r.balance_scope=json_extract(NEW.config_json,'$.balance_scope')
        AND ((json_extract(NEW.config_json,'$.review.status')='approved' AND r.verified>=1
          AND NEW.approved_by IS json_extract(NEW.config_json,'$.review.by') AND NEW.approved_at IS json_extract(NEW.config_json,'$.review.at')) OR
          (json_extract(NEW.config_json,'$.review.status')='unreviewed' AND NEW.approved_by IS NULL AND NEW.approved_at IS NULL)))
        THEN RAISE(ABORT,'配置的冻结、批准或基础字段与格式规则不一致。') END;
    END;
    CREATE TRIGGER v3_config_update BEFORE UPDATE ON format_rule_config
      BEGIN SELECT RAISE(ABORT,'已登记的配置版本不能修改，请新增版本。'); END;
    CREATE TRIGGER v3_config_delete BEFORE DELETE ON format_rule_config
      BEGIN SELECT RAISE(ABORT,'配置版本不能删除。'); END;
    CREATE TRIGGER v3_rule_referenced_update BEFORE UPDATE ON format_rule
      WHEN EXISTS(SELECT 1 FROM fund_flow WHERE format_rule_id=OLD.id) OR EXISTS(SELECT 1 FROM format_rule_config WHERE rule_id=OLD.id)
      BEGIN SELECT RAISE(ABORT,'历史或配置引用的规则不能改写。'); END;
    CREATE TRIGGER v3_rule_referenced_delete BEFORE DELETE ON format_rule
      WHEN EXISTS(SELECT 1 FROM fund_flow WHERE format_rule_id=OLD.id) OR EXISTS(SELECT 1 FROM format_rule_config WHERE rule_id=OLD.id)
      BEGIN SELECT RAISE(ABORT,'历史或配置引用的规则不能删除。'); END;
    CREATE TRIGGER v3_rule_referenced_replace BEFORE INSERT ON format_rule
      WHEN EXISTS(SELECT 1 FROM format_rule r WHERE (r.id=NEW.id OR (r.platform=NEW.platform AND r.format_key=NEW.format_key AND r.rule_version=NEW.rule_version))
        AND (EXISTS(SELECT 1 FROM fund_flow f WHERE f.format_rule_id=r.id) OR EXISTS(SELECT 1 FROM format_rule_config c WHERE c.rule_id=r.id)))
      BEGIN SELECT RAISE(ABORT,'历史或配置引用的规则不能替换。'); END;
    CREATE TRIGGER v3_flow_raw_update BEFORE UPDATE ON fund_flow WHEN
      NEW.raw_income_text IS NOT OLD.raw_income_text OR NEW.raw_expense_text IS NOT OLD.raw_expense_text OR
      NEW.raw_currency_text IS NOT OLD.raw_currency_text OR NEW.raw_record IS NOT OLD.raw_record OR
      NEW.currency_evidence IS NOT OLD.currency_evidence
      BEGIN SELECT RAISE(ABORT,'原始字段与币种证据不能原地改写。'); END;
    CREATE TRIGGER v3_flow_legacy_insert BEFORE INSERT ON fund_flow WHEN NEW.currency_evidence='legacy_unverified'
      BEGIN SELECT RAISE(ABORT,'新流水不能伪装成历史币种证据。'); END;
    CREATE TRIGGER v3_source_archive_insert BEFORE INSERT ON source_file
      WHEN NEW.archive_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM archive_entry a
        WHERE a.id=NEW.archive_entry_id AND a.status='verified' AND a.expected_sha256=NEW.file_sha256)
      BEGIN SELECT RAISE(ABORT,'材料只能引用哈希一致的已核验归档。'); END;
    CREATE TRIGGER v3_source_archive_update BEFORE UPDATE ON source_file BEGIN
      SELECT CASE WHEN OLD.archive_entry_id IS NOT NULL AND NEW.archive_entry_id IS NOT OLD.archive_entry_id
        THEN RAISE(ABORT,'材料归档引用不能改写或清空。') END;
      SELECT CASE WHEN NEW.archive_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM archive_entry a
        WHERE a.id=NEW.archive_entry_id AND a.status='verified' AND a.expected_sha256=NEW.file_sha256)
        THEN RAISE(ABORT,'材料只能引用哈希一致的已核验归档。') END;
    END;
    CREATE TRIGGER v3_batch_metadata_update BEFORE UPDATE ON import_batch BEGIN
      SELECT CASE WHEN OLD.archive_entry_id IS NOT NULL AND NEW.archive_entry_id IS NOT OLD.archive_entry_id
        THEN RAISE(ABORT,'批次归档引用不能改写或清空。') END;
      SELECT CASE WHEN OLD.status IN ('done','failed','partial') AND (
        NEW.pending_rows IS NOT OLD.pending_rows OR NEW.unquantifiable_rows IS NOT OLD.unquantifiable_rows OR
        NEW.error_rows IS NOT OLD.error_rows OR NEW.cancelled_rows IS NOT OLD.cancelled_rows OR
        NEW.error_code IS NOT OLD.error_code OR NEW.cancel_reason IS NOT OLD.cancel_reason OR NEW.archive_entry_id IS NOT OLD.archive_entry_id OR
        NEW.notes IS NOT OLD.notes)
        THEN RAISE(ABORT,'终止批次的回执不能改写。') END;
    END;
    CREATE TRIGGER v3_archive_batch_insert BEFORE INSERT ON archive_entry
      WHEN NEW.batch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM import_batch b JOIN source_file s ON s.id=b.source_file_id
        WHERE b.id=NEW.batch_id AND b.case_id=1 AND s.case_id=1 AND s.file_sha256=NEW.expected_sha256)
      BEGIN SELECT RAISE(ABORT,'归档批次与材料原件哈希不一致。'); END;
    CREATE TRIGGER v3_archive_batch_update BEFORE UPDATE ON archive_entry
      WHEN NEW.batch_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM import_batch b JOIN source_file s ON s.id=b.source_file_id
        WHERE b.id=NEW.batch_id AND b.case_id=1 AND s.case_id=1 AND s.file_sha256=NEW.expected_sha256)
      BEGIN SELECT RAISE(ABORT,'归档批次与材料原件哈希不一致。'); END;
    CREATE TRIGGER v3_archive_replace BEFORE INSERT ON archive_entry WHEN EXISTS(SELECT 1 FROM archive_entry
      WHERE id=NEW.id OR staging_relative_path=NEW.staging_relative_path OR final_relative_path=NEW.final_relative_path)
      BEGIN SELECT RAISE(ABORT,'归档账本身份不能替换。'); END;
    CREATE TRIGGER v3_archive_update BEFORE UPDATE ON archive_entry BEGIN
      SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.staging_relative_path IS NOT OLD.staging_relative_path OR
        NEW.final_relative_path IS NOT OLD.final_relative_path OR NEW.expected_sha256 IS NOT OLD.expected_sha256 OR
        NEW.size_bytes IS NOT OLD.size_bytes OR NEW.created_at IS NOT OLD.created_at OR
        (OLD.batch_id IS NOT NULL AND NEW.batch_id IS NOT OLD.batch_id) OR OLD.status='removed'
        THEN RAISE(ABORT,'归档身份、原件哈希与已登记批次不能修改。') END;
      SELECT CASE WHEN (EXISTS(SELECT 1 FROM source_file WHERE archive_entry_id=OLD.id) OR
        EXISTS(SELECT 1 FROM import_batch WHERE archive_entry_id=OLD.id) OR OLD.batch_id IS NOT NULL) AND
        (NEW.status IS NOT 'verified' OR NEW.copied_sha256 IS NOT OLD.copied_sha256 OR NEW.verified_at IS NOT OLD.verified_at)
        THEN RAISE(ABORT,'归档仍有材料或历史批次引用，不能改动或清理。') END;
      SELECT CASE WHEN OLD.status='verified' AND NEW.status='staged'
        THEN RAISE(ABORT,'已核验归档不能退回复制中。') END;
    END;
    CREATE TRIGGER v3_archive_delete BEFORE DELETE ON archive_entry
      BEGIN SELECT RAISE(ABORT,'归档账本不可删除；清理只登记 removed 状态。'); END;
  `);
  for (const event of ['INSERT','UPDATE']) {
    db.exec(`CREATE TRIGGER v3_source_coverage_${event.toLowerCase()} BEFORE ${event} ON source_file
      WHEN NEW.coverage_complete=1 AND (NEW.header_rows IS NULL OR NEW.data_rows IS NULL OR
        NEW.trailer_rows IS NULL OR NEW.unclassified_rows IS NULL OR NEW.unclassified_rows<>0)
      BEGIN SELECT RAISE(ABORT,'材料分类计数未知或仍有未分类记录，不能声明覆盖完整。'); END;`);
    db.exec(`CREATE TRIGGER v3_batch_receipt_${event.toLowerCase()} BEFORE ${event} ON import_batch BEGIN
      SELECT CASE WHEN (NEW.cancel_reason IS NOT NULL AND (length(trim(NEW.cancel_reason))=0 OR NEW.status IS NOT 'failed')) OR
        (NEW.error_code IS NOT NULL AND length(trim(NEW.error_code))=0) OR
        (NEW.pending_rows IS NOT NULL AND NEW.imported_rows IS NOT NULL AND NEW.pending_rows>NEW.imported_rows) OR
        (NEW.unquantifiable_rows IS NOT NULL AND NEW.imported_rows IS NOT NULL AND NEW.unquantifiable_rows>NEW.imported_rows) OR
        (NEW.error_rows IS NOT NULL AND NEW.total_rows IS NOT NULL AND NEW.error_rows>NEW.total_rows) OR
        (NEW.cancelled_rows IS NOT NULL AND NEW.total_rows IS NOT NULL AND NEW.cancelled_rows>NEW.total_rows)
        THEN RAISE(ABORT,'批次回执行数、取消状态或错误码不合法。') END;
      SELECT CASE WHEN NEW.status='done' ${event==='UPDATE' ? "AND OLD.status<>'done'" : ''} AND (
        (NEW.pending_rows IS NOT NULL AND NEW.pending_rows<>(SELECT count(*) FROM fund_flow f WHERE f.batch_id=NEW.id AND f.status='pending')) OR
        (NEW.unquantifiable_rows IS NOT NULL AND NEW.unquantifiable_rows<>(SELECT count(*) FROM fund_flow f WHERE f.batch_id=NEW.id AND f.amount IS NULL)))
        THEN RAISE(ABORT,'发布时待核与不可量化行数不一致。') END;
    END;`);
    db.exec(`CREATE TRIGGER v3_flow_currency_${event.toLowerCase()} BEFORE ${event} ON fund_flow BEGIN
      SELECT CASE WHEN NEW.currency_evidence='unknown' AND NEW.currency IS NOT NULL
        THEN RAISE(ABORT,'没有币种证据时不得写入默认币种。') END;
      SELECT CASE WHEN NEW.currency_evidence='raw_iso' AND (NEW.currency IS NULL OR length(NEW.currency)<>3 OR
        NEW.currency GLOB '*[^A-Z]*' OR NEW.raw_currency_text IS NULL OR upper(fundsift_trim(NEW.raw_currency_text)) IS NOT NEW.currency)
        THEN RAISE(ABORT,'ISO币种必须与原始文本证据一致。') END;
      SELECT CASE WHEN NEW.currency_evidence IN ('approved_map','verified_cny') AND NOT EXISTS(
        SELECT 1 FROM format_rule_config c WHERE c.rule_id=NEW.format_rule_id AND c.rule_version=NEW.rule_version AND c.approved_by IS NOT NULL
        AND ((NEW.currency_evidence='verified_cny' AND NEW.currency='CNY' AND
          (NEW.raw_currency_text IS NULL OR length(fundsift_trim(NEW.raw_currency_text))=0) AND json_extract(c.config_json,'$.currency_policy')='verified_cny') OR
          (NEW.currency_evidence='approved_map' AND NEW.raw_currency_text IS NOT NULL AND NEW.currency IS NOT NULL AND
            NOT (length(fundsift_trim(NEW.raw_currency_text))=3 AND upper(fundsift_trim(NEW.raw_currency_text)) NOT GLOB '*[^A-Z]*') AND
            EXISTS(SELECT 1 FROM json_each(c.config_json,'$.currency_map') m WHERE m.key=fundsift_trim(NEW.raw_currency_text) AND m.value=NEW.currency))))
        THEN RAISE(ABORT,'币种映射或CNY规则缺少已批准的对应证据。') END;
    END;`);
    db.exec(`CREATE TRIGGER v3_batch_archive_${event.toLowerCase()} BEFORE ${event} ON import_batch
      WHEN NEW.archive_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM archive_entry a JOIN source_file s ON s.id=NEW.source_file_id
        WHERE a.id=NEW.archive_entry_id AND a.status='verified' AND a.expected_sha256=s.file_sha256)
      BEGIN SELECT RAISE(ABORT,'批次归档必须与材料身份一致且已核验。'); END;`);
  }
}

function installCaseV3(db, record) {
  if (!db.inTransaction) fail('FS_CASE_TRANSACTION','v3 安装必须处于受控迁移事务。');
  if (db.pragma('foreign_keys',{simple:true}) !== 0) fail('FS_MIGRATION_FOREIGN_KEYS','v3 重建需在开启事务前关闭外键，提交前检查后恢复。');
  configureFoundation(db);
  // Capture and restore all existing SQL objects. Dropping dependent views and
  // triggers avoids SQLite rename rewriting or accepting dangling references.
  const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL ORDER BY type,name").all();
  for (const item of objects) db.exec(`DROP ${item.type.toUpperCase()} "${item.name.replaceAll('"','""')}"`);
  const previous = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='fund_flow'").get().sql;
  const columns = db.pragma('table_info(fund_flow)').map(row => '"'+row.name+'"').join(',');
  const definition = previous.replace(/^CREATE TABLE\s+fund_flow\s*\(/i,'CREATE TABLE fund_flow_v3 (')
    .replace(/currency TEXT DEFAULT 'CNY'/,'currency TEXT')
    .replace(/UNIQUE \(batch_id, source_file_id, source_loc\)/,`raw_income_text TEXT, raw_expense_text TEXT, raw_currency_text TEXT,
      raw_record TEXT CHECK(raw_record IS NULL OR json_valid(raw_record)),
      currency_evidence TEXT NOT NULL DEFAULT 'unknown' CHECK(currency_evidence IN ('legacy_unverified','raw_iso','approved_map','verified_cny','unknown')),
      UNIQUE (batch_id, source_file_id, source_loc)`);
  if (!definition.includes('raw_income_text') || definition.includes("currency TEXT DEFAULT 'CNY'")) fail('FS_MIGRATION_SCHEMA','无法识别旧流水结构，已停止重建。');
  db.exec(definition);
  db.exec(`INSERT INTO fund_flow_v3(${columns},currency_evidence) SELECT ${columns},'legacy_unverified' FROM fund_flow`);
  db.exec('DROP TABLE fund_flow; ALTER TABLE fund_flow_v3 RENAME TO fund_flow');
  for (const item of objects) db.exec(item.sql);
  db.exec(V3_SCHEMA);
  installV3Triggers(db);
  validateCaseV3(db,record);
  // Schema installation does not constitute a business edit. Preserve v2
  // summary timestamps and version byte-for-byte, and reset only observation.
  rememberCaseState(db);
  return readSummary(db,record);
}

function validateFoundationData(db) {
  for (const row of db.prepare(`SELECT c.*,r.frozen AS rule_frozen,r.verified,r.amount_expr,r.source_unit,r.unit_scale,r.rounding_rule,r.balance_scope
    FROM format_rule_config c JOIN format_rule r ON r.id=c.rule_id AND r.rule_version=c.rule_version`).all()) {
    let config;
    try { config = validateRuleConfig(JSON.parse(row.config_json)); }
    catch (_) { fail('FS_RULE_CONFIG','已登记配置不符合契约。'); }
    if (sha256(row.config_json) !== row.config_sha256 || canonicalJSON(config) !== row.config_json || row.rule_frozen !== 1 ||
        !configMatchesRule(config,row) ||
        (config.review.status==='approved' && (row.verified<1 || row.approved_by!==config.review.by || row.approved_at!==config.review.at)) ||
        (config.review.status==='unreviewed' && (row.approved_by!==null || row.approved_at!==null))) {
      fail('FS_RULE_CONFIG','规则配置哈希、批准或冻结状态不一致。');
    }
  }
  const checks = [
    [`SELECT s.id FROM source_file s LEFT JOIN archive_entry a ON a.id=s.archive_entry_id
      WHERE s.archive_entry_id IS NOT NULL AND (a.id IS NULL OR a.status<>'verified' OR a.expected_sha256<>s.file_sha256) LIMIT 1`, '材料归档引用不一致'],
    [`SELECT b.id FROM import_batch b JOIN source_file s ON s.id=b.source_file_id LEFT JOIN archive_entry a ON a.id=b.archive_entry_id
      WHERE b.archive_entry_id IS NOT NULL AND (a.id IS NULL OR a.status<>'verified' OR a.expected_sha256<>s.file_sha256) LIMIT 1`, '历史批次归档引用不一致']
  ];
  for (const [sql,message] of checks) if (db.prepare(sql).get()) fail('FS_CASE_DATA',message+'，已停止操作。');
  return true;
}

function validateCaseV3(db, record) { return validateCaseV1(db,record); }

module.exports = { installCaseV3, validateCaseV3, validateFoundationData, configureFoundation, registerRuleConfig,
  validateRuleConfig, RULE_CONFIG_SCHEMA, canonicalJSON };
