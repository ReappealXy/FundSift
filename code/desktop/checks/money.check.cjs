'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { INT64_MIN, INT64_MAX, parseMinor, assertInt64, sumMinor, normalizeMoney, toWire } = require('../money.cjs');

function rule(expr = 'A', overrides = {}) {
  return {
    id: 'synthetic-money', rule_version: 1, amount_expr: expr, source_unit: '元', unit_scale: 100,
    rounding_rule: 'ROUND_HALF_UP', direction_map: ['B', 'C', 'E'].includes(expr) ? { 收入: '进', 支出: '出' } : {},
    negative_policy: { A: 'signed', B: 'reverse', C: 'magnitude', D: 'column_defined', E: 'pending', F: 'pending' }[expr],
    zero_policy: 'pending', zero_direction: null, currency_policy: 'explicit', currency_map: {},
    review: { status: 'approved' }, ...overrides
  };
}
function raw(overrides = {}) {
  return { raw_amount_text: '1.00', raw_income_text: null, raw_expense_text: null,
    raw_direction: '支出', currency_text: 'CNY', ...overrides };
}
const codes = result => result.reasons.map(reason => reason.reason_code);
function known(result, amount, direction, reversal = 0) {
  assert.equal(result.amount, amount);
  assert.equal(result.direction, direction);
  assert.equal(result.reversal_flag, reversal);
  assert.deepEqual(result.reasons, []);
}

test('十进制元转分：正负半分均向远离零舍入，保留尾数损失标记', () => {
  for (const [text, value, rounded] of [
    ['1.005', 101n, true], ['-1.005', -101n, true], ['1.0049', 100n, true], ['-1.0049', -100n, true],
    ['0.005', 1n, true], ['-0.005', -1n, true], ['9.999', 1000n, true], ['-9.999', -1000n, true],
    ['1.2300', 123n, false], ['0', 0n, false], ['-0.000', 0n, false]
  ]) assert.deepEqual(parseMinor(text, '元'), { value, rounded }, text);
});

test('来源为分不乘百；有小数分时仍按 HALF_UP 舍入', () => {
  assert.deepEqual(parseMinor('100', '分'), { value: 100n, rounded: false });
  assert.deepEqual(parseMinor('-1.5', '分'), { value: -2n, rounded: true });
  assert.deepEqual(parseMinor('1.49', '分'), { value: 1n, rounded: true });
});

test('十进制语法：仅接受文本及合法三位千分组，不清洗坏文本', () => {
  assert.deepEqual(parseMinor(' +1,234.50 ', '元'), { value: 123450n, rounded: false });
  assert.deepEqual(parseMinor('0001.00', '元'), { value: 100n, rounded: false });
  for (const value of [1.01, null, undefined, '', ' ', '1e3', '１.００', '￥1', '1元', 'N/A', '—',
    '1,23', '1234,567', '1,,234', '.5', '1.', '+ 1', '1 000', '1_000', 'NaN', 'Infinity']) {
    assert.throws(() => parseMinor(value, '元'), { code: 'FS_MONEY_FORMAT' }, String(value));
  }
  assert.throws(() => parseMinor('100', undefined), { code: 'FS_MONEY_UNIT' });
});

test('转换先保留任意精度，存储边界在实际方向确定后检查', () => {
  assert.equal(parseMinor('92233720368547758.08', '元').value, 9223372036854775808n);
  assert.equal(parseMinor('-92233720368547758.08', '元').value, INT64_MIN);
  assert.equal(parseMinor('9007199254740993', '分').value, 9007199254740993n);
});

test('A 类按原金额正负定方向，不被摘要或方向原文字样覆盖', () => {
  known(normalizeMoney(raw({ raw_amount_text: '-2.30', raw_direction: '收入', summary: '退款' }), rule()), '-230', '出');
  known(normalizeMoney(raw({ raw_amount_text: '+2.30', raw_direction: '支出' }), rule()), '230', '进');
});

