'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Excel = require('exceljs');
const Database = require('better-sqlite3');
const { WorkspaceStore } = require('../storage.cjs');
const { DesktopData } = require('../desktop-data.cjs');
const { importAlipayAccount } = require('../import-service.cjs');
const { runCaseTransaction } = require('../hardening.cjs');
const { getWorkpaperContext, exportWorkpaper } = require('../workpaper.cjs');
const { createImportFixtures } = require('../../../scripts/import-smoke-fixtures.cjs');

const OMITTED_ALIPAY_FIELD = '00000000000000000X';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fundsift-workpaper-'));
  const store = new WorkspaceStore({ schemaPath: path.resolve(__dirname, '../../ddl_extract_check.sql') });
  t.after(() => {
    store.close();
    // Remove only the directory created by this test.
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  });
  await store.openWorkspace(root);
  const current = await store.createCase({ name: '合成核对底稿', number: '001-WP' });
  const data = new DesktopData(store);
  const db = store.caseDb, record = store._caseRecord(current.id);
  const approved = { confirmedCny: true, confirmedAt: '2026-11-19T00:00:00.000Z' };
  return { root, store, current, data, db, record, approved };
}

function writeAlipay(fix) {
  const { HEADERS } = require('../alipay-account.cjs');
  const row = (id, time, amount, direction, status) => [
    id, 'order', time, time, '', 'source', 'type', '\t0000000000000000001',
    '=1+2', '\t商品', amount, direction, status, 'way', '', '', OMITTED_ALIPAY_FIELD
  ];
  const rows = [HEADERS,
    row('1', '2026-01-01 08:00:01', '92233720368547758.07', '收入', '交易成功'),
    row('2', '2026-01-01 08:00:02', '1.005', '支出', '交易成功'),
    row('3', '', '12.00', '收入', '交易中途关闭（未完成）'),
    row('4', '2026-01-01 08:00:04', '13.00', '其它', '交换产品-余额实时转余额宝成功'),
    row('5', '2026-01-01 08:00:05', '', '支出', '交易成功')
  ];
  const filePath = path.join(fix.root, '合成支付宝.csv');
  fs.writeFileSync(filePath, '\ufeff' + rows.map(values => values.join(',')).join('\r\n') + '\r\n');
  return filePath;
}

function importAlipayV1(fix, filePath) {
  const { FORMAT_KEY } = require('../alipay-account.cjs');
  const review = { status: 'approved', by: '合成核对', at: fix.approved.confirmedAt, reason: '合成材料批准按人民币处理' };
  return importAlipayAccount({
    db: fix.db, record: fix.record, caseDirectory: fix.store._casePath(fix.current.id), filePath,
    rule: { platform: '支付宝', format_key: FORMAT_KEY, rule_version: 1,
      amount_expr: 'E', rounding_rule: 'ROUND_HALF_UP', source_unit: '元', unit_scale: 100,
      direction_map: { 收入: '进', 支出: '出' }, negative_policy: 'pending', zero_policy: 'pending', zero_direction: null,
      currency_policy: 'verified_cny', currency_map: {}, balance_scope: 'unknown', balance_same_direction: true,
      reversal_note: '合成边界保守待核', review },
    policy: { timeColumn: '付款时间', accountIdentityPolicy: 'raw_platform_info', businessStatusPolicy: 'exact_v1', review }
  });
}

function writeWechat(fix) {
  const { HEADERS } = require('../wechat-trades.cjs');
  const row = [
    '0000010000000000001','wx-order','large-order','合成名称','出','快捷支付','消费','2026-11-19 08:00:00',
    '101','0','0000002345678901234','bank-link','网联','本方信息','peer\u0001_x0041_\\literal','合成对方',
    '0934567891234567890','合成银行','peer-link','银联','','非间连','{}','','100','备注','\u200c\u200e末列'
  ];
  const filePath = path.join(fix.root, '合成微信.txt');
  fs.writeFileSync(filePath, [HEADERS, row].map(values => values.join('\t')).join('\r\n') + '\r\n');
  return filePath;
}

