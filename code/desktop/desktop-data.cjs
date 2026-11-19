'use strict';

// Desktop-only adapter. Renderer input never supplies paths, rules or approval
// identities; the main process selects one file and confirms its currency.
const { importSourceFile, readFlowSource } = require('./import-service.cjs');
const { queryFlowPage } = require('./flow-query.cjs');
const { withCaseReadSnapshot } = require('./hardening.cjs');
const { assertInt64 } = require('./money.cjs');
const { queryRelationCandidates } = require('./relation-candidates.cjs');

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, allowed) { return object(value) && Object.keys(value).every(key => allowed.includes(key)); }
function wire(row) { return Object.fromEntries(Object.entries(row).map(([key,value]) => [key, typeof value === 'bigint' ? value.toString() : value])); }
function version(value) { return typeof value === 'string' && /^(?:0|[1-9]\d{0,18})$/.test(value); }

const FORMATS = Object.freeze({
  'alipay-account-17col-v1': { platform: '支付宝', unit: '元', scale: 100, direction: {收入:'进',支出:'出'} },
  'wechat-trades-27col-v1': { platform: '微信', unit: '分', scale: 1, direction: {入:'进',出:'出'} },
  'ccb-account-32col-v1': { platform: '建设银行', unit: '元', scale: 100, direction: {借:'出',贷:'进'} }
});
function approvedRule(formatKey) {
  const format = FORMATS[formatKey], bank = formatKey === 'ccb-account-32col-v1';
  return { platform: format.platform, format_key: formatKey, rule_version: 1,
    config_version: 1, amount_expr: 'E', rounding_rule: 'ROUND_HALF_UP',
    source_unit: format.unit, unit_scale: format.scale, direction_map: format.direction,
    negative_policy: 'pending', zero_policy: 'pending', zero_direction: null,
    currency_policy: bank ? 'explicit' : 'verified_cny', currency_map: bank ? {'人民币元':'CNY'} : {},
    balance_scope: 'unknown', balance_same_direction: formatKey === 'alipay-account-17col-v1',
    reversal_note: '负额、零额、未知方向及不支持的状态保留待核；不推断冲正。',
    source_evidence: `已批准的${formatKey}技术预览规则；缺少币种列的材料须逐次由本机操作人核实人民币来源证据。`,
    review: { status: 'approved', by: '项目规则批准人', at: '2026-11-19',
      reason: bank ? '用户批准元转分、借出贷进、负数待核、人民币元映射CNY、账号卡号分开、交易日期加交易时间、余额保留未知口径。'
        : formatKey === 'wechat-trades-27col-v1' ? '用户批准主金额按分、入进出出、完整平台用户ID、收款金额不符待核、余额保留未知口径；无币种列须逐次确认人民币来源证据。'
        : '用户批准元转分、收入进支出出、付款时间、完整平台身份及其它/关闭交易待核；无币种列须逐次确认人民币来源证据。' } };
}
function approvedPolicy(formatKey, confirmedAt) {
  const policy = formatKey === 'ccb-account-32col-v1' ? {
    timeColumn: '交易日期+交易时间', accountIdentityPolicy: 'raw_bank_account', balancePolicy: 'preserve_unknown'
  } : formatKey === 'wechat-trades-27col-v1' ? {
    timeColumn: '交易时间', accountIdentityPolicy: 'raw_platform_user_id', receiverAmountPolicy: 'mismatch_pending', balancePolicy: 'preserve_unknown'
  } : { timeColumn: '付款时间', accountIdentityPolicy: 'raw_platform_info', businessStatusPolicy: 'exact_v1' };
  return { ...policy,
    review: { status: 'approved', by: '本机操作人', at: confirmedAt,
      reason: formatKey === 'ccb-account-32col-v1'
        ? '已确认采用建行保守规则；币种仅按原始人民币元及批准映射确认，账号卡号不合并，负额待核，余额仅保留。技术预览，完整G0未完成。'
        : '已根据本次所选协查材料来源确认金额均为人民币，采用已批准格式规则；仅技术预览，完整G0未完成，待核只读。' } };
}

