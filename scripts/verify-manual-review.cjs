'use strict';

// Exercise the real review service and workbook on an isolated workspace copy.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Excel = require('exceljs');
const { WorkspaceStore } = require('../code/desktop/storage.cjs');
const { DesktopData } = require('../code/desktop/desktop-data.cjs');
const { EFFECTIVE_FLOW_FROM } = require('../code/desktop/hardening.cjs');
const { getReviewContext, saveReview } = require('../code/desktop/manual-review.cjs');

const bank = '建设银行';
const signReason = 'sign_semantics_undefined';
const coordinates = ['交易明细!50', '交易明细!51', '交易明细!52'];
const originalCounts = [8105, 36, 18, 39];
const reviewedCounts = [8105, 34, 16, 37];

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function manifest(directory, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...manifest(directory, relativePath));
    } else {
      assert.ok(entry.isFile());
      // SQLite recreates the shared-memory index from the copied WAL.
      if (!entry.name.endsWith('.sqlite-shm')) files.push([relativePath, sha256(path.join(directory, relativePath))]);
    }
  }
  return files.sort(([left], [right]) => left.localeCompare(right));
}

function copyWorkspace(source, outputDirectory) {
  const before = manifest(source);
  assert.ok(before.some(([relative]) => relative === 'workspace.sqlite'));
  assert.ok(before.some(([relative]) => relative.startsWith(`cases${path.sep}`) && path.basename(relative) === 'case.sqlite'));
  const parent = fs.realpathSync(path.dirname(outputDirectory));
  const output = path.join(parent, path.basename(outputDirectory));
  const relativeToSource = path.relative(source, output);
  assert.ok(relativeToSource.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToSource));
  fs.mkdirSync(output);
  const workspace = path.join(output, 'workspace');
  for (const [relative] of before) {
    const target = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, relative), target, fs.constants.COPYFILE_EXCL);
  }
  assert.deepEqual(manifest(workspace), before);
  assert.deepEqual(manifest(source), before);
  return { output, workspace, before };
}

function readSnapshot(db) {
  const rows = db.prepare(`SELECT f.id, f.source_file_id, f.source_loc, f.platform, f.raw_record,
    f.status, f.amount, f.direction ${EFFECTIVE_FLOW_FROM} ORDER BY f.id`).safeIntegers().all();
  const reasons = db.prepare(`SELECT p.fund_flow_id, p.reason_code FROM pending_reason p
    WHERE p.resolved_at IS NULL ORDER BY p.reason_code`).safeIntegers().all();
  const reasonsByFlow = new Map();
  for (const { fund_flow_id, reason_code } of reasons) {
    if (!reasonsByFlow.has(fund_flow_id)) reasonsByFlow.set(fund_flow_id, []);
    reasonsByFlow.get(fund_flow_id).push(reason_code);
  }
  return rows.map(row => ({ ...row, reasonCodes: reasonsByFlow.get(row.id) ?? [] }));
}

function counts(rows) {
  return [rows.length, rows.filter(row => row.status === 'pending').length, rows.filter(row => row.amount === null).length,
    rows.reduce((total, row) => total + row.reasonCodes.length, 0)];
}

function cents(rawValue) {
  const parts = /^(-?)(\d+)(?:\.(\d{1,2}))?$/u.exec(rawValue);
  assert.ok(parts && parts[0] === rawValue);
  const [, sign, whole, fraction = ''] = parts;
  const integer = 100n * BigInt(whole) + BigInt(fraction.padEnd(2, '0'));
  return sign === '-' ? -integer : integer;
}