async function readWorkbook(filePath) {
  const book = new Excel.Workbook();
  await book.xlsx.readFile(filePath);
  return book;
}

test('真实导入的底稿只取有效批次，回读原文、精确金额、差异原因和来源', async t => {
  const fix = await fixture(t);
  const alipay = writeAlipay(fix), wechat = writeWechat(fix);
  const ccb = createImportFixtures(path.join(fix.root, 'bank-fixture')).find(item => item.formatKey === 'ccb-account-32col-v1');
  await importAlipayV1(fix, alipay);
  const stored = fix.db.prepare('SELECT * FROM format_rule').get();
  const config = JSON.parse(fix.db.prepare('SELECT config_json FROM format_rule_config').get().config_json);
  const policy = JSON.parse(fix.db.prepare('SELECT notes FROM import_batch WHERE id=1').get().notes).policy;
  await importAlipayAccount({
    db: fix.db, record: fix.record, caseDirectory: fix.store._casePath(fix.current.id), filePath: alipay, reimport: true,
    rule: { ...config, platform: stored.platform, format_key: stored.format_key, rule_version: stored.rule_version }, policy
  });
  await fix.data.importFile(fix.current.id, { ...fix.approved, filePath: wechat, formatKey: 'wechat-trades-27col-v1' });
  await fix.data.importFile(fix.current.id, { ...ccb, confirmedCny: false, confirmedAt: fix.approved.confirmedAt });
  const context = getWorkpaperContext(fix);
  assert.match(context.fileName, /^流水核对底稿-格式v4-数据v\d+-\d{8}T\d{9}Z\.xlsx$/);
  assert.equal(context.totalRows, 8);
  const filePath = path.join(fix.root, context.fileName);
  const result = await exportWorkpaper({ ...fix, filePath, expectedDataVersion: context.dataVersion });
  assert.deepEqual(result.platforms.map(platform => [platform.platform, platform.totalRows, platform.pendingRows]).sort(),
    [['支付宝', 5, 3], ['微信', 1, 1], ['建设银行', 2, 1]].sort());
  assert.equal(result.totalRows, 8);
  assert.equal(result.confirmedRows, 3);
  assert.equal(result.pendingRows, 5);
  assert.equal(result.unknownAmountRows, 3);
  assert.equal(getWorkpaperContext(fix).dataVersion, context.dataVersion);

  const book = await readWorkbook(filePath);
  const comparison = book.getWorksheet('导入文本核对');
  assert.deepEqual(comparison.getRow(1).values.slice(6, 8), ['原始值', '修复后']);
  const remark = comparison.getRows(2, comparison.rowCount - 1).find(row => row.getCell(5).value === '备注2');
  assert.equal(remark.getCell(6).value, '\\u16:\\u200c\\u200e末列');
  assert.equal(remark.getCell(7).value, '末列');
  assert.equal(remark.getCell(7).fill.fgColor.argb, 'FFFFF2CA');
  const ambiguous = comparison.getRows(2, comparison.rowCount - 1).find(row => row.getCell(8).value === '待核原文');
  assert.ok(ambiguous);
  assert.equal(ambiguous.getCell(7).value, null);
  const flows = book.getWorksheet('流水明细'), info = book.getWorksheet('导出说明');
  const indexes = new Map(flows.getRow(1).values.map((header, index) => [header, index]).slice(1));
  const view = (row, name) => flows.getRow(row).getCell(indexes.get(name));
  const find = (name, value) => {
    for (let number = 2; number <= flows.rowCount; number++) if (view(number, name).value === value) return number;
    assert.fail('missing expected value: ' + name);
  };
  const max = find('原始金额（原文）', '92233720368547758.07');
  assert.equal(view(max, '案件编号').value, '001-WP');
  assert.equal(view(max, '本方账号／平台标识').value, '\t0000000000000000001');
  assert.equal(view(max, '本方账号／平台标识').type, Excel.ValueType.String);
  assert.equal(view(max, '对方账号／平台标识').value, '=1+2');
  assert.equal(view(max, '对方账号／平台标识').type, Excel.ValueType.String);
  assert.equal(view(max, '批次号').value, '2');
  assert.equal(view(max, '规则版本').value, '1');
  assert.equal(view(max, '原件文件名').value, '合成支付宝.csv');
  assert.match(view(max, '原件 SHA256').value, /^[a-f0-9]{64}$/);
  assert.equal(view(max, '行号／逻辑记录号').value, view(max, 'source_loc 原文').value);
  assert.equal(view(max, '标准金额（元）').value, '92233720368547758.07');
  assert.equal(view(max, '标准金额（元）').numFmt, '@');
  assert.equal(indexes.get('原始金额单位'), indexes.get('原始金额（原文）') + 1);
  assert.equal(view(max, '原始金额单位').value, '元');
  assert.equal(view(max, '摘要').value, '\t商品');
  for (const label of ['交易类型', '本方名称', '对方名称', '原件记载说明']) assert.equal(view(max, label).value, null);
  const rounded = find('原始金额（原文）', '1.005');
  assert.equal(view(rounded, '标准金额（元）').value, -1.01);
  assert.equal(view(rounded, '标准金额（元）').numFmt, '#,##0.00');
  assert.match(view(rounded, '换算说明').value, /1\.005 → 1\.01 元/);
  const closed = find('原始金额（原文）', '12.00');
  assert.equal(view(closed, '业务状态（原文）').value, '交易中途关闭（未完成）');
  assert.equal(view(closed, '原件收付记载').value, '标为关闭或未完成');
  assert.match(view(closed, '原件记载说明').value, /关闭|未完成/);
  assert.equal(view(closed, '是否计入收付（派生，仅供参考）').value, '否');
  assert.equal(view(closed, '证据状态（规则）').value, '待核');
  assert.equal(view(closed, '全部待核原因码').value, 'business_status_closed\ntime_missing');
  const unknown = find('原始金额（原文）', '13.00');
  assert.equal(view(unknown, '标准金额（元）').value, null);
  assert.equal(view(unknown, '原件收付记载').value, '有收付记载');
  assert.match(view(unknown, '业务状态（规则归一）').value, /未获准词表/);
  assert.equal(view(unknown, '是否计入收付（派生，仅供参考）').value, '未知');
  assert.equal(view(unknown, '全部待核原因码').value, 'business_status_unknown\ndirection_unknown');
  for (const label of ['内部划转方向', '内部划转金额（元，绝对值）', '账户变动留痕', '是否计入经济收支']) {
    assert.equal(view(unknown, label).value, null);
  }
  const wx = find('平台', '微信');
  assert.equal(view(wx, '本方银行卡号（原文）').value, '0000002345678901234');
  assert.equal(view(wx, '原始金额（原文）').value, '101');
  assert.equal(view(wx, '原始金额单位').value, '分');
  assert.equal(view(wx, '微信接收金额（原文，分）').value, '100');
  assert.equal(view(wx, '标准金额（元）').value, -1.01);
  assert.equal(view(wx, '全部待核原因码').value, 'receiver_amount_mismatch');
  assert.equal(view(wx, '原件收付记载').value, '有收付记载');
  assert.match(view(wx, '原件记载说明').value, /差异|不同|不一致/);
  assert.equal(view(wx, '摘要').value, '消费');
  assert.equal(view(wx, '交易类型').value, '快捷支付');
  assert.equal(view(wx, '本方名称').value, '合成名称');
  assert.equal(view(wx, '对方名称').value, '合成对方');
  assert.equal(view(wx, '对方账号／平台标识').value, '\\u16:peer\\u0001\\u005fx0041_\\\\literal');
  const ccbRefund = find('摘要', '消费退货');
  assert.equal(view(ccbRefund, '原始金额单位').value, '元');
  assert.equal(view(ccbRefund, '本方名称').value, '合成主体');
  assert.equal(view(ccbRefund, '对方名称').value, '合成对手');
  assert.equal(view(ccbRefund, '对方账号／平台标识').value, '000peer');
  assert.equal(view(ccbRefund, '原件收付记载').value, '有收付记载');
  assert.match(view(ccbRefund, '原件记载说明').value, /退货|符号|负号|负额/);
  const noOriginal = find('原件收付记载', '记载不足以判断');
  assert.ok([null, ''].includes(view(noOriginal, '原始金额（原文）').value));
  assert.equal(view(noOriginal, '标准金额（元）').value, null);
  const labels = flows.getColumn(indexes.get('原件收付记载')).values.slice(2).sort();
  assert.deepEqual(labels, [...Array(6).fill('有收付记载'), '标为关闭或未完成', '记载不足以判断'].sort());
  book.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => {
    assert.equal(cell.type === Excel.ValueType.Formula, false);
    assert.equal(typeof cell.value === 'string' && cell.value.includes(OMITTED_ALIPAY_FIELD), false);
  })));
  assert.ok(info.getColumn(2).values.includes(context.dataVersion));
  assert.ok(info.getColumn(2).values.some(value => typeof value === 'string' && value.includes('在 Excel 里改不算复核')));
  assert.ok(info.getColumn(1).values.includes('receiver_amount_mismatch'));
  const formatRow = info.getColumn(1).values.indexOf('底稿格式版本');
  assert.equal(info.getRow(formatRow).getCell(2).value, 4);
  assert.ok(info.getColumn(1).values.includes('字段来源表'));
  assert.ok(info.getColumn(2).values.some(value => typeof value === 'string' && /本方标识、对方标识和摘要.*前导制表符/u.test(value)));
  const counted = ['标为关闭或未完成', '有收付记载', '记载不足以判断']
    .map(label => info.getRow(info.getColumn(1).values.indexOf(label)).getCell(2).value);
  assert.deepEqual(counted, [1, 6, 1]);
  const sourceRow = info.getColumn(1).values.indexOf('摘要');
  assert.equal(info.getRow(sourceRow).getCell(4).value, '消费名称');
  assert.match(info.getRow(sourceRow).getCell(5).value, /转账/u);
  assert.ok(info.getColumn(1).values.includes('原文转义'));
  assert.equal(flows.rowCount, 9);
  assert.ok(flows.autoFilter);
  assert.equal(flows.views[0].ySplit, 1);

  const previous = fs.readFileSync(filePath);
  await assert.rejects(() => exportWorkpaper({ ...fix, filePath, expectedDataVersion: context.dataVersion }), { code: 'FS_EXPORT_EXISTS' });
  assert.deepEqual(fs.readFileSync(filePath), previous);
  assert.equal(fs.readdirSync(fix.root).some(name => name.endsWith('.tmp')), false);
});

