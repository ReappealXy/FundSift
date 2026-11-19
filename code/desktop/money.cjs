'use strict';

// Production money logic is independent of the G0 oracle and its validator.
// Raw evidence stays with the caller. This module never edits raw or rule.
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
const own = (value, key) => Object.hasOwn(value, key);
const blank = value => value === null || value === undefined || typeof value === 'string' && value.trim() === '';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const flip = direction => direction === '进' ? '出' : '进';

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function decimal(text, unit) {
  if (unit !== '元' && unit !== '分') fail('FS_MONEY_UNIT', '来源单位必须明确为元或分');
  // This is a numeric interpretation limit, not an evidence-storage limit.
  // Oversized raw fields remain with the caller and become explicit pending.
  if (typeof text === 'string' && text.length > 4096) fail('FS_MONEY_FORMAT', '金额文本超过本版可安全解释的长度');
  if (typeof text !== 'string' || !/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text.trim())) {
    fail('FS_MONEY_FORMAT', '金额必须是十进制原文，千分位必须按三位分组');
  }
  const source = text.trim().replaceAll(',', '');
  const negative = source.startsWith('-');
  const unsigned = /^[+-]/.test(source) ? source.slice(1) : source;
  const [whole, fraction = ''] = unsigned.split('.');
  const scale = unit === '元' ? 2 : 0;
  const remainder = fraction.slice(scale);
  let magnitude = BigInt(whole + fraction.slice(0, scale).padEnd(scale, '0'));
  // HALF_UP rounds ties away from zero; there is no binary float conversion.
  if (remainder !== '' && remainder[0] >= '5') magnitude += 1n;
  const zero = !/[1-9]/.test(whole + fraction);
  return { value: negative ? -magnitude : magnitude, rounded: /[1-9]/.test(remainder), negative: negative && !zero, zero };
}

/** Exact conversion, before direction and storage-range checks.
 * A positive source magnitude of 2^63 may still become a valid INT64_MIN outflow.
 */
function parseMinor(text, unit) {
  const { value, rounded } = decimal(text, unit);
  return { value, rounded };
}

/** Accept only exact, canonical integer values; never coerce unsafe Numbers. */
function assertInt64(value) {
  let integer;
  if (typeof value === 'bigint') integer = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)) integer = BigInt(value);
  else if (typeof value === 'string' && value.length <= 20 && /^(?:0|-?[1-9]\d*)(?![\s\S])/.test(value)) integer = BigInt(value);
  else fail('FS_MONEY_INT64', '金额必须是无损的规范整数');
  if (integer < INT64_MIN || integer > INT64_MAX) fail('FS_MONEY_INT64', '金额超出 SQLite 有符号 64 位整数范围');
  return integer;
}

/** Caller chooses the confirmed/currency/perspective scope. Null is not zero.
 * Exact accumulation permits temporary cancellation; the final total must fit.
 */
function sumMinor(values) {
  if (values === null || values === undefined || typeof values === 'string' || typeof values[Symbol.iterator] !== 'function') {
    fail('FS_MONEY_INT64', '汇总需要明确选择的整数金额集合');
  }
  let total = 0n;
  for (const value of values) total += assertInt64(value);
  return assertInt64(total);
}

function validateRule(rule) {
  if (!plain(rule)) fail('FS_MONEY_RULE', '金额规则必须是明确的配置对象');
  const policies = { A: 'signed', B: 'reverse', C: 'magnitude', D: 'column_defined', E: 'pending', F: 'pending' };
  if (!own(policies, rule.amount_expr) || !(rule.negative_policy === policies[rule.amount_expr] ||
      rule.amount_expr === 'D' && rule.negative_policy === 'pending')) fail('FS_MONEY_RULE', '金额类别与负号策略不匹配');
  if (!['元', '分'].includes(rule.source_unit) || rule.unit_scale !== (rule.source_unit === '元' ? 100 : 1)) {
    fail('FS_MONEY_RULE', '来源单位与入库倍率不匹配');
  }
  if (rule.rounding_rule !== 'ROUND_HALF_UP') fail('FS_MONEY_RULE', '本版只支持 ROUND_HALF_UP 舍入');
  if (!plain(rule.direction_map) || Object.values(rule.direction_map).some(value => !['进', '出'].includes(value)) ||
      ['A', 'D'].includes(rule.amount_expr) && Object.keys(rule.direction_map).length !== 0) {
    fail('FS_MONEY_RULE', '方向词表无效，A/D 类不能执行方向词表');
  }
  if (!['pending', 'confirmed'].includes(rule.zero_policy) ||
      !['进', '出', null].includes(rule.zero_direction) || rule.zero_policy === 'confirmed' && rule.zero_direction === null) {
    fail('FS_MONEY_RULE', '零值策略及方向声明无效');
  }
  if (!['explicit', 'verified_cny', 'unverified'].includes(rule.currency_policy) || !plain(rule.currency_map)) {
    fail('FS_MONEY_RULE', '币种策略与映射必须明确配置');
  }
  for (const [alias, currency] of Object.entries(rule.currency_map)) {
    if (alias.trim() === '' || alias !== alias.trim() || /^[A-Za-z]{3}$/.test(alias) ||
        typeof currency !== 'string' || !/^[A-Z]{3}(?![\s\S])/.test(currency)) {
      fail('FS_MONEY_RULE', '币种映射只能从明确非 ISO 原文映射到大写三字母代码');
    }
  }
  if (own(rule, 'column_negative_policy')) {
    const policy = rule.column_negative_policy;
    if (rule.amount_expr !== 'D' || rule.negative_policy !== 'column_defined' || !plain(policy) ||
        Object.keys(policy).length !== 2 || !['income', 'expense'].every(key => own(policy, key) &&
          ['reverse', 'magnitude', 'pending'].includes(policy[key]))) {
      fail('FS_MONEY_RULE', '双列负值须分别明确收入列与支出列的处理政策');
    }
  }
}

