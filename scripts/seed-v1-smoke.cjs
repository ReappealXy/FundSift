'use strict';

// Synthetic legacy fixture for the actual desktop/portable migration smoke run.
// Invoke through run-electron-node.cjs so better-sqlite3 uses the Electron ABI.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const root = path.resolve(process.argv[2]);
const profile = path.resolve(process.argv[3]);
if (fs.existsSync(root)) throw new Error('Legacy fixture requires a new directory');
const id = randomUUID(), created = '2026-11-01T00:00:00.000Z', updated = '2026-11-02T00:00:00.000Z';
const directory = path.join(root, 'cases', id);
fs.mkdirSync(directory, { recursive: true });
fs.mkdirSync(path.join(directory, 'archive')); fs.mkdirSync(path.join(directory, 'exports'));
const catalog = new Database(path.join(root, 'workspace.sqlite'));
catalog.exec(`CREATE TABLE workspace_case (
  id TEXT PRIMARY KEY, case_no TEXT NOT NULL UNIQUE, case_name TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_opened_at TEXT
); PRAGMA application_id=1179866963; PRAGMA user_version=1;`);
catalog.prepare('INSERT INTO workspace_case VALUES(?,?,?,?,?,?,?)').run(id, 'LEGACY-SMOKE-001', '旧版合成验收案', `cases/${id}/case.sqlite`, created, updated, created);
catalog.close();
const db = new Database(path.join(directory, 'case.sqlite'));
db.exec(fs.readFileSync(path.resolve(__dirname, '../code/ddl_extract_check.sql'), 'utf8'));
db.exec('CREATE TABLE desktop_case_identity (id INTEGER PRIMARY KEY CHECK (id = 1), case_uuid TEXT NOT NULL UNIQUE)');
db.prepare('INSERT INTO case_info(id,case_no,case_name,created_at) VALUES(1,?,?,?)').run('LEGACY-SMOKE-001', '旧版合成验收案', created);
db.prepare('INSERT INTO desktop_case_identity VALUES(1,?)').run(id);
db.exec(`PRAGMA application_id=1179861825; PRAGMA user_version=1;
  INSERT INTO format_rule(id,platform,format_key,amount_expr,source_unit,unit_scale) VALUES(1,'synthetic','legacy','A','元',100);
  INSERT INTO source_file(id,case_id,file_name,file_sha256,status) VALUES(1,1,'legacy-synthetic.csv','synthetic-hash','imported');
  INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status,total_rows,imported_rows,skipped_rows) VALUES(1,1,1,'2026-11-02','synthetic-v1','done',1,1,0);
  UPDATE source_file SET first_batch_id=1,current_batch_id=1 WHERE id=1;
  INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,raw_amount_text,amount,direction,status) VALUES(1,1,1,1,1,'row1','123.45',12345,'进','confirmed');`);
db.close();
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'workspace.json'), JSON.stringify({ version: 1, workspacePath: root, currentCaseId: id }));
fs.writeFileSync(path.join(profile, 'legacy-fixture.json'), JSON.stringify({ id, updated }));
console.log('Created independent synthetic v1 workspace');
