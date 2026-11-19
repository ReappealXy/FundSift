'use strict';

// A concrete CSV structure adapter, not a platform-wide Alipay parser.
// Structural constants are not an approved business rule. Approval and the
// executable money configuration are supplied by the caller for every import.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { INT64_MAX, normalizeMoney, parseMinor, validateMoneyRule } = require('./money.cjs');

const FORMAT_KEY = 'alipay-account-17col-v1';
const MAX_BYTES = 64 * 1024 * 1024;
const HEADERS = Object.freeze(['交易号', '商户订单号', '交易创建时间', '付款时间', '最近修改时间', '交易来源地', '类型',
  '用户信息', '交易对方信息', '消费名称', '金额（元）', '收/支', '交易状态', '支付方式', '清算流水号', '备注', '对应的协查数据']);
const SUCCESS = new Set(['转账成功', '交易成功可以退款', '交易成功']);
const CLOSED = '交易中途关闭（未完成）';
const BALANCE_TO_YUEBAO = '交换产品-余额实时转余额宝成功';
const own = (value, key) => Object.hasOwn(value, key);
const blank = value => value === null || value === undefined || typeof value === 'string' && value.trim() === '';
const abort = signal => { if (signal?.aborted) fail('FS_USER_CANCELLED', '已取消文件读取，未发布导入结果。'); };
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

function limits(maxBytes) {
  const result = maxBytes ?? MAX_BYTES;
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_BYTES) fail('FS_FORMAT_INPUT', '本格式文件大小上限必须介于1字节和64MiB之间。');
  return result;
}

function decode(bytes) {
  const utf8 = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (bytes.length >= 2 && (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff)) {
    fail('FS_FORMAT_ENCODING', '本结构只支持已明确的GB18030无BOM或UTF-8有BOM编码。');
  }
  try {
    const encoding = utf8 ? 'utf-8' : 'gb18030';
    const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(utf8 ? bytes.subarray(3) : bytes);
    if (text.includes('\0')) fail('FS_FORMAT_ENCODING', '文件含不支持的空字符，不能按本结构解码。');
    return { text, encoding, bom: utf8 };
  } catch (error) {
    if (error.code === 'FS_FORMAT_ENCODING') throw error;
    fail('FS_FORMAT_ENCODING', '文件不能按明确的来源编码无损解码。');
  }
}

