-- 案件
CREATE TABLE case_info (
  id INTEGER PRIMARY KEY,
  case_no TEXT NOT NULL UNIQUE,
  case_name TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL
);

-- 格式规则（不可变版本：verified>=1 后 frozen=1，变更必须新增 rule_version 行）
CREATE TABLE format_rule (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,           -- 银行/微信/支付宝…
  format_key TEXT NOT NULL,         -- 平台+表头/结构指纹+版本 的组合，不单独用 templateId
  rule_version INTEGER NOT NULL DEFAULT 1,
  amount_expr TEXT NOT NULL CHECK (amount_expr IN ('A','B','C','D','E','F')),
  direction_source TEXT,            -- amount_sign / direction_col / two_cols
  source_unit TEXT NOT NULL DEFAULT '元' CHECK (source_unit IN ('元','分')),  -- 仅支持元/分
  unit_scale INTEGER NOT NULL CHECK (unit_scale IN (1, 100)),  -- 入库倍率：元→分=100；分→分=1
  rounding_rule TEXT DEFAULT 'ROUND_HALF_UP',
  reversal_marker TEXT,
  balance_scope TEXT DEFAULT 'unknown' CHECK (balance_scope IN ('asset_ledger','debt','available','unknown')),
  source_evidence TEXT,             -- 规则出处：模板文件路径 / 样本编号 / 人工确认记录
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1,2)),
  frozen INTEGER NOT NULL DEFAULT 0 CHECK (frozen IN (0,1)),
  CHECK (verified = 0 OR frozen = 1),   -- 「已验证必冻结」：verified≥1 时必须同时 frozen=1（review-09）
  UNIQUE (platform, format_key, rule_version),
  UNIQUE (id, rule_version)         -- 供 fund_flow 复合外键引用
);

-- 导入批次（一文件一批，见 §4.1；每次解析运行一行）
CREATE TABLE import_batch (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES case_info(id),
  source_file_id INTEGER NOT NULL REFERENCES source_file(id),  -- 该批次只对应一个文件
  started_at TEXT NOT NULL,
  finished_at TEXT,
  parser_version TEXT NOT NULL,          -- 解析器版本，参与追溯
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','parsing','importing','done','partial','failed')),
  total_rows INTEGER,
  imported_rows INTEGER,
  skipped_rows INTEGER,
  notes TEXT
);

-- 原始文件登记（原件身份；每案件每哈希一行）
CREATE TABLE source_file (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES case_info(id),
  first_batch_id INTEGER REFERENCES import_batch(id),
  current_batch_id INTEGER REFERENCES import_batch(id),  -- 当前有效批次指针（只指 done）
  file_name TEXT NOT NULL,
  file_path TEXT,             -- 原件副本归档位置（导入时拷贝进案件目录 archive/）
  file_size INTEGER,
  file_sha256 TEXT NOT NULL,
  format_rule_id INTEGER REFERENCES format_rule(id),
  raw_records INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','imported','partial','failed')),
  imported_at TEXT,
  UNIQUE (case_id, file_sha256)
);

-- 并表流水（核心表：双存 + 溯源 + 规则/解析器追溯）
CREATE TABLE fund_flow (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES case_info(id),
  batch_id INTEGER NOT NULL REFERENCES import_batch(id),
  source_file_id INTEGER NOT NULL REFERENCES source_file(id),
  format_rule_id INTEGER NOT NULL,
  rule_version INTEGER NOT NULL,
  source_loc TEXT NOT NULL,         -- 回源坐标：xlsx="sheet名!行号"；csv/txt=逻辑记录号
  platform TEXT,
  acct_no TEXT,
  acct_name TEXT,
  peer_acct TEXT,
  peer_name TEXT,
  txn_time TEXT,                    -- 规范化时间（第一片限本地时间；口径见 §6.3）
  txn_time_text TEXT,               -- 原始时间文本（含精度）
  raw_amount_text TEXT,             -- 原始金额字符串（真原始值）
  raw_direction TEXT,               -- 原始方向字段原值
  raw_balance_text TEXT,            -- 原始余额字符串
  currency TEXT DEFAULT 'CNY',
  amount INTEGER,                   -- 标准金额（分）：收进为正、付出为负
  direction TEXT CHECK (direction IN ('进','出')),
  balance INTEGER,                  -- 标准余额（分）
  txn_type TEXT,
  summary TEXT,
  reversal_flag INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','pending')),
  UNIQUE (batch_id, source_file_id, source_loc),   -- 批内幂等
  FOREIGN KEY (format_rule_id, rule_version) REFERENCES format_rule(id, rule_version)
);

