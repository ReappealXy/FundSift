'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { finished } = require('node:stream/promises');
const Excel = require('exceljs');
const { EFFECTIVE_FLOW_FROM, withCaseReadSnapshot } = require('./hardening.cjs');
const { parseMinor, assertInt64 } = require('./money.cjs');

const MAX_DATA_ROWS = 1048575;
const MAX_CELL_LENGTH = 32767;
const EXACT_EXCEL_MINOR_LIMIT = 999999999999999n;
const WORKPAPER_FORMAT_VERSION = 3;
const ALIPAY = 'alipay-account-17col-v1';
const WECHAT = 'wechat-trades-27col-v1';
const CCB = 'ccb-account-32col-v1';
const FORMAT_WIDTHS = { [ALIPAY]: 17, [WECHAT]: 27, [CCB]: 32 };
const ALIPAY_CLOSED_STATUS = '交易中途关闭（未完成）';
const TEXT_ESCAPE_PREFIX = '\\u16:';
const CONTROL_OR_EXCEL_ESCAPE = /[\x00-\x08\x0B-\x1F\x7F-\x9F\u202A-\u202E\u2066-\u2069\uD800-\uDFFF\uFFFE\uFFFF]|_x[0-9A-F]{4}_/iu;
const XML_UNSAFE_LITERAL = /[\\\x00-\x08\x0B-\x1F\x7F-\x9F\u202A-\u202E\u2066-\u2069\uD800-\uDFFF\uFFFE\uFFFF]|_(?=x[0-9A-F]{4}_)/giu;
const FILLS = ['25435D', '3C536D', '314E64'];
const font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF172B3F' } };
const text = '@';

const COLUMNS = [
  ['案件编号', 17, text], ['案件名称', 23, text], ['材料名', 31, text], ['平台', 15, text],
  ['原件文件名', 31, text], ['原件 SHA256', 69, text], ['批次号', 12, text], ['格式键', 31, text],
  ['规则版本', 13, text], ['解析器版本', 23, text],
  ['工作表名', 19, text], ['行号／逻辑记录号', 20, text], ['source_loc 原文', 22, text],
  ['本方账号／平台标识', 29, text], ['对方账号／平台标识', 29, text],
  ['本方名称', 29, text], ['对方名称', 29, text],
  ['本方银行卡号（原文）', 27, text], ['对方银行卡号（原文）', 27, text],
  ['摘要', 34, text], ['交易类型', 19, text],
  ['原始金额（原文）', 23, text], ['原始金额单位', 16, text],
  ['微信接收金额（原文，分）', 25, text], ['标准金额（元）', 25, '#,##0.00'],
  ['原始方向（原文）', 21, text], ['标准方向', 13, text], ['原始时间（原文）', 25, text], ['标准交易时间', 25, text],
  ['原始余额（原文）', 23, text], ['原始币种（原文）', 20, text], ['标准币种', 13, text], ['币种依据', 28, text],
  ['业务状态（原文）', 30, text], ['业务状态（规则归一）', 25, text],
  ['原件收付记载', 25, text], ['原件记载说明', 47, text],
  ['证据状态（规则）', 19, text], ['全部待核原因码', 45, text], ['待核原因说明', 64, text],
  ['是否计入收付（派生，仅供参考）', 30, text], ['换算说明', 67, text],
  ['内部划转方向', 22, text], ['内部划转金额（元，绝对值）', 30, '#,##0.00'],
  ['账户变动留痕', 18, text], ['是否计入经济收支', 23, text]
];
const columnNumber = label => COLUMNS.findIndex(([column]) => column === label) + 1;
const firstEvidenceColumn = columnNumber('本方账号／平台标识');
const firstStatusColumn = columnNumber('业务状态（原文）');
const amountColumn = columnNumber('标准金额（元）');
const transferAmountColumn = columnNumber('内部划转金额（元，绝对值）');
const recordNoteColumn = columnNumber('原件记载说明');
const recordStatusColumn = columnNumber('原件收付记载');
const reasonCodeColumn = columnNumber('全部待核原因码');
const reasonDetailColumn = columnNumber('待核原因说明');
const RECORD = {
  closed: '标为关闭或未完成', present: '有收付记载', insufficient: '记载不足以判断'
};

