'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { FORMAT_KEY, MAX_BYTES, HEADERS, parseAlipayAccountBytes, openAlipayAccount, readAlipayRecordByCoordinate } = require('../alipay-account.cjs');

function rule(extra = {}) {
  return { id: 1, rule_version: 1, amount_expr: 'E', source_unit: '元', unit_scale: 100,
    rounding_rule: 'ROUND_HALF_UP', direction_map: { 收入: '进', 支出: '出' }, negative_policy: 'pending',
    zero_policy: 'pending', zero_direction: null, currency_policy: 'verified_cny', currency_map: {},
    review: { status: 'approved', by: '合成审核人', at: '2026-11-18', reason: '仅合成测试' }, ...extra };
}
function policy(extra = {}) {
  return { timeColumn: '付款时间', accountIdentityPolicy: 'raw_platform_info', businessStatusPolicy: 'exact_v1',
    review: { status: 'approved', by: '合成审核人', at: '2026-11-18', reason: '仅合成测试' }, ...extra };
}
function values(extra = {}) {
  const row = ['\t000000000000000001', 'order1', '2026-01-01 01:02:03', '2026-02-28 12:34:56', '2026-03-01 01:02:03',
    'source', 'type', '\t0000000000000001(合成身份)', '\t0000000000000002(合成对手)', '合成消费', '1.005', '支出', '转账成功', '方式', 'clear1', '备注', '协查'];
  for (const [index, value] of Object.entries(extra)) row[Number(index)] = value;
  return row;
}
function csv(rows) { return rows.map(row => row.map(value => /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value).join(',')).join('\r\n'); }
function bytes(rows = [values()], header = HEADERS) { return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv([header, ...rows]) + '\r\n')]); }
async function rows(data, options = {}) {
  const parsed = parseAlipayAccountBytes(data, { rule: rule(), policy: policy(), ...options });
  const output = [];
  for await (const row of parsed.rows) output.push(row);
  return { metadata: parsed.metadata, rows: output };
}
const codes = row => row.pendingReasons.map(reason => reason.reason_code);

test('严格UTF8 BOM结构与真实逻辑坐标，保留17原字段、前导Tab及三个原时间', async () => {
  const original = values(), output = await rows(bytes([original]));
  assert.equal(output.metadata.formatKey, FORMAT_KEY);
  assert.equal(output.metadata.encoding, 'utf-8'); assert.equal(output.metadata.bom, true);
  assert.equal(output.metadata.headerRecordCount, 1); assert.equal(output.metadata.dataRecordCount, 1); assert.equal(output.metadata.nonDataRecordCount, 1);
  const row = output.rows[0];
  assert.equal(row.source_loc, '2'); assert.deepEqual(row.raw_values, original);
  assert.deepEqual(JSON.parse(row.raw_record).values, original);
  assert.equal(row.raw_fields.用户信息, original[7]); assert.equal(row.acct_no, original[7]);
  assert.equal(row.acct_name, null); assert.equal(row.peer_acct, null); assert.equal(row.peer_info, original[8]);
  assert.equal(row.created_time_text, original[2]); assert.equal(row.txn_time_text, original[3]); assert.equal(row.modified_time_text, original[4]);
  assert.equal(row.txn_time, original[3]); assert.equal(row.amount, '-101'); assert.equal(row.direction, '出');
  assert.equal(row.currency, 'CNY'); assert.equal(row.currency_evidence, 'verified_cny'); assert.equal(row.status, 'confirmed');
  assert.equal(row.reversal_flag, 0); assert.deepEqual(row.pendingReasons, []);
});

