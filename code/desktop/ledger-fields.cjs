'use strict';

const alipay = require('./alipay-account.cjs');
const wechat = require('./wechat-trades.cjs');
const ccb = require('./ccb-account.cjs');

const formats = new Map([
  [alipay.FORMAT_KEY, {
    headers: alipay.HEADERS,
    fields: {
      account: '用户信息', counterpartyAccount: '交易对方信息',
      note1: '消费名称', note2: '备注', tradeId: '交易号'
    }
  }],
  [wechat.FORMAT_KEY, {
    headers: wechat.HEADERS,
    fields: {
      owner: '用户侧账号名称', account: '用户ID', counterparty: '对手侧账户名称',
      counterpartyAccount: '对手方ID', note1: '备注1', note2: '备注2', tradeId: '交易单号'
    }
  }],
  [ccb.FORMAT_KEY, {
    headers: ccb.HEADERS,
    fields: {
      owner: '客户名称', account: '账号', counterparty: '对方户名', counterpartyAccount: '对方账号',
      note1: '摘要', note2: '扩充备注', tradeId: '交易流水号'
    }
  }]
]);

function ledgerFields(row, raw) {
  const fallback = {
    owner: row.acct_name, account: row.acct_no, counterparty: row.peer_name,
    counterpartyAccount: row.peer_acct, note1: row.summary, note2: null, tradeId: null
  };
  const format = formats.get(row.format_key);
  if (!format || raw?.format_key !== row.format_key || raw.source_loc !== row.source_loc ||
      !Array.isArray(raw.values) || raw.values.length !== format.headers.length) return fallback;

  for (const [key, header] of Object.entries(format.fields)) {
    const value = raw.values[format.headers.indexOf(header)];
    fallback[key] = typeof value === 'string' && value.trim() !== '' ? value : null;
  }
  return fallback;
}

function sourceFields(raw) {
  const format = formats.get(raw?.format_key);
  if (!format || raw.values.length !== format.headers.length) return [];
  return format.headers.map((header, index) => ({ header, column: index + 1, value: raw.values[index] }));
}

module.exports = { ledgerFields, sourceFields };