const FIELD_SOURCES = [
  ['摘要', '摘要', '交易用途类型', '消费名称', '原件的交易用途或消费对象。支付宝的“消费名称”也可能填写交易说明，例如转账。'],
  ['交易类型', '留空', '交易业务类型', '留空', '当前版本只展示微信的交易业务类型。'],
  ['本方名称', '客户名称', '用户侧账号名称', '留空', '本方名称原值。支付宝本方信息放在身份列。'],
  ['对方名称', '对方户名', '对手侧账户名称', '留空', '对方名称原值。支付宝对方信息放在身份列。'],
  ['本方账号／平台标识', '账号', '用户ID', '用户信息', '账户编号或平台提供的本方身份原文。'],
  ['对方账号／平台标识', '对方账号', '对手方ID', '交易对方信息', '账户编号或平台提供的对方身份原文。'],
  ['本方银行卡号（原文）', '交易卡号', '用户银行卡号', '留空', '原件所列本方银行卡号。'],
  ['对方银行卡号（原文）', '留空', '对手方银行卡号', '留空', '原件所列对方银行卡号。'],
  ['原始金额（原文）', '交易金额', '交易金额(分)', '金额（元）', '原始文本。比较前先看相邻的单位列。'],
  ['原始金额单位', '元', '分', '元', '取自逐笔保存的换算依据。没有可靠依据时显示未知。'],
  ['微信接收金额（原文，分）', '留空', '对手方接收金额(分)', '留空', '微信对手方视角的原始接收金额。'],
  ['原始方向（原文）', '借贷方向', '借贷类型', '收/支', '按各格式保留原文。'],
  ['原始时间（原文）', '交易日期、交易时间', '交易时间', '付款时间', '建行两项拼接显示。'],
  ['原始余额（原文）', '账户余额', '账户余额(分)', '留空', '原件账面余额文本。'],
  ['原始币种（原文）', '币种', '留空', '留空', '原件币种文本。标准币种及依据另列。'],
  ['业务状态（原文）', '留空', '留空', '交易状态', '原件记载的交易状态。']
];

const CURRENCY_EVIDENCE = {
  raw_iso: '原文 ISO 币种', approved_map: '获准格式映射', verified_cny: '导入时核实人民币来源',
  legacy_unverified: '历史保留值，币种依据未核验', unknown: '证据不足'
};

const REASON_LABELS = {
  direction_unknown: '原始方向不在获准格式词表内',
  business_status_unknown: '业务状态不在获准词表内',
  business_status_closed: '原始交易已关闭或未完成',
  receiver_amount_mismatch: '微信主金额和接收金额不同',
  time_missing: '缺少规定的交易时间字段',
  sign_semantics_undefined: '规则未定义此负号的资金方向含义'
};

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function readDataVersion(db, record) {
  const state = db.prepare('SELECT case_uuid,data_version FROM case_data_state WHERE id=1').safeIntegers().get();
  if (!record || state?.case_uuid !== record.id) fail('FS_CASE_IDENTITY', '底稿案件与当前数据库不符。');
  return state.data_version.toString();
}

function rowCount(db) {
  return db.prepare('SELECT count(*) AS n ' + EFFECTIVE_FLOW_FROM).get().n;
}

function getWorkpaperContext({ db, record }) {
  return withCaseReadSnapshot(db, () => {
    const dataVersion = readDataVersion(db, record);
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
    return { caseId: record.id, dataVersion, formatVersion: WORKPAPER_FORMAT_VERSION, totalRows: rowCount(db),
      fileName: `流水核对底稿-格式v${WORKPAPER_FORMAT_VERSION}-数据v${dataVersion}-${timestamp}.xlsx` };
  });
}

// Preserve ordinary text literally. SpreadsheetML interprets _xHHHH_ sequences
// and XML/Excel normalizes or removes some controls, so visibly escape those
// cases with an unambiguous, reversible marker.
function excelText(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value);
  const encoded = raw.startsWith(TEXT_ESCAPE_PREFIX) || CONTROL_OR_EXCEL_ESCAPE.test(raw)
    ? TEXT_ESCAPE_PREFIX + raw.replace(XML_UNSAFE_LITERAL, char =>
      char === '\\' ? '\\\\' : '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'))
    : raw;
  if (encoded.length > MAX_CELL_LENGTH) {
    fail('FS_EXPORT_CELL_LIMIT', '有原文或说明超过 Excel 单元格的 32,767 字符上限。底稿没有发布，请核对原材料。');
  }
  return encoded;
}

