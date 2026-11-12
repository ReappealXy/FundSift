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
  source_unit TEXT NOT NULL DEFAULT '元',   -- 来源金额单位（'元'/'分'），原始单位落在这里
  unit_scale INTEGER NOT NULL CHECK (unit_scale IN (1, 100)),  -- 入库倍率：元→分=100；分→分=1
  rounding_rule TEXT DEFAULT 'ROUND_HALF_UP',
  reversal_marker TEXT,
  balance_scope TEXT DEFAULT 'unknown' CHECK (balance_scope IN ('asset_ledger','debt','available','unknown')),
  source_evidence TEXT,             -- 规则出处：模板文件路径 / 样本编号 / 人工确认记录
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1,2)),
  frozen INTEGER NOT NULL DEFAULT 0 CHECK (frozen IN (0,1)),
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

-- 余额链校验结果（每笔最多一条当前结果，重跑=更新）
CREATE TABLE balance_check (
  id INTEGER PRIMARY KEY,
  fund_flow_id INTEGER NOT NULL UNIQUE REFERENCES fund_flow(id),
  prev_flow_id INTEGER REFERENCES fund_flow(id),   -- 无前项/跨文件断点记 NULL
  expect_balance INTEGER,
  actual_balance INTEGER,
  diff INTEGER,
  balance_scope TEXT NOT NULL DEFAULT 'unknown' CHECK (balance_scope IN ('asset_ledger','debt','available','unknown')),
  reason TEXT,                      -- 同秒多笔/缺行/口径混用/不适用/未分类
  status TEXT NOT NULL DEFAULT 'unchecked' CHECK (status IN ('unchecked','pass','fail','manual','na')),
  checked_at TEXT
);

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

-- 索引
CREATE INDEX idx_ff_case_time ON fund_flow(case_id, txn_time);
CREATE INDEX idx_ff_acct ON fund_flow(acct_no);
CREATE INDEX idx_ff_peer ON fund_flow(peer_acct);
CREATE INDEX idx_ff_source_batch ON fund_flow(source_file_id, batch_id);
CREATE INDEX idx_sf_hash ON source_file(case_id, file_sha256);
