'use strict';

// Synthetic storage probe, deliberately separate from future M2 file parsing.
// Run: node scripts/run-electron-node.cjs scripts/benchmark-m0.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { WorkspaceStore } = require('../code/desktop/storage.cjs');
const { runCaseIntegrityTransaction } = require('../code/desktop/hardening.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts', 'm0-hardening-performance');
const schemaPath = path.join(root, 'code', 'ddl_extract_check.sql');
const rows = Number(process.argv[2] || 200000);
if (!Number.isSafeInteger(rows) || rows < 1 || rows > 1000000) throw new Error('Rows must be an integer from 1 to 1000000');
fs.mkdirSync(output, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fundsift-benchmark-'));
const stores = [], connections = [];
const mb = value => Number((value / 1024 / 1024).toFixed(2));

function configure(db) {
  db.pragma('foreign_keys=ON');
  db.pragma('journal_mode=WAL');
  db.pragma('synchronous=FULL');
}

function seedBase(db, record) {
  configure(db);
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  db.exec('CREATE TABLE desktop_case_identity (id INTEGER PRIMARY KEY CHECK (id = 1), case_uuid TEXT NOT NULL UNIQUE)');
  db.prepare('INSERT INTO case_info(id,case_no,case_name,created_at) VALUES(1,?,?,?)').run(record.case_no, record.case_name, record.created_at);
  db.prepare('INSERT INTO desktop_case_identity VALUES(1,?)').run(record.id);
}

function insertBatch(db, samples) {
  db.exec(`
    INSERT INTO format_rule(id,platform,format_key,amount_expr,source_unit,unit_scale) VALUES(1,'synthetic','benchmark','A','元',100);
    INSERT INTO source_file(id,case_id,file_name,file_sha256,status) VALUES(1,1,'synthetic.csv','synthetic-hash','pending');
    INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status) VALUES(1,1,1,'synthetic','probe-v1','importing');
  `);
  // Prepare is included in the timed transaction for all three variants.
  const insert = db.prepare(`INSERT INTO fund_flow
    (case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,raw_amount_text,amount,direction,status)
    VALUES(1,1,1,1,1,?,'1.00',100,'进','confirmed')`);
  for (let i = 1; i <= rows; i++) {
    insert.run('row-' + i);
    if (i % 10000 === 0) samples.push(process.memoryUsage().rss);
  }
  db.prepare("UPDATE import_batch SET status='done',total_rows=?,imported_rows=?,skipped_rows=0 WHERE id=1").run(rows, rows);
  db.exec("UPDATE source_file SET first_batch_id=1,current_batch_id=1,status='imported' WHERE id=1");
}

async function main() {
  const results = [];
  let v2Root, v2Id;
  for (const variant of ['v1-baseline', 'v1-when-zero', 'v2-transaction-summary']) {
    let db, record;
    if (variant === 'v2-transaction-summary') {
      v2Root = path.join(temp, 'workspace');
      const store = new WorkspaceStore({ schemaPath }); stores.push(store);
      await store.openWorkspace(v2Root);
      const item = await store.createCase({ name: '合成性能案', number: 'PERF-200K' });
      v2Id = item.id;
      record = { id: item.id, case_no: item.number, case_name: item.name, created_at: item.createdAt, updated_at: item.updatedAt };
      store.close();
      db = new Database(path.join(v2Root, 'cases', item.id, 'case.sqlite'));
      configure(db);
    } else {
      record = { id: randomUUID(), case_no: variant, case_name: variant, created_at: '2026-11-13T00:00:00.000Z' };
      db = new Database(path.join(temp, variant + '.sqlite'));
      seedBase(db, record);
      if (variant === 'v1-when-zero') db.exec('CREATE TRIGGER benchmark_empty BEFORE INSERT ON fund_flow WHEN 0 BEGIN SELECT 1; END');
    }
    connections.push(db);
    const rssBefore = process.memoryUsage().rss;
    const samples = [rssBefore];
    const started = performance.now();
    if (variant === 'v2-transaction-summary') runCaseIntegrityTransaction(db, record, () => insertBatch(db, samples));
    else db.transaction(() => insertBatch(db, samples)).immediate();
    const elapsedMs = performance.now() - started;
    samples.push(process.memoryUsage().rss);
    const result = { variant, rows, elapsedMs: Number(elapsedMs.toFixed(2)),
      rssBeforeMiB: mb(rssBefore), rssAfterMiB: mb(process.memoryUsage().rss), sampledPeakRssMiB: mb(Math.max(...samples)),
      processPeakRssMiB: Number((process.resourceUsage().maxRSS / 1024).toFixed(2)),
      databaseBytes: fs.statSync(db.name).size,
      walBytes: fs.existsSync(db.name + '-wal') ? fs.statSync(db.name + '-wal').size : 0,
      actualRows: db.prepare('SELECT count(*) n FROM fund_flow').get().n };
    if (variant === 'v2-transaction-summary') result.summary = db.prepare('SELECT files,flows,pending,valid,covered_version FROM case_summary').get();
    results.push(result);
    console.log(`${variant}: ${result.elapsedMs} ms; sampled peak ${result.sampledPeakRssMiB} MiB`);
    db.close();
  }
  // Only the script patches prepare; no production tracing option is introduced.
  const trace = [], originalPrepare = Database.prototype.prepare;
  Database.prototype.prepare = function(sql, ...args) {
    trace.push(sql);
    return originalPrepare.call(this, sql, ...args);
  };
  let listing;
  try {
    const store = new WorkspaceStore({ schemaPath }); stores.push(store);
    let started = performance.now();
    const state = await store.openWorkspace(v2Root, { allowCreate: false });
    const coldMs = performance.now() - started;
    if (state.cases.find(item => item.id === v2Id)?.stats.flows !== rows) throw new Error('Cold list did not preserve summary');
    const hotMs = [];
    for (let i = 0; i < 5; i++) {
      started = performance.now();
      const cases = await store.listCases();
      hotMs.push(Number((performance.now() - started).toFixed(2)));
      if (cases.find(item => item.id === v2Id)?.stats.flows !== rows) throw new Error('Warm list did not preserve summary');
    }
    const flowQueries = trace.filter(sql => /\b(?:FROM|JOIN|UPDATE|INTO)\s+["`\[]?fund_flow\b/i.test(sql));
    listing = { cases: 1, flowsInCase: rows, coldOpenAndListMs: Number(coldMs.toFixed(2)), hotListMs: hotMs,
      statements: trace.length, directFundFlowQueries: flowQueries.length,
      uniquePreparedSql: [...new Set(trace.map(sql => sql.replace(/\s+/g, ' ').trim()))] };
    if (flowQueries.length) throw new Error('List unexpectedly queried fund_flow: ' + flowQueries.join('\n'));
    store.close();
  } finally { Database.prototype.prepare = originalPrepare; }
  const report = {
    generatedAt: new Date().toISOString(), rows, synthetic: true,
    runtime: { electron: process.versions.electron, node: process.versions.node, sqlite: process.versions.sqlite || 'better-sqlite3 bundled', platform: process.platform, arch: process.arch },
    method: 'Sequential single-process, separate SQLite files; frozen real v1 DDL and identical flow indexes; WAL + synchronous FULL; prepare, insert, publish, commit timed in one immediate transaction. V2 also includes its current full validation and summary refresh.',
    limits: 'One synthetic run per variant, not a statistical benchmark. RSS includes Electron Node runtime and preceding allocations; sampled peaks are observations, not isolated per-variant ceilings. No parsing, archived files, IPC or interactive UI is included. This probes the explicit full integrity path, not the source/record scoped transaction added in 0.1.3; it does not accept M2 import performance.',
    results, listing
  };
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(output, 'list-queries.txt'), listing.uniquePreparedSql.join('\n\n') + '\n');
  console.log(`List cold ${listing.coldOpenAndListMs} ms; warm ${listing.hotListMs.join(', ')} ms; flow queries ${listing.directFundFlowQueries}`);
  console.log('Results:', path.join(output, 'result.json'));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const store of stores) store.close();
  for (const db of connections) if (db.open) db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