test('B 类原支出负数是实际流入，原收入负数是实际流出', () => {
  known(normalizeMoney(raw({ raw_amount_text: '-1.34' }), rule('B')), '134', '进', 1);
  known(normalizeMoney(raw({ raw_amount_text: '-1.34', raw_direction: '收入' }), rule('B')), '-134', '出', 1);
  known(normalizeMoney(raw({ raw_amount_text: '1.34' }), rule('B')), '-134', '出');
});

test('C 类方向已表达实际方向，负号不反转', () => {
  known(normalizeMoney(raw({ raw_amount_text: '-1.34' }), rule('C')), '-134', '出');
  known(normalizeMoney(raw({ raw_amount_text: '-1.34', raw_direction: '收入' }), rule('C')), '134', '进');
});

test('D 类一列非零，另一列空或零时按所在列判向', () => {
  known(normalizeMoney(raw({ raw_income_text: '12.50', raw_expense_text: '0', raw_direction: '支出' }), rule('D')), '1250', '进');
  known(normalizeMoney(raw({ raw_income_text: null, raw_expense_text: '12.50', raw_direction: '收入' }), rule('D')), '-1250', '出');
});

test('D 类两列非零不得相减，舍入前非零也不能掩盖双列冲突', () => {
  for (const pair of [['100', '80'], ['-100', '80'], ['0.001', '0.001']]) {
    const result = normalizeMoney(raw({ raw_income_text: pair[0], raw_expense_text: pair[1] }), rule('D'));
    assert.equal(result.amount, null); assert.equal(result.direction, null);
    assert.ok(codes(result).includes('both_columns_nonzero'));
  }
});

test('D 类空列与真零分别保留未知，两列皆零也不能借零政策猜列位', () => {
  for (const pair of [[null, null], ['', '0'], ['0', '0']]) {
    const result = normalizeMoney(raw({ raw_income_text: pair[0], raw_expense_text: pair[1] }),
      rule('D', { zero_policy: 'confirmed', zero_direction: '进' }));
    assert.equal(result.amount, null); assert.equal(result.direction, null);
    assert.ok(codes(result).includes('columns_empty'));
  }
});

test('D 类任一非空坏列导致待核，不借另一列猜测或跳过', () => {
  for (const pair of [['N/A', '1'], ['1', '—'], ['１', null]]) {
    const result = normalizeMoney(raw({ raw_income_text: pair[0], raw_expense_text: pair[1] }), rule('D'));
    assert.equal(result.amount, null); assert.equal(result.direction, null);
    assert.ok(codes(result).includes('amount_unparseable'));
  }
});

test('D 类 column_defined 不是算法，缺具体负列配置时仍待核', () => {
  for (const negative_policy of ['column_defined', 'pending']) {
    const result = normalizeMoney(raw({ raw_income_text: null, raw_expense_text: '-1.00' }), rule('D', { negative_policy }));
    assert.equal(result.amount, null); assert.equal(result.direction, null);
    assert.ok(codes(result).includes('negative_column_undefined'));
  }
});

test('D 类明确反转负列：负收入转付出，负支出转收进', () => {
  const policy = { income: 'reverse', expense: 'reverse' };
  known(normalizeMoney(raw({ raw_income_text: '-2', raw_expense_text: '0' }),
    rule('D', { column_negative_policy: policy })), '-200', '出', 1);
  known(normalizeMoney(raw({ raw_income_text: '0', raw_expense_text: '-2' }),
    rule('D', { column_negative_policy: policy })), '200', '进', 1);
});

test('D 类负值按列分别声明，可保留列方向或明确待核', () => {
  const policy = { income: 'magnitude', expense: 'pending' };
  known(normalizeMoney(raw({ raw_income_text: '-2', raw_expense_text: '0' }),
    rule('D', { column_negative_policy: policy })), '200', '进');
  const result = normalizeMoney(raw({ raw_income_text: null, raw_expense_text: '-2' }), rule('D', { column_negative_policy: policy }));
  assert.equal(result.amount, null);
  assert.ok(codes(result).includes('negative_column_undefined'));
});

