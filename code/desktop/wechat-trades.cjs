'use strict';

// Only the observed 27-column UTF-8/TAB structure. Every business decision is
// supplied by the caller; this module never approves or merges source records.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeMoney, validateMoneyRule, assertInt64 } = require('./money.cjs');

const FORMAT_KEY = 'wechat-trades-27col-v1';
const PARSER_VERSION = 'wechat-trades-preview-1';
const MAX_BYTES = 64 * 1024 * 1024;
const HEADERS = Object.freeze(['用户ID', '交易单号', '大单号', '用户侧账号名称', '借贷类型', '交易业务类型', '交易用途类型',
  '交易时间', '交易金额(分)', '账户余额(分)', '用户银行卡号', '用户侧网银联单号', '网联/银联', '第三方账户名称',
  '对手方ID', '对手侧账户名称', '对手方银行卡号', '对手侧银行名称', '对手侧网银联单号', '网联/银联',
  '基金公司信息', '间联/非间联交易', '第三方账户名称', '对手方接收时间', '对手方接收金额(分)', '备注1', '备注2']);
const INTEGER = /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)(?![\s\S])/;
const blank = value => value === null || value === undefined || typeof value === 'string' && value.trim() === '';
const abort = signal => { if (signal?.aborted) fail('FS_USER_CANCELLED', '已取消文件读取，未发布导入结果。'); };
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function limits(value) {
  const cap = value ?? MAX_BYTES;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_BYTES) fail('FS_FORMAT_INPUT', '本格式文件大小上限必须介于1字节和64MiB之间。');
  return cap;
}
function fieldEntries(values) { return HEADERS.map((header, index) => ({ column: index + 1, header, value: values[index] })); }
function positionalFields(values) { return Object.fromEntries(values.map((value, index) => [`column_${String(index + 1).padStart(2, '0')}`, value])); }

function decode(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ||
      bytes.length >= 2 && (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff)) {
    fail('FS_FORMAT_ENCODING', '本27列结构只接受已明确的UTF-8无BOM编码。');
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes('\0')) fail('FS_FORMAT_ENCODING', '文件含不支持的空字符，不能按本结构解码。');
    return text;
  } catch (error) {
    if (error.code === 'FS_FORMAT_ENCODING') throw error;
    fail('FS_FORMAT_ENCODING', '文件不能按UTF-8无损解码。');
  }
}

// The observed export quotes nested JSON using TAB/CSV double-quote escapes.
// Quotes inside an unquoted field are literal evidence, as in the source
// inventory's TSV dialect. Newlines inside a quoted field are not record ends.
function parseTSV(text) {
  const records = [];
  let row = [], field = '', mode = 'start', begun = false;
  function finishField() {
    if (row.length >= HEADERS.length) fail(records.length ? 'FS_FORMAT_STRUCTURE' : 'FS_FORMAT_UNSUPPORTED', 'TXT逻辑记录超过本结构支持的27列。');
    row.push(field); field = ''; mode = 'start';
  }
  function finishRecord() {
    finishField();
    const header = row.length === HEADERS.length && HEADERS.every((value, n) => row[n] === value);
    if (!records.length && !header) fail('FS_FORMAT_UNSUPPORTED', '表头与已支持的27列微信交易结构不一致。');
    if (records.length && (row.length !== HEADERS.length || row.every(value => value.trim() === '') || header)) {
      fail('FS_FORMAT_STRUCTURE', `来源记录${records.length + 1}为空、重复表头或列数不符，整份文件不能发布。`);
    }
    records.push(row); row = []; begun = false;
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (mode === 'quoted') {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; }
        else mode = 'closed';
      } else field += char;
      continue;
    }
    if (char === '\t' || char === '\n' || char === '\r') {
      if (char === '\t') { finishField(); begun = true; }
      else {
        if (char === '\r') {
          if (text[index + 1] !== '\n') fail('FS_FORMAT_TSV', 'TXT记录边界必须为CRLF或LF，不能猜测裸CR。');
          index++;
        }
        finishRecord();
      }
    } else if (mode === 'closed') fail('FS_FORMAT_TSV', 'TXT闭合引号后出现了非分隔文本。');
    else if (char === '"' && mode === 'start') { mode = 'quoted'; begun = true; }
    else { field += char; mode = 'plain'; begun = true; }
  }
  if (mode === 'quoted') fail('FS_FORMAT_TSV', 'TXT引号字段未闭合。');
  if (begun || row.length || field !== '' || mode === 'closed') finishRecord();
  return records;
}