/** Only money-local decisions are returned. The caller combines time/account
 * reasons before deciding the record status; no whole-record confirmed here.
 *
 * Raw: raw_amount_text, raw_income_text, raw_expense_text, raw_direction,
 *      currency_text (or the production storage name raw_currency_text).
 * Result: amount:string|null, direction, currency, reversal_flag, reasons,
 *         derivation. Known foreign currency is preserved and marked unsupported.
 */
function normalizeMoney(raw, rule) {
  validateRule(rule);
  if (!plain(raw)) fail('FS_MONEY_FORMAT', '原始金额字段必须是对象');
  const reasons = [];
  const derivation = {
    amount_expr: rule.amount_expr, source_unit: rule.source_unit, unit_scale: rule.unit_scale,
    rounding_rule: rule.rounding_rule, rule_id: rule.id ?? null, rule_version: rule.rule_version ?? null,
    amount: null, rounding: [], currency: null
  };
  const add = (reason_code, detail) => {
    if (!reasons.some(reason => reason.reason_code === reason_code)) reasons.push({ reason_code, detail });
  };
  const result = { amount: null, direction: null, currency: null, reversal_flag: 0, reasons, derivation };
  const approved = rule.review?.status === 'approved';
  if (!approved) add('rule_unapproved', '绑定规则版本尚未批准，机械结果只能供核对，不能确认记录');
  // Two API spellings are supported explicitly. Conflicting evidence is never
  // resolved by silently choosing one of them.
  const currencyConflict = own(raw, 'currency_text') && own(raw, 'raw_currency_text') && raw.currency_text !== raw.raw_currency_text;
  const currencyText = own(raw, 'currency_text') ? raw.currency_text : raw.raw_currency_text;
  const alias = typeof currencyText === 'string' ? currencyText.trim() : null;
  if (currencyConflict) {
    add('currency_evidence_conflict', '原始币种字段存在互相冲突的证据');
    derivation.currency = { source: 'conflict' };
  } else if (alias !== null && /^[A-Za-z]{3}$/.test(alias)) {
    result.currency = alias.toUpperCase();
    derivation.currency = { source: 'iso' };
  } else if (alias !== null && alias !== '' && own(rule.currency_map, alias) && approved) {
    result.currency = rule.currency_map[alias];
    derivation.currency = { source: 'approved_map', alias };
  } else if (blank(currencyText) && rule.currency_policy === 'verified_cny' && approved) {
    result.currency = 'CNY';
    derivation.currency = { source: 'verified_cny' };
  } else {
    derivation.currency = { source: 'unknown' };
    add(blank(currencyText) ? 'currency_missing' : 'currency_unknown', '币种缺少原文或本格式已批准的判定证据');
  }
  if (result.currency !== null && result.currency !== 'CNY') {
    add('currency_unsupported', '本版保留已知外币，禁止混入人民币处理与合计');
  }

  const read = field => {
    if (blank(raw[field])) return null;
    try {
      const parsed = decimal(raw[field], rule.source_unit);
      derivation.rounding.push({ field, rounded: parsed.rounded });
      return parsed;
    } catch (error) {
      if (error.code !== 'FS_MONEY_FORMAT') throw error;
      add('amount_unparseable', '非空金额字段不符合已支持的十进制格式');
      return false;
    }
  };
  const apply = (parsed, direction, method, reversed = false) => {
    result.direction = direction;
    result.reversal_flag = reversed ? 1 : 0;
    const magnitude = parsed.value < 0n ? -parsed.value : parsed.value;
    const value = direction === '进' ? magnitude : -magnitude;
    derivation.amount = { method, negative_policy: rule.negative_policy };
    try { result.amount = assertInt64(value).toString(); }
    catch (error) {
      if (error.code !== 'FS_MONEY_INT64') throw error;
      add('amount_out_of_range', '标准金额超出有符号 64 位整数范围');
    }
    if (!parsed.zero && value === 0n) add('amount_rounds_to_zero', '原始非零金额舍入为零分，需单独核对');
  };
  const zero = parsed => {
    result.amount = '0';
    derivation.amount = { method: 'raw_zero', zero_policy: rule.zero_policy };
    if (rule.zero_policy === 'confirmed') result.direction = rule.zero_direction;
    else add('zero_rule_undefined', '原始零金额没有已确认的方向语义');
  };

  if (rule.amount_expr === 'F') {
    add('amount_semantics_unknown', '本规则未确认该行的金额与方向语义');
    return result;
  }
  if (rule.amount_expr === 'D') {
    const income = read('raw_income_text'), expense = read('raw_expense_text');
    if (income === false || expense === false) return result;
    const activeIncome = income !== null && !income.zero, activeExpense = expense !== null && !expense.zero;
    if (activeIncome && activeExpense) {
      add('both_columns_nonzero', '收入与支出两列同时为非零，禁止自动相减或选列');
      return result;
    }
    if (!activeIncome && !activeExpense) {
      if (income === null && expense === null) add('amount_missing', '收入与支出两列均缺少金额');
      add('columns_empty', '收入与支出两列均为空或零，不能据列位确定金额方向');
      return result;
    }
    const key = activeIncome ? 'income' : 'expense';
    const parsed = activeIncome ? income : expense;
    const direction = activeIncome ? '进' : '出';
    if (parsed.negative) {
      const policy = rule.negative_policy === 'column_defined' ? rule.column_negative_policy?.[key] : 'pending';
      if (policy !== 'reverse' && policy !== 'magnitude') {
        add('negative_column_undefined', '负列值没有明确的已验证可执行政策');
        return result;
      }
      apply(parsed, policy === 'reverse' ? flip(direction) : direction, `${key}_${policy}`, policy === 'reverse');
    } else apply(parsed, direction, `${key}_column`);
    return result;
  }

  let mappedDirection = null;
  if (['B', 'C', 'E'].includes(rule.amount_expr)) {
    if (typeof raw.raw_direction === 'string' && own(rule.direction_map, raw.raw_direction)) mappedDirection = rule.direction_map[raw.raw_direction];
    else add(blank(raw.raw_direction) ? 'direction_missing' : 'direction_unknown', '原始方向缺失或不在本格式方向词表中');
  }
  const parsed = read('raw_amount_text');
  if (parsed === false) return result;
  if (parsed === null) {
    add('amount_missing', '原始金额缺失，不能以零代替');
    return result;
  }
  let direction;
  if (rule.amount_expr === 'A') direction = parsed.negative ? '出' : '进';
  else if (mappedDirection !== null) direction = mappedDirection;
  else return result;
  if (parsed.zero) {
    zero(parsed);
    if (rule.amount_expr === 'E' && raw.raw_amount_text.trim().startsWith('-')) {
      add('sign_semantics_undefined', '无符号金额规则未定义原文负号，即使值为零也不静默确认');
    }
    return result;
  }
  if (rule.amount_expr === 'E' && parsed.negative) {
    add('sign_semantics_undefined', '无符号金额规则不能解释负号，不猜测反转方向');
    return result;
  }
  const reversed = rule.amount_expr === 'B' && parsed.negative;
  apply(parsed, reversed ? flip(direction) : direction,
    { A: 'amount_sign', B: reversed ? 'direction_reversed' : 'direction_map', C: 'direction_magnitude', E: 'direction_map' }[rule.amount_expr], reversed);
  return result;
}