-- 记录阻断原因：每项独立；余额 fail/manual 不属于记录阻断原因
CREATE TABLE pending_reason (
  id INTEGER PRIMARY KEY,
  fund_flow_id INTEGER NOT NULL REFERENCES fund_flow(id),
  reason_code TEXT NOT NULL CHECK (length(trim(reason_code)) > 0),
  detail TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_reason TEXT,
  CHECK (
    (resolved_at IS NULL AND resolution_reason IS NULL) OR
    (resolved_at IS NOT NULL AND length(trim(resolved_at)) > 0 AND
     resolution_reason IS NOT NULL AND length(trim(resolution_reason)) > 0)
  )
);

-- 余额检查历史：计算、接受均追加，不覆写原检查
CREATE TABLE balance_check_history (
  id INTEGER PRIMARY KEY,
  fund_flow_id INTEGER NOT NULL REFERENCES fund_flow(id),
  input_version TEXT NOT NULL CHECK (length(trim(input_version)) > 0),
  prev_flow_id INTEGER REFERENCES fund_flow(id),
  expect_balance INTEGER,
  actual_balance INTEGER,
  diff INTEGER,
  balance_scope TEXT NOT NULL DEFAULT 'unknown' CHECK (balance_scope IN ('asset_ledger','debt','available','unknown')),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'unchecked' CHECK (status IN ('unchecked','pass','fail','manual','na')),
  checked_at TEXT NOT NULL,
  accepted_from_id INTEGER,          -- manual 引用被接受的 fail 历史
  manual_reason TEXT,
  accepted_at TEXT,
  CHECK (
    (status = 'manual' AND accepted_from_id IS NOT NULL AND
     manual_reason IS NOT NULL AND length(trim(manual_reason)) > 0 AND
     accepted_at IS NOT NULL AND length(trim(accepted_at)) > 0) OR
    (status <> 'manual' AND accepted_from_id IS NULL AND manual_reason IS NULL AND accepted_at IS NULL)
  ),
  UNIQUE (fund_flow_id, id),
  UNIQUE (fund_flow_id, id, input_version),
  FOREIGN KEY (fund_flow_id, accepted_from_id, input_version)
    REFERENCES balance_check_history(fund_flow_id, id, input_version)
);

-- 每笔唯一的是当前指针，历史允许多条；复合 FK 防止指向别笔历史
CREATE TABLE balance_check (
  id INTEGER PRIMARY KEY,
  fund_flow_id INTEGER NOT NULL UNIQUE REFERENCES fund_flow(id),
  current_history_id INTEGER NOT NULL,
  FOREIGN KEY (fund_flow_id, current_history_id)
    REFERENCES balance_check_history(fund_flow_id, id)
);

CREATE VIEW balance_check_current AS
SELECT c.id AS current_id, h.*
FROM balance_check AS c
JOIN balance_check_history AS h
  ON h.id = c.current_history_id AND h.fund_flow_id = c.fund_flow_id;

-- 导入核对与异常清单
CREATE TABLE import_check (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES case_info(id),
  batch_id INTEGER REFERENCES import_batch(id),
  source_file_id INTEGER REFERENCES source_file(id),
  check_type TEXT NOT NULL,     -- row_count/balance/sign_conflict/duplicate/encoding
  error_code TEXT,
  issue_desc TEXT,
  expect_value TEXT,
  actual_value TEXT,
  impact_amount INTEGER,        -- 可量化影响金额（分）；不可量化记 NULL 并披露记录数
  ref_rows TEXT,                -- 涉及坐标（JSON 数组）
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','confirmed')),
  resolved_at TEXT
);

-- 触发器：frozen 规则不可原地修改（R3）
CREATE TRIGGER trg_format_rule_frozen
BEFORE UPDATE ON format_rule
WHEN OLD.frozen = 1
BEGIN
  SELECT RAISE(ABORT, 'frozen rule is immutable');
END;

CREATE TRIGGER trg_format_rule_frozen_delete
BEFORE DELETE ON format_rule
WHEN OLD.frozen = 1
BEGIN
  SELECT RAISE(ABORT, 'frozen rule cannot be deleted');
END;

CREATE TRIGGER trg_format_rule_frozen_replace
BEFORE INSERT ON format_rule
WHEN EXISTS (
  SELECT 1 FROM format_rule
  WHERE frozen = 1 AND (id = NEW.id OR
    (platform = NEW.platform AND format_key = NEW.format_key AND rule_version = NEW.rule_version))
)
BEGIN
  SELECT RAISE(ABORT, 'frozen rule cannot be replaced');
END;