function structure(bytes, options = {}) {
  const cap = limits(options.maxBytes);
  if (!Buffer.isBuffer(bytes)) fail('FS_FORMAT_INPUT', '解析入口需要文件字节Buffer。');
  if (bytes.length > cap) fail('FS_FORMAT_TOO_LARGE', '本次技术预览只支持不超过64MiB的单个文件。');
  abort(options.signal);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (options.expectedSha256 !== undefined && (typeof options.expectedSha256 !== 'string' ||
      !/^[a-f0-9]{64}(?![\s\S])/.test(options.expectedSha256) || options.expectedSha256 !== sha256)) {
    fail('FS_FORMAT_IDENTITY', '文件字节与预期归档身份不一致。');
  }
  const text = decode(bytes);
  const records = parseTSV(text);
  const isHeader = row => row.length === HEADERS.length && HEADERS.every((header, n) => header === row[n]);
  if (!records.length || !isHeader(records[0])) fail('FS_FORMAT_UNSUPPORTED', '表头与已支持的27列微信交易结构不一致。');
  if (records.length === 1) fail('FS_FORMAT_EMPTY', '文件只有表头，没有可导入数据记录。');
  for (let index = 1; index < records.length; index++) {
    const row = records[index];
    if (row.length !== HEADERS.length || row.every(value => value.trim() === '') || isHeader(row)) {
      fail('FS_FORMAT_STRUCTURE', `来源记录${index + 1}为空、重复表头或列数不符，整份文件不能发布。`);
    }
  }
  return { records, metadata: { formatKey: FORMAT_KEY, parserVersion: PARSER_VERSION, encoding: 'utf-8', bom: false,
    sha256, sizeBytes: bytes.length.toString(), headerRecordCount: 1, dataRecordCount: records.length - 1,
    nonDataRecordCount: 1, columns: [...HEADERS], fieldKeys: HEADERS.map((_, n) => `column_${String(n + 1).padStart(2, '0')}`) } };
}

function validateBinding(rule) {
  validateMoneyRule(rule);
  if (rule.amount_expr !== 'E' || rule.source_unit !== '分' || rule.unit_scale !== 1 || rule.negative_policy !== 'pending' ||
      rule.zero_policy !== 'pending' || Object.keys(rule.direction_map).length !== 2 || rule.direction_map.入 !== '进' || rule.direction_map.出 !== '出' ||
      rule.balance_scope !== 'unknown' || rule.balance_same_direction !== false) {
    fail('FS_FORMAT_RULE', '此27列结构需要明确的E类整数分、入出词表、异常待核和未知余额口径。');
  }
}

function localTimestamp(text) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?![\s\S])/.test(text)) return null;
  const year = Number(text.slice(0, 4)), month = Number(text.slice(5, 7)), day = Number(text.slice(8, 10));
  const hour = Number(text.slice(11, 13)), minute = Number(text.slice(14, 16)), second = Number(text.slice(17, 19));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour <= 23 && minute <= 59 && second <= 59 ? text : null;
}

// Classify the reason without converting a timezone or choosing a range end.
function invalidTimeReason(text) {
  const ambiguous = new Set(['CST', 'IST', 'EST', 'PST', 'BST', 'AST', 'GST', 'MST']);
  const zones = new Set(['UTC', 'GMT', 'JST', 'KST', 'HKT', 'SGT', 'AEST', 'AEDT', 'CET', 'CEST', 'MSK']);
  const clocks = [];
  for (const match of text.matchAll(/(?<![0-9:])[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?![0-9:])/g)) {
    const prefix = /([0-9]{4}[-/][0-9]{2}[-/][0-9]{2})(T|\s+)$/i.exec(text.slice(0, match.index));
    clocks.push({ start: prefix ? prefix.index : match.index, end: match.index + match[0].length,
      clock: match[0], date: Boolean(prefix), iso: prefix?.[2].toUpperCase() === 'T' });
  }
  for (let n = 1; n < clocks.length; n++) {
    const left = clocks[n - 1], right = clocks[n], separator = text.slice(left.end, right.start);
    if (!/^\s*[-–—~～至到]\s*$/.test(separator)) continue;
    const offset = left.iso && separator === '-' && !right.date && /^[0-9]{2}:[0-9]{2}$/.test(right.clock) &&
      !/[A-Za-z0-9_:.]/.test(text[right.end] || '');
    if (!offset) return 'time_ambiguous';
  }
  const words = [];
  for (const match of text.matchAll(/[A-Za-z]+/g)) {
    if (/[A-Za-z0-9_]/.test(text[match.index - 1] || '') || /[A-Za-z0-9_]/.test(text[match.index + match[0].length] || '')) continue;
    const word = match[0].toUpperCase();
    if (ambiguous.has(word)) return 'time_ambiguous';
    if (zones.has(word)) words.push({ index: match.index });
  }
  let marked = words.length > 0;
  for (const clock of clocks) {
    const rest = text.slice(clock.end);
    if (/^\s*Z(?![A-Za-z0-9_:.])/i.test(rest)) marked = true;
    for (const offset of rest.matchAll(/[+-](?:[0-9]{2}:[0-9]{2}|[0-9]{4}|[0-9]{2})(?![A-Za-z0-9_:.])/g)) {
      const adjacent = rest.slice(0, offset.index).trim() === '';
      if (!adjacent && /[0-9:]/.test(rest[offset.index - 1] || '')) continue;
      if (!adjacent || !clock.iso && /^-[0-9]{2}:[0-9]{2}$/.test(offset[0])) return 'time_ambiguous';
      marked = true;
    }
  }
  for (const word of words) {
    let before;
    for (const clock of clocks) if (clock.end <= word.index) before = clock;
    if (before && text.slice(before.end, word.index).trim() !== '') return 'time_ambiguous';
  }
  return marked ? 'time_timezone' : 'time_invalid';
}