test('GB18030无BOM按明确编码解码，不盲试UTF8', async () => {
  // Synthetic header/status/direction encoded independently using GB18030.
  const header = Buffer.from('vbvS17rFLMnMu6e2qbWlusUsvbvS17S0vajKsbzkLLi2v+7KsbzkLNfuvfzQ3rjEyrG85Cy9u9LXwLTUtLXYLMDg0M0s08O7p9DFz6IsvbvS17bUt73Qxc+iLM/7t9HD+7PGLL3wtu6jqNSqo6ksytUv1qcsvbvS19e0zKws1qe4tre9yr0sx+XL48H3y666xSyxuNeiLLbU06a1xNCtsunK/b7d', 'base64');
  const original = values({ 7: 'raw-account', 8: 'raw-peer', 9: 'item', 13: 'method', 15: 'note', 16: 'extra' });
  const encoded = original.map((value, index) => index === 11 ? Buffer.from('ytXI6w==', 'base64') : index === 12 ? Buffer.from('16rVy7PJuaY=', 'base64') : Buffer.from(value));
  const data = Buffer.concat([header, Buffer.from('\r\n'), ...encoded.flatMap((value, index) => index ? [Buffer.from(','), value] : [value]), Buffer.from('\r\n')]);
  const output = await rows(data);
  assert.equal(output.metadata.encoding, 'gb18030'); assert.equal(output.metadata.bom, false);
  assert.equal(output.rows[0].direction, '进'); assert.equal(output.rows[0].amount, '101');
});

test('严格CSV保留双引号、逗号和多行字段，逻辑record不受物理换行影响', async () => {
  const first = values({ 9: '名称,"引号"\r\n第二行', 15: '行一\n行二' }), second = values({ 0: 'second' });
  const output = await rows(bytes([first, second]));
  assert.deepEqual(output.rows.map(row => row.source_loc), ['2', '3']);
  assert.deepEqual(output.rows[0].raw_values, first);
  assert.equal(output.rows[0].raw_fields.消费名称, first[9]);
});

test('重复交易号与同秒同额按来源保留多重记录，不删行', async () => {
  const row = values(), output = await rows(bytes([row, row]));
  assert.equal(output.rows.length, 2); assert.deepEqual(output.rows.map(value => value.source_loc), ['2', '3']);
});

test('不把607写死，608条合成逻辑record得到607条数据与准确坐标', async () => {
  const output = await rows(bytes(Array.from({ length: 607 }, (_, index) => values({ 0: String(index) }))));
  assert.equal(output.metadata.dataRecordCount, 607); assert.equal(output.rows.length, 607);
  assert.equal(output.rows.at(-1).source_loc, '608');
});

test('表头严格匹配完整列序，余额明细、空格改名或多余列均不认', () => {
  for (const header of [[...HEADERS].reverse(), HEADERS.map((value, index) => index === 3 ? value + ' ' : value), [...HEADERS, '多余']]) {
    assert.throws(() => parseAlipayAccountBytes(bytes([values()], header), { rule: rule(), policy: policy() }), { code: 'FS_FORMAT_UNSUPPORTED' });
  }
});

test('空文件、仅表头、空record与列数错误都整文件失败，不跳行', () => {
  assert.throws(() => parseAlipayAccountBytes(Buffer.alloc(0), { rule: rule() }), { code: 'FS_FORMAT_UNSUPPORTED' });
  assert.throws(() => parseAlipayAccountBytes(bytes([]), { rule: rule() }), { code: 'FS_FORMAT_EMPTY' });
  for (const invalid of [[values(), ['']], [values(), values().slice(0, 16)], [Array(17).fill('')]]) {
    assert.throws(() => parseAlipayAccountBytes(bytes(invalid), { rule: rule() }), { code: 'FS_FORMAT_STRUCTURE' });
  }
});

test('CSV未闭合、裸引号、闭引号后文本、裸CR均明确报错', () => {
  const header = HEADERS.join(',') + '\n';
  for (const body of ['"unclosed', 'a"bad,b', '"closed"x,b', 'field\rnext']) {
    const data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(header + body)]);
    assert.throws(() => parseAlipayAccountBytes(data, { rule: rule() }), { code: 'FS_FORMAT_CSV' });
  }
});

