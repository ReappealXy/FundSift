'use strict';

const { createHash } = require('node:crypto');
const { FORMAT_KEY: CCB } = require('./ccb-account.cjs');
const { FORMAT_KEY: ALIPAY } = require('./alipay-account.cjs');
const { EFFECTIVE_FLOW_FROM, runCaseTransaction, withCaseReadSnapshot } = require('./hardening.cjs');
const { assertInt64, parseMinor, toWire } = require('./money.cjs');
const { rawValuesHash } = require('./review-schema.cjs');

const REFUND_REASON = 'sign_semantics_undefined';

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function id(value) {
  let result;
  try { result = assertInt64(value); }
  catch (_) { fail('FS_REVIEW_INPUT', '复核记录或材料编号无效。'); }
  if (result < 1n || result > BigInt(Number.MAX_SAFE_INTEGER)) fail('FS_REVIEW_INPUT', '复核记录或材料编号无效。');
  return result;
}

function caseState(db, record, expected) {
  const state = db.prepare('SELECT case_uuid,data_version FROM case_data_state WHERE id=1').safeIntegers().get();
  if (state?.case_uuid !== record.id) fail('FS_CASE_IDENTITY', '案件身份与数据库不符。');
  if (expected !== undefined && state.data_version.toString() !== expected) {
    fail('FS_REVIEW_STALE', '案件数据已更新，请刷新并重新核对后提交。');
  }
  return state;
}

function currentFlow(db, flowId) {
  const row = db.prepare(`SELECT f.*,s.file_name AS file_name,s.file_sha256 AS file_sha256,
    (SELECT format_key FROM format_rule WHERE id=f.format_rule_id) AS format_key,
    (b.archive_entry_id IS NULL AND json_type(f.raw_record,'$.values') IS NOT 'array') AS legacy_without_archive,
    ${rawValuesHash('f')} AS raw_sha256 ${EFFECTIVE_FLOW_FROM} AND f.id=?`).safeIntegers().get(flowId);
  if (!row) fail('FS_REVIEW_SCOPE', '该流水已经不属于当前有效批次，请刷新流水。');
  return row;
}

function reasonsFor(db, flowId) {
  return db.prepare(`SELECT id,reason_code,detail,created_at,resolved_at,resolution_reason FROM pending_reason
    WHERE fund_flow_id=? ORDER BY reason_code,id`).safeIntegers().all(flowId);
}

function supportsRefund(row, raw) {
  if (row.format_key !== CCB || row.rule_version !== 1n || raw?.format_key !== CCB ||
      !Array.isArray(raw.values) || raw.values.length !== 32 || raw.values[12] !== '消费退货' ||
      raw.values[13] !== '借' || row.raw_direction !== '借' || row.raw_amount_text !== raw.values[14] || row.currency !== 'CNY') {
    return false;
  }
  try {
    const amount = parseMinor(row.raw_amount_text, '元');
    return !amount.rounded && assertInt64(amount.value) < 0n;
  } catch (_) { return false; }
}

function firstResolution(db, flowId) {
  return db.prepare(`SELECT id,reason_id,before_amount,before_direction,before_status FROM review_event
    WHERE fund_flow_id=? AND action='resolve' ORDER BY id LIMIT 1`).safeIntegers().get(flowId);
}

function eventWire(event) {
  const { request_sha256, is_current_batch, ...visible } = event;
  return toWire({ ...visible, is_current_batch: Boolean(is_current_batch) });
}