function policyApproved(policy) {
  return policy?.review?.status === 'approved' && ['by', 'at', 'reason'].every(key => typeof policy.review[key] === 'string' && policy.review[key].trim());
}
function integerText(text) { return typeof text === 'string' && text.length <= 4096 && INTEGER.test(text); }

function rowResult(values, coordinate, rule, policy) {
  const mainValid = integerText(values[8]);
  const money = normalizeMoney({ raw_amount_text: mainValid ? values[8] : null, raw_direction: values[4], currency_text: null }, rule);
  const reasons = money.reasons.filter(reason => mainValid || blank(values[8]) || reason.reason_code !== 'amount_missing').map(reason => ({ ...reason }));
  const diagnostics = [];
  const add = (reason_code, detail) => { if (!reasons.some(reason => reason.reason_code === reason_code)) reasons.push({ reason_code, detail }); };
  if (!mainValid && !blank(values[8])) add('amount_unparseable', '主交易金额不是本格式明确的规范整数分，禁止舍入、补零或猜测。');
  const approved = policyApproved(policy);
  let txn_time = null, acct_no = null, balance = null;
  if (!approved || policy.timeColumn !== '交易时间') add('time_policy_unapproved', '主交易时间政策尚未批准，不回退对手方接收时间。');
  else if (blank(values[7])) add('time_missing', '主交易时间缺失，不能用对手方接收时间补位。');
  else {
    txn_time = localTimestamp(values[7]);
    if (txn_time === null) add(invalidTimeReason(values[7]), '主时间不是明确完整的本地时间，保留原文并待核，不换算时区或取区间端点。');
  }
  if (!approved || policy.accountIdentityPolicy !== 'raw_platform_user_id') {
    add('account_identity_policy_unapproved', '本方用户ID来源标识政策尚未批准。');
    add('account_missing', '标准本方来源标识尚未确定，原始用户ID和卡号分别保留。');
  } else if (blank(values[0])) add('account_missing', '本方用户ID缺失，不能按名称、银行卡或对手标识补位。');
  else acct_no = values[0];
  if (!approved || policy.receiverAmountPolicy !== 'mismatch_pending') add('receiver_amount_policy_unapproved', '接收金额与主金额差异的待核政策尚未批准。');
  else if (!blank(values[24])) {
    if (!integerText(values[24]) || values[24].startsWith('-')) add('receiver_amount_unparseable', '接收金额不是明确的非负整数分，保留原文并待核，不回填主金额。');
    else if (mainValid && BigInt(values[8]) !== BigInt(values[24])) add('receiver_amount_mismatch', '主金额与对手方接收金额不同，保留两种视角并待核，不自动拆分、替换或抵消。');
  }
  if (!approved || policy.balancePolicy !== 'preserve_unknown') add('balance_policy_unapproved', '余额原文保留与未知口径政策尚未批准。');
  else if (!blank(values[9])) {
    try {
      if (!integerText(values[9])) throw new Error('noninteger');
      balance = assertInt64(values[9]).toString();
    } catch (_) { diagnostics.push({ code: 'balance_unparseable', column: 10, detail: '余额不能无损解释为整数分，保留原文；不反推主金额或方向。' }); }
  }
  if (values[22].trimStart().startsWith('{')) {
    try {
      const data = JSON.parse(values[22]);
      if (data === null || Array.isArray(data) || typeof data !== 'object') throw new Error('notobject');
    } catch (_) { diagnostics.push({ code: 'third_party_json_unparseable', column: 23, detail: '附加第三方字段不能按JSON对象解码，完整原文保留，不自动改变主交易状态。' }); }
  }
  const source_loc = String(coordinate);
  const derivation = { money: money.derivation, time_column: '交易时间', time_fallback: false,
    account_identity_policy: approved ? policy.accountIdentityPolicy ?? null : null,
    account_identity_type: acct_no === null ? null : 'platform_user_id_raw',
    business_status_policy: 'not_available', receiver_amount_policy: approved ? policy.receiverAmountPolicy ?? null : null,
    balance_policy: approved ? policy.balancePolicy ?? null : null, balance_scope: 'unknown',
    amount_column: 9, receiver_amount_column: 25, original_column_count: 27, supplementary_diagnostics: diagnostics };
  return { source_loc, raw_values: [...values], raw_fields: positionalFields(values), raw_field_entries: fieldEntries(values),
    raw_record: JSON.stringify({ format_key: FORMAT_KEY, source_loc, values }),
    raw_amount_text: values[8], raw_direction: values[4], raw_currency_text: null, txn_time_text: values[7], raw_balance_text: values[9],
    trade_no: values[1], order_no: values[2], acct_no, acct_name: null, account_name_text: values[3],
    peer_acct: null, peer_name: null, peer_info: values[14], peer_name_text: values[15],
    user_bank_card_text: values[10], peer_bank_card_text: values[16], user_bank_link_id: values[11], peer_bank_link_id: values[18],
    receiver_time_text: values[23], receiver_amount_text: values[24],
    summary: values[6], remark: values[25], txn_type: values[5], business_status: null,
    amount: money.amount, direction: money.direction, currency: money.currency,
    currency_evidence: { iso: 'raw_iso', approved_map: 'approved_map', verified_cny: 'verified_cny', unknown: 'unknown' }[money.derivation.currency.source] ?? 'unknown',
    reversal_flag: money.reversal_flag, txn_time, balance, balance_scope: 'unknown',
    status: reasons.length ? 'pending' : 'confirmed', pendingReasons: reasons, reasons, diagnostics, derivation };
}