test('错误编码、UTF16与NUL不以替换字符掩盖', () => {
  for (const data of [Buffer.from([0xef, 0xbb, 0xbf, 0xc3, 0x28]), Buffer.from([0x81]), Buffer.from([0xff, 0xfe, 0x41, 0]), Buffer.from([0])]) {
    assert.throws(() => parseAlipayAccountBytes(data, { rule: rule() }), { code: 'FS_FORMAT_ENCODING' });
  }
});

test('付款时间缺失时不回退创建或修改时间，关闭状态另保留原因', async () => {
  const output = await rows(bytes([values({ 3: '', 12: '交易中途关闭（未完成）' })]));
  const row = output.rows[0];
  assert.equal(row.txn_time, null); assert.equal(row.amount, '-101'); assert.equal(row.status, 'pending');
  assert.deepEqual(codes(row).sort(), ['business_status_closed', 'time_missing']);
  assert.equal(row.created_time_text, '2026-01-01 01:02:03');
});

test('完整本地时间严格calendar验证，时区、区间、备注与日期不转换', async () => {
  const invalid = ['2026-02-29 12:00:00', '2026-02-30 12:00:00', '2026-11-18 24:00:00', '2026-11-18',
    '2026-11-18T08:00:00Z', '2026-11-18 08:00:00+08:00', '2026-11-18 08:00-09:00（班次）',
    '2026-11-18 08:00:00 CST', '2026-11-18 08:00:00 交易', ' 2026-11-18 08:00:00'];
  const output = await rows(bytes(invalid.map(time => values({ 3: time }))));
  assert.ok(output.rows.every(row => row.txn_time === null && row.status === 'pending' && codes(row).some(code => ['time_invalid', 'time_ambiguous', 'time_timezone'].includes(code))));
  const leap = await rows(bytes([values({ 3: '2024-02-29 00:00:00' })]));
  assert.equal(leap.rows[0].txn_time, '2024-02-29 00:00:00');
});

test('明确时间标记保持null并给time_timezone，不误称区间或普通非法时间', async () => {
  const marked = ['2026-11-18T08:00:00+08:00（北京时间）', '2026-11-18 08:00:00+08:00 交易',
    '2026-11-18T08:00:00-05:00 交易', '2026-11-18 08:00:00+08', '08:00Z', '08:00 Z',
    ...['UTC', 'GMT', 'JST', 'KST', 'HKT', 'SGT', 'AEST', 'AEDT', 'CET', 'CEST', 'MSK'].map(word => `2026-11-18 08:00:00 ${word}`)];
  const output = await rows(bytes(marked.map(time => values({ 3: time }))));
  for (let index = 0; index < output.rows.length; index++) {
    const row = output.rows[index];
    assert.equal(row.txn_time, null, marked[index]); assert.equal(row.status, 'pending');
    assert.deepEqual(codes(row), ['time_timezone'], marked[index]);
  }
});

test('区间含尾注优先判歧义，空格负偏移和非紧邻token不擅自解释', async () => {
  const ambiguous = ['08:00-09:00', '08:00 - 09:00', '08:00至09:00', '08:00-09:00（班次）UTC',
    '2026-11-18 23:00 至 2026-11-19 01:00（跨日）', '2026-11-18 08:00:00-05:00 交易',
    '08:00 备注+08:00', '08:00 备注JST', '08:00 备注UTC'];
  const output = await rows(bytes(ambiguous.map(time => values({ 3: time }))));
  for (let index = 0; index < output.rows.length; index++) {
    assert.equal(output.rows[index].txn_time, null);
    assert.deepEqual(codes(output.rows[index]), ['time_ambiguous'], ambiguous[index]);
  }
});