function yuanFromMinor(minor) {
  const absolute = minor < 0n ? -minor : minor;
  return (minor < 0n ? '-' : '') + absolute / 100n + '.' + String(absolute % 100n).padStart(2, '0');
}

function excelAmount(minor) {
  if (minor === null) return null;
  if (minor >= -EXACT_EXCEL_MINOR_LIMIT && minor <= EXACT_EXCEL_MINOR_LIMIT) return Number(minor) / 100;
  return yuanFromMinor(minor);
}

function rawEnvelope(row) {
  const width = FORMAT_WIDTHS[row.format_key];
  if (width === undefined) return null;
  if (!row.raw_record && row.currency_evidence === 'legacy_unverified') return null;
  let raw;
  try { raw = JSON.parse(row.raw_record); }
  catch (_) { fail('FS_EXPORT_EVIDENCE', '有效流水的原文记录无法读取，请核对材料后重试。'); }
  if (raw?.format_key !== row.format_key || raw?.source_loc !== row.source_loc || raw?.values?.length !== width ||
      !Array.isArray(raw.values) || raw.values.some(value => typeof value !== 'string') || !raw.derivation?.money) {
    fail('FS_EXPORT_EVIDENCE', '有效流水的原文记录与来源信息不一致，请核对材料后重试。');
  }
  return raw;
}

function rawEvidence(row, raw) {
  const values = raw?.values ?? [];
  switch (row.format_key) {
    case ALIPAY: return [values[7] ?? row.acct_no, values[8] ?? row.peer_acct, null, null, null, values[12]];
    case WECHAT: return [values[0] ?? row.acct_no, values[14] ?? row.peer_acct, values[10], values[16], values[24], null];
    case CCB: return [values[2] ?? row.acct_no, values[19] ?? row.peer_acct, values[11], null, null, null];
    default: return [row.acct_no, row.peer_acct, null, null, null, null];
  }
}

function accountNames(row, raw) {
  if (row.format_key === WECHAT) return [raw?.values[3], raw?.values[15]];
  if (row.format_key === ALIPAY) return [null, null];
  return [row.acct_name, row.peer_name];
}

function populatedText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function position(row) {
  const worksheet = /^(.*)!([1-9]\d*)(?![\s\S])/u.exec(row.source_loc);
  if (worksheet) return [worksheet[1], worksheet[2]];
  const logical = /^(?:record:)?([1-9]\d*)(?![\s\S])/u.exec(row.source_loc);
  return [null, logical?.[1] ?? null];
}

function internalTransfer(row, raw) {
  const transfer = raw?.derivation?.internal_transfer;
  if (transfer == null) return null;
  if (row.format_key !== ALIPAY || row.rule_version !== 2n ||
      raw.derivation.business_status_policy !== 'exact_v2' ||
      transfer.kind !== 'balance_to_yuebao' || transfer.account_change !== true || transfer.economic_inclusion !== false) {
    fail('FS_EXPORT_EVIDENCE', '内部划转依据与规则版本不一致，请核对材料后重试。');
  }
  const minor = transfer.amount_minor;
  if (minor === null) return { amount: null };
  if (typeof minor !== 'string' || !/^[1-9]\d{0,18}(?![\s\S])/u.test(minor)) {
    fail('FS_EXPORT_EVIDENCE', '内部划转金额的保存格式无效，请核对材料后重试。');
  }
  try { return { amount: assertInt64(minor) }; }
  catch (_) { fail('FS_EXPORT_EVIDENCE', '内部划转金额超过可核验的范围，请核对材料后重试。'); }
}

