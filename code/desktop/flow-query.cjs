'use strict';

// A cursor is a query context, not an authorization token. The worker must own
// the case connection; every page checks its identity and committed version.
const { createHash } = require('node:crypto');
const { withCaseReadSnapshot } = require('./hardening.cjs');
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
    const params = [], conditions = ['f.case_id=1'];
    if (filters.sourceFileId !== null) { conditions.push('f.source_file_id=?'); params.push(filters.sourceFileId); }
    if (filters.status !== null) { conditions.push('f.status=?'); params.push(filters.status); }
    const from = `FROM fund_flow f
      JOIN source_file s ON s.id=f.source_file_id AND s.case_id=f.case_id
      JOIN import_batch b ON b.id=s.current_batch_id AND b.id=f.batch_id
        AND b.source_file_id=s.id AND b.case_id=f.case_id AND b.status='done'
      WHERE ${conditions.join(' AND ')}`;
    const total = db.prepare(`SELECT count(*) n ${from}`).safeIntegers().get(...params).n.toString();
    let after = '';
    if (token) {
      after = " AND ((f.txn_time IS NULL),coalesce(f.txn_time,''),f.source_file_id,f.source_loc COLLATE BINARY,f.id) > (?,?,?,?,?)";
      params.push(token.last[0], token.last[1], BigInt(token.last[2]), token.last[3], BigInt(token.last[4]));
    }
    const rows = db.prepare(`SELECT f.*,s.file_name AS source_file_name,s.file_sha256 AS source_sha256,
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
      rows: rows.map(row => ({ ...Object.fromEntries(Object.entries(row).map(([k,v]) => [k,typeof v === 'bigint' ? v.toString() : v])),
        pendingReasons: reasons.all(row.id) })), nextCursor };
  });
}

module.exports = { queryFlowPage, SORT };