-- 触发器：source_unit 与 unit_scale 配对校验（'元'↔100、'分'↔1）
CREATE TRIGGER trg_format_rule_unit_ins
BEFORE INSERT ON format_rule
WHEN (NEW.source_unit = '分' AND NEW.unit_scale <> 1) OR (NEW.source_unit = '元' AND NEW.unit_scale <> 100)
BEGIN
  SELECT RAISE(ABORT, 'source_unit/unit_scale mismatch');
END;

CREATE TRIGGER trg_format_rule_unit_upd
BEFORE UPDATE ON format_rule
WHEN (NEW.source_unit = '分' AND NEW.unit_scale <> 1) OR (NEW.source_unit = '元' AND NEW.unit_scale <> 100)
BEGIN
  SELECT RAISE(ABORT, 'source_unit/unit_scale mismatch');
END;

-- 待核项只可一次性解除，不能改写创建事实、删掉或重新打开旧项
CREATE TRIGGER trg_pending_reason_insert
BEFORE INSERT ON pending_reason
WHEN NEW.resolved_at IS NOT NULL OR NEW.resolution_reason IS NOT NULL OR
     EXISTS (SELECT 1 FROM pending_reason WHERE id = NEW.id) OR
     EXISTS (SELECT 1 FROM pending_reason
             WHERE fund_flow_id = NEW.fund_flow_id AND reason_code = NEW.reason_code AND resolved_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'pending reason must be new and unresolved');
END;

CREATE TRIGGER trg_pending_reason_update
BEFORE UPDATE ON pending_reason
WHEN OLD.resolved_at IS NOT NULL OR NEW.resolved_at IS NULL OR
     NEW.id IS NOT OLD.id OR NEW.fund_flow_id IS NOT OLD.fund_flow_id OR
     NEW.reason_code IS NOT OLD.reason_code OR NEW.detail IS NOT OLD.detail OR
     NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'pending reason only permits one resolution');
END;

CREATE TRIGGER trg_pending_reason_delete
BEFORE DELETE ON pending_reason
BEGIN
  SELECT RAISE(ABORT, 'pending reason audit is immutable');
END;

CREATE TRIGGER trg_balance_history_update
BEFORE UPDATE ON balance_check_history
BEGIN
  SELECT RAISE(ABORT, 'balance history is immutable');
END;

CREATE TRIGGER trg_balance_history_delete
BEFORE DELETE ON balance_check_history
BEGIN
  SELECT RAISE(ABORT, 'balance history is immutable');
END;

-- SQLite REPLACE 可能绕过普通 UPDATE/DELETE 保护，插入前拒绝已有历史身份
CREATE TRIGGER trg_balance_history_insert
BEFORE INSERT ON balance_check_history
WHEN EXISTS (SELECT 1 FROM balance_check_history WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'balance history cannot be replaced');
END;

-- 接受只能基于当前的 fail；逐字段 NULL-safe 比对，不允许把差额改成 0
CREATE TRIGGER trg_balance_history_accept
BEFORE INSERT ON balance_check_history
WHEN NEW.status = 'manual' AND NOT EXISTS (
  SELECT 1
  FROM balance_check AS c
  JOIN balance_check_history AS h
    ON h.id = c.current_history_id AND h.fund_flow_id = c.fund_flow_id
  WHERE c.fund_flow_id = NEW.fund_flow_id AND h.id = NEW.accepted_from_id
    AND h.status = 'fail' AND h.input_version = NEW.input_version
    AND h.prev_flow_id IS NEW.prev_flow_id
    AND h.expect_balance IS NEW.expect_balance
    AND h.actual_balance IS NEW.actual_balance AND h.diff IS NEW.diff
    AND h.balance_scope IS NEW.balance_scope AND h.reason IS NEW.reason
    AND h.checked_at IS NEW.checked_at
)
BEGIN
  SELECT RAISE(ABORT, 'manual acceptance must preserve current failed check');
END;

-- 索引
CREATE INDEX idx_ff_case_time ON fund_flow(case_id, txn_time);
CREATE INDEX idx_ff_acct ON fund_flow(acct_no);
CREATE INDEX idx_ff_peer ON fund_flow(peer_acct);
CREATE INDEX idx_ff_source_batch ON fund_flow(source_file_id, batch_id);
CREATE INDEX idx_sf_hash ON source_file(case_id, file_sha256);
CREATE UNIQUE INDEX idx_pending_open_reason
  ON pending_reason(fund_flow_id, reason_code) WHERE resolved_at IS NULL;
CREATE INDEX idx_balance_history_flow ON balance_check_history(fund_flow_id, id);