class DesktopData {
  constructor(store, { onProgress = () => {} } = {}) { this.store = store; this.onProgress = onProgress; }
  context(caseId) {
    const store = this.store;
    if (typeof caseId !== 'string' || !caseId || !store.caseDb || caseId !== store.currentCaseId) {
      fail('FS_CASE_CONTEXT', '当前案件已变化，请重新打开案件后操作。');
    }
    const record = store._caseRecord(caseId);
    return { db: store.caseDb, record, caseDirectory: store._casePath(caseId) };
  }
  listMaterials(caseId) {
    const {db} = this.context(caseId);
    return withCaseReadSnapshot(db, () => {
      const state = db.prepare('SELECT case_uuid,data_version FROM case_data_state WHERE id=1').safeIntegers().get();
      if (!state || state.case_uuid !== caseId) fail('FS_CASE_IDENTITY', '案件身份与数据库不符。');
      const materials = db.prepare(`SELECT s.id,s.file_name AS fileName,s.file_size AS sizeBytes,s.file_sha256 AS sha256,
        s.status,s.perspective,s.encoding_observed AS encoding,s.format_observed AS formatKey,
        s.data_rows AS observedRows,s.coverage_complete AS coverageComplete,s.current_batch_id AS currentBatchId,
        b.status AS batchStatus,b.imported_rows AS importedRows,b.pending_rows AS pendingRows,
        b.unquantifiable_rows AS unquantifiableRows,b.parser_version AS parserVersion,b.finished_at AS importedAt,
        latest.id AS latestBatchId,latest.status AS latestBatchStatus,latest.error_code AS latestErrorCode,
        (s.status='failed' AND s.current_batch_id IS NULL AND latest.status='failed' AND latest.archive_entry_id IS NOT NULL) AS canRetry,
        (SELECT count(*) FROM fund_flow f WHERE f.case_id=s.case_id AND f.source_file_id=s.id AND f.batch_id=b.id
          AND CASE WHEN json_valid(f.raw_record) THEN coalesce(json_array_length(f.raw_record,'$.derivation.supplementary_diagnostics'),0)>0 ELSE 0 END) AS diagnosticRows
        FROM source_file s LEFT JOIN import_batch b ON b.id=s.current_batch_id AND b.source_file_id=s.id AND b.status='done'
        LEFT JOIN import_batch latest ON latest.id=(SELECT max(id) FROM import_batch WHERE source_file_id=s.id)
        WHERE s.case_id=1 ORDER BY s.id`).safeIntegers().all().map(row => ({ ...wire(row), canRetry: row.canRetry === 1n }));
      return { caseId, dataVersion: state.data_version.toString(), materials };
    });
  }
  queryFlows(caseId, options = {}) {
    const {db} = this.context(caseId);
    if (!keys(options, ['limit','cursor','filters'])) fail('FS_QUERY_INPUT', '流水查询参数无效。');
    return queryFlowPage(db, { ...options, caseId });
  }
  queryRelations(caseId, options = {}) {
    const {db} = this.context(caseId);
    if (!keys(options, ['limit'])) fail('FS_QUERY_INPUT', '关系候选查询参数无效。');
    return queryRelationCandidates(db,{...options,caseId});
  }
  async importFile(caseId, input) {
    const context = this.context(caseId);
    const formatKey = input?.formatKey ?? 'alipay-account-17col-v1';
    if (!keys(input, ['filePath','formatKey','confirmedCny','confirmedAt']) || !Object.hasOwn(FORMATS,formatKey) || typeof input.filePath !== 'string' ||
      input.confirmedCny !== (formatKey !== 'ccb-account-32col-v1') || typeof input.confirmedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.confirmedAt) ||
      !Number.isFinite(Date.parse(input.confirmedAt))) {
      fail('FS_IMPORT_APPROVAL', '需要先确认本次材料的币种与技术预览范围。');
    }
    const receipt = await importSourceFile({ ...context, filePath: input.filePath, rule: approvedRule(formatKey),
      policy: approvedPolicy(formatKey, input.confirmedAt), onProgress: event => this.onProgress(event) });
    return { receipt, materials: this.listMaterials(caseId), case: this.store._dto(context.record, context.db) };
  }
  async retryImport(caseId, sourceFileId) {
    const context = this.context(caseId);
    if (typeof sourceFileId !== 'string' || !/^[1-9]\d{0,18}$/.test(sourceFileId)) {
      fail('FS_IMPORT_INPUT', '请选择一份导入失败的材料。');
    }
    const { retryFailedImport } = require('./import-service.cjs');
    const receipt = await retryFailedImport({ ...context, sourceFileId, onProgress: event => this.onProgress(event) });
    return { receipt, materials: this.listMaterials(caseId), case: this.store._dto(context.record, context.db) };
  }
  getWorkpaperContext(caseId) {
    const { getWorkpaperContext } = require('./workpaper.cjs');
    return getWorkpaperContext(this.context(caseId));
  }
  exportWorkpaper(caseId, filePath, expectedDataVersion) {
    const { exportWorkpaper } = require('./workpaper.cjs');
    return exportWorkpaper({ ...this.context(caseId), filePath, expectedDataVersion, onProgress: event => this.onProgress(event) });
  }
  async readFlowSource(caseId, input) {
    const context = this.context(caseId);
    if (!keys(input, ['flowId','dataVersion']) || !version(input.dataVersion)) fail('FS_QUERY_INPUT', '回源需要当前列表版本。');
    let flowId;
    try { flowId = assertInt64(input.flowId); } catch (_) { fail('FS_QUERY_INPUT', '流水编号无效。'); }
    if (flowId < 1n) fail('FS_QUERY_INPUT', '流水编号无效。');
    const readCurrent = () => withCaseReadSnapshot(context.db, () => {
      const state = context.db.prepare('SELECT case_uuid,data_version FROM case_data_state WHERE id=1').safeIntegers().get();
      if (state?.case_uuid !== caseId) fail('FS_CASE_IDENTITY', '案件身份与数据库不符。');
      if (state.data_version.toString() !== input.dataVersion) fail('FS_QUERY_STALE', '数据已更新，请刷新列表后查看原文。');
      const row = context.db.prepare(`SELECT f.*,s.file_name AS source_file_name,b.parser_version FROM fund_flow f
        JOIN source_file s ON s.id=f.source_file_id AND s.case_id=f.case_id
        JOIN import_batch b ON b.id=s.current_batch_id AND b.id=f.batch_id AND b.source_file_id=s.id AND b.status='done'
        WHERE f.id=? AND f.case_id=1`).safeIntegers().get(flowId);
      if (!row) fail('FS_IMPORT_SOURCE', '此流水不属于当前已发布批次，请刷新列表。');
      return { ...wire(row), pendingReasons: context.db.prepare(`SELECT reason_code,detail FROM pending_reason
        WHERE fund_flow_id=? AND resolved_at IS NULL ORDER BY reason_code`).all(flowId) };
    });
    readCurrent();
    this.onProgress({ phase: 'reading-source' });
    const source = await readFlowSource({ ...context, flowId });
    // Hashing yields; recheck version/current membership before showing evidence.
    this.context(caseId);
    const standard = readCurrent();
    return { ...source, caseId, dataVersion: input.dataVersion, standard };
  }
}

module.exports = { DesktopData };