function getReviewContext(db, record, input) {
  const flowId = id(typeof input === 'object' && input !== null ? input.flowId : input);
  return withCaseReadSnapshot(db, () => {
    const state = caseState(db, record, input?.dataVersion);
    const row = currentFlow(db, flowId);
    const raw = JSON.parse(row.raw_record);
    const reasons = reasonsFor(db, flowId);
    const first = firstResolution(db, flowId);
    const canResolve = supportsRefund(row, raw);
    const history = db.prepare(`SELECT e.*,e.batch_id=? AS is_current_batch,? AS current_flow_id
      FROM review_event e WHERE source_file_id=? AND source_loc=? AND raw_sha256=? ORDER BY e.id DESC`)
      .safeIntegers().all(row.batch_id, flowId, row.source_file_id, row.source_loc, row.raw_sha256).map(eventWire);
    return toWire({ caseId: record.id, dataVersion: state.data_version, flowId, sourceFileId: row.source_file_id,
      sourceFileName: row.file_name, sourceFileSha256: row.file_sha256, batchId: row.batch_id,
      sourceLoc: row.source_loc, rawSha256: row.raw_sha256, ruleVersion: row.rule_version,
      status: row.status, amount: row.amount, direction: row.direction,
      legacyWithoutArchive: Boolean(row.legacy_without_archive),
      canNote: row.status === 'pending',
      resolveReasonId: canResolve ? reasons.find(reason => reason.resolved_at === null && reason.reason_code === REFUND_REASON)?.id ?? null : null,
      correctReasonId: canResolve ? first?.reason_id ?? null : null,
      internalTransfer: row.format_key === ALIPAY && row.rule_version === 2n && raw?.derivation?.internal_transfer?.kind === 'balance_to_yuebao',
      rule: {
        amount: first ? first.before_amount : row.amount,
        direction: first ? first.before_direction : row.direction,
        status: first ? first.before_status : row.status,
        reasons: reasons.filter(reason => reason.resolved_at === null || reason.id === first?.reason_id)
          .map(({ id, reason_code, detail }) => ({ id, reason_code, detail }))
      },
      reasons, history });
  });
}

function saveInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('FS_REVIEW_INPUT', '复核参数无效。');
  const { flowId, requestId, dataVersion, action, operator, evidence, reasonId, amountText, direction } = input;
  const allowed = ['flowId','requestId','dataVersion','action','operator','evidence'];
  if (action !== 'note') allowed.push('reasonId','amountText','direction');
  if (!['note','resolve','correct'].includes(action) || Object.keys(input).some(key => !allowed.includes(key)) ||
      typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}(?![\s\S])/u.test(requestId) ||
      typeof dataVersion !== 'string' || !/^(?:0|[1-9]\d{0,18})(?![\s\S])/u.test(dataVersion) ||
      typeof operator !== 'string' || operator.length > 80 || !operator.trim() || operator.includes('\0') ||
      typeof evidence !== 'string' || evidence.length > 2000 || !evidence.trim() || evidence.includes('\0')) {
    fail('FS_REVIEW_INPUT', '请输入有效的操作人、依据与案件版本。');
  }
  let amount = null;
  if (action !== 'note') {
    if (!['进','出'].includes(direction) || typeof amountText !== 'string' ||
        !/^\d{1,19}(?:\.\d{1,2})?(?![\s\S])/u.test(amountText)) {
      fail('FS_REVIEW_INPUT', '请填写大于零的金额（元，最多两位小数）并选择资金方向。');
    }
    const { value } = parseMinor(amountText, '元');
    if (!value) fail('FS_REVIEW_INPUT', '复核金额必须大于零。');
    try { amount = assertInt64(direction === '进' ? value : -value); }
    catch (_) { fail('FS_REVIEW_INPUT', '复核金额超出可保存的有符号整数分范围。'); }
  }
  const target = id(flowId);
  const reason = action === 'note' ? null : id(reasonId);
  const digest = createHash('sha256').update(JSON.stringify([
    target.toString(),dataVersion,action,operator,evidence,reason?.toString() ?? null,amountText ?? null,direction ?? null
  ])).digest('hex');
  return { flowId: target, requestId, dataVersion, action, operator: operator.trim(), evidence: evidence.trim(),
    reasonId: reason, amount, direction: direction ?? null, digest };
}