test('固定多义缩写大小写不敏感且精确记time_ambiguous', async () => {
  const ambiguous = ['CST', 'IST', 'EST', 'PST', 'BST', 'AST', 'GST', 'MST', 'cst'].map(word => `08:00 ${word}`);
  const output = await rows(bytes(ambiguous.map(time => values({ 3: time }))));
  for (let index = 0; index < output.rows.length; index++) {
    assert.equal(output.rows[index].txn_time, null);
    assert.deepEqual(codes(output.rows[index]), ['time_ambiguous'], ambiguous[index]);
  }
});

test('Zebra、BCST、单号和日期不伪称时区，仍不扩展本地确认格式', async () => {
  const invalid = ['08:00 Zebra', '08:00 BCST', '08:00 CSTfoo', '08:00 _CST_', '08:00 单号123456',
    '08:00-123456', '2026-11-18', '2026-11-18 08:00', '2026-11-18T08:00:00'];
  const output = await rows(bytes(invalid.map(time => values({ 3: time }))));
  for (let index = 0; index < output.rows.length; index++) {
    assert.equal(output.rows[index].txn_time, null);
    assert.deepEqual(codes(output.rows[index]), ['time_invalid'], invalid[index]);
  }
});

test('其它方向与余额宝状态保留原行并分别待核，不猜向不并余额文件', async () => {
  const row = (await rows(bytes([values({ 11: '其它', 12: '交换产品-余额实时转余额宝成功' })]))).rows[0];
  assert.equal(row.amount, null); assert.equal(row.direction, null); assert.equal(row.status, 'pending');
  assert.deepEqual(codes(row).sort(), ['business_status_unknown', 'direction_unknown']);
  assert.equal(row.raw_amount_text, '1.005'); assert.equal(row.business_status, '交换产品-余额实时转余额宝成功');
});

test('成功状态精确词表，可退款不等于已退款，新成功字样仍待核', async () => {
  const statuses = ['转账成功', '交易成功可以退款', '交易成功', '交易成功 ', '新交易成功', ''];
  const output = await rows(bytes(statuses.map(status => values({ 12: status }))));
  assert.ok(output.rows.slice(0, 3).every(row => row.status === 'confirmed' && row.reversal_flag === 0));
  assert.ok(output.rows.slice(3).every(row => row.status === 'pending' && codes(row).includes('business_status_unknown')));
});

test('未批准规则与policy不输出伪confirmed，原始身份不拆不trim', async () => {
  const config = rule({ review: { status: 'unreviewed' }, currency_policy: 'unverified' });
  const row = (await rows(bytes(), { rule: config, policy: {} })).rows[0];
  assert.equal(row.status, 'pending'); assert.equal(row.amount, '-101'); assert.equal(row.currency, null);
  assert.equal(row.acct_no, null); assert.equal(row.txn_time, null);
  for (const reason of ['rule_unapproved', 'currency_missing', 'account_missing', 'account_identity_policy_unapproved', 'time_policy_unapproved', 'business_status_policy_unapproved']) assert.ok(codes(row).includes(reason));
  assert.equal(row.raw_fields.用户信息, values()[7]);
});

test('approved标记缺批准信息不足以启用身份/状态/时间政策', async () => {
  const row = (await rows(bytes(), { policy: policy({ review: { status: 'approved', by: '', at: 't', reason: 'r' } }) })).rows[0];
  assert.equal(row.acct_no, null); assert.equal(row.txn_time, null); assert.equal(row.status, 'pending');
});

test('缺币种证据保持unknown，账号缺失也不被非空其它字段补位', async () => {
  const row = (await rows(bytes([values({ 7: '' })]), { rule: rule({ currency_policy: 'explicit' }) })).rows[0];
  assert.equal(row.currency, null); assert.equal(row.currency_evidence, 'unknown'); assert.equal(row.acct_no, null);
  assert.deepEqual(codes(row).sort(), ['account_missing', 'currency_missing']);
});