test('规则 v2 的底稿单列可核实的内部划转金额，原始收付方向继续待核', async t => {
  const fix = await fixture(t);
  const { HEADERS } = require('../alipay-account.cjs');
  const row = (no, amount, status, subject = '\t000001(合成主体)', memo = '\t余额宝-自动转入') => [
    no, 'order', '2026-01-01 08:00:01', '2026-01-01 08:00:02', '', 'source', '即时到账交易',
    '\t000001(合成主体)', subject, memo, amount, '其它', status, '余额', '', '', OMITTED_ALIPAY_FIELD
  ];
  const transfer = '交换产品-余额实时转余额宝成功';
  const rows = [HEADERS, row('1', '30.55', transfer), row('2', '92233720368547758.07', transfer),
    row('3', '12.00', transfer, '\t000002(合成对手)'),
    row('4', '8.00', '交易中途关闭（未完成）')];
  const filePath = path.join(fix.root, '合成内部划转.csv');
  fs.writeFileSync(filePath, '\ufeff' + rows.map(values => values.join(',')).join('\r\n') + '\r\n');
  await fix.data.importFile(fix.current.id, { ...fix.approved, filePath });
  const context = getWorkpaperContext(fix);
  const output = path.join(fix.root, context.fileName);
  await exportWorkpaper({ ...fix, filePath: output, expectedDataVersion: context.dataVersion });
  const book = await readWorkbook(output);
  const flows = book.getWorksheet('流水明细'), info = book.getWorksheet('导出说明');
  const labels = flows.getRow(1).values;
  const byRecord = rowNumber => label => flows.getRow(rowNumber).getCell(labels.indexOf(label));
  const ordinaryAmount = byRecord(2), largeAmount = byRecord(3), unrelated = byRecord(4), closed = byRecord(5);
  const heading = '内部划转金额（元，绝对值）';
  for (const read of [ordinaryAmount, largeAmount]) {
    assert.equal(read('业务状态（规则归一）').value, '内部划转');
    assert.equal(read('内部划转方向').value, '余额转余额宝');
    assert.equal(read('账户变动留痕').value, '是');
    assert.equal(read('是否计入经济收支').value, '否');
    assert.equal(read('是否计入收付（派生，仅供参考）').value, '否');
    assert.equal(read('证据状态（规则）').value, '待核');
    assert.equal(read('标准方向').value, null);
    assert.equal(read('标准金额（元）').value, null);
    assert.equal(read('全部待核原因码').value, 'direction_unknown');
    assert.match(read('原件记载说明').value, /从经济收支中排除/u);
  }
  assert.equal(ordinaryAmount(heading).value, 30.55);
  assert.equal(ordinaryAmount(heading).numFmt, '#,##0.00');
  assert.equal(largeAmount(heading).value, '92233720368547758.07');
  assert.equal(largeAmount(heading).numFmt, '@');
  assert.equal(unrelated('业务状态（规则归一）').value, '未获准词表（见原文）');
  assert.equal(unrelated(heading).value, null);
  assert.equal(unrelated('是否计入经济收支').value, null);
  assert.equal(closed('原件收付记载').value, '标为关闭或未完成');
  const zero = info.getColumn(1).values.indexOf('记载不足以判断');
  assert.equal(info.getRow(zero).getCell(2).value, 0);
});