/** JSON-compatible transport only. Amount BigInts become decimal strings;
 * unsafe numbers, fractions, missing values and cycles fail rather than drift.
 */
function toWire(value) {
  const ancestors = new WeakSet();
  function visit(current) {
    if (typeof current === 'bigint') return current.toString();
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isSafeInteger(current) || Object.is(current, -0)) fail('FS_MONEY_WIRE', '传输数字必须为安全整数；金额使用 BigInt 或十进制整数字符串');
      return current;
    }
    if (!Array.isArray(current) && !plain(current)) fail('FS_MONEY_WIRE', '传输值必须是 JSON 数据');
    if (ancestors.has(current)) fail('FS_MONEY_WIRE', '传输值不能包含循环引用');
    if (Object.getOwnPropertySymbols(current).length) fail('FS_MONEY_WIRE', '传输值不能包含符号字段');
    ancestors.add(current);
    let output;
    if (Array.isArray(current)) {
      output = [];
      for (let index = 0; index < current.length; index++) output.push(visit(current[index]));
    } else {
      output = {};
      for (const key of Object.keys(current)) Object.defineProperty(output, key, {
        value: visit(current[key]), enumerable: true, writable: true, configurable: true
      });
    }
    ancestors.delete(current);
    return output;
  }
  return visit(value);
}

module.exports = { INT64_MIN, INT64_MAX, parseMinor, assertInt64, sumMinor, validateMoneyRule: validateRule, normalizeMoney, toWire };
