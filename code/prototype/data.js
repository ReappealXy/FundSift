(function () {
  'use strict';

  // Demonstration records only. No original case material is included.
  const cases = [
    { id: 'case-1', name: '远川商贸资金核查', number: 'DQ-2026-018', type: '资金核查', status: 'active', updated: '2026-11-12 14:32', description: '核查主要账户资金收付，复核跨渠道往来及退款记录。' },
    { id: 'case-2', name: '恒舟设备往来审计', number: 'DQ-2026-015', type: '往来审计', status: 'review', updated: '2026-11-12 11:08', description: '设备购销往来核对，待确认两笔收付方向。' },
    { id: 'case-3', name: '南岭项目专项核查', number: 'DQ-2026-012', type: '专项核查', status: 'active', updated: '2026-11-11 17:46', description: '项目专户与支付账户流水整理。' },
    { id: 'case-4', name: '锦禾服务收支核对', number: 'DQ-2026-006', type: '收支核对', status: 'archived', updated: '2026-11-06 16:20', description: '已完成复核并留存并表结果。' }
  ];

  const files = [
    { id: 'file-1', caseId: 'case-1', name: '建设银行_基本户_202610.xlsx', platform: '建设银行', type: 'XLSX', size: '32.6 KB', records: 0, accounts: 1, period: '2026-10-01 至 2026-11-12', status: 'ready', importedAt: '2026-11-12 09:21', rule: '建设银行交易明细 · v2' },
    { id: 'file-2', caseId: 'case-1', name: '建设银行_结算户_202610.xlsx', platform: '建设银行', type: 'XLSX', size: '28.4 KB', records: 0, accounts: 1, period: '2026-10-01 至 2026-11-12', status: 'ready', importedAt: '2026-11-12 09:23', rule: '建设银行交易明细 · v2' },
    { id: 'file-3', caseId: 'case-1', name: '微信支付_交易明细_10月.txt', platform: '微信支付', type: 'TXT', size: '12.8 KB', records: 0, accounts: 1, period: '2026-10-01 至 2026-10-31', status: 'ready', importedAt: '2026-11-12 09:25', rule: '微信支付交易明细 · v1' },
    { id: 'file-4', caseId: 'case-1', name: '微信支付_交易明细_11月.txt', platform: '微信支付', type: 'TXT', size: '8.2 KB', records: 0, accounts: 1, period: '2026-11-01 至 2026-11-12', status: 'ready', importedAt: '2026-11-12 09:26', rule: '微信支付交易明细 · v1' },
    { id: 'file-5', caseId: 'case-1', name: '支付宝_账户明细_10月.csv', platform: '支付宝', type: 'CSV', size: '16.1 KB', records: 0, accounts: 1, period: '2026-10-01 至 2026-10-31', status: 'ready', importedAt: '2026-11-12 09:28', rule: '支付宝账户明细 · v1' },
    { id: 'file-6', caseId: 'case-1', name: '支付宝_账户明细_11月.csv', platform: '支付宝', type: 'CSV', size: '10.3 KB', records: 0, accounts: 1, period: '2026-11-01 至 2026-11-12', status: 'ready', importedAt: '2026-11-12 09:29', rule: '支付宝账户明细 · v1' },
    { id: 'file-7', caseId: 'case-1', name: '建设银行_补充流水.xlsx', platform: '建设银行', type: 'XLSX', size: '21.5 KB', records: 0, accounts: 0, period: '尚未识别', status: 'pending', importedAt: '2026-11-12 14:18', rule: '表头结构待确认' },
    { id: 'file-8', caseId: 'case-1', name: '支付宝_余额明细_补充.csv', platform: '支付宝', type: 'CSV', size: '0 KB', records: 0, accounts: 0, period: '尚未读取', status: 'error', importedAt: '2026-11-12 14:18', rule: '文件为空，请重新提供' },
    { id: 'file-9', caseId: 'case-2', name: '建设银行_货款往来.xlsx', platform: '建设银行', type: 'XLSX', size: '19.6 KB', records: 0, accounts: 1, period: '2026-11-01 至 2026-11-12', status: 'ready', importedAt: '2026-11-12 10:30', rule: '建设银行交易明细 · v2' },
    { id: 'file-10', caseId: 'case-2', name: '微信支付_收支记录.txt', platform: '微信支付', type: 'TXT', size: '5.6 KB', records: 0, accounts: 1, period: '2026-11-01 至 2026-11-12', status: 'ready', importedAt: '2026-11-12 10:34', rule: '微信支付交易明细 · v1' },
    { id: 'file-11', caseId: 'case-3', name: '建设银行_项目专户.xlsx', platform: '建设银行', type: 'XLSX', size: '22.8 KB', records: 0, accounts: 1, period: '2026-11-01 至 2026-11-11', status: 'ready', importedAt: '2026-11-11 16:10', rule: '建设银行交易明细 · v2' },
    { id: 'file-12', caseId: 'case-3', name: '支付宝_项目支付.csv', platform: '支付宝', type: 'CSV', size: '6.1 KB', records: 0, accounts: 1, period: '2026-11-01 至 2026-11-11', status: 'ready', importedAt: '2026-11-11 16:12', rule: '支付宝账户明细 · v1' },
    { id: 'file-13', caseId: 'case-4', name: '建设银行_服务款收支.xlsx', platform: '建设银行', type: 'XLSX', size: '18.7 KB', records: 0, accounts: 1, period: '2026-11-01 至 2026-11-06', status: 'ready', importedAt: '2026-11-06 09:14', rule: '建设银行交易明细 · v2' },
    { id: 'file-14', caseId: 'case-4', name: '支付宝_服务结算.csv', platform: '支付宝', type: 'CSV', size: '4.7 KB', records: 0, accounts: 1, period: '2026-11-01 至 2026-11-06', status: 'ready', importedAt: '2026-11-06 09:16', rule: '支付宝账户明细 · v1' }
  ];

  const accountProfiles = [
    { platform: '建设银行', account: '建行 · 尾号 0826', owner: '远川商贸（基本户）', opening: 16834280 },
    { platform: '建设银行', account: '建行 · 尾号 1930', owner: '远川商贸（结算户）', opening: 8354000 },
    { platform: '微信支付', account: '微信 · 尾号 6021', owner: '远川商贸（微信）', opening: 248600 },
    { platform: '支付宝', account: '支付宝 · 尾号 7350', owner: '远川商贸（支付宝）', opening: 572430 }
  ];
  const entries = [
    ['澄禾物资有限公司', '货款结算', '转账', 1280000],
    ['汇谷办公用品', '办公用品采购', '消费', -36800],
    ['明岸物流服务', '运输服务费', '转账', -125000],
    ['星桥技术服务', '服务款收回', '转账', 560000],
    ['云桥商户', '日常采购', '消费', -2860],
    ['青湾设备有限公司', '设备预付款', '转账', -2500000],
    ['远川商贸结算户', '账户间划转', '转账', 800000],
    ['锦禾服务有限公司', '项目服务款', '转账', 3650000],
    ['溪岸商店', '商品采购', '消费', -6800],
    ['宁序商户', '退款入账', '退款', 12900],
    ['远川商贸基本户', '备用金划转', '转账', -120000],
    ['银行结息', '活期结息', '结息', 187]
  ];
  const flows = [];
  const balances = accountProfiles.map(function (a) { return a.opening; });
  const positions = {};

  function decimal(cents) {
    return (cents / 100).toFixed(2);
  }

  function appendFlow(config) {
    const source = files.find(function (f) { return f.id === config.sourceId; });
    const row = (positions[config.sourceId] || 0) + 1;
    positions[config.sourceId] = row;
    const previousBalance = config.previousBalance;
    const amount = config.amount;
    flows.push({
      id: config.id,
      caseId: config.caseId,
      sourceId: config.sourceId,
      sourceLoc: source.type === 'XLSX' ? '交易明细!' + (row + 1) : '记录 ' + row,
      time: config.time,
      platform: config.platform,
      account: config.account,
      owner: config.owner,
      peer: config.peer,
      peerAccount: config.peerAccount,
      amount: amount,
      balance: config.balance,
      summary: config.summary,
      txnType: config.txnType,
      status: config.status || 'confirmed',
      balanceStatus: config.balanceStatus || 'pass',
      rawAmount: config.rawAmount !== undefined ? config.rawAmount : amount === null ? '' : decimal(Math.abs(amount)),
      rawDirection: config.rawDirection !== undefined ? config.rawDirection : amount === null ? '其他' : amount >= 0 ? '收入' : '支出',
      rule: config.rule || source.rule,
      issue: config.issue || '',
      previousBalance: previousBalance
    });
  }

  for (let i = 0; i < 42; i += 1) {
    const ai = i % 4;
    const profile = accountProfiles[ai];
    const template = entries[i % entries.length];
    const isNovember = i >= 20;
    const month = isNovember ? '11' : '10';
    const day = isNovember ? Math.min(12, 1 + Math.floor((i - 20) / 2)) : 20 + Math.floor(i / 2);
    const hour = 9 + (i % 8);
    const minute = (13 + i * 7) % 60;
    let sourceId = ai === 0 ? 'file-1' : ai === 1 ? 'file-2' : ai === 2 ? isNovember ? 'file-4' : 'file-3' : isNovember ? 'file-6' : 'file-5';
    let amount = template[3];
    let status = 'confirmed';
    let balanceStatus = ai >= 2 ? 'na' : 'pass';
    let issue = '';
    let summary = template[1];
    let rawAmount;
    let rawDirection;
    let type = template[2];
    const previousBalance = balances[ai];

    if (i === 8) {
      amount = 134;
      summary = '消费退货 · 原借方负数';
      type = '退款';
      rawAmount = '-1.34';
      rawDirection = '借';
    }
    if (i === 16 || i === 25) {
      balanceStatus = 'fail';
      issue = i === 16 ? '余额链差额 50.00 元，需核对该段流水完整性' : '余额链差额 1.20 元，需核对该段流水完整性';
    }
    if ([5, 14, 27, 34].indexOf(i) !== -1) {
      status = 'pending';
      balanceStatus = 'na';
      amount = null;
      rawAmount = i === 27 ? '' : decimal(Math.abs(template[3]));
      rawDirection = i === 27 ? '支出' : '其他';
      issue = i === 27 ? '金额字段缺失，无法确定标准金额' : '方向标识未匹配，请核对原始方向';
      summary = i === 27 ? '材料采购 · 金额字段为空' : template[1] + ' · 方向待核';
    }

    let balance = amount === null ? null : previousBalance + amount;
    if (i === 16) balance += 5000;
    if (i === 25) balance += 120;
    if (balance !== null) balances[ai] = balance;
    appendFlow({
      id: 'flow-' + String(i + 1).padStart(3, '0'),
      caseId: 'case-1', sourceId: sourceId,
      time: '2026-' + month + '-' + String(day).padStart(2, '0') + ' ' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + ':' + String((i * 11) % 60).padStart(2, '0'),
      platform: profile.platform, account: profile.account, owner: profile.owner,
      peer: template[0], peerAccount: '对方账户 · 尾号 ' + String(1042 + (i % 11) * 317).padStart(4, '0'),
      amount: amount, balance: balance, previousBalance: previousBalance,
      summary: summary, txnType: type, status: status, balanceStatus: balanceStatus,
      rawAmount: rawAmount, rawDirection: rawDirection, issue: issue
    });
  }

  [
    { caseId: 'case-2', count: 6, sourceIds: ['file-9', 'file-10'], owner: '恒舟设备', accounts: ['建行 · 尾号 5168', '微信 · 尾号 2291'], platforms: ['建设银行', '微信支付'], opening: [35800000, 780000] },
    { caseId: 'case-3', count: 4, sourceIds: ['file-11', 'file-12'], owner: '南岭项目', accounts: ['建行 · 尾号 4073', '支付宝 · 尾号 6630'], platforms: ['建设银行', '支付宝'], opening: [12600000, 385000] },
    { caseId: 'case-4', count: 3, sourceIds: ['file-13', 'file-14'], owner: '锦禾服务', accounts: ['建行 · 尾号 9012', '支付宝 · 尾号 1805'], platforms: ['建设银行', '支付宝'], opening: [6200000, 126000] }
  ].forEach(function (group) {
    const currentBalances = group.opening.slice();
    for (let i = 0; i < group.count; i += 1) {
      const ai = i % 2;
      const entry = entries[(i + 3) % entries.length];
      const pending = group.caseId === 'case-2' && (i === 1 || i === 4);
      const amount = pending ? null : entry[3];
      const previousBalance = currentBalances[ai];
      const balance = amount === null ? null : previousBalance + amount;
      if (balance !== null) currentBalances[ai] = balance;
      appendFlow({
        id: 'flow-' + String(flows.length + 1).padStart(3, '0'), caseId: group.caseId,
        sourceId: group.sourceIds[ai], time: '2026-11-0' + (i + 1) + ' 10:2' + i + ':00',
        platform: group.platforms[ai], account: group.accounts[ai], owner: group.owner,
        peer: entry[0], peerAccount: '对方账户 · 尾号 ' + (5040 + i * 29),
        amount: amount, balance: balance, previousBalance: previousBalance,
        summary: pending ? entry[1] + ' · 方向待核' : entry[1], txnType: entry[2],
        status: pending ? 'pending' : 'confirmed', balanceStatus: pending || ai === 1 ? 'na' : 'pass',
        rawAmount: decimal(Math.abs(entry[3])), rawDirection: pending ? '其他' : entry[3] >= 0 ? '收入' : '支出',
        issue: pending ? '方向标识未匹配，请核对原始方向' : ''
      });
    }
  });

  files.forEach(function (file) {
    file.records = flows.filter(function (row) { return row.sourceId === file.id; }).length;
    if (file.status === 'ready') {
      file.accounts = new Set(flows.filter(function (row) { return row.sourceId === file.id; }).map(function (row) { return row.account; })).size;
    }
  });

  const exports = [
    { id: 'export-1', caseId: 'case-1', name: '远川商贸_并表流水_20261112.xlsx', format: 'Excel 工作簿', rows: flows.filter(function (row) { return row.caseId === 'case-1'; }).length, scope: '全部流水，含待核清单', created: '2026-11-12 11:42', status: 'done' },
    { id: 'export-2', caseId: 'case-2', name: '恒舟设备_待核清单_20261112.xlsx', format: 'Excel 工作簿', rows: flows.filter(function (row) { return row.caseId === 'case-2' && row.status === 'pending'; }).length, scope: '仅待核流水', created: '2026-11-12 11:08', status: 'done' },
    { id: 'export-3', caseId: 'case-4', name: '锦禾服务_并表流水_20261106.xlsx', format: 'Excel 工作簿', rows: flows.filter(function (row) { return row.caseId === 'case-4'; }).length, scope: '全部流水', created: '2026-11-06 16:20', status: 'done' }
  ];

  window.FUND_DATA = { cases: cases, files: files, flows: flows, exports: exports };
}());