test('E 类正金额按方向映射；负金额不静默取绝对值或反转', () => {
  known(normalizeMoney(raw({ raw_amount_text: '6.00' }), rule('E')), '-600', '出');
  const result = normalizeMoney(raw({ raw_amount_text: '-6.00' }), rule('E'));
  assert.equal(result.amount, null); assert.equal(result.direction, null);
  assert.ok(codes(result).includes('sign_semantics_undefined'));
});

test('F 类即使原文像合法数字也不猜标准值', () => {
  const result = normalizeMoney(raw(), rule('F'));
  assert.equal(result.amount, null); assert.equal(result.direction, null);
  assert.ok(codes(result).includes('amount_semantics_unknown'));
});

test('方向词表按具体规则精确匹配，不借公共词表或自动trim补判', () => {
  for (const word of ['借', ' 支出 ', null, '']) {
    const result = normalizeMoney(raw({ raw_direction: word }), rule('B'));
    assert.equal(result.amount, null); assert.equal(result.direction, null);
    assert.ok(codes(result).some(code => /^direction_/.test(code)));
  }
  known(normalizeMoney(raw({ raw_direction: '借' }), rule('B', { direction_map: { 借: '出' } })), '-100', '出');
});

test('原始零只有已声明零方向才有方向，否则零不等于未知', () => {
  known(normalizeMoney(raw({ raw_amount_text: '-0.00' }), rule('A', { zero_policy: 'confirmed', zero_direction: '出' })), '0', '出');
  const result = normalizeMoney(raw({ raw_amount_text: '0.000' }), rule());
  assert.equal(result.amount, '0'); assert.equal(result.direction, null);
  assert.ok(codes(result).includes('zero_rule_undefined'));
  const unsignedNegativeZero = normalizeMoney(raw({ raw_amount_text: '-0.00' }), rule('E', { zero_policy: 'confirmed', zero_direction: '出' }));
  assert.equal(unsignedNegativeZero.amount, '0');
  assert.ok(codes(unsignedNegativeZero).includes('sign_semantics_undefined'));
});

test('原始非零舍入到0分时保留实际方向并待核，不冒充原始零', () => {
  const result = normalizeMoney(raw({ raw_amount_text: '-0.004' }), rule('B', { zero_policy: 'confirmed', zero_direction: '出' }));
  assert.equal(result.amount, '0'); assert.equal(result.direction, '进'); assert.equal(result.reversal_flag, 1);
  assert.ok(codes(result).includes('amount_rounds_to_zero'));
  assert.deepEqual(result.derivation.rounding, [{ field: 'raw_amount_text', rounded: true }]);
});

test('空金额与坏金额原因独立，二者都不变成0', () => {
  const missing = normalizeMoney(raw({ raw_amount_text: null }), rule());
  const malformed = normalizeMoney(raw({ raw_amount_text: 'N/A' }), rule());
  assert.equal(missing.amount, null); assert.equal(malformed.amount, null);
  assert.ok(codes(missing).includes('amount_missing'));
  assert.ok(codes(malformed).includes('amount_unparseable'));
});

test('超长金额显式待核，解释上限不改变或截断原始字段', () => {
  const text = '1'.repeat(4097);
  assert.throws(() => parseMinor(text, '元'), { code: 'FS_MONEY_FORMAT' });
  const input = raw({ raw_amount_text: text });
  const result = normalizeMoney(input, rule());
  assert.equal(result.amount, null);
  assert.ok(codes(result).includes('amount_unparseable'));
  assert.equal(input.raw_amount_text, text);
});

test('ISO币种仅忽略两端空白与大小写，外币原值不被CNY规则替换', () => {
  const result = normalizeMoney(raw({ currency_text: ' usd ' }), rule('A', { currency_policy: 'verified_cny', currency_map: { 美金: 'CNY' } }));
  assert.equal(result.currency, 'USD'); assert.equal(result.amount, '100');
  assert.deepEqual(codes(result), ['currency_unsupported']);
  assert.equal(result.derivation.currency.source, 'iso');
});