function businessStatus(rawStatus, raw, reasons, transfer) {
  if (transfer) return '内部划转';
  const policy = raw?.derivation?.business_status_policy;
  if (policy === 'not_available') return '原件无业务状态字段';
  if (!populatedText(rawStatus)) return '原件未填业务状态';
  if (policy !== 'exact_v1' && policy !== 'exact_v2') return '未获准词表（见原文）';
  if (reasons.some(reason => reason.reason_code === 'business_status_closed')) return '关闭／未完成';
  if (!reasons.some(reason => reason.reason_code.startsWith('business_status_'))) return '成功';
  return '未获准词表（见原文）';
}

function originalRecordStatus(row, rawStatus, business) {
  if (business === '关闭／未完成' || (row.format_key === ALIPAY && rawStatus === ALIPAY_CLOSED_STATUS)) {
    return RECORD.closed;
  }
  return populatedText(row.raw_amount_text) ? RECORD.present : RECORD.insufficient;
}

function originalRecordNote(row, rawStatus, label, reasons, transfer) {
  if (row.status !== 'pending') return null;
  const hasReason = code => reasons.some(reason => reason.reason_code === code);
  if (label === RECORD.closed) return '原件的交易状态标为关闭或未完成。';
  if (transfer) return '同一主体的余额转入余额宝，保留账户变动并从经济收支中排除。标准方向及其余待核项见待核原因。';
  if (hasReason('receiver_amount_mismatch')) return '微信原件的交易金额与对手方接收金额有差异，两个原值均保留。';
  if (row.format_key === CCB && hasReason('sign_semantics_undefined')) {
    return '建行原件记载负额，金额和方向仍待核，参见摘要与借贷方向。';
  }
  if (row.format_key === ALIPAY && rawStatus === '交换产品-余额实时转余额宝成功') {
    return '支付宝原件记载余额实时转余额宝，方向和业务状态仍待核。';
  }
  if (label === RECORD.insufficient) return '原件缺少金额记载，请查看待核原因。';
  return '原件有金额记载，请查看全部待核原因及说明。';
}

function inclusionStatus(row, business, transfer) {
  if (transfer || business === '关闭／未完成') return '否';
  if (row.status !== 'confirmed' || row.currency !== 'CNY' ||
      ['legacy_unverified', 'unknown'].includes(row.currency_evidence) ||
      row.amount === null || !['进', '出'].includes(row.direction)) {
    return '未知';
  }
  return row.amount === 0n ? '否' : '是';
}

const AMOUNT_METHODS = {
  amount_sign: '按原始正负号确定方向', direction_map: '按方向词表赋予标准正负号',
  direction_reversed: '按规则反转方向', direction_magnitude: '按方向取金额绝对值后赋号',
  raw_zero: '保留原始零金额', income_reverse: '收入列负额按获准规则反向',
  expense_reverse: '支出列负额按获准规则反向', income_magnitude: '收入列取绝对值',
  expense_magnitude: '支出列取绝对值'
};

function moneyExplanation(row, money) {
  if (!money) return '未保留逐笔换算依据';
  if (!['元', '分'].includes(money.source_unit)) return '未保留可核验的原始金额单位';
  const notes = [
    money.source_unit === '元' ? '原文元 → 存储分 → 标准元' : '原文分 → 存储分 → 标准元'
  ];
  for (const { field, rounded } of money.rounding ?? []) {
    if (!rounded) continue;
    // Use the saved rounding flag and the original unit. Do not re-interpret
    // transaction direction to display the pre-sign rounding result.
    const raw = row[field];
    if (typeof raw === 'string' && ['raw_amount_text', 'raw_income_text', 'raw_expense_text'].includes(field)) {
      const { value } = parseMinor(raw, money.source_unit);
      notes.push('舍入 ' + raw + ' → ' + yuanFromMinor(value) + ' 元（' + money.rounding_rule + '）');
    }
    else notes.push('有金额字段舍入（' + money.rounding_rule + '）');
  }
  if (money.amount?.method) notes.push(AMOUNT_METHODS[money.amount.method] ?? money.amount.method);
  if (row.amount === null) notes.push('标准金额待核，留空');
  return notes.join('；');
}