test('金额负数/零/坏文本沿金额模块待核，不做浮点乘百', async () => {
  const output = await rows(bytes(['-1', '0', 'N/A', '90071992547409.93'].map(amount => values({ 10: amount }))));
  assert.ok(codes(output.rows[0]).includes('sign_semantics_undefined'));
  assert.ok(codes(output.rows[1]).includes('zero_rule_undefined'));
  assert.ok(codes(output.rows[2]).includes('amount_unparseable'));
  assert.equal(output.rows[3].amount, '-9007199254740993');
});

test('不接受其它类别或扩大方向/零值政策，不在adapter内批准规则', () => {
  for (const extra of [{ amount_expr: 'C', negative_policy: 'magnitude' }, { direction_map: { 收入: '进', 支出: '出', 其它: '进' } },
    { zero_policy: 'confirmed', zero_direction: '进' }, { source_unit: '分', unit_scale: 1 }]) {
    assert.throws(() => parseAlipayAccountBytes(bytes(), { rule: rule(extra), policy: policy() }), { code: 'FS_FORMAT_RULE' });
  }
});

test('iterator使用规则快照，不因外部对象随后变化而混用两版判定', async () => {
  const config = rule(), control = policy(), parsed = parseAlipayAccountBytes(bytes(), { rule: config, policy: control });
  config.direction_map.支出 = '进'; control.accountIdentityPolicy = 'extract_digits';
  const output = []; for await (const row of parsed.rows) output.push(row);
  assert.equal(output[0].amount, '-101'); assert.equal(output[0].acct_no, values()[7]);
});

test('大小上限、预期哈希与取消在任何标准行产出前生效', async () => {
  const data = bytes();
  assert.throws(() => parseAlipayAccountBytes(data, { rule: rule(), maxBytes: data.length - 1 }), { code: 'FS_FORMAT_TOO_LARGE' });
  assert.throws(() => parseAlipayAccountBytes(data, { rule: rule(), maxBytes: MAX_BYTES + 1 }), { code: 'FS_FORMAT_INPUT' });
  assert.throws(() => parseAlipayAccountBytes(data, { rule: rule(), expectedSha256: 'a'.repeat(64) }), { code: 'FS_FORMAT_IDENTITY' });
  const controller = new AbortController(), parsed = parseAlipayAccountBytes(data, { rule: rule(), policy: policy(), signal: controller.signal });
  controller.abort();
  await assert.rejects(parsed.rows.next(), { code: 'FS_USER_CANCELLED' });
});

test('从普通归档文件读取，按哈希与CSV逻辑坐标直接回源而不重新解释规则', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fundsift-alipay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'synthetic.csv'), original = values({ 9: '多行\n字段' }), data = bytes([original, values({ 0: 'second' })]);
  fs.writeFileSync(file, data); const sha256 = createHash('sha256').update(data).digest('hex');
  const parsed = await openAlipayAccount(file, { rule: rule(), policy: policy(), expectedSha256: sha256 });
  assert.equal(parsed.metadata.dataRecordCount, 2); assert.equal(parsed.metadata.fileName, 'synthetic.csv');
  const source = await readAlipayRecordByCoordinate(file, '2', { expectedSha256: sha256 });
  assert.deepEqual(source.values, original); assert.equal(source.fields.消费名称, original[9]);
  await assert.rejects(readAlipayRecordByCoordinate(file, '1'), { code: 'FS_SOURCE_COORDINATE' });
  await assert.rejects(readAlipayRecordByCoordinate(file, '4'), { code: 'FS_SOURCE_COORDINATE' });
  await assert.rejects(openAlipayAccount(file, { rule: rule(), maxBytes: 5 }), { code: 'FS_FORMAT_TOO_LARGE' });
  fs.appendFileSync(file, 'changed');
  await assert.rejects(readAlipayRecordByCoordinate(file, '2', { expectedSha256: sha256 }), { code: 'FS_FORMAT_IDENTITY' });
});