test('数据版本改变时不发布，外部写入和发布时的同名冲突也不留下半成品', async t => {
  const fix = await fixture(t);
  await fix.data.importFile(fix.current.id, { ...fix.approved, filePath: writeAlipay(fix) });
  const first = getWorkpaperContext(fix), filePath = path.join(fix.root, first.fileName);
  await assert.rejects(() => exportWorkpaper({ ...fix, filePath, expectedDataVersion: '0' }), { code: 'FS_EXPORT_STALE' });

  const flowId = fix.db.prepare('SELECT id FROM fund_flow WHERE status=? ORDER BY id').pluck().get('confirmed');
  await assert.rejects(() => exportWorkpaper({ ...fix, filePath, expectedDataVersion: first.dataVersion, onProgress({ phase }) {
    if (phase === 'publishing') runCaseTransaction(fix.db, fix.record, { flowIds: [flowId] }, () => {
      fix.db.prepare('UPDATE fund_flow SET amount=999 WHERE id=?').run(flowId);
    });
  } }), { code: 'FS_EXPORT_STALE' });
  assert.equal(fs.existsSync(filePath), false);

  const second = getWorkpaperContext(fix), outside = new Database(fix.db.name);
  try {
    await assert.rejects(() => exportWorkpaper({ ...fix, filePath, expectedDataVersion: second.dataVersion, onProgress({ phase }) {
      if (phase === 'publishing') outside.exec('CREATE TABLE export_external_write (id INTEGER PRIMARY KEY)');
    } }), { code: 'FS_EXPORT_STALE' });
    assert.equal(fs.existsSync(filePath), false);
  } finally { outside.close(); }
  await assert.rejects(() => exportWorkpaper({ ...fix, filePath, expectedDataVersion: second.dataVersion, onProgress({ phase }) {
    if (phase === 'publishing') fs.writeFileSync(filePath, 'new user content');
  } }), { code: 'FS_EXPORT_EXISTS' });
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'new user content');
  assert.equal(fs.readdirSync(fix.root).some(name => name.endsWith('.tmp')), false);
});
