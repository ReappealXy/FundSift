'use strict';

// Only the ordered original fields participate in the hash. A new rule may
// change raw_record.derivation without changing the source identity.
function rawValuesHash(alias) {
  return `CASE WHEN json_type(${alias}.raw_record,'$.values')='array'
    THEN fundsift_sha256(json_extract(${alias}.raw_record,'$.values'))
    ELSE fundsift_sha256(json_array('legacy-raw-columns-v1',${alias}.txn_time_text,
      ${alias}.raw_amount_text,${alias}.raw_income_text,${alias}.raw_expense_text,
      ${alias}.raw_direction,${alias}.raw_balance_text,${alias}.raw_currency_text)) END`;
}

function installCaseV4(db) {
  if (!db.inTransaction) {
    throw Object.assign(new Error('v4 安装必须处于受控迁移事务。'), { code: 'FS_CASE_TRANSACTION' });
  }
  db.exec(`
    CREATE TABLE review_event (
      id INTEGER PRIMARY KEY CHECK(id > 0),
      fund_flow_id INTEGER NOT NULL REFERENCES fund_flow(id),
      source_file_id INTEGER NOT NULL REFERENCES source_file(id),
      source_loc TEXT NOT NULL CHECK(length(source_loc) > 0),
      raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256)=64 AND raw_sha256 NOT GLOB '*[^0-9a-f]*'),
      batch_id INTEGER NOT NULL REFERENCES import_batch(id),
      rule_version INTEGER NOT NULL,
      request_id TEXT NOT NULL UNIQUE CHECK(length(request_id) BETWEEN 1 AND 128 AND request_id NOT GLOB '*[^A-Za-z0-9_-]*'),
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
      action TEXT NOT NULL CHECK(action IN ('note','resolve','correct')),
      operator TEXT NOT NULL CHECK(length(trim(operator)) BETWEEN 1 AND 80),
      evidence TEXT NOT NULL CHECK(length(trim(evidence)) BETWEEN 1 AND 2000),
      reviewed_at TEXT NOT NULL CHECK(length(reviewed_at) > 0),
      reason_id INTEGER REFERENCES pending_reason(id),
      reason_code TEXT,
      before_amount INTEGER CHECK(before_amount IS NULL OR typeof(before_amount)='integer'),
      before_direction TEXT CHECK(before_direction IN ('进','出')),
      before_status TEXT NOT NULL CHECK(before_status IN ('pending','confirmed')),
      after_amount INTEGER CHECK(after_amount IS NULL OR typeof(after_amount)='integer'),
      after_direction TEXT CHECK(after_direction IN ('进','出')),
      after_status TEXT NOT NULL CHECK(after_status IN ('pending','confirmed')),
      data_version INTEGER NOT NULL CHECK(typeof(data_version)='integer' AND data_version > 0),
      CHECK((action='note' AND reason_id IS NULL AND reason_code IS NULL AND before_status='pending'
          AND before_amount IS after_amount AND before_direction IS after_direction AND before_status=after_status)
        OR (action IN ('resolve','correct') AND reason_code IS 'sign_semantics_undefined' AND reason_id IS NOT NULL
          AND ((after_amount > 0 AND after_direction IS '进') OR (after_amount < 0 AND after_direction IS '出'))
          AND after_amount IS NOT NULL))
    );
    CREATE INDEX idx_review_event_source ON review_event(source_file_id,source_loc,raw_sha256,id);
    CREATE INDEX idx_review_event_flow ON review_event(fund_flow_id,id);
    CREATE INDEX idx_review_event_flow_resolution ON review_event(fund_flow_id,id) WHERE action='resolve';
    CREATE UNIQUE INDEX idx_review_event_resolution ON review_event(reason_id) WHERE action='resolve';

    CREATE TRIGGER v4_review_event_insert BEFORE INSERT ON review_event BEGIN
      SELECT CASE WHEN EXISTS(SELECT 1 FROM review_event WHERE id=NEW.id OR request_id=NEW.request_id)
        OR (NEW.action='resolve' AND EXISTS(SELECT 1 FROM review_event WHERE action='resolve' AND reason_id=NEW.reason_id))
        THEN RAISE(ABORT,'复核历史只能追加，已有记录不能替换。') END;
      SELECT CASE WHEN (SELECT valid FROM case_summary WHERE id=1) IS NOT 0 OR
        (SELECT data_version FROM case_data_state WHERE id=1) IS NOT NEW.data_version
        THEN RAISE(ABORT,'复核历史必须通过当前案件事务写入。') END;
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM fund_flow f
        JOIN source_file s ON s.id=f.source_file_id AND s.case_id=f.case_id
        JOIN import_batch b ON b.id=f.batch_id AND b.id=s.current_batch_id AND b.status='done'
          AND b.case_id=f.case_id AND b.source_file_id=s.id
        WHERE f.id=NEW.fund_flow_id AND f.case_id=1 AND f.batch_id=NEW.batch_id
          AND f.source_file_id=NEW.source_file_id AND f.source_loc=NEW.source_loc AND f.rule_version=NEW.rule_version
          AND (${rawValuesHash('f')})=NEW.raw_sha256 AND f.amount IS NEW.before_amount
          AND f.direction IS NEW.before_direction AND f.status=NEW.before_status)
        THEN RAISE(ABORT,'复核记录与当前批次、来源或修改前解释不一致。') END;
      SELECT CASE WHEN NEW.action='resolve' AND NOT EXISTS(SELECT 1 FROM pending_reason p
        WHERE p.id=NEW.reason_id AND p.fund_flow_id=NEW.fund_flow_id AND p.reason_code=NEW.reason_code
          AND p.resolved_at IS NULL)
        THEN RAISE(ABORT,'所选原因不属于本笔流水或已解除。') END;
      SELECT CASE WHEN NEW.action='correct' AND NOT EXISTS(SELECT 1 FROM review_event e
        JOIN pending_reason p ON p.id=e.reason_id AND p.fund_flow_id=e.fund_flow_id
        WHERE e.fund_flow_id=NEW.fund_flow_id AND e.action='resolve' AND e.reason_id=NEW.reason_id
          AND e.reason_code=NEW.reason_code AND p.resolved_at IS NOT NULL)
        THEN RAISE(ABORT,'更正必须关联本批次已有的人工确认。') END;
    END;
    CREATE TRIGGER v4_review_event_update BEFORE UPDATE ON review_event
      BEGIN SELECT RAISE(ABORT,'复核历史不可修改。'); END;
    CREATE TRIGGER v4_review_event_delete BEFORE DELETE ON review_event
      BEGIN SELECT RAISE(ABORT,'复核历史不可删除。'); END;
  `);
}

module.exports = { installCaseV4, rawValuesHash };
