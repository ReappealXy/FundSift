'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { FORMAT_KEY, PARSER_VERSION, MAX_BYTES, HEADERS, parseWechatTradesBytes, openWechatTrades, readWechatTradeSource } = require('../wechat-trades.cjs');

function rule(extra = {}) {
  return { id: 1, rule_version: 1, amount_expr: 'E', source_unit: '分', unit_scale: 1,
    rounding_rule: 'ROUND_HALF_UP', direction_map: { 入: '进', 出: '出' }, negative_policy: 'pending', zero_policy: 'pending',
    zero_direction: null, currency_policy: 'verified_cny', currency_map: {}, balance_scope: 'unknown', balance_same_direction: false,
    review: { status: 'approved', by: '合成审核人', at: '2026-11-19', reason: '仅合成测试' }, ...extra };
}
function policy(extra = {}) {
  return { timeColumn: '交易时间', accountIdentityPolicy: 'raw_platform_user_id', receiverAmountPolicy: 'mismatch_pending',
    balancePolicy: 'preserve_unknown', review: { status: 'approved', by: '合成审核人', at: '2026-11-19', reason: '仅合成测试' }, ...extra };
}
function values(extra = {}) {
  const row = [' user-0001 ', '000000000000000001', 'large-order-1', '合成名称', '出', '快捷支付', '消费',
    '2026-02-28 12:34:56', '101', '0', '0000000000000001', 'bank-link', '网联', '本方第三方原文',
    'peer-0001', '对手合成名称', '0000000000000002', '合成银行', 'peer-link', '银联', '', '非间连交易',
    '{"type":"synthetic","name":"different third-party"}', '2026-03-01 12:00:00', '', '备注一', '\u200c\u200e\u202a\u202c备注二'];
  for (const [index, value] of Object.entries(extra)) row[Number(index)] = value;
  return row;
}
function bytes(rows = [values()], header = HEADERS, newline = '\r\n') {
  const field = value => /["\t\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
  return Buffer.from([header, ...rows].map(row => row.map(field).join('\t')).join(newline) + newline, 'utf8');
}
async function collect(data = bytes(), options = {}) {
  const parsed = parseWechatTradesBytes(data, { rule: rule(), policy: policy(), ...options }), rows = [];
  for await (const row of parsed.rows) rows.push(row);
  return { metadata: parsed.metadata, rows };
}
const codes = row => row.pendingReasons.map(reason => reason.reason_code);

test('微信27列按位置保留同名字段、全部原文和双向控制字符', async () => {
  const original = values(), { metadata, rows: [row] } = await collect(bytes([original]));
  assert.equal(metadata.formatKey, FORMAT_KEY); assert.equal(metadata.parserVersion, PARSER_VERSION);
  assert.equal(metadata.encoding, 'utf-8'); assert.equal(metadata.bom, false);
  assert.equal(metadata.dataRecordCount, 1); assert.equal(metadata.headerRecordCount, 1); assert.equal(metadata.nonDataRecordCount, 1);
  assert.deepEqual(metadata.columns, HEADERS); assert.equal(metadata.fieldKeys.length, 27);
  assert.deepEqual(row.raw_values, original); assert.deepEqual(JSON.parse(row.raw_record).values, original);
  assert.equal(Object.keys(row.raw_fields).length, 27); assert.equal(row.raw_fields.column_14, original[13]);
  assert.equal(row.raw_fields.column_23, original[22]); assert.equal(row.raw_field_entries[13].header, row.raw_field_entries[22].header);
  assert.notEqual(row.raw_field_entries[13].value, row.raw_field_entries[22].value);
  assert.equal(row.raw_fields.column_27, original[26]); assert.equal(row.source_loc, '2');
});

test('批准政策下主额整数分不乘百，入进出出，平台ID与卡号分开', async () => {
  const output = await collect(bytes([values(), values({ 4: '入', 8: '9007199254740993', 9: '9007199254740993' })]));
  const [out, incoming] = output.rows;
  assert.equal(out.amount, '-101'); assert.equal(out.direction, '出'); assert.equal(out.status, 'confirmed');
  assert.equal(incoming.amount, '9007199254740993'); assert.equal(incoming.direction, '进');
  assert.equal(incoming.balance, '9007199254740993'); assert.equal(incoming.balance_scope, 'unknown');
  assert.equal(out.acct_no, values()[0]); assert.equal(out.acct_name, null); assert.equal(out.peer_acct, null);
  assert.equal(out.user_bank_card_text, values()[10]); assert.equal(out.peer_bank_card_text, values()[16]);
  assert.equal(out.txn_time, values()[7]); assert.equal(out.raw_balance_text, '0'); assert.equal(out.balance, '0');
  assert.equal(out.currency, 'CNY'); assert.equal(out.currency_evidence, 'verified_cny');
  assert.equal(out.derivation.business_status_policy, 'not_available'); assert.equal(out.derivation.money.unit_scale, 1);
});

test('重复交易号、同秒同额、完全相同源行都按来源坐标保留', async () => {
  const same = values();
  const result = await collect(bytes([same, values({ 6: '手续费', 8: '1' }), same]));
  assert.equal(result.rows.length, 3); assert.deepEqual(result.rows.map(row => row.source_loc), ['2', '3', '4']);
  assert.ok(result.rows.every(row => row.trade_no === same[1]));
  assert.notEqual(result.rows[0].raw_record, result.rows[2].raw_record);
});

test('LF边界、末空字段、标准TSV转义后的嵌套JSON与引号无损', async () => {
  const original = values({ 3: '"合成名称"', 22: '{"a":"b,c"}', 26: '' });
  const result = await collect(bytes([original], HEADERS, '\n'));
  assert.deepEqual(result.rows[0].raw_values, original); assert.equal(result.rows[0].raw_fields.column_27, '');
});

test('带TAB和换行的引号字段保留完整原文，来源坐标按逻辑记录计数', async () => {
  const first = values({ 22: '{"a":"b"}', 26: '第一行\t内容\r\n第二行' }), second = values({ 1: 'next' });
  const output = await collect(bytes([first, second]));
  assert.deepEqual(output.rows.map(row => row.source_loc), ['2', '3']); assert.deepEqual(output.rows[0].raw_values, first);
});

test('未闭引号和闭引号后杂文严格拒绝，非引号字段内部引号原样保留', async () => {
  const header = HEADERS.join('\t') + '\n';
  for (const record of ['"unclosed', '"closed"garbage']) {
    assert.throws(() => parseWechatTradesBytes(Buffer.from(header + record), { rule: rule() }), { code: 'FS_FORMAT_TSV' });
  }
  const original = values({ 3: '中"间引号' });
  const data = Buffer.from(header + original.map((value, index) => index === 3 ? value : /["\t\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value).join('\t'));
  assert.equal((await collect(data)).rows[0].account_name_text, original[3]);
});

test('整数分禁止小数、千分位、全角、加号、前导零和尾注，不舍入', async () => {
  const malformed = ['1.5', '1.0', '1,000', '１２', '+1', '001', ' 101 ', 'N/A', '101元', '-0'];
  const output = await collect(bytes(malformed.map(value => values({ 8: value }))));
  for (let n = 0; n < output.rows.length; n++) {
    const row = output.rows[n];
    assert.equal(row.amount, null, malformed[n]); assert.equal(row.status, 'pending');
    assert.ok(codes(row).includes('amount_unparseable'), malformed[n]);
    assert.equal(row.raw_amount_text, malformed[n]); assert.equal(row.derivation.money.rounding.length, 0);
  }
});

test('负主额、零额、缺金额和未知方向有独立原因，不静默取绝对值', async () => {
  const output = await collect(bytes([values({ 8: '-101' }), values({ 8: '0' }), values({ 8: '' }), values({ 4: '收入' }), values({ 4: '' })]));
  assert.equal(output.rows[0].amount, null); assert.ok(codes(output.rows[0]).includes('sign_semantics_undefined'));
  assert.equal(output.rows[1].amount, '0'); assert.ok(codes(output.rows[1]).includes('zero_rule_undefined'));
  assert.ok(codes(output.rows[2]).includes('amount_missing')); assert.ok(codes(output.rows[3]).includes('direction_unknown'));
  assert.ok(codes(output.rows[4]).includes('direction_missing')); assert.ok(output.rows.every(row => row.status === 'pending'));
});

test('精确int64边界：出2^63可存最小值，入2^63越界待核', async () => {
  const output = await collect(bytes([values({ 8: '9223372036854775808' }), values({ 4: '入', 8: '9223372036854775808' }), values({ 8: '9223372036854775809' })]));
  assert.equal(output.rows[0].amount, '-9223372036854775808'); assert.equal(output.rows[0].status, 'confirmed');
  assert.equal(output.rows[1].amount, null); assert.ok(codes(output.rows[1]).includes('amount_out_of_range'));
  assert.equal(output.rows[2].amount, null); assert.ok(codes(output.rows[2]).includes('amount_out_of_range'));
});

test('接收金额差异单独待核，主时间主金额不回退接收字段', async () => {
  const output = await collect(bytes([values({ 24: '101' }), values({ 24: '100' }), values({ 24: 'bad' }),
    values({ 24: '-101' }), values({ 7: '', 8: '', 24: '101' })]));
  assert.equal(output.rows[0].status, 'confirmed'); assert.equal(output.rows[0].receiver_amount_text, '101');
  assert.equal(output.rows[1].amount, '-101'); assert.deepEqual(codes(output.rows[1]), ['receiver_amount_mismatch']);
  assert.ok(codes(output.rows[2]).includes('receiver_amount_unparseable')); assert.ok(codes(output.rows[3]).includes('receiver_amount_unparseable'));
  assert.equal(output.rows[4].amount, null); assert.equal(output.rows[4].txn_time, null);
  assert.ok(codes(output.rows[4]).includes('amount_missing')); assert.ok(codes(output.rows[4]).includes('time_missing'));
});

test('附加JSON失败与未知余额解析失败只记补充诊断，不自动改主交易状态', async () => {
  const output = await collect(bytes([values({ 22: '{bad', 9: 'not-a-balance' }), values({ 9: '9223372036854775808' })]));
  assert.ok(output.rows.every(row => row.status === 'confirmed' && row.amount === '-101' && row.balance === null));
  assert.deepEqual(output.rows[0].diagnostics.map(d => d.code), ['balance_unparseable', 'third_party_json_unparseable']);
  assert.equal(output.rows[0].raw_fields.column_23, '{bad'); assert.equal(output.rows[0].raw_balance_text, 'not-a-balance');
  assert.deepEqual(output.rows[0].derivation.supplementary_diagnostics, output.rows[0].diagnostics);
});

test('退款和手续费用途不自动翻向、抵消或并入原笔', async () => {
  const output = await collect(bytes([values({ 6: '退款', 4: '入' }), values({ 6: '手续费', 4: '出' })]));
  assert.deepEqual(output.rows.map(row => row.amount), ['101', '-101']);
  assert.ok(output.rows.every(row => row.reversal_flag === 0 && row.status === 'confirmed'));
});

test('只认完整本地日历时间，不接受小数秒、缺秒、时区或无效日期', async () => {
  const invalid = ['2026-02-29 12:00:00', '2026-02-30 12:00:00', '2026-11-19 24:00:00', '2026-11-19 12:60:00',
    '2026-11-19', '2026-11-19 08:00', '2026-11-19 08:00:00.123', ' 2026-11-19 08:00:00',
    '2026-11-19T08:00:00Z', '2026-11-19 08:00:00+08:00', '2026-11-19 08:00:00 交易'];
  const output = await collect(bytes(invalid.map(time => values({ 7: time }))));
  assert.ok(output.rows.every(row => row.status === 'pending' && row.txn_time === null && codes(row).some(code => /^time_/.test(code))));
  const leap = (await collect(bytes([values({ 7: '2024-02-29 00:00:00' })]))).rows[0];
  assert.equal(leap.status, 'confirmed'); assert.equal(leap.txn_time, '2024-02-29 00:00:00');
});

test('带尾注时区与区间按证据记原因，缩写按多义区分且有整词边界', async () => {
  const cases = [
    ['2026-11-19T08:00:00+08:00（北京时间）', 'time_timezone'], ['2026-11-19T08:00:00-05:00 交易', 'time_timezone'],
    ['08:00-09:00（班次）', 'time_ambiguous'], ['2026-11-19 23:00至2026-11-20 01:00', 'time_ambiguous'],
    ['08:00 备注+08:00', 'time_ambiguous'], ['08:00 cst', 'time_ambiguous'], ['08:00 JST', 'time_timezone'],
    ['08:00Z', 'time_timezone'], ['08:00 Zebra', 'time_invalid'], ['08:00 BCST', 'time_invalid'], ['08:00-123456', 'time_invalid']];
  const output = await collect(bytes(cases.map(([time]) => values({ 7: time }))));
  for (let n = 0; n < cases.length; n++) assert.deepEqual(codes(output.rows[n]), [cases[n][1]], cases[n][0]);
});

test('缺本方ID不按名称、卡号或对手补位；完整非空ID不裁剪', async () => {
  const output = await collect(bytes([values({ 0: '' }), values()]));
  assert.equal(output.rows[0].acct_no, null); assert.ok(codes(output.rows[0]).includes('account_missing'));
  assert.equal(output.rows[1].acct_no, values()[0]); assert.equal(output.rows[1].account_name_text, values()[3]);
});

test('未批准规则不凭分字默认人民币，未批准policy不确认时间身份和视角', async () => {
  const output = await collect(bytes(), { rule: rule({ review: { status: 'unreviewed' }, currency_policy: 'unverified' }), policy: {} });
  const row = output.rows[0];
  assert.equal(row.status, 'pending'); assert.equal(row.currency, null); assert.equal(row.currency_evidence, 'unknown');
  assert.equal(row.txn_time, null); assert.equal(row.acct_no, null);
  for (const code of ['rule_unapproved', 'currency_missing', 'time_policy_unapproved', 'account_missing',
    'account_identity_policy_unapproved', 'receiver_amount_policy_unapproved', 'balance_policy_unapproved']) assert.ok(codes(row).includes(code), code);
});

test('approve字样缺审核信息不足以启用policy', async () => {
  const row = (await collect(bytes(), { policy: policy({ review: { status: 'approved', by: '', at: 't', reason: 'r' } }) })).rows[0];
  assert.equal(row.status, 'pending'); assert.equal(row.txn_time, null); assert.equal(row.acct_no, null);
});

test('词表、单位、负数、零和余额口径不得隐式扩大', () => {
  for (const extra of [{ source_unit: '元', unit_scale: 100 }, { direction_map: { 收入: '进', 支出: '出' } },
    { direction_map: { 入: '进', 出: '出', 收入: '进' } }, { amount_expr: 'C', negative_policy: 'magnitude' },
    { zero_policy: 'confirmed', zero_direction: '进' }, { balance_scope: 'asset_ledger', balance_same_direction: true }]) {
    assert.throws(() => parseWechatTradesBytes(bytes(), { rule: rule(extra), policy: policy() }), { code: 'FS_FORMAT_RULE' });
  }
});

test('表头全序严格匹配，不猜相近格式、字段名或列数', () => {
  for (const header of [[...HEADERS].reverse(), HEADERS.map((h, n) => n === 8 ? '交易金额(元)' : h), [...HEADERS, '额外']]) {
    assert.throws(() => parseWechatTradesBytes(bytes([values()], header), { rule: rule() }), { code: 'FS_FORMAT_UNSUPPORTED' });
  }
});

test('空文件、仅表头、正文空行、重复表头和字段数错误整文件拒绝不跳行', () => {
  assert.throws(() => parseWechatTradesBytes(Buffer.alloc(0), { rule: rule() }), { code: 'FS_FORMAT_UNSUPPORTED' });
  assert.throws(() => parseWechatTradesBytes(bytes([]), { rule: rule() }), { code: 'FS_FORMAT_EMPTY' });
  for (const rows of [[values(), ['']], [values(), [...HEADERS]], [values().slice(0, 26)], [Array(27).fill('')], [[...values(), 'extra']]]) {
    assert.throws(() => parseWechatTradesBytes(bytes(rows), { rule: rule() }), { code: 'FS_FORMAT_STRUCTURE' });
  }
  assert.throws(() => parseWechatTradesBytes(Buffer.from(HEADERS.join('\t') + '\r' + values().join('\t')), { rule: rule() }), { code: 'FS_FORMAT_TSV' });
});

test('非法UTF8、各类BOM及NUL拒绝，不以替换符或编码猜测掩盖', () => {
  for (const data of [Buffer.from([0xc3, 0x28]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes()]),
    Buffer.from([0xff, 0xfe, 0x41, 0]), Buffer.from([0xfe, 0xff]), Buffer.from([0])]) {
    assert.throws(() => parseWechatTradesBytes(data, { rule: rule() }), { code: 'FS_FORMAT_ENCODING' });
  }
});

test('外部rule/policy突变不影响本次iterator规则快照', async () => {
  const config = rule(), control = policy(), parsed = parseWechatTradesBytes(bytes(), { rule: config, policy: control });
  config.direction_map.出 = '进'; control.timeColumn = '对手方接收时间'; control.accountIdentityPolicy = 'extract_digits';
  const rows = []; for await (const row of parsed.rows) rows.push(row);
  assert.equal(rows[0].amount, '-101'); assert.equal(rows[0].txn_time, values()[7]); assert.equal(rows[0].acct_no, values()[0]);
});

test('64MiB上限、身份hash和取消在产出前执行，迭代中取消也生效', async () => {
  const data = bytes();
  assert.throws(() => parseWechatTradesBytes(data, { rule: rule(), maxBytes: data.length - 1 }), { code: 'FS_FORMAT_TOO_LARGE' });
  assert.throws(() => parseWechatTradesBytes(data, { rule: rule(), maxBytes: MAX_BYTES + 1 }), { code: 'FS_FORMAT_INPUT' });
  assert.throws(() => parseWechatTradesBytes(data, { rule: rule(), expectedSha256: 'a'.repeat(64) }), { code: 'FS_FORMAT_IDENTITY' });
  const controller = new AbortController(), parsed = parseWechatTradesBytes(bytes([values(), values()]), { rule: rule(), policy: policy(), signal: controller.signal });
  assert.equal((await parsed.rows.next()).value.source_loc, '2'); controller.abort();
  await assert.rejects(parsed.rows.next(), { code: 'FS_USER_CANCELLED' });
});

test('从归档文件回源无需重解释规则，同名字段按位置返回，改字节hash失败', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fundsift-wechat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'synthetic.txt'), original = values(), data = bytes([original, values({ 1: 'second' })]);
  fs.writeFileSync(file, data); const hash = createHash('sha256').update(data).digest('hex');
  const parsed = await openWechatTrades(file, { rule: rule(), policy: policy(), expectedSha256: hash });
  assert.equal(parsed.metadata.fileName, 'synthetic.txt'); assert.equal(parsed.metadata.dataRecordCount, 2);
  const source = await readWechatTradeSource(file, '2', { expectedSha256: hash });
  assert.deepEqual(source.values, original); assert.equal(source.fields.column_14, original[13]); assert.equal(source.fields.column_23, original[22]);
  assert.equal(source.fieldEntries.length, 27); assert.equal(source.fieldEntries[22].column, 23);
  for (const coordinate of ['1', '4', '02', '2 ', '2\n', '-1']) await assert.rejects(readWechatTradeSource(file, coordinate), { code: 'FS_SOURCE_COORDINATE' });
  fs.appendFileSync(file, 'changed');
  await assert.rejects(readWechatTradeSource(file, '2', { expectedSha256: hash }), { code: 'FS_FORMAT_IDENTITY' });
});