function rowValues(row, record, reasons) {
  const raw = rawEnvelope(row);
  const [account, peer, ownCard, peerCard, receiver, rawStatus] = rawEvidence(row, raw);
  const [ownName, peerName] = accountNames(row, raw);
  const [worksheet, rowNumber] = position(row);
  const transfer = internalTransfer(row, raw);
  const status = businessStatus(rawStatus, raw, reasons, transfer);
  const originalStatus = originalRecordStatus(row, rawStatus, status);
  const money = raw?.derivation?.money;
  const unit = ['元', '分'].includes(money?.source_unit) ? money.source_unit : '未知';
  const cells = [
    record.case_no, record.case_name, row.file_name, row.platform, row.file_name, row.file_sha256,
    row.batch_id, row.format_key, row.rule_version, row.parser_version,
    worksheet, rowNumber, row.source_loc, account, peer, populatedText(ownName), populatedText(peerName), ownCard, peerCard,
    populatedText(row.summary), populatedText(row.txn_type),
    row.raw_amount_text, unit, receiver, excelAmount(row.amount), row.raw_direction, row.direction,
    row.txn_time_text, row.txn_time, row.raw_balance_text, row.raw_currency_text, row.currency,
    CURRENCY_EVIDENCE[row.currency_evidence] ?? '依据未记录',
    rawStatus, status, originalStatus, originalRecordNote(row, rawStatus, originalStatus, reasons, transfer),
    row.status === 'confirmed' ? '已确认' : '待核',
    reasons.map(reason => reason.reason_code).join('\n') || null,
    reasons.map(reason => reason.reason_code + (reason.detail ? ' · ' + reason.detail : '')).join('\n') || null,
    inclusionStatus(row, status, transfer), moneyExplanation(row, money),
    transfer ? '余额转余额宝' : null, transfer ? excelAmount(transfer.amount) : null,
    transfer ? '是' : null, transfer ? '否' : null
  ];
  return cells.map(value => typeof value === 'number' ? value : excelText(value));
}

function newCounts() {
  return { totalRows: 0, confirmedRows: 0, pendingRows: 0, unknownAmountRows: 0 };
}

function countRow(counts, row) {
  counts.totalRows++;
  if (row.status === 'confirmed') counts.confirmedRows++;
  else counts.pendingRows++;
  if (row.amount === null) counts.unknownAmountRows++;
}

function readWorkpaper(db, record, expectedDataVersion) {
  const connectionVersion = db.pragma('data_version', { simple: true });
  return withCaseReadSnapshot(db, () => {
    const dataVersion = readDataVersion(db, record);
    if (dataVersion !== expectedDataVersion) fail('FS_EXPORT_STALE', '案件数据已更新，请重新生成底稿。');
    const totalRows = rowCount(db);
    if (totalRows > MAX_DATA_ROWS) fail('FS_EXPORT_ROW_LIMIT', '有效流水超过 Excel 单页容量，当前底稿无法完整生成。');
    const materials = db.prepare(`SELECT s.file_name,s.file_sha256,s.status
      FROM source_file s LEFT JOIN import_batch b ON b.id=s.current_batch_id AND b.source_file_id=s.id
        AND b.case_id=s.case_id AND b.status='done'
      WHERE s.case_id=1 AND b.id IS NULL ORDER BY s.id`).all();
    const readReasons = db.prepare(`SELECT reason_code,detail FROM pending_reason
      WHERE fund_flow_id=? AND resolved_at IS NULL ORDER BY reason_code`);
    const readRows = db.prepare(`SELECT flow.*,r.format_key FROM (
      SELECT f.id,f.batch_id,f.source_file_id,f.format_rule_id,f.rule_version,f.source_loc,f.platform,f.acct_no,
        f.peer_acct,f.acct_name,f.peer_name,f.summary,f.txn_type,f.txn_time,f.txn_time_text,
        f.raw_amount_text,f.raw_income_text,f.raw_expense_text,f.raw_direction,f.raw_balance_text,
        f.raw_currency_text,f.raw_record,f.amount,f.direction,f.currency,f.currency_evidence,f.status,
        s.file_name,s.file_sha256,b.parser_version ${EFFECTIVE_FLOW_FROM}
      ) flow LEFT JOIN format_rule r ON r.id=flow.format_rule_id AND r.rule_version=flow.rule_version
      ORDER BY (flow.txn_time IS NULL),flow.txn_time,flow.source_file_id,flow.source_loc COLLATE BINARY,flow.id`).safeIntegers();
    const counts = newCounts(), platforms = new Map(), reasonSummary = new Map(), rows = [];
    const recordCounts = new Map(Object.values(RECORD).map(label => [label, 0]));
    let hasEscapedText = false;
    for (const row of readRows.iterate()) {
      const reasons = readReasons.all(row.id);
      for (const item of reasons) {
        const previous = reasonSummary.get(item.reason_code);
        if (previous) previous.count++;
        else reasonSummary.set(item.reason_code, { code: item.reason_code, count: 1,
          detail: (Object.hasOwn(REASON_LABELS, item.reason_code) ? REASON_LABELS[item.reason_code] : item.detail) ?? '该原因未附说明' });
      }
      const name = row.platform || '未识别平台';
      if (!platforms.has(name)) platforms.set(name, { platform: name, ...newCounts() });
      countRow(platforms.get(name), row);
      countRow(counts, row);
      const values = rowValues(row, record, reasons);
      const label = values[recordStatusColumn - 1];
      recordCounts.set(label, recordCounts.get(label) + 1);
      hasEscapedText ||= values.some(value => typeof value === 'string' && value.startsWith(TEXT_ESCAPE_PREFIX));
      rows.push(values);
    }
    if (rows.length !== totalRows) fail('FS_EXPORT_READ', '底稿行数与有效流水不一致，未生成文件。');
    return { rows, materials, counts, recordCounts, dataVersion, connectionVersion, hasEscapedText,
      platforms: [...platforms.values()].sort((a, b) => a.platform.localeCompare(b.platform, 'zh-CN')),
      reasons: [...reasonSummary.values()].sort((a, b) => a.code.localeCompare(b.code)) };
  });
}