function saveReview(db, record, input) {
  const value = saveInput(input);
  function receipt(event) {
    // The saved response is stable on retry, including after newer edits.
    return { caseId: record.id, dataVersion: event.data_version.toString(),
      event: eventWire({ ...event, is_current_batch: true, current_flow_id: event.fund_flow_id }) };
  }
  return runCaseTransaction(db, record, { flowIds: [Number(value.flowId)] }, () => {
    const state = caseState(db, record);
    const row = currentFlow(db, value.flowId);
    const timestamp = new Date().toISOString();
    const note = value.action === 'note';
    const resolve = value.action === 'resolve';
    let status = row.status;
    if (note) {
      if (status !== 'pending') fail('FS_REVIEW_SCOPE', '记说明适用于仍待核的流水。');
    } else {
      const reasons = reasonsFor(db, row.id);
      const reason = reasons.find(item => item.id === value.reasonId);
      const supported = supportsRefund(row, JSON.parse(row.raw_record)) && reason?.reason_code === REFUND_REASON;
      const correctsFirst = !resolve && reason?.resolved_at !== null && firstResolution(db, row.id)?.reason_id === value.reasonId;
      if (!supported || !(resolve ? reason.resolved_at === null : correctsFirst)) {
        fail('FS_REVIEW_SCOPE', '当前版本只支持确认或更正本批次建行负额消费退货的指定原因。');
      }
      if (resolve) status = reasons.some(item => item.id !== reason.id && item.resolved_at === null) ? 'pending' : 'confirmed';
    }
    const amount = note ? row.amount : value.amount;
    const direction = note ? row.direction : value.direction;
    const result = db.prepare(`INSERT INTO review_event (fund_flow_id,source_file_id,source_loc,raw_sha256,batch_id,rule_version,
      request_id,request_sha256,action,operator,evidence,reviewed_at,reason_id,reason_code,before_amount,before_direction,before_status,
      after_amount,after_direction,after_status,data_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).safeIntegers().run(
      row.id,row.source_file_id,row.source_loc,row.raw_sha256,row.batch_id,row.rule_version,
      value.requestId,value.digest,value.action,value.operator,value.evidence,timestamp,value.reasonId,note ? null : REFUND_REASON,
      row.amount,row.direction,row.status,amount,direction,status,state.data_version);
    if (resolve) db.prepare(`UPDATE pending_reason SET resolved_at=?,resolution_reason=? WHERE id=?`)
      .run(timestamp, `人工复核 #${result.lastInsertRowid}：${value.evidence}`, value.reasonId);
    if (!note) db.prepare('UPDATE fund_flow SET amount=?,direction=?,status=? WHERE id=?').run(amount,direction,status,row.id);
    return receipt(db.prepare('SELECT * FROM review_event WHERE id=?').safeIntegers().get(result.lastInsertRowid));
  }, { preflight: () => {
    const state = caseState(db, record);
    const saved = db.prepare('SELECT * FROM review_event WHERE request_id=?').safeIntegers().get(value.requestId);
    if (saved) {
      if (saved.request_sha256 !== value.digest) fail('FS_REVIEW_REQUEST_CONFLICT', '该请求号已用于另一项复核。请刷新后重新提交。');
      return receipt(saved);
    }
    if (state.data_version.toString() !== value.dataVersion) {
      fail('FS_REVIEW_STALE', '案件数据已更新，请刷新并重新核对后提交。');
    }
  } });
}

function listMaterialReviewHistory(db, record, sourceFileId) {
  const target = id(sourceFileId);
  return withCaseReadSnapshot(db, () => {
    const state = caseState(db, record);
    const material = db.prepare(`SELECT s.id,s.file_name,s.file_sha256,b.id AS current_batch_id FROM source_file s
      LEFT JOIN import_batch b ON b.id=s.current_batch_id AND b.case_id=s.case_id AND b.source_file_id=s.id AND b.status='done'
      WHERE s.id=? AND s.case_id=1`).safeIntegers().get(target);
    if (!material) fail('FS_REVIEW_SCOPE', '材料不属于当前案件。');
    const history = db.prepare(`SELECT e.*,e.batch_id=? AS is_current_batch,f.id AS current_flow_id
      FROM review_event e LEFT JOIN fund_flow f ON f.case_id=1 AND f.batch_id=? AND f.source_file_id=e.source_file_id
        AND f.source_loc=e.source_loc AND (${rawValuesHash('f')})=e.raw_sha256
      WHERE e.source_file_id=? ORDER BY e.id DESC`)
      .safeIntegers().all(material.current_batch_id, material.current_batch_id, target).map(eventWire);
    const priorRows = new Set(history.filter(event => !event.is_current_batch)
      .map(event => JSON.stringify([event.source_loc,event.raw_sha256])));
    return toWire({ caseId: record.id, dataVersion: state.data_version, sourceFileId: target,
      sourceFileName: material.file_name, sourceFileSha256: material.file_sha256, currentBatchId: material.current_batch_id,
      oldReviewCount: priorRows.size, history });
  });
}

module.exports = { getReviewContext, saveReview, listMaterialReviewHistory };
