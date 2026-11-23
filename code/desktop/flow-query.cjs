'use strict';

// A cursor is a query context, not an authorization token. The worker must own
// the case connection; every page checks its identity and committed version.
const { createHash } = require('node:crypto');
const { ledgerFields } = require('./ledger-fields.cjs');
const { repairFields } = require('./text-repair.cjs');
const { supportsRefund, REFUND_REASON } = require('./manual-review.cjs');
const { rawValuesHash } = require('./review-schema.cjs');
const { effectiveFlowFrom, withCaseReadSnapshot } = require('./hardening.cjs');
const SORT = 'time-null-last/time/source/coordinate/id:v1';

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function filtersFor(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(k => !['sourceFileId', 'status'].includes(k))) {
    fail('FS_QUERY_INPUT', '流水筛选条件无效。');
  }
  const filters = { sourceFileId: input.sourceFileId ?? null, status: input.status ?? null };
  if (filters.sourceFileId !== null && (!Number.isSafeInteger(filters.sourceFileId) || filters.sourceFileId < 1) ||
      filters.status !== null && !['confirmed', 'pending'].includes(filters.status)) {
    fail('FS_QUERY_INPUT', '流水筛选值无效。');
  }
  return filters;
}
function decodeCursor(value) {
  if (typeof value !== 'string' || value.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail('FS_QUERY_CURSOR', '翻页位置无效，请重新查询。');
  }
  let token;
  try {
    if (Buffer.from(value, 'base64url').toString('base64url') !== value) throw new Error('encoding');
    token = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch (_) { fail('FS_QUERY_CURSOR', '翻页位置无法读取，请重新查询。'); }
  const key = token?.last;
  if (!token || token.v !== 1 || typeof token.caseId !== 'string' ||
      !/^(0|[1-9]\d*)$/.test(token.dataVersion) || !/^[a-f0-9]{64}$/.test(token.filtersHash) ||
      token.sort !== SORT || !Array.isArray(key) || key.length !== 5 ||
      ![0, 1].includes(key[0]) || typeof key[1] !== 'string' || key[1].length > 32 ||
      !/^[1-9]\d{0,18}$/.test(key[2]) || typeof key[3] !== 'string' || key[3].length > 2048 ||
      !/^[1-9]\d{0,18}$/.test(key[4]) || (key[0] === 1 && key[1] !== '')) {
    fail('FS_QUERY_CURSOR', '翻页条件不完整，请重新查询。');
  }
  for (const id of [key[2], key[4]]) if (BigInt(id) > 9223372036854775807n) fail('FS_QUERY_CURSOR', '翻页编号越界。');
  return token;
}

function queryFlowPage(db, { caseId, filters: input, limit = 50, cursor = null } = {}) {
  if (typeof caseId !== 'string' || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    fail('FS_QUERY_INPUT', '案件身份或每页条数无效。');
  }
  const filters = filtersFor(input), filtersHash = hash(filters);
  const token = cursor === null ? null : decodeCursor(cursor);
  return withCaseReadSnapshot(db, () => {
    const state = db.prepare('SELECT case_uuid,data_version FROM case_data_state WHERE id=1').safeIntegers().get();
    if (!state || state.case_uuid !== caseId) fail('FS_CASE_IDENTITY', '查询案件与当前数据库不符。');
    const version = state.data_version.toString();
    if (token && (token.caseId !== caseId || token.filtersHash !== filtersHash || token.sort !== SORT)) {
      fail('FS_QUERY_CONTEXT', '案件或筛选条件已变化，请从第一页重新查询。');
    }
    if (token && token.dataVersion !== version) fail('FS_QUERY_STALE', '数据已更新，请刷新列表后继续查看。');
    const params = [];
    let from = effectiveFlowFrom(db);
    if (filters.sourceFileId !== null) { from += ' AND f.source_file_id=?'; params.push(filters.sourceFileId); }
    if (filters.status !== null) { from += ' AND f.status=?'; params.push(filters.status); }
    const total = db.prepare(`SELECT count(*) n ${from}`).safeIntegers().get(...params).n.toString();
    let after = '';
    if (token) {
      after = " AND ((f.txn_time IS NULL),coalesce(f.txn_time,''),f.source_file_id,f.source_loc COLLATE BINARY,f.id) > (?,?,?,?,?)";
      params.push(token.last[0], token.last[1], BigInt(token.last[2]), token.last[3], BigInt(token.last[4]));
    }
    const hasReview = db.pragma('user_version', { simple: true }) >= 4;
    const reviewHistory = hasReview
      ? `EXISTS (SELECT 1 FROM review_event e WHERE e.source_file_id=f.source_file_id AND e.source_loc=f.source_loc
          AND e.raw_sha256=(${rawValuesHash('f')}))` : '0';
    const rows = db.prepare(`SELECT f.*,s.file_name AS source_file_name,s.file_sha256 AS source_sha256,
      (SELECT format_key FROM format_rule WHERE id=f.format_rule_id) AS format_key,
      ${reviewHistory} AS has_review_history,
      b.parser_version ${from}${after}
      ORDER BY (f.txn_time IS NULL),f.txn_time,f.source_file_id,f.source_loc COLLATE BINARY,f.id LIMIT ?`)
      .safeIntegers().all(...params, limit + 1);
    const hasNext = rows.length > limit;
    if (hasNext) rows.pop();
    const last = rows.at(-1);
    const nextCursor = hasNext ? Buffer.from(JSON.stringify({ v: 1, caseId, dataVersion: version,
      filtersHash, sort: SORT, last: [last.txn_time === null ? 1 : 0, last.txn_time ?? '',
        last.source_file_id.toString(), last.source_loc, last.id.toString()] })).toString('base64url') : null;
    const reasons = db.prepare(`SELECT reason_code,detail FROM pending_reason
      WHERE fund_flow_id=? AND resolved_at IS NULL ORDER BY reason_code`);
    return { caseId, dataVersion: version, filters, sort: SORT, total,
      rows: rows.map(row => {
        const pendingReasons = reasons.all(row.id);
        const raw = row.raw_record ? JSON.parse(row.raw_record) : null;
        const { has_review_history, ...values } = row;
        const ledger = ledgerFields(row, raw);
        return {
          ...Object.fromEntries(Object.entries(values).map(([key,value]) => [key,typeof value === 'bigint' ? value.toString() : value])),
          ledger,
          repairs: repairFields({ ...ledger, time: raw ? row.txn_time_text : null, direction: row.raw_direction,
            amount: row.raw_amount_text, type: row.txn_type }),
          review: {
            canNote: hasReview && row.status === 'pending',
            canResolve: hasReview && pendingReasons.some(reason => reason.reason_code === REFUND_REASON) && supportsRefund(row, raw),
            hasHistory: Boolean(has_review_history)
          },
          pendingReasons
        };
      }), nextCursor };
  });
}

module.exports = { queryFlowPage, SORT };