function styleHeader(row, colors = [FILLS[0]]) {
  row.height = 27;
  row.eachCell((cell, index) => {
    cell.font = { ...font, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + (colors[index - 1] ?? colors[0]) } };
  });
  row.commit();
}

function summarySheet(workbook, record, snapshot, exportedAt) {
  const sheet = workbook.addWorksheet('导出说明', {
    views: [{ showGridLines: false }], properties: { tabColor: { argb: 'FF7C8BA0' } }
  });
  sheet.columns = [32, 65, 29, 25, 49].map(width => ({ width, style: { font } }));
  let hasEscapedText = snapshot.hasEscapedText;
  function add(values, height = 21) {
    const cells = values.map(value => typeof value === 'number' ? value : excelText(value));
    hasEscapedText ||= cells.some(value => typeof value === 'string' && value.startsWith(TEXT_ESCAPE_PREFIX));
    const row = sheet.addRow(cells);
    row.height = height;
    row.eachCell(cell => { cell.alignment = { vertical: 'middle', wrapText: true }; });
    row.commit();
  }
  const title = sheet.addRow(['流水核对底稿']);
  title.getCell(1).font = { ...font, bold: true, size: 14 };
  title.height = 28;
  title.commit();
  add(['用途', '本表为规则结果、未经人工复核。在 Excel 里改不算复核，也不会写回案件。'], 33);
  add(['案件', record.case_no + ' · ' + record.case_name], 26);
  add(['底稿格式版本', WORKPAPER_FORMAT_VERSION]);
  add(['数据版本', snapshot.dataVersion]);
  add(['导出时间（UTC）', exportedAt]);
  add(['有效流水口径', '仅收录每份材料当前已完成批次内的记录。保留各来源记录与待核原因。'], 33);
  add(['金额与标识', '原始金额保留文本，单位见相邻列。标准金额以元显示两位小数，未知留空。超出精确范围的金额、账号及银行卡号存为文本。'], 48);
  add(['支付宝字段原文', '支付宝的本方标识、对方标识和摘要列可能含前导制表符。做精确筛选或匹配时，可在核对副本中去掉前导制表符。'], 48);
  add(['原件收付记载', '先看原件是否标为关闭或未完成，否则根据原文金额是否填写显示固定标签。标签表示原件记载情况，结算结果仍需另行核实。'], 48);
  add(['派生列', '“是否计入收付”仅供参考。已确认且有核实币种依据的非零人民币收付为“是”，内部划转、明确关闭或无金额变化为“否”，其余为“未知”。本表仅提供笔数。'], 56);
  add(['支付宝内部划转', '规则识别的同主体划转在账户变动中留痕，并排除经济收支。内部划转金额为原件能核实的绝对值。标准收付方向或金额仍待核时，保留原待核项。'], 56);
  add(['内部划转列', '“内部划转方向”记录余额与余额宝之间的路径。“账户变动留痕”和“是否计入经济收支”只在识别出的划转行填写。留痕只表明原件记载的账户间变动。'], 56);
  add(['原件文件名', '本版本材料名称采用登记的原件文件名。来源以文件 SHA256 和原文坐标为准。'], 33);
  add([]);
  styleHeader(sheet.addRow(['记录统计', '总行数', '已确认', '待核', '金额未知']));
  const countCells = item => [item.totalRows, item.confirmedRows, item.pendingRows, item.unknownAmountRows];
  add(['全案', ...countCells(snapshot.counts)]);
  for (const item of snapshot.platforms) add([item.platform, ...countCells(item)]);
  add([]);
  styleHeader(sheet.addRow(['原件收付记载标签', '本次导出行数']));
  for (const [label, count] of snapshot.recordCounts) add([label, count]);
  add([]);
  styleHeader(sheet.addRow(['待核原因码', '含义', '出现次数']));
  for (const item of snapshot.reasons) add([item.code, item.detail, item.count], 33);
  if (!snapshot.reasons.length) add(['无待核原因']);
  add([]);
  styleHeader(sheet.addRow(['未入表材料', '原件 SHA256', '材料状态']));
  for (const material of snapshot.materials) {
    add([material.file_name, material.file_sha256,
      ({ pending: '待导入', partial: '未完整导入', failed: '导入失败', imported: '无有效批次' })[material.status] ?? '无有效批次'], 32);
  }
  if (!snapshot.materials.length) add(['无未入表材料']);
  add([]);
  styleHeader(sheet.addRow(['字段来源表', '建行原文字段', '微信原文字段', '支付宝原文字段', '含义与口径']));
  for (const source of FIELD_SOURCES) add(source, 34);
  if (hasEscapedText) {
    add([]);
    add(['原文转义', '带 \\u16: 前缀的文本使用可逆转义。去掉前缀，\\\\ 还原为反斜杠，\\u 加四位十六进制表示原字符。例如 \\u16:A\\u0001 表示字母 A 后接 U+0001 控制字符。'], 58);
  }
  sheet.commit();
}