test('缺币种证据保持null，仅已批准verified_cny可声明人民币', () => {
  for (const policy of ['explicit', 'unverified']) {
    const result = normalizeMoney(raw({ currency_text: null }), rule('A', { currency_policy: policy }));
    assert.equal(result.currency, null); assert.ok(codes(result).includes('currency_missing'));
  }
  const unapproved = normalizeMoney(raw({ currency_text: null }), rule('A', { currency_policy: 'verified_cny', review: { status: 'unreviewed' } }));
  assert.equal(unapproved.currency, null); assert.ok(codes(unapproved).includes('currency_missing'));
  known(normalizeMoney(raw({ currency_text: null }), rule('A', { currency_policy: 'verified_cny' })), '100', '进');
});

test('非ISO币种只有本规则已批准精确映射命中才确认', () => {
  const mappedRule = rule('A', { currency_map: { 人民币: 'CNY', '156': 'CNY' } });
  const result = normalizeMoney(raw({ currency_text: ' 人民币 ' }), mappedRule);
  known(result, '100', '进'); assert.equal(result.currency, 'CNY');
  assert.equal(result.derivation.currency.source, 'approved_map');
  assert.equal(normalizeMoney(raw({ currency_text: '156' }), mappedRule).currency, 'CNY');
  for (const [word, config] of [['人民币元', mappedRule], ['人民币', { ...mappedRule, review: { status: 'unreviewed' } }]]) {
    const unknown = normalizeMoney(raw({ currency_text: word }), config);
    assert.equal(unknown.currency, null); assert.ok(codes(unknown).includes('currency_unknown'));
  }
});

test('非ISO非空原文不能借verified_cny兜底，映射也不能用来补缺值', () => {
  const config = rule('A', { currency_policy: 'verified_cny', currency_map: { 人民币: 'CNY' } });
  const unknown = normalizeMoney(raw({ currency_text: '未知币种' }), config);
  assert.equal(unknown.currency, null); assert.ok(codes(unknown).includes('currency_unknown'));
  const explicit = normalizeMoney(raw({ currency_text: null }), rule('A', { currency_map: { 人民币: 'CNY' } }));
  assert.equal(explicit.currency, null);
});

test('已批准的外币映射保留真实代码并提示不支持', () => {
  const result = normalizeMoney(raw({ currency_text: '美元' }), rule('A', { currency_map: { 美元: 'USD' } }));
  assert.equal(result.currency, 'USD'); assert.deepEqual(codes(result), ['currency_unsupported']);
});

test('生产raw_currency_text字段可读取，两个币种证据冲突则不任选一个', () => {
  const input = raw(); delete input.currency_text; input.raw_currency_text = 'cny';
  assert.equal(normalizeMoney(input, rule()).currency, 'CNY');
  const conflict = normalizeMoney(raw({ raw_currency_text: 'USD' }), rule());
  assert.equal(conflict.currency, null); assert.ok(codes(conflict).includes('currency_evidence_conflict'));
});

test('多个局部问题各自保留，金额已知不代表整行confirmed', () => {
  const result = normalizeMoney(raw({ raw_amount_text: '0', currency_text: null }), rule());
  assert.deepEqual(codes(result).sort(), ['currency_missing', 'zero_rule_undefined']);
  assert.equal(Object.hasOwn(result, 'status'), false);
  const timeUnknown = normalizeMoney(raw({ txn_time_text: null, acct_no: null }), rule());
  known(timeUnknown, '100', '进');
  assert.equal(Object.hasOwn(timeUnknown, 'status'), false);
  const bothUnknown = normalizeMoney(raw({ raw_amount_text: null, raw_direction: null }), rule('B'));
  assert.deepEqual(codes(bothUnknown).sort(), ['amount_missing', 'direction_missing']);
});

test('未批准规则允许解释机械值，但始终带独立阻断原因', () => {
  const result = normalizeMoney(raw(), rule('B', { review: { status: 'unreviewed' } }));
  assert.equal(result.amount, '-100'); assert.equal(result.direction, '出');
  assert.ok(codes(result).includes('rule_unapproved'));
  assert.equal(Object.hasOwn(result, 'status'), false);
});