function yuan(amount) {
  return `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
}

async function checkWorkbook(filePath, targets) {
  const book = new Excel.Workbook();
  await book.xlsx.readFile(filePath);
  const sheet = book.getWorksheet('流水明细');
  const headings = sheet.getRow(1).values;
  assert.equal(sheet.columnCount, 46);
  const value = (row, heading) => row.getCell(headings.indexOf(heading)).value;
  let pending = 0, amountBlank = 0, reasons = 0, rows = 0;
  const matched = new Set();
  sheet.eachRow((row, number) => {
    if (number === 1) return;
    rows++;
    const status = value(row, '证据状态（规则）');
    const amount = value(row, '标准金额（元）');
    const reasonCodes = value(row, '全部待核原因码');
    if (status === '待核') pending++;
    if (amount === null) amountBlank++;
    if (reasonCodes) reasons += reasonCodes.split('\n').length;
    const coordinate = value(row, 'source_loc 原文');
    if (value(row, '平台') !== bank || !targets.has(coordinate)) return;
    assert.ok(!matched.has(coordinate));
    matched.add(coordinate);
    assert.equal(status, '待核');
    assert.equal(amount, null);
    assert.equal(value(row, '标准方向'), null);
    assert.equal(reasonCodes, signReason);
  });
  assert.deepEqual([...matched].sort(), [...targets.keys()].sort());
  assert.deepEqual([rows, pending, amountBlank, reasons], originalCounts);
  const explanation = book.getWorksheet('导出说明').getColumn(2).values;
  assert.ok(explanation.some(value => typeof value === 'string' && /规则.*结果/u.test(value) && value.includes('人工复核')));
}

let stage = '复制验收库';
async function run(sourcePath, outputPath) {
  assert.ok(sourcePath && outputPath);
  const source = fs.realpathSync(sourcePath);
  const { workspace, output, before } = copyWorkspace(source, path.resolve(outputPath));
  const store = new WorkspaceStore({ schemaPath: path.resolve(__dirname, '../code/ddl_extract_check.sql') });
  let report;
  try {
    stage = '现有案件迁移与基线';
    const state = await store.openWorkspace(workspace, { allowCreate: false });
    assert.equal(state.cases.length, 1);
    const { id: caseId } = state.cases[0];
    await store.openCase(caseId);
    const data = new DesktopData(store);
    const record = store._caseRecord(caseId);
    const context = flowId => getReviewContext(store.caseDb, record, String(flowId));
    const snapshot = readSnapshot(store.caseDb);
    assert.deepEqual(counts(snapshot), originalCounts);
    assert.equal(store.caseDb.pragma('user_version', { simple: true }), 4);
    assert.equal(store.caseDb.prepare('SELECT count(*) FROM review_event').pluck().get(), 0);

    stage = '核对原件及连续余额';
    const fromBank = snapshot.filter(row => row.platform === bank && coordinates.includes(row.source_loc));
    assert.equal(fromBank.length, coordinates.length);
    const rows = coordinates.map(coordinate => fromBank.find(row => row.source_loc === coordinate));
    assert.ok(rows.every(row => row.source_file_id === rows[0].source_file_id));
    const archived = [];
    for (const row of rows) {
      const review = context(row.id);
      const raw = await data.readFlowSource(caseId, { flowId: review.flowId, dataVersion: review.dataVersion });
      assert.deepEqual(raw.values, JSON.parse(row.raw_record).values);
      assert.equal(raw.sourceLoc, row.source_loc);
      archived.push(raw.values);
    }
    assert.ok(archived.every(row => row[2] === archived[0][2]));
    const balances = archived.map(row => cents(row[15]));
    assert.deepEqual(balances, [73n, 207n, 398n]);
    const gaps = [balances[1] - balances[0], balances[2] - balances[1]];
    assert.deepEqual(gaps, [134n, 191n]);
    const targets = new Map();
    for (let index = 1; index < rows.length; index++) {
      const row = rows[index], original = archived[index], amount = gaps[index - 1];
      assert.deepEqual(row.reasonCodes, [signReason]);
      assert.equal(row.amount, null);
      assert.equal(row.status, 'pending');
      assert.equal(original[12], '消费退货');
      assert.equal(original[13], '借');
      assert.equal(cents(original[14]), -amount);
      targets.set(row.source_loc, { row, amount, to: balances[index], from: balances[index - 1] });
    }

    stage = '确认两笔并从第二次打开读取历史';
    for (const { row, amount, to, from } of targets.values()) {
      const review = context(row.id);
      const result = saveReview(store.caseDb, record, {
        flowId: review.flowId, dataVersion: review.dataVersion, requestId: randomUUID(),
        action: 'resolve', reasonId: review.resolveReasonId, amountText: yuan(amount), direction: '进',
        operator: '隔离验收', evidence: `原件相邻余额从 ${yuan(from)} 元增加至 ${yuan(to)} 元，差额为 +${yuan(amount)} 元。摘要为消费退货，原文为借方负额。`
      });
      assert.equal(result.event.after_amount, String(amount));
      assert.equal(result.event.after_status, 'confirmed');
    }
    store.close();
    await store.openWorkspace(workspace, { allowCreate: false });
    await store.openCase(caseId);
    const reviewed = readSnapshot(store.caseDb);
    assert.deepEqual(counts(reviewed), reviewedCounts);
    assert.deepEqual(store.caseDb.pragma('foreign_key_check'), []);
    const expectedRows = snapshot.map(row => {
      const target = targets.get(row.source_loc);
      if (!target || target.row.id !== row.id) return row;
      return { ...row, amount: target.amount, direction: '进', status: 'confirmed', reasonCodes: [] };
    });
    assert.deepEqual(reviewed, expectedRows);
    for (const { row, amount } of targets.values()) {
      const review = context(row.id);
      assert.equal(review.history.length, 1);
      assert.equal(review.history[0].after_amount, String(amount));
      assert.equal(review.history[0].after_direction, '进');
      assert.equal(review.history[0].reason_code, signReason);
      assert.ok(review.reasons[0].resolved_at);
      const raw = await data.readFlowSource(caseId, { flowId: review.flowId, dataVersion: review.dataVersion });
      assert.deepEqual(raw.values, JSON.parse(row.raw_record).values);
    }

    stage = '生成并回读规则底稿';
    const exportContext = data.getWorkpaperContext(caseId);
    const workbook = path.join(output, exportContext.fileName);
    const receipt = await data.exportWorkpaper(caseId, workbook, exportContext.dataVersion);
    assert.deepEqual([receipt.totalRows, receipt.pendingRows, receipt.unknownAmountRows], originalCounts.slice(0, 3));
    await checkWorkbook(workbook, targets);
    report = {
      originalCounts, reviewedCounts, workpaperCounts: originalCounts,
      confirmed: [...targets].map(([sourceLoc, { amount }]) => ({ sourceLoc, amount: `+${yuan(amount)}`, direction: '进' })),
      dataVersion: receipt.dataVersion, formatVersion: receipt.formatVersion,
      fileName: receipt.fileName, bytes: fs.statSync(workbook).size, sha256: sha256(workbook)
    };
  } finally {
    store.close();
  }
  stage = '确认原工作区文件未变动';
  assert.deepEqual(manifest(source), before);
  console.log(JSON.stringify(report));
}

run(...process.argv.slice(2)).catch(error => {
  // Error details may contain private evidence, coordinates, or file paths.
  const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code) ? error.code : 'VERIFY_FAILED';
  const line = /verify-manual-review\.cjs:(\d+):\d+/u.exec(error.stack || '')?.[1];
  console.error(`单笔复核验收失败 · ${stage} · ${code}${line ? ` · 第 ${line} 行` : ''}`);
  process.exitCode = 1;
});