async function writeWorkbook(stream, record, snapshot, time, onProgress) {
  const workbook = new Excel.stream.xlsx.WorkbookWriter({ stream, useStyles: true,
    created: time, modified: time, creator: '东启勘流 FundSift' });
  const sheet = workbook.addWorksheet('流水明细', {
    views: [{ state: 'frozen', xSplit: 3, ySplit: 1, showGridLines: false }],
    properties: { tabColor: { argb: 'FF25435D' } },
    autoFilter: { from: { row: 1, column: 1 }, to: { row: snapshot.rows.length + 1, column: COLUMNS.length } }
  });
  sheet.columns = COLUMNS.map(([, width, numFmt]) => ({ width, style: { font, numFmt } }));
  styleHeader(sheet.addRow(COLUMNS.map(([label]) => label)),
    COLUMNS.map((_, index) => FILLS[index + 1 < firstEvidenceColumn ? 0 : index + 1 < firstStatusColumn ? 1 : 2]));
  const totalRows = snapshot.rows.length;
  onProgress({ phase: 'writing-export', totalRows, writtenRows: 0 });
  for (let index = 0; index < totalRows; index++) {
    const values = snapshot.rows[index];
    const row = sheet.addRow(values);
    row.height = 18;
    for (const column of [amountColumn, transferAmountColumn]) {
      if (typeof values[column - 1] === 'string') row.getCell(column).numFmt = text;
    }
    row.getCell(recordNoteColumn).alignment = { wrapText: true, vertical: 'middle' };
    row.getCell(reasonCodeColumn).alignment = { wrapText: true, vertical: 'middle' };
    row.getCell(reasonDetailColumn).alignment = { wrapText: true, vertical: 'middle' };
    const detail = values[reasonDetailColumn - 1];
    const detailLines = detail ? detail.split('\n').reduce((lines, line) => lines + Math.ceil(line.length / 48), 0) : 0;
    const note = values[recordNoteColumn - 1];
    const noteLines = note ? Math.ceil(note.length / 32) : 0;
    if (detailLines || noteLines) row.height = Math.min(110, 14 + 15 * Math.max(detailLines, noteLines));
    row.commit();
    // Give the writer's stream time to flush on large workpapers.
    if ((index + 1) % 512 === 0) {
      onProgress({ phase: 'writing-export', totalRows, writtenRows: index + 1 });
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  onProgress({ phase: 'writing-export', totalRows, writtenRows: totalRows });
  sheet.commit();
  summarySheet(workbook, record, snapshot, time.toISOString());
  await workbook.commit();
}

async function exportWorkpaper({ db, record, filePath, expectedDataVersion, onProgress = () => {} }) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.xlsx' ||
      typeof expectedDataVersion !== 'string' || !/^(?:0|[1-9]\d{0,18})$/.test(expectedDataVersion) || db.inTransaction) {
    fail('FS_EXPORT_INPUT', '请重新选择 Excel 底稿的保存位置。');
  }
  const time = new Date();
  onProgress({ phase: 'reading-export' });
  const snapshot = readWorkpaper(db, record, expectedDataVersion);
  let temporary, stream, done, published = false;
  try {
    if (fs.existsSync(filePath)) fail('FS_EXPORT_EXISTS', '同名底稿已存在，请重新生成文件名。');
    const candidate = path.join(path.dirname(filePath), '.fundsift-' + randomUUID() + '.tmp');
    const fd = fs.openSync(candidate, 'wx', 0o600);
    temporary = candidate;
    stream = fs.createWriteStream(temporary, { fd });
    done = finished(stream);
    await Promise.all([writeWorkbook(stream, record, snapshot, time, onProgress), done]);
    const completed = fs.openSync(temporary, 'r+');
    try { fs.fsyncSync(completed); }
    finally { fs.closeSync(completed); }
    onProgress({ phase: 'publishing' });
    db.transaction(() => {
      if (readDataVersion(db, record) !== snapshot.dataVersion ||
          db.pragma('data_version', { simple: true }) !== snapshot.connectionVersion) {
        fail('FS_EXPORT_STALE', '导出期间案件数据已更新，请重新生成底稿。');
      }
      // An immediate transaction keeps other SQLite writers out between the
      // version check and publication. A hard link publishes the finished
      // workbook atomically and fails if the selected name already exists.
      try {
        fs.linkSync(temporary, filePath);
        published = true;
      }
      catch (error) {
        if (error.code === 'EEXIST') fail('FS_EXPORT_EXISTS', '同名底稿已存在，请重新生成文件名。');
        if (['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].includes(error.code)) {
          fail('FS_EXPORT_LINK', '保存位置不支持安全发布底稿或没有操作权限。请改用可写的本地 NTFS 文件夹。');
        }
        throw error;
      }
    }).immediate();
    const result = { caseId: record.id, dataVersion: snapshot.dataVersion, formatVersion: WORKPAPER_FORMAT_VERSION,
      filePath, fileName: path.basename(filePath),
      exportedAt: time.toISOString(), ...snapshot.counts, platforms: snapshot.platforms };
    try { fs.unlinkSync(temporary); }
    catch (error) {
      if (error.code !== 'ENOENT') result.cleanupWarning = '底稿已生成，临时文件未能清理。';
    }
    return result;
  } catch (error) {
    stream?.destroy();
    await done?.catch(() => {});
    if (error.code?.startsWith('FS_')) throw error;
    fail('FS_EXPORT_WRITE', '无法写出底稿，请检查保存目录和剩余磁盘空间。');
  } finally {
    if (temporary && !published) {
      try { fs.unlinkSync(temporary); }
      catch (error) { if (error.code !== 'ENOENT') fail('FS_EXPORT_CLEANUP', '底稿临时文件无法清理，请检查保存目录权限。'); }
    }
  }
}

module.exports = { getWorkpaperContext, exportWorkpaper };