function parseWechatTradesBytes(bytes, options = {}) {
  validateBinding(options.rule);
  const parsed = structure(bytes, options), rule = structuredClone(options.rule), policy = structuredClone(options.policy ?? {});
  async function* rows() {
    for (let index = 1; index < parsed.records.length; index++) {
      if (index % 250 === 0) await new Promise(resolve => setImmediate(resolve));
      abort(options.signal);
      yield rowResult(parsed.records[index], index + 1, rule, policy);
    }
  }
  return { metadata: parsed.metadata, rows: rows() };
}

async function readBytes(filePath, options = {}) {
  const cap = limits(options.maxBytes);
  try {
    abort(options.signal);
    const initial = fs.lstatSync(filePath, { bigint: true });
    if (!initial.isFile() || initial.isSymbolicLink()) fail('FS_FORMAT_SOURCE', '请选择普通归档文件。');
    if (initial.size > BigInt(cap)) fail('FS_FORMAT_TOO_LARGE', '本次技术预览只支持不超过64MiB的单个文件。');
    const chunks = []; let size = 0;
    const stream = fs.createReadStream(filePath, { highWaterMark: 65536, signal: options.signal });
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > cap) { stream.destroy(); fail('FS_FORMAT_TOO_LARGE', '文件读取期间超过本版大小上限。'); }
      chunks.push(chunk);
    }
    const final = fs.lstatSync(filePath, { bigint: true });
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => initial[key] !== final[key]) || final.isSymbolicLink() || BigInt(size) !== initial.size) {
      fail('FS_FORMAT_IDENTITY', '文件读取期间发生变化，请重新核对归档身份。');
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error.code?.startsWith('FS_')) throw error;
    if (error.name === 'AbortError') fail('FS_USER_CANCELLED', '已取消文件读取，未发布导入结果。');
    fail('FS_FORMAT_SOURCE', '无法读取本次归档文件，请检查文件身份与访问权限。');
  }
}
async function openWechatTrades(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath === '') fail('FS_FORMAT_INPUT', '需要明确的归档文件路径。');
  const parsed = parseWechatTradesBytes(await readBytes(filePath, options), options);
  parsed.metadata.fileName = path.basename(filePath);
  return parsed;
}
async function readWechatTradeSource(filePath, sourceLoc, options = {}) {
  if (typeof sourceLoc !== 'string' || !/^[1-9]\d{0,8}(?![\s\S])/.test(sourceLoc)) fail('FS_SOURCE_COORDINATE', '来源坐标必须是TXT记录号。');
  const parsed = structure(await readBytes(filePath, options), options), index = Number(sourceLoc) - 1;
  if (index < 1 || index >= parsed.records.length) fail('FS_SOURCE_COORDINATE', '来源坐标不在本文件的数据记录范围内。');
  const values = parsed.records[index];
  return { metadata: parsed.metadata, source_loc: sourceLoc, values: [...values], fields: positionalFields(values), fieldEntries: fieldEntries(values) };
}
module.exports = { FORMAT_KEY, PARSER_VERSION, MAX_BYTES, HEADERS, parseWechatTradesBytes, openWechatTrades, readWechatTradeSource };