// Strict comma/double-quote CSV with preserved field contents. CRLF and LF are
// record boundaries only outside quotes. A trailing terminator is not a row;
// an actual blank record is retained and subsequently rejected as wrong-width.
function parseCSV(text) {
  const records = [];
  let row = [], field = '', mode = 'start', begun = false;
  function finishField() {
    if (row.length >= HEADERS.length) fail(records.length ? 'FS_FORMAT_STRUCTURE' : 'FS_FORMAT_UNSUPPORTED', 'CSV逻辑记录超过本结构支持的17列。');
    row.push(field); field = ''; mode = 'start';
  }
  function finishRecord() {
    finishField();
    if (!records.length && (row.length !== HEADERS.length || !HEADERS.every((value, index) => row[index] === value))) {
      fail('FS_FORMAT_UNSUPPORTED', '表头与已支持的17列支付宝账户明细结构不一致。');
    }
    if (records.length && (row.length !== HEADERS.length || row.every(value => value.trim() === ''))) {
      fail('FS_FORMAT_STRUCTURE', `逻辑记录${records.length + 1}为空或列数不符，整份文件不能发布。`);
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
    if (char === ',' || char === '\n' || char === '\r') {
      if (char === ',') { finishField(); begun = true; }
      else {
        if (char === '\r') {
          if (text[index + 1] !== '\n') fail('FS_FORMAT_CSV', 'CSV记录边界必须为CRLF或LF，不能猜测裸CR。');
          index++;
        }
        finishRecord();
      }
    } else if (mode === 'closed') fail('FS_FORMAT_CSV', 'CSV闭合引号后出现了非分隔文本。');
    else if (char === '"') {
      if (mode !== 'start') fail('FS_FORMAT_CSV', 'CSV非引号字段内出现了引号。');
      mode = 'quoted'; begun = true;
    } else { field += char; mode = 'plain'; begun = true; }
  }
  if (mode === 'quoted') fail('FS_FORMAT_CSV', 'CSV引号字段未闭合。');
  if (begun || row.length || field !== '' || mode === 'closed') finishRecord();
  return records;
}

function structure(bytes, options = {}) {
  const maxBytes = limits(options.maxBytes);
  if (!Buffer.isBuffer(bytes)) fail('FS_FORMAT_INPUT', '解析入口需要文件字节Buffer。');
  if (bytes.length > maxBytes) fail('FS_FORMAT_TOO_LARGE', '本次技术预览只支持不超过64MiB的单个文件。');
  abort(options.signal);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (options.expectedSha256 !== undefined && (!/^[a-f0-9]{64}(?![\s\S])/.test(options.expectedSha256) || options.expectedSha256 !== sha256)) {
    fail('FS_FORMAT_IDENTITY', '文件字节与预期归档身份不一致。');
  }
  const decoded = decode(bytes), records = parseCSV(decoded.text);
  if (!records.length || records[0].length !== HEADERS.length || !HEADERS.every((value, index) => records[0][index] === value)) {
    fail('FS_FORMAT_UNSUPPORTED', '表头与已支持的17列支付宝账户明细结构不一致。');
  }
  if (records.length === 1) fail('FS_FORMAT_EMPTY', '文件只有表头，没有可导入数据记录。');
  for (let index = 1; index < records.length; index++) {
    if (records[index].length !== HEADERS.length || records[index].every(value => value.trim() === '')) {
      fail('FS_FORMAT_STRUCTURE', `逻辑记录${index + 1}为空或列数不符，整份文件不能发布。`);
    }
  }
  return { records, metadata: { formatKey: FORMAT_KEY, encoding: decoded.encoding, bom: decoded.bom,
    sha256, sizeBytes: bytes.length.toString(), headerRecordCount: 1, dataRecordCount: records.length - 1,
    nonDataRecordCount: 1, columns: [...HEADERS] } };
}

function validateBinding(rule) {
  validateMoneyRule(rule);
  const keys = Object.keys(rule.direction_map);
  if (rule.amount_expr !== 'E' || rule.source_unit !== '元' || rule.unit_scale !== 100 || rule.negative_policy !== 'pending' ||
      rule.zero_policy !== 'pending' || keys.length !== 2 || rule.direction_map.收入 !== '进' || rule.direction_map.支出 !== '出') {
    fail('FS_FORMAT_RULE', '此17列结构只接受已声明的E类元金额、精确收支词表和异常待核政策。');
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

// Evidence classification is deliberately separate from localTimestamp. A
// detected marker never makes a timestamp parseable and is never converted.
// These fixed meanings follow the approved time-evidence contract, without
// calling the independent G0 checker or accepting additional local formats.
function invalidTimeReason(text) {
  const ambiguousWords = new Set(['CST', 'IST', 'EST', 'PST', 'BST', 'AST', 'GST', 'MST']);
  const zoneWords = new Set(['UTC', 'GMT', 'JST', 'KST', 'HKT', 'SGT', 'AEST', 'AEDT', 'CET', 'CEST', 'MSK']);
  const clocks = [];
  for (const match of text.matchAll(/(?<![0-9:])[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?![0-9:])/g)) {
    const prefix = /([0-9]{4}[-/][0-9]{2}[-/][0-9]{2})(T|\s+)$/i.exec(text.slice(0, match.index));
    clocks.push({ start: prefix ? prefix.index : match.index, end: match.index + match[0].length,
      clock: match[0], date: Boolean(prefix), iso: prefix?.[2].toUpperCase() === 'T' });
  }
  for (let index = 1; index < clocks.length; index++) {
    const left = clocks[index - 1], right = clocks[index];
    const separator = text.slice(left.end, right.start);
    if (!/^\s*[-–—~～至到]\s*$/.test(separator)) continue;
    // A compact dateTclock-HH:mm is the approved explicit-offset spelling.
    const isoOffset = left.iso && separator === '-' && !right.date && /^[0-9]{2}:[0-9]{2}$/.test(right.clock) &&
      !/[A-Za-z0-9_:.]/.test(text[right.end] || '');
    if (!isoOffset) return 'time_ambiguous';
  }
  const words = [];
  for (const match of text.matchAll(/[A-Za-z]+/g)) {
    if (/[A-Za-z0-9_]/.test(text[match.index - 1] || '') || /[A-Za-z0-9_]/.test(text[match.index + match[0].length] || '')) continue;
    const word = match[0].toUpperCase();
    if (ambiguousWords.has(word)) return 'time_ambiguous';
    if (zoneWords.has(word)) words.push({ index: match.index });
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
  return policy?.review?.status === 'approved' && ['by', 'at', 'reason'].every(key => typeof policy.review[key] === 'string' && policy.review[key].trim() !== '');
}

function recordedTransferAmount(text, money, add) {
  if (money.currency !== 'CNY' || blank(text) || money.reasons.some(reason => reason.reason_code === 'amount_unparseable')) return null;
  const { value, rounded } = parseMinor(text, '元');
  if (text.trimStart().startsWith('-')) {
    add('sign_semantics_undefined', '内部划转原文金额有负号，划转金额仍待核。');
  } else if (rounded) {
    add('amount_transfer_precision', '内部划转原文金额无法无损换算为整数分，划转金额仍待核。');
  } else if (value === 0n) {
    add('zero_rule_undefined', '内部划转原文金额为零，划转金额仍待核。');
  } else if (value > INT64_MAX) {
    add('amount_out_of_range', '内部划转原文金额超出有符号 64 位整数范围。');
  } else {
    return value.toString();
  }
  return null;
}

function internalTransfer(values, acctNo, money, add) {
  const [, , , , , , transactionType, owner, peer, summary, amount, direction, status, paymentMethod] = values;
  if (status !== BALANCE_TO_YUEBAO || direction !== '其它' || transactionType !== '即时到账交易' ||
      paymentMethod !== '余额' || summary.replace(/^\t/, '') !== '余额宝-自动转入' || acctNo === null || owner !== peer) return null;
  // A complete original identifier and its account name must match across both parties.
  const identity = /^\t?[0-9]+\(([^()\r\n\t]+)\)(?![\s\S])/u.exec(owner);
  if (!identity || blank(identity[1])) return null;
  return {
    kind: 'balance_to_yuebao', account_change: true, economic_inclusion: false,
    amount_minor: recordedTransferAmount(amount, money, add),
    evidence: { status, transaction_type: transactionType, summary, payment_method: paymentMethod, same_original_identity: true }
  };
}

function rowResult(values, coordinate, rule, policy) {
  const raw_fields = Object.fromEntries(HEADERS.map((name, index) => [name, values[index]]));
  const money = normalizeMoney({ raw_amount_text: values[10], raw_direction: values[11], currency_text: null }, rule);
  const reasons = money.reasons.map(reason => ({ ...reason }));
  const add = (reason_code, detail) => { if (!reasons.some(reason => reason.reason_code === reason_code)) reasons.push({ reason_code, detail }); };
  const approved = policyApproved(policy);
  let txn_time = null, acct_no = null;
  if (!approved || policy.timeColumn !== '付款时间') add('time_policy_unapproved', '付款时间取值政策尚未批准，不回退其它时间列。');
  else if (blank(values[3])) add('time_missing', '付款时间缺失，不能用创建或修改时间补位。');
  else {
    txn_time = localTimestamp(values[3]);
    if (txn_time === null) {
      add(invalidTimeReason(values[3]),
        '付款时间不是本格式明确的完整本地时间，保留原文并待核，不转换时区或取区间端点。');
    }
  }
  if (!approved || policy.accountIdentityPolicy !== 'raw_platform_info') {
    add('account_identity_policy_unapproved', '本方复合用户信息的标识政策尚未批准。');
    add('account_missing', '标准本方标识尚未确定，原始用户信息完整保留。');
  } else if (blank(values[7])) add('account_missing', '原始用户信息缺失，不能按姓名或其它账号补位。');
  else acct_no = values[7];
  const transferPolicyApproved = approved && policy.businessStatusPolicy === 'exact_v2' &&
    rule.rule_version === 2 && rule.business_status_policy === 'exact_v2' && policyApproved(rule);
  const transfer = transferPolicyApproved ? internalTransfer(values, acct_no, money, add) : null;
  if (!(approved && policy.businessStatusPolicy === 'exact_v1') && !transferPolicyApproved) {
    add('business_status_policy_unapproved', '业务状态政策尚未批准，不能按成功字样确认。');
  }
  else if (values[12] === CLOSED) add('business_status_closed', '原始状态为交易关闭或未完成，保留该行但不计入已确认收付。');
  else if (!transfer && !SUCCESS.has(values[12])) add('business_status_unknown', '原始业务状态不在本格式已批准的精确成功词表中。');
  const source_loc = coordinate.toString();
  const derivation = { money: money.derivation, time_column: '付款时间', time_fallback: false,
    account_identity_policy: approved ? policy.accountIdentityPolicy ?? null : null,
    account_identity_type: acct_no === null ? null : 'platform_user_info_raw',
    business_status_policy: approved ? policy.businessStatusPolicy ?? null : null,
    ...(transfer ? { internal_transfer: transfer } : {}) };
  return {
    source_loc, raw_values: [...values], raw_fields,
    raw_record: JSON.stringify({ format_key: FORMAT_KEY, source_loc, values }),
    raw_amount_text: values[10], raw_direction: values[11], raw_currency_text: null, txn_time_text: values[3],
    created_time_text: values[2], modified_time_text: values[4],
    trade_no: values[0], order_no: values[1], acct_no, acct_name: null, peer_acct: null, peer_name: null, peer_info: values[8],
    summary: values[9], remark: values[15], business_status: values[12],
    amount: money.amount, direction: money.direction, currency: money.currency,
    currency_evidence: { iso: 'raw_iso', approved_map: 'approved_map', verified_cny: 'verified_cny', unknown: 'unknown' }[money.derivation.currency.source] ?? 'unknown',
    reversal_flag: money.reversal_flag, txn_time, balance: null, balance_scope: 'unknown',
    status: reasons.length ? 'pending' : 'confirmed', pendingReasons: reasons, reasons, derivation
  };
}

function parseAlipayAccountBytes(bytes, options = {}) {
  validateBinding(options.rule);
  const parsed = structure(bytes, options);
  // Take immutable input snapshots so a caller cannot change a rule halfway
  // through yielding a single import. This copy does not approve or freeze it.
  const rule = structuredClone(options.rule), policy = structuredClone(options.policy ?? {});
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
  let initial, stream;
  try {
    abort(options.signal);
    initial = fs.lstatSync(filePath, { bigint: true });
    if (!initial.isFile() || initial.isSymbolicLink()) fail('FS_FORMAT_SOURCE', '请选择普通归档文件。');
    if (initial.size > BigInt(cap)) fail('FS_FORMAT_TOO_LARGE', '本次技术预览只支持不超过64MiB的单个文件。');
    const chunks = []; let size = 0;
    stream = fs.createReadStream(filePath, { highWaterMark: 65536, signal: options.signal });
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > cap) { stream.destroy(); fail('FS_FORMAT_TOO_LARGE', '文件读取期间超过本版大小上限。'); }
      chunks.push(chunk);
    }
    const final = fs.lstatSync(filePath, { bigint: true });
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => final[key] !== initial[key]) || final.isSymbolicLink() || BigInt(size) !== initial.size) {
      fail('FS_FORMAT_IDENTITY', '文件读取期间发生变化，请重新核对归档身份。');
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error.code?.startsWith('FS_')) throw error;
    if (error.name === 'AbortError') fail('FS_USER_CANCELLED', '已取消文件读取，未发布导入结果。');
    fail('FS_FORMAT_SOURCE', '无法读取本次归档文件，请检查文件身份与访问权限。');
  }
}

async function openAlipayAccount(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath === '') fail('FS_FORMAT_INPUT', '需要明确的归档文件路径。');
  const parsed = parseAlipayAccountBytes(await readBytes(filePath, options), options);
  parsed.metadata.fileName = path.basename(filePath);
  return parsed;
}

async function readAlipayRecordByCoordinate(filePath, sourceLoc, options = {}) {
  if (typeof sourceLoc !== 'string' || !/^[1-9]\d{0,8}(?![\s\S])/.test(sourceLoc)) fail('FS_SOURCE_COORDINATE', '来源坐标必须是CSV逻辑记录号。');
  const parsed = structure(await readBytes(filePath, options), options), index = Number(sourceLoc) - 1;
  if (index < 1 || index >= parsed.records.length) fail('FS_SOURCE_COORDINATE', '来源坐标不在本文件的数据记录范围内。');
  const values = parsed.records[index];
  return { metadata: parsed.metadata, source_loc: sourceLoc, values: [...values],
    fields: Object.fromEntries(HEADERS.map((name, position) => [name, values[position]])) };
}

module.exports = { FORMAT_KEY, MAX_BYTES, HEADERS, parseAlipayAccountBytes, openAlipayAccount, readAlipayRecordByCoordinate };