test('int64入库边界：A最小负值有效，正2^63无效', () => {
  const config = rule('A', { source_unit: '分', unit_scale: 1 });
  known(normalizeMoney(raw({ raw_amount_text: INT64_MIN.toString() }), config), INT64_MIN.toString(), '出');
  known(normalizeMoney(raw({ raw_amount_text: INT64_MAX.toString() }), config), INT64_MAX.toString(), '进');
  for (const text of ['9223372036854775808', '-9223372036854775809']) {
    const result = normalizeMoney(raw({ raw_amount_text: text }), config);
    assert.equal(result.amount, null); assert.ok(codes(result).includes('amount_out_of_range'));
  }
});

test('无符号幅值2^63可按实际支出变成INT64_MIN，反向则越界', () => {
  const config = rule('E', { source_unit: '分', unit_scale: 1 });
  known(normalizeMoney(raw({ raw_amount_text: '9223372036854775808' }), config), INT64_MIN.toString(), '出');
  const overflow = normalizeMoney(raw({ raw_amount_text: '9223372036854775808', raw_direction: '收入' }), config);
  assert.equal(overflow.amount, null); assert.ok(codes(overflow).includes('amount_out_of_range'));
  const reverse = normalizeMoney(raw({ raw_amount_text: INT64_MIN.toString() }), rule('B', { source_unit: '分', unit_scale: 1 }));
  assert.equal(reverse.amount, null); assert.equal(reverse.direction, '进');
});

test('双列2^63边界也在应用列方向与负值政策后判断', () => {
  const config = rule('D', { source_unit: '分', unit_scale: 1, column_negative_policy: { income: 'reverse', expense: 'reverse' } });
  known(normalizeMoney(raw({ raw_expense_text: '9223372036854775808' }), config), INT64_MIN.toString(), '出');
  known(normalizeMoney(raw({ raw_income_text: '-9223372036854775808' }), config), INT64_MIN.toString(), '出', 1);
  const result = normalizeMoney(raw({ raw_expense_text: '-9223372036854775808' }), config);
  assert.equal(result.amount, null); assert.ok(codes(result).includes('amount_out_of_range'));
});

test('元金额在HALF_UP后检查int64，不提前按原始文本截范围', () => {
  known(normalizeMoney(raw({ raw_amount_text: '-92233720368547758.075' }), rule()), INT64_MIN.toString(), '出');
  const overflow = normalizeMoney(raw({ raw_amount_text: '92233720368547758.075' }), rule());
  assert.equal(overflow.amount, null); assert.ok(codes(overflow).includes('amount_out_of_range'));
});

test('规范int64拒绝宽松BigInt语法与已失真的JSON数字', () => {
  for (const value of [' 100 ', '100\n', '100\r\n', '+100', '007', '-0', -0, '1.0', 1.5, 9007199254740992, NaN, Infinity, null, undefined]) {
    assert.throws(() => assertInt64(value), { code: 'FS_MONEY_INT64' });
  }
  assert.equal(assertInt64('0'), 0n); assert.equal(assertInt64(100), 100n);
  assert.equal(assertInt64(INT64_MIN.toString()), INT64_MIN);
  assert.throws(() => assertInt64('1'.repeat(100000)), { code: 'FS_MONEY_INT64' });
});

test('汇总BigInt精确运算，最终超界抛错，未知金额不得当0', () => {
  assert.equal(sumMinor(['9007199254740993', '-1']), 9007199254740992n);
  assert.equal(sumMinor([INT64_MAX, 1n, -1n]), INT64_MAX);
  assert.equal(sumMinor([]), 0n);
  assert.throws(() => sumMinor([INT64_MAX, 1n]), { code: 'FS_MONEY_INT64' });
  assert.throws(() => sumMinor([INT64_MIN, -1n]), { code: 'FS_MONEY_INT64' });
  assert.throws(() => sumMinor(['100', null]), { code: 'FS_MONEY_INT64' });
  assert.throws(() => sumMinor('100'), { code: 'FS_MONEY_INT64' });
});

test('规则矛盾直接拒绝，不能用失配倍率或ISO映射改业务', () => {
  const invalid = [
    { source_unit: '分' }, { unit_scale: 1 }, { rounding_rule: 'floor' }, { negative_policy: 'magnitude' },
    { direction_map: { 借: '出' } }, { zero_policy: 'confirmed', zero_direction: null },
    { currency_map: { USD: 'CNY' } }, { currency_map: { '人民币 ': 'CNY' } }, { currency_map: { 人民币: 'cny' } },
    { currency_map: { 人民币: 'CNY\n' } }, { currency_map: { 人民币: { toString: () => 'CNY' } } }
  ];
  for (const change of invalid) assert.throws(() => normalizeMoney(raw(), rule('A', change)), { code: 'FS_MONEY_RULE' });
  for (const policy of [{ income: 'reverse' }, { income: 'reverse', expense: 'reverse', extra: 'reverse' }, { income: 'guess', expense: 'pending' }]) {
    assert.throws(() => normalizeMoney(raw(), rule('D', { column_negative_policy: policy })), { code: 'FS_MONEY_RULE' });
  }
  assert.throws(() => normalizeMoney(raw(), rule('A', { column_negative_policy: { income: 'reverse', expense: 'reverse' } })), { code: 'FS_MONEY_RULE' });
});

test('引擎不改原文与规则，不以摘要冲正关键词代替符号政策', () => {
  const input = raw({ summary: '冲正退款抹账', raw_amount_text: '1.005' }), config = rule();
  const before = JSON.stringify({ input, config });
  Object.freeze(input); Object.freeze(config.direction_map); Object.freeze(config);
  const result = normalizeMoney(input, config);
  known(result, '101', '进');
  assert.equal(JSON.stringify({ input, config }), before);
  assert.equal(result.derivation.rounding[0].rounded, true);
});

test('IPC精度传输递归转换BigInt，保留安全计数且不修改输入', () => {
  const input = { amount: INT64_MIN, counts: 42, list: [INT64_MAX, { amount: 9007199254740993n }], nil: null };
  const output = toWire(input);
  assert.deepEqual(output, { amount: INT64_MIN.toString(), counts: 42, list: [INT64_MAX.toString(), { amount: '9007199254740993' }], nil: null });
  assert.equal(typeof input.amount, 'bigint');
  assert.equal(JSON.parse(JSON.stringify(output)).list[1].amount, '9007199254740993');
});

test('IPC不让非安全数字、缺值、循环或非JSON对象静默流过', () => {
  for (const input of [9007199254740992, 0.1, -0, NaN, Infinity, undefined, { amount: undefined }, [undefined], new Date(), new Set()]) {
    assert.throws(() => toWire(input), { code: 'FS_MONEY_WIRE' });
  }
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => toWire(cycle), { code: 'FS_MONEY_WIRE' });
  const shared = { amount: 1n };
  assert.deepEqual(toWire([shared, shared]), [{ amount: '1' }, { amount: '1' }]);
});

test('IPC对象字段不触发__proto__原型赋值', () => {
  const input = JSON.parse('{"__proto__":{"amount":"test"}}'); input.__proto__.amount = 1n;
  const output = toWire(input);
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.equal(Object.hasOwn(output, '__proto__'), true);
  assert.deepEqual(output.__proto__, { amount: '1' });
});

test('int64两端经消息端口与JSON实际往返仍为精确十进制文本', async () => {
  const { MessageChannel } = require('node:worker_threads');
  const { port1, port2 } = new MessageChannel();
  try {
    const received = new Promise(resolve => port2.once('message', resolve));
    port1.postMessage(toWire({ minimum: INT64_MIN, maximum: INT64_MAX, unknown: null }));
    const value = JSON.parse(JSON.stringify(await received));
    assert.deepEqual(value, { minimum: '-9223372036854775808', maximum: '9223372036854775807', unknown: null });
    assert.equal(assertInt64(value.minimum), INT64_MIN);
    assert.equal(assertInt64(value.maximum), INT64_MAX);
  } finally { port1.close(); port2.close(); }
});
