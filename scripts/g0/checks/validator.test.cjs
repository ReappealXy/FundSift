'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createFixture,createReleaseFixture,digest,approved,unreviewed} = require('./fixture.cjs');
const {validateDataset,int64} = require('../validate.cjs');
const project = path.resolve(__dirname, '../../..');

async function check(f, options = {}) {
  f.save();
  return validateDataset(f.bundlePath, {sourceRoot:f.sourceRoot,...options});
}
function rejected(report) {
  assert.equal(report.ok, false, JSON.stringify(report));
  assert.ok(Array.isArray(report.errors) && report.errors.length > 0, 'A rejection explains its cause');
  assert.equal(report.ready_for_m1, false);
}
function pending(f, code = 'amount_missing') {
  const row = f.answer;
  row.layer = 'B'; row.expected.status = 'pending';
  row.expected.pending_reason = [{reason_code:code,detail:'纯合成待核原因'}];
}
function repinReleaseBundle(f) {
  f.bundle.answers_sha256=digest(fs.readFileSync(f.answersPath));
  f.bundle.schema_sha256=digest(fs.readFileSync(path.join(project,'schemas/g0/bundle.schema.json')));
  f.bundle.matrix_sha256=digest(fs.readFileSync(path.join(project,'schemas/g0/coverage-matrix.json')));
  f.save();
  return digest(fs.readFileSync(f.bundlePath));
}

test('最小合法草稿通过，但不能宣告M1基准就绪', async t => {
  const f=createFixture(t),r=await check(f);
  assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.ready_for_m1,false);
});

test('空模板只代表结构草稿，正式冻结检查必须拒绝', async () => {
  const file=path.join(project,'docs/g0/templates/bundle.json');
  const draft=await validateDataset(file);
  assert.equal(draft.ok,true,JSON.stringify(draft));assert.equal(draft.ready_for_m1,false);
  rejected(await validateDataset(file,{release:true}));
});

test('缺字段与未知字段均不能被静默忽略', async t => {
  const f=createFixture(t);delete f.answer.basis;rejected(await check(f));
  f.answer.basis='合成依据';f.answer.expected.silent_default=true;rejected(await check(f));
});

test('同文件坐标重复，即使内容相同也拒绝', async t => {
  const f=createFixture(t);f.answers.push(structuredClone(f.answer));f.source.observations.data_records=2;f.source.observations.logical_records=2;
  rejected(await check(f));
});

test('非数据行计数与逻辑总数不一致时拒绝', async t => {
  const f=createFixture(t);f.source.observations.header_records=1;
  rejected(await check(f));
});

test('答案行数不能少于登记的数据记录数', async t => {
  const f=createFixture(t);f.source.observations.data_records=2;f.source.observations.logical_records=2;
  rejected(await check(f));
});

test('源文件字节变化时哈希核对拒绝，原件不被改写', async t => {
  const f=createFixture(t);const changed=Buffer.from('tampered!\n');fs.writeFileSync(f.sourcePath,changed);
  rejected(await check(f));assert.ok(fs.readFileSync(f.sourcePath).equals(changed));
});

test('文件大小登记错误和答案引用旧哈希分别拒绝', async t => {
  const f=createFixture(t);f.source.size++;rejected(await check(f));
  f.source.size--;f.answer.source_sha256='0'.repeat(64);rejected(await check(f));
});

test('已声明答案文件哈希不匹配时拒绝', async t => {
  const f=createFixture(t);f.bundle.answers_sha256='0'.repeat(64);rejected(await check(f));
});

test('材料、规则和规则版本必须能精确关联', async t => {
  const f=createFixture(t);f.answer.source_id='not-registered';rejected(await check(f));
  f.answer.source_id='s1';f.answer.rule_version=2;rejected(await check(f));
  f.answer.rule_version=1;f.source.rule_id='not-registered';rejected(await check(f));
});

test('元分倍率配对不允许靠默认值猜测', async t => {
  const f=createFixture(t);f.rule.source_unit='分';rejected(await check(f));
});

test('小数分和超安全整数的标准金额都拒绝', async t => {
  const f=createFixture(t);f.answer.expected.amount=-0.5;rejected(await check(f));
  f.answer.expected.amount=Number.MAX_SAFE_INTEGER+1;rejected(await check(f));
});

test('JSON数字原文小数不能被浮点舍入伪装成整数', async t => {
  const f=createFixture(t);f.save();
  const text=JSON.stringify(f.answer).replace('"amount":-100','"amount":-100.00000000000000001');
  fs.writeFileSync(f.answersPath,text+'\n');
  rejected(await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot}));
});

test('SQLite int64边界以十进制字符串无损表示，越界和非规范文本拒绝', async t => {
  const f=createFixture(t);f.answer.expected.amount='-9223372036854775808';
  f.answer.raw.raw_amount_text='-92233720368547758.08';
  const r=await check(f);assert.equal(r.ok,true,JSON.stringify(r));
  for(const invalid of ['-9223372036854775809','9223372036854775808','01','-0','1e3','1.0']){
    f.answer.expected.amount=invalid;rejected(await check(f));
  }
});

test('标准金额符号和方向冲突时拒绝', async t => {
  const f=createFixture(t);f.answer.expected.direction='进';rejected(await check(f));
});

test('confirmed不能带未知金额或未解除阻断原因', async t => {
  const f=createFixture(t);f.answer.expected.amount=null;rejected(await check(f));
  f.answer.expected.amount=-100;f.answer.expected.pending_reason=[{reason_code:'time_missing',detail:'待核时间'}];rejected(await check(f));
});

test('pending必须有具体原因而非空数组或空白原因', async t => {
  const f=createFixture(t);f.answer.layer='B';f.answer.expected.status='pending';rejected(await check(f));
  f.answer.expected.pending_reason=[{reason_code:' ',detail:' '}];rejected(await check(f));
});

test('金额未知用null保持合法，不能冒充零金额', async t => {
  const f=createFixture(t);pending(f);f.answer.raw.raw_amount_text=null;f.answer.expected.amount=null;f.answer.expected.direction=null;
  const r=await check(f);assert.equal(r.ok,true,JSON.stringify(r));
});

test('缺交易时间但金额可靠时保留金额和方向，整行继续pending', async t => {
  const f=createFixture(t);pending(f,'time_missing');f.answer.raw.txn_time_text=null;f.answer.expected.txn_time=null;
  const r=await check(f);assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(f.answer.expected.amount,-100);assert.equal(f.answer.expected.direction,'出');
});

test('已解决问题必须同时具有决定、决定者和时间', async t => {
  const f=createFixture(t);
  f.bundle.questions.push({id:'q1',status:'resolved',question:'合成零值策略如何决定',affected:[{source_id:'s1',source_loc:'1'}],options:['待核','确认'],recommendation:'待核',decision:null,decided_by:null,decided_at:null});
  f.answer.question_ids=['q1'];rejected(await check(f));
});

test('答案所引用的问题和问题影响坐标必须存在', async t => {
  const f=createFixture(t);f.answer.question_ids=['missing-question'];rejected(await check(f));
  f.answer.question_ids=[];
  f.bundle.questions.push({id:'q1',status:'open',question:'纯合成问题',affected:[{source_id:'s1',source_loc:'999'}],options:['甲','乙'],recommendation:null,decision:null,decided_by:null,decided_at:null});
  rejected(await check(f));
});

test('批准记录不能仅改status而不留裁决身份和依据', async t => {
  const f=createFixture(t);f.answer.review.status='approved';rejected(await check(f));
});

test('未知格式是文件级结果，不伪造fund_flow行凑数', async t => {
  const f=createFixture(t);f.source.disposition='unrecognized';f.source.format='unknown';f.source.rule_id=null;f.source.rule_version=null;
  f.source.observations.data_records=0;f.source.observations.other_non_data_records=1;f.answers.length=0;
  const r=await check(f);assert.equal(r.ok,true,JSON.stringify(r));
  f.answers.push(structuredClone(createFixture(t).answer));rejected(await check(f));
});

test('答案或原件相对路径不能逃出明确的根目录', async t => {
  const f=createFixture(t);f.bundle.answers_file='../outside.jsonl';rejected(await check(f));
  f.bundle.answers_file='answers.jsonl';f.source.path='../outside.txt';rejected(await check(f));
});

test('覆盖项必须存在且不能给明显不匹配的A类记录贴D冲突标签', async t => {
  const f=createFixture(t);f.answer.coverage=['invented-case'];rejected(await check(f));
  f.answer.coverage=['d_both_nonzero'];rejected(await check(f));
});

test('余额失败独立于金额confirmed，差额校验不能自动改向', async t => {
  const f=createFixture(t);const first=f.answer,second=f.addAnswer();
  f.rule.balance_scope='asset_ledger';f.rule.balance_same_direction=true;
  first.expected.balance_scope='asset_ledger';first.expected.balance=1000;first.raw.raw_balance_text='10.00';
  second.raw.raw_amount_text='1.00';second.raw.raw_balance_text='12.00';second.expected.amount=100;second.expected.direction='进';
  second.expected.balance_scope='asset_ledger';second.expected.balance=1200;
  second.expected.balance_check={status:'fail',comparable:true,reason:'预期1100分，实际1200分，差100分',previous:{source_id:'s1',source_loc:'1'},expect_balance:1100,diff:100,segment_complete:true,order:'stable'};
  second.layer='B';second.review=approved();f.setSourceText('-1.00,10.00\n1.00,12.00\n');
  const r=await check(f);assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(second.expected.status,'confirmed');assert.equal(second.expected.amount,100);
  second.expected.balance_check.diff=0;rejected(await check(f));
});

test('没有前项、余额口径非资产或顺序未知不能宣告pass', async t => {
  const f=createFixture(t);f.answer.expected.balance_check.status='pass';f.answer.expected.balance_check.comparable=true;
  rejected(await check(f));
});

test('冻结模式需要独立外部bundle哈希，不能只信内部自述', async t => {
  const f=createFixture(t);f.bundle.state='frozen';f.answer.review=approved();
  rejected(await check(f,{release:true}));
  const r=await check(f,{release:true,expectedBundleSha256:'0'.repeat(64)});rejected(r);
});

test('即使外部bundle哈希正确，未覆盖全矩阵也不能冻结', async t => {
  const f=createFixture(t);f.bundle.state='frozen';f.answer.review=approved();f.save();
  rejected(await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:digest(fs.readFileSync(f.bundlePath))}));
});

test('CLI对失败契约返回非零状态，对草稿保持可识别JSON输出', t => {
  const f=createFixture(t);
  const ok=spawnSync(process.execPath,[path.join(project,'scripts/g0/validate.cjs'),f.bundlePath,'--source-root',f.sourceRoot,'--json'],{encoding:'utf8',windowsHide:true});
  assert.equal(ok.status,0,ok.stderr+ok.stdout);assert.equal(JSON.parse(ok.stdout).ready_for_m1,false);
  f.answer.expected.direction='进';f.save();
  const bad=spawnSync(process.execPath,[path.join(project,'scripts/g0/validate.cjs'),f.bundlePath,'--source-root',f.sourceRoot,'--json'],{encoding:'utf8',windowsHide:true});
  assert.notEqual(bad.status,0);assert.equal(JSON.parse(bad.stdout).ok,false);
});

test('纯合成完整冻结夹具走通41覆盖和五角色准入，但不是实际G0证据', async t => {
  const f=createReleaseFixture(t),r=await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:f.expectedBundleSha256});
  assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.ready_for_m1,true);assert.equal(r.counts.coverage,41);
});

test('完整冻结基准删去覆盖见证或真实角色即拒绝', async t => {
  const f=createReleaseFixture(t);f.pairs.get('rounding').row.coverage=[];
  rejected(await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:f.pin()}));
  f.pairs.get('rounding').row.coverage=['rounding_yuan'];f.pairs.get('amount-c').source.kind='synthetic';
  rejected(await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:f.pin()}));
});

test('冻结B层未批准、A层未抽查和生成器哈希变化分别拒绝', async t => {
  const f=createReleaseFixture(t),b=f.pairs.get('missing-time').row;
  b.review=unreviewed();
  rejected(await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:f.pin()}));
  b.review=approved();f.ordinaryA.review=unreviewed();
  rejected(await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:f.pin()}));
  f.ordinaryA.review=approved();const hash=f.pin();fs.appendFileSync(path.join(f.root,'synthetic-generator.cjs'),'// changed\n');
  rejected(await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:hash}));
});

test('越界余额int64在前项链中返回拒绝报告，不抛异常', async t => {
  const f=createReleaseFixture(t);f.pairs.get('asset-previous').row.expected.balance='9223372036854775808';
  const report=await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:f.pin()});
  rejected(report);
});

test('JSON重复键不能按最后值覆盖而静默通过', async t => {
  const f=createFixture(t);f.save();
  fs.writeFileSync(f.answersPath,JSON.stringify(f.answer).replace('"amount":-100','"amount":0,"amount":-100')+'\n');
  rejected(await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot}));
});

test('本地时间非法日期和逻辑坐标超出登记范围均拒绝', async t => {
  const f=createFixture(t);f.answer.expected.txn_time='2026-02-30 08:00:00';rejected(await check(f));
  f.answer.expected.txn_time='2026-11-18 08:00:00';f.answer.source_loc='2';rejected(await check(f));
});

test('余额前项不能晚于本项、混用余额口径或组成循环', async t => {
  const f=createReleaseFixture(t),prev=f.pairs.get('asset-previous').row,current=f.pairs.get('asset-fail').row;
  prev.expected.txn_time='2026-11-18 08:00:01';
  rejected(await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:f.pin()}));
  prev.expected.txn_time='2026-11-18 08:00:00';prev.expected.balance_scope='unknown';f.pairs.get('asset-previous').rule.balance_scope='unknown';f.pairs.get('asset-previous').rule.balance_same_direction=false;
  rejected(await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:f.pin()}));
  prev.expected.balance_scope='asset_ledger';f.pairs.get('asset-previous').rule.balance_scope='asset_ledger';f.pairs.get('asset-previous').rule.balance_same_direction=true;
  prev.expected.balance_check.previous={source_id:current.source_id,source_loc:current.source_loc};
  rejected(await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:f.pin()}));
});

test('原文明确外币时不能静默改成CNY，即使没有覆盖标签也拒绝', async t => {
  const f=createFixture(t);f.answer.raw.currency_text='USD';f.answer.expected.currency='CNY';
  assert.deepEqual(f.answer.coverage,[]);rejected(await check(f));
});

test('两笔账户均缺失不能仅因null相等就判余额可比通过', async t => {
  const f=createReleaseFixture(t),prev=f.pairs.get('asset-previous').row,current=f.pairs.get('asset-fail').row;
  for(const row of [prev,current]){
    row.raw.acct_no=null;row.expected.acct_no=null;row.expected.status='pending';
    row.expected.pending_reason=[{reason_code:'account_missing',detail:'合成记录所属账户未知'}];
    row.coverage=[];
  }
  prev.expected.balance_check.previous=null;
  current.expected.balance=1100;current.raw.raw_balance_text='11.00';
  current.expected.balance_check.status='pass';current.expected.balance_check.diff=0;
  f.bundle.state='draft';f.bundle.answers_sha256=null;f.bundle.schema_sha256=null;f.bundle.matrix_sha256=null;f.save();
  rejected(await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot}));
});

test('同案同SHA256不能登记为两个不同source身份', async t => {
  const f=createFixture(t),secondSource=structuredClone(f.source),secondAnswer=structuredClone(f.answer);
  secondSource.id='duplicate-material';secondAnswer.source_id=secondSource.id;
  f.bundle.sources.push(secondSource);f.answers.push(secondAnswer);
  rejected(await check(f));
});

test('案件B角色必须有真实冲回见证，不能仅靠角色名称和普通覆盖准入', async t => {
  const f=createReleaseFixture(t),caseB=f.pairs.get('amount-b');
  caseB.row.expected.reversal_flag=0;caseB.row.coverage=['amount_b'];
  // Keep the aggregate matrix complete via another, explicitly synthetic
  // reversal witness; the rejection must concern the real case-B role itself.
  const s=structuredClone(caseB.source),r=structuredClone(caseB.rule),row=structuredClone(caseB.row);
  s.id='s-synthetic-reversal';s.kind='synthetic';s.sample_role='boundary';s.path='synthetic-extra-reversal.txt';s.file_name=s.path;s.rule_id='r-synthetic-reversal';
  r.id=s.rule_id;r.format_key='synthetic-extra-reversal';row.source_id=s.id;row.format_rule_id=r.id;row.expected.reversal_flag=1;
  row.coverage=['reversal_b','sign_conflict_defined'];f.bundle.sources.push(s);f.bundle.rules.push(r);f.answers.push(row);
  rejected(await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:f.pin()}));
});

test('冻结release每个原件都带独立记录索引和可核验提取器', async t => {
  const f=createReleaseFixture(t);
  for(const source of f.bundle.sources){
    assert.ok(source.record_index);
    assert.ok(fs.existsSync(path.join(f.root,source.record_index.path)));
    assert.equal(source.record_index.extractor.independent_of_parser,true);
  }
  const r=await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:f.expectedBundleSha256});
  assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.ready_for_m1,true);
});

test('记录索引字节被篡改且未更新SHA256时拒绝', async t => {
  const f=createReleaseFixture(t),source=f.pairs.get('amount-a').source;
  fs.appendFileSync(path.join(f.root,source.record_index.path),'tampered\n');
  rejected(await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:f.expectedBundleSha256}));
});

test('索引与答案都各自有hash但data坐标不一致时拒绝', async t => {
  const f=createReleaseFixture(t),source=f.pairs.get('amount-a').source;
  f.pin();
  const indexPath=path.join(f.root,source.record_index.path);
  const index=fs.readFileSync(indexPath,'utf8').replace('SyntheticSheet!1','SyntheticSheet!9');
  fs.writeFileSync(indexPath,index);source.record_index.sha256=digest(Buffer.from(index));
  const pin=repinReleaseBundle(f);
  rejected(await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:pin}));
});

test('冻结索引声明独立性false时拒绝，即使所有内容哈希正确', async t => {
  const f=createReleaseFixture(t),source=f.pairs.get('amount-b').source;
  source.record_index.extractor.independent_of_parser=false;
  const pin=repinReleaseBundle(f);
  rejected(await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:pin}));
});

test('规则卡声明负值待核时，不能仅加B层批准就确认为普通支出', async t => {
  const f=createFixture(t);
  Object.assign(f.rule,{amount_expr:'E',direction_map:{'支出':'出'},negative_policy:'pending'});
  f.answer.raw.raw_direction='支出';f.answer.raw.raw_amount_text='-1.00';
  f.answer.layer='B';f.answer.review=approved();
  rejected(await check(f));
  f.answer.expected.status='pending';
  f.answer.expected.pending_reason=[{reason_code:'negative_sign_undefined',detail:'E类格式尚未定义负值语义，保留已知文本等待规则裁决'}];
  const r=await check(f);assert.equal(r.ok,true,JSON.stringify(r));
});

test('ISO币种比较忽略首尾空格与大小写，不能借小写外币替换成CNY', async t => {
  const f=createFixture(t);
  for(const raw of ['usd',' UsD ','\tusd\n']) {
    f.answer.raw.currency_text=raw;f.answer.expected.currency='CNY';
    rejected(await check(f));
    f.answer.expected.currency='USD';
    const r=await check(f);assert.equal(r.ok,true,JSON.stringify(r));
    assert.equal(f.answer.raw.currency_text,raw,'Comparison must preserve raw evidence verbatim');
  }
});

test('非CNY币种必须有原始证据，不能靠verified_cny推断USD', async t => {
  const f=createFixture(t);f.answer.expected.currency='USD';
  for(const policy of ['explicit','verified_cny','unverified']) {
    f.rule.currency_policy=policy;
    for(const raw of [null,'',' ']) {f.answer.raw.currency_text=raw;rejected(await check(f));}
  }
});

test('缺币种证据时仅已批准的verified_cny允许声明CNY', async t => {
  const f=createFixture(t);f.answer.raw.currency_text=null;
  for(const policy of ['explicit','unverified']) {f.rule.currency_policy=policy;rejected(await check(f));}
  f.rule.currency_policy='verified_cny';
  const accepted=await check(f);assert.equal(accepted.ok,true,JSON.stringify(accepted));
  f.rule.review=unreviewed();rejected(await check(f));
});

test('非ISO币种原文不能当作任意币种的证据，未知保持null待核', async t => {
  const f=createFixture(t);f.rule.currency_policy='verified_cny';
  for(const raw of ['美元','人民币','???']) {
    f.answer.raw.currency_text=raw;f.answer.expected.currency='CNY';
    rejected(await check(f));
    f.answer.expected.currency='USD';rejected(await check(f));
    pending(f,'currency_unknown');f.answer.expected.currency=null;
    const r=await check(f);assert.equal(r.ok,true,JSON.stringify(r));
  }
});

test('外币覆盖见证使用相同ISO比较规则并保留原文', async t => {
  const f=createFixture(t);f.answer.raw.currency_text=' usd ';f.answer.expected.currency='USD';
  pending(f,'currency_unsupported');f.answer.coverage=['currency_foreign'];
  const r=await check(f);assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(f.answer.raw.currency_text,' usd ');
});

test('int64自身拒绝非规范文本、非整数和不安全数字，不依赖schema兜底', () => {
  for(const invalid of [' 100 ','100\n','100\r\n','+100','007','-0','1.0','1e3','',true,false,undefined,100.5,Number.MAX_SAFE_INTEGER+1,NaN,Infinity,-0])
    assert.throws(()=>int64(invalid),`Direct int64 rejection: ${String(invalid)}`);
  for(const value of [0,1,-100,Number.MAX_SAFE_INTEGER,'0','-100','9223372036854775807','-9223372036854775808'])
    assert.equal(int64(value),BigInt(value));
  assert.equal(int64(null),null);
  for(const value of ['9223372036854775808','-9223372036854775809'])assert.throws(()=>int64(value));
});

test('旧schema或matrix版本不能在新41项契约中静默继续使用', async t => {
  const f=createFixture(t);
  f.bundle.schema_version=1;
  let r=await check(f);rejected(r);assert.ok(r.errors.some(e=>e.code==='SCHEMA'));
  for(const schemaVersion of [1,2,3])for(const matrixVersion of [1,2,3,4]) {
    if(schemaVersion===3&&matrixVersion===4)continue;
    f.bundle.schema_version=schemaVersion;f.bundle.matrix_version=matrixVersion;
    r=await check(f);rejected(r);assert.ok(r.errors.some(e=>e.code==='SCHEMA'));
  }
  f.bundle.schema_version=3;f.bundle.matrix_version=4;
  r=await check(f);assert.equal(r.ok,true,JSON.stringify(r));
});

test('时区标记覆盖要求保留原文并以未知本地时间待核', async t => {
  const f=createFixture(t);pending(f,'timezone_marker');f.answer.expected.txn_time=null;
  f.answer.coverage=['time_timezone_marker'];
  for(const raw of ['2026-03-01T10:00:00+08:00','2026-03-01T02:00:00Z']) {
    f.answer.raw.txn_time_text=raw;
    const r=await check(f);assert.equal(r.ok,true,JSON.stringify(r));
  }
  f.answer.raw.txn_time_text='2026-03-01 10:00:00';
  const noMarker=await check(f);rejected(noMarker);assert.ok(noMarker.errors.some(e=>e.code==='COVERAGE'));
  f.answer.raw.txn_time_text='2026-03-01T10:00:00+08:00';f.answer.expected.txn_time='2026-03-01 10:00:00';
  rejected(await check(f));
  f.answer.expected.status='confirmed';f.answer.expected.pending_reason=[];
  rejected(await check(f));
});

test('不可解析金额覆盖要求非空非十进制原文，未知不能冒充零', async t => {
  const f=createFixture(t);pending(f,'amount_unparseable');
  f.answer.coverage=['amount_unparseable'];f.answer.expected.amount=null;f.answer.expected.direction=null;
  for(const raw of ['N/A','—','１２３']) {
    f.answer.raw.raw_amount_text=raw;
    const r=await check(f);assert.equal(r.ok,true,JSON.stringify(r));
  }
  for(const raw of [null,'',' ','1.00','0','-1,000.20']) {
    f.answer.raw.raw_amount_text=raw;
    const invalid=await check(f);rejected(invalid);
    if(raw===null||raw.trim())assert.ok(invalid.errors.some(e=>e.code==='COVERAGE'));
  }
  f.answer.raw.raw_amount_text='N/A';f.answer.expected.amount=0;
  rejected(await check(f));
});

test('正式41项基准缺少任一新增覆盖即拒绝', async t => {
  const f=createReleaseFixture(t);
  for(const [pair,coverage] of [['time-timezone','time_timezone_marker'],['amount-unparseable','amount_unparseable'],['time-ambiguous','time_ambiguous'],['currency-mapped','currency_mapped_cny']]) {
    f.pairs.get(pair).row.coverage=[];
    const r=await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:f.pin()});
    rejected(r);assert.ok(r.errors.some(e=>e.code==='COVERAGE'&&e.at===coverage));
    f.pairs.get(pair).row.coverage=[coverage];
  }
});

test('删除时区与不可解析金额标签也不能静默转换时间或猜测金额', async t => {
  const f=createFixture(t);f.answer.layer='B';f.answer.review=approved();
  assert.deepEqual(f.answer.coverage,[]);
  f.answer.raw.txn_time_text='2026-03-01T10:00:00+08:00';
  f.answer.expected.txn_time='2026-03-01 10:00:00';
  const timezone=await check(f);rejected(timezone);assert.ok(timezone.errors.some(e=>e.code==='TIME'));
  f.answer.raw.txn_time_text='2026-11-18 08:00:00';f.answer.expected.txn_time='2026-11-18 08:00:00';
  f.answer.raw.raw_amount_text='N/A';
  const amount=await check(f);rejected(amount);assert.ok(amount.errors.some(e=>e.code==='PENDING'));
});

test('仅小时ISO时区偏移仍需保留原文待核，不能删标签后写成本地时间', async t => {
  const f=createFixture(t);pending(f,'timezone_marker');f.answer.expected.txn_time=null;
  for(const raw of ['2026-03-01T10:00:00+08','2026-03-01T10:00:00-05']) {
    f.answer.raw.txn_time_text=raw;f.answer.coverage=['time_timezone_marker'];
    const valid=await check(f);assert.equal(valid.ok,true,JSON.stringify(valid));
    f.answer.coverage=[];f.answer.expected.txn_time='2026-03-01 10:00:00';
    const changed=await check(f);rejected(changed);assert.ok(changed.errors.some(e=>e.code==='TIME'));
    f.answer.expected.txn_time=null;
  }
});

test('D类实际收支列含不可解析文本时必须金额未知待核，不能被另一正常列掩盖', async t => {
  const f=createFixture(t);
  Object.assign(f.rule,{amount_expr:'D',direction_map:{},negative_policy:'column_defined'});
  f.answer.raw.raw_amount_text=null;f.answer.raw.raw_expense_text='N/A';
  f.answer.layer='B';f.answer.review=approved();
  for(const income of [null,'1.00']) {
    f.answer.raw.raw_income_text=income;f.answer.coverage=[];
    f.answer.expected.amount=-100;f.answer.expected.direction='出';
    f.answer.expected.status='confirmed';f.answer.expected.pending_reason=[];
    const guessed=await check(f);rejected(guessed);assert.ok(guessed.errors.some(e=>e.code==='PENDING'));
    pending(f,'amount_unparseable');f.answer.expected.amount=null;f.answer.expected.direction=null;
    f.answer.coverage=['amount_unparseable'];
    const valid=await check(f);assert.equal(valid.ok,true,JSON.stringify(valid));
  }
});

test('非D类不可解析单金额不能借无关双列字段编造标准金额', async t => {
  const f=createFixture(t);f.answer.layer='B';f.answer.review=approved();
  f.answer.raw.raw_amount_text='N/A';f.answer.raw.raw_income_text='1.00';
  assert.deepEqual(f.answer.coverage,[]);
  const guessed=await check(f);rejected(guessed);assert.ok(guessed.errors.some(e=>e.code==='PENDING'));
  pending(f,'amount_unparseable');f.answer.expected.amount=null;f.answer.expected.direction=null;
  f.answer.coverage=['amount_unparseable'];
  const valid=await check(f);assert.equal(valid.ok,true,JSON.stringify(valid));
});

test('币种映射为规则卡必填字段，不允许旧规则靠省略获得默认映射', async t => {
  const f=createFixture(t);delete f.rule.currency_map;
  const r=await check(f);rejected(r);assert.ok(r.errors.some(e=>e.code==='SCHEMA'));
});

test('已批准的格式币种映射识别中文和数字别名，首尾空白比较不改写原文', async t => {
  const f=createFixture(t);f.rule.currency_map={'人民币':'CNY','156':'CNY'};
  for(const raw of ['人民币','156',' 人民币 ','\t156\n']) {
    f.answer.raw.currency_text=raw;
    const r=await check(f);assert.equal(r.ok,true,JSON.stringify(r));
    assert.equal(f.answer.raw.currency_text,raw,'Mapping comparison preserves the evidence');
    assert.equal(f.answer.expected.currency,'CNY');
  }
  assert.equal(f.answer.layer,'A','Approved mapping may classify ordinary rows under their bound rule');
});

test('未批准的币种映射不能充当币种证据，草稿只能保留未知待核', async t => {
  const f=createFixture(t);f.rule.currency_map={'人民币':'CNY'};
  f.rule.review=unreviewed();f.answer.raw.currency_text='人民币';
  const guessed=await check(f);rejected(guessed);assert.ok(guessed.errors.some(e=>e.code==='CURRENCY'));
  pending(f,'currency_unverified');f.answer.expected.currency=null;
  const draft=await check(f);assert.equal(draft.ok,true,JSON.stringify(draft));
  assert.equal(draft.ready_for_m1,false);
});

test('映射未命中不能退回verified_cny或使用继承属性猜币种', async t => {
  const f=createFixture(t);f.rule.currency_policy='verified_cny';f.rule.currency_map={'人民币':'CNY'};
  for(const raw of ['人 民 币','人民币元','constructor','toString','__proto__']) {
    f.answer.raw.currency_text=raw;f.answer.expected.currency='CNY';
    f.answer.layer='A';f.answer.expected.status='confirmed';f.answer.expected.pending_reason=[];
    const guessed=await check(f);rejected(guessed);assert.ok(guessed.errors.some(e=>e.code==='CURRENCY'));
    pending(f,'currency_unknown');f.answer.expected.currency=null;
    const unknown=await check(f);assert.equal(unknown.ok,true,JSON.stringify(unknown));
  }
});

test('已批准映射命中后标准币种须一致，不能换成别的币种或丢失已知证据', async t => {
  const f=createFixture(t);f.rule.currency_map={'人民币':'CNY'};f.answer.raw.currency_text='人民币';
  for(const currency of ['USD',null]) {
    f.answer.expected.currency=currency;
    if(currency===null)pending(f,'currency_unknown');
    const r=await check(f);rejected(r);assert.ok(r.errors.some(e=>e.code==='CURRENCY'));
  }
});

test('币种映射只取答案绑定的格式规则，不能借其他规则的批准', async t => {
  const f=createFixture(t),other=structuredClone(f.rule);
  other.id='unbound-rule';other.format_key='other-format';other.currency_map={'人民币':'CNY'};
  f.bundle.rules.push(other);f.answer.raw.currency_text='人民币';
  const r=await check(f);rejected(r);assert.ok(r.errors.some(e=>e.code==='CURRENCY'));
});

test('币种映射拒绝空别名、带边空白别名、ISO覆盖和非大写标准代码', async t => {
  const f=createFixture(t);
  for(const map of [{'':'CNY'},{' ':'CNY'},{' 人民币':'CNY'},{'人民币 ':'CNY'},{USD:'CNY'},{usd:'CNY'},{'人民币':'cny'},{'156':'人民币'},{'人民币':null}]) {
    f.rule.currency_map=map;
    const r=await check(f);rejected(r);
    assert.ok(r.errors.some(e=>['SCHEMA','RULE','CURRENCY'].includes(e.code)));
  }
});

test('批准的外币别名保留实际ISO币种且可作为外币覆盖见证', async t => {
  const f=createFixture(t);f.rule.currency_map={'美元':'USD'};f.answer.raw.currency_text=' 美元 ';
  f.answer.expected.currency='USD';pending(f,'currency_unsupported');f.answer.coverage=['currency_foreign'];
  const r=await check(f);assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(f.answer.raw.currency_text,' 美元 ');
  f.answer.expected.currency='CNY';
  const replaced=await check(f);rejected(replaced);assert.ok(replaced.errors.some(e=>e.code==='CURRENCY'));
});

test('批准映射覆盖不能由普通ISO、无映射或无批准的中文行冒充', async t => {
  const f=createFixture(t);f.answer.layer='B';f.answer.review=approved();f.answer.coverage=['currency_mapped_cny'];
  const plain=await check(f);rejected(plain);assert.ok(plain.errors.some(e=>e.code==='COVERAGE'));
  f.answer.raw.currency_text='人民币';
  rejected(await check(f));
  f.rule.currency_map={'人民币':'CNY'};f.rule.review=unreviewed();
  rejected(await check(f));
  f.rule.review=approved();
  const mapped=await check(f);assert.equal(mapped.ok,true,JSON.stringify(mapped));
});

test('批准后的币种映射变化仍使旧外部bundle哈希失效', async t => {
  const f=createReleaseFixture(t),oldPin=f.expectedBundleSha256;
  f.pairs.get('currency-mapped').rule.currency_map['人民币元']='CNY';f.save();
  const r=await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:oldPin});
  rejected(r);assert.ok(r.errors.some(e=>e.code==='HASH'&&e.at==='bundle'));
});

test('时间区间和负偏移歧义须用独立time_ambiguous原因待核，原文不改写', async t => {
  const f=createFixture(t);pending(f,'time_ambiguous');f.answer.expected.txn_time=null;
  f.answer.coverage=['time_ambiguous'];
  for(const raw of ['2026-11-18 08:00-09:00','08:00-09:00','2026-11-18 08:00:00-09:00:00','2026-11-18 08:00:00 - 2026-11-18 09:00:00']) {
    f.answer.raw.txn_time_text=raw;
    const r=await check(f);assert.equal(r.ok,true,JSON.stringify(r));
    assert.equal(f.answer.raw.txn_time_text,raw);
  }
});

test('时间区间不能借通用时间或时区原因通过，也不能计入时区覆盖', async t => {
  const f=createFixture(t);f.answer.raw.txn_time_text='2026-11-18 08:00-09:00';
  f.answer.expected.txn_time=null;f.answer.coverage=[];
  for(const reason of ['timezone_marker','time_missing']) {
    pending(f,reason);
    const r=await check(f);rejected(r);assert.ok(r.errors.some(e=>e.code==='TIME'));
  }
  pending(f,'time_ambiguous');f.answer.coverage=['time_timezone_marker'];
  const wrongCoverage=await check(f);rejected(wrongCoverage);assert.ok(wrongCoverage.errors.some(e=>e.code==='COVERAGE'));
});

test('删除区间覆盖也不允许把任一端点当作已确认交易时刻', async t => {
  const f=createFixture(t);f.answer.raw.txn_time_text='2026-11-18 08:00-09:00';
  f.answer.layer='B';f.answer.review=approved();assert.deepEqual(f.answer.coverage,[]);
  for(const time of ['2026-11-18 08:00:00','2026-11-18 09:00:00']) {
    f.answer.expected.txn_time=time;
    const r=await check(f);rejected(r);assert.ok(r.errors.some(e=>e.code==='TIME'));
  }
});

test('明确时区标记仍识别Z、UTC、GMT和ISO正负各精度偏移', async t => {
  const f=createFixture(t);pending(f,'timezone_marker');f.answer.expected.txn_time=null;
  f.answer.coverage=['time_timezone_marker'];
  for(const raw of ['2026-11-18 08:00:00Z','2026-11-18 08:00 UTC','GMT 2026-11-18 08:00','2026-11-18 08:00+08','2026-11-18 08:00+0800','2026-11-18 08:00+08:00','2026-11-18 08:00-0500','2026-11-18 08:00-05','2026-11-18T08:00-09:00','2026-11-18T08:00:00-09:00']) {
    f.answer.raw.txn_time_text=raw;
    const r=await check(f);assert.equal(r.ok,true,JSON.stringify(r));
  }
  f.answer.coverage=['time_ambiguous'];
  const wrong=await check(f);rejected(wrong);assert.ok(wrong.errors.some(e=>e.code==='COVERAGE'));
});

test('不同日期分隔符与多空格不能漏掉明确时区，斜线日期区间保持含义待核', async t => {
  const f=createFixture(t);
  for(const raw of ['2026/11/18 08:00+08:00','2026/11/18 08:00Z','2026-11-18   08:00Z']) {
    f.answer.raw.txn_time_text=raw;pending(f,'timezone_marker');
    f.answer.expected.txn_time=null;f.answer.coverage=['time_timezone_marker'];
    const valid=await check(f);assert.equal(valid.ok,true,JSON.stringify(valid));
    f.answer.coverage=[];f.answer.expected.txn_time='2026-11-18 08:00:00';
    f.answer.expected.status='confirmed';f.answer.expected.pending_reason=[];
    const guessed=await check(f);rejected(guessed);assert.ok(guessed.errors.some(e=>e.code==='TIME'));
  }
  f.answer.raw.txn_time_text='2026/11/18 08:00-09:00';
  f.answer.expected.txn_time=null;pending(f,'time_ambiguous');f.answer.coverage=['time_ambiguous'];
  const range=await check(f);assert.equal(range.ok,true,JSON.stringify(range));
  pending(f,'timezone_marker');f.answer.coverage=[];
  const wrong=await check(f);rejected(wrong);assert.ok(wrong.errors.some(e=>e.code==='TIME'));
});

test('带尾注和不同分隔的时间区间仍须含义待核，不能被当作偏移或端点', async t => {
  const f=createFixture(t);
  for(const raw of ['08:00-09:00（班次）','08:00 - 09:00 交易','08:00至09:00（班次）','08:00～09:00 备注','2026-11-18 08:00:00 - 2026-11-19 09:00:00（跨日）','2026-11-18T08:00:00-09:00:00（区间）']) {
    f.answer.raw.txn_time_text=raw;pending(f,'time_ambiguous');f.answer.expected.txn_time=null;
    f.answer.coverage=['time_ambiguous'];
    const valid=await check(f);assert.equal(valid.ok,true,JSON.stringify({raw,...valid}));
    assert.equal(f.answer.raw.txn_time_text,raw);
    f.answer.coverage=[];f.answer.expected.txn_time='2026-11-18 08:00:00';
    f.answer.expected.status='confirmed';f.answer.expected.pending_reason=[];
    const guessed=await check(f);rejected(guessed);assert.ok(guessed.errors.some(e=>e.code==='TIME'));
  }
});

test('时间后紧邻偏移和Z带括号或尾注仍是明确时区，不能静默确认', async t => {
  const f=createFixture(t);
  for(const raw of ['2026-11-18T08:00:00+08:00（北京时间）','2026-11-18 08:00:00+08:00 交易','08:00+08（备注）','08:00+0800 交易','08:00Z（原始时间）','2026-11-18T08:00:00-05:00 交易']) {
    f.answer.raw.txn_time_text=raw;pending(f,'timezone_marker');f.answer.expected.txn_time=null;
    f.answer.coverage=['time_timezone_marker'];
    const valid=await check(f);assert.equal(valid.ok,true,JSON.stringify({raw,...valid}));
    assert.equal(f.answer.raw.txn_time_text,raw);
    f.answer.coverage=[];f.answer.expected.txn_time='2026-11-18 08:00:00';
    f.answer.expected.status='confirmed';f.answer.expected.pending_reason=[];
    const guessed=await check(f);rejected(guessed);assert.ok(guessed.errors.some(e=>e.code==='TIME'));
  }
});

test('空格分隔负冒号偏移带尾注仍须独立歧义原因，不能冒充明确时区', async t => {
  const f=createFixture(t);f.answer.raw.txn_time_text='2026-11-18 08:00:00-05:00 交易';
  pending(f,'time_ambiguous');f.answer.expected.txn_time=null;f.answer.coverage=['time_ambiguous'];
  const valid=await check(f);assert.equal(valid.ok,true,JSON.stringify(valid));
  pending(f,'timezone_marker');f.answer.coverage=[];
  const wrong=await check(f);rejected(wrong);assert.ok(wrong.errors.some(e=>e.code==='TIME'));
});

test('时间后非紧邻的完整偏移或缩写不能被备注掩盖，须保留含义待核', async t => {
  const f=createFixture(t);
  for(const raw of ['08:00 备注+08:00','08:00 交易备注 +0800','08:00 备注-05','08:00 备注JST','08:00 备注 CST']) {
    f.answer.raw.txn_time_text=raw;pending(f,'time_ambiguous');f.answer.expected.txn_time=null;
    f.answer.coverage=['time_ambiguous'];
    const valid=await check(f);assert.equal(valid.ok,true,JSON.stringify({raw,...valid}));
    f.answer.coverage=[];f.answer.expected.txn_time='2026-11-18 08:00:00';
    f.answer.expected.status='confirmed';f.answer.expected.pending_reason=[];
    const guessed=await check(f);rejected(guessed);assert.ok(guessed.errors.some(e=>e.code==='TIME'));
  }
});

test('备注单号和日期连字符不属于完整偏移，不能把普通本地时间强制待核', async t => {
  const f=createFixture(t);
  for(const raw of ['08:00 单号123456','08:00-123456','08:00 单号+123456','08:00 备注+08:001','2026-11-18','2026-11-18 08:00:00（交易时间）']) {
    f.answer.raw.txn_time_text=raw;
    const valid=await check(f);assert.equal(valid.ok,true,JSON.stringify({raw,...valid}));
    assert.equal(f.answer.expected.status,'confirmed');
  }
});

test('Z和缩写必须是完整token，Zebra、BCST和嵌入英文单词不误判', async t => {
  const f=createFixture(t);
  for(const raw of ['08:00 Zebra','08:00Zebra','08:00 BCST','08:00 CSTX','08:00 abcJST','08:00 JST_code','08:00 Z123','08:00 Z:12','08:00 Z.12']) {
    f.answer.raw.txn_time_text=raw;
    const valid=await check(f);assert.equal(valid.ok,true,JSON.stringify({raw,...valid}));
  }
});

test('固定多义缩写名单大小写无关，须time_ambiguous且可提供缩写覆盖见证', async t => {
  const f=createFixture(t);f.answer.coverage=['time_zone_abbreviation'];f.answer.expected.txn_time=null;
  for(const abbreviation of ['CST','IST','EST','PST','BST','AST','GST','MST'])for(const token of [abbreviation,abbreviation.toLowerCase()]) {
    f.answer.raw.txn_time_text='2026-11-18 08:00 '+token;pending(f,'time_ambiguous');
    const valid=await check(f);assert.equal(valid.ok,true,JSON.stringify({token,...valid}));
  }
  pending(f,'timezone_marker');
  const wrong=await check(f);rejected(wrong);assert.ok(wrong.errors.some(e=>e.code==='TIME'));
});

test('固定明确缩写名单大小写无关，仍须时区待核且可提供缩写覆盖见证', async t => {
  const f=createFixture(t);f.answer.coverage=['time_zone_abbreviation'];f.answer.expected.txn_time=null;
  for(const abbreviation of ['UTC','GMT','JST','KST','HKT','SGT','AEST','AEDT','CET','CEST','MSK'])for(const token of [abbreviation,abbreviation.toLowerCase()]) {
    f.answer.raw.txn_time_text='2026-11-18 08:00 '+token;pending(f,'timezone_marker');
    const valid=await check(f);assert.equal(valid.ok,true,JSON.stringify({token,...valid}));
  }
  pending(f,'time_ambiguous');
  const wrong=await check(f);rejected(wrong);assert.ok(wrong.errors.some(e=>e.code==='TIME'));
});

test('删除缩写覆盖标签也不能将CST或JST悄悄当成本地时间确认', async t => {
  const f=createFixture(t);
  for(const raw of ['2026-11-18 08:00 CST','2026-11-18 08:00 JST','2026-11-18 08:00 cst']) {
    f.answer.raw.txn_time_text=raw;
    const guessed=await check(f);rejected(guessed);assert.ok(guessed.errors.some(e=>e.code==='TIME'));
  }
});

test('缩写覆盖要求真实名单token，普通时间、数字偏移和相似单词不能冒充', async t => {
  const f=createFixture(t);f.answer.coverage=['time_zone_abbreviation'];f.answer.expected.txn_time=null;
  for(const raw of ['2026-11-18 08:00:00','08:00+08:00','08:00 Zebra','08:00 BCST',null]) {
    f.answer.raw.txn_time_text=raw;pending(f,'timezone_marker');
    const invalid=await check(f);rejected(invalid);assert.ok(invalid.errors.some(e=>e.code==='COVERAGE'));
  }
});

test('区间和非紧邻缩写优先按歧义分类，缩写覆盖仍检查最终原因', async t => {
  const f=createFixture(t);f.answer.coverage=['time_zone_abbreviation'];f.answer.expected.txn_time=null;
  for(const raw of ['08:00-09:00（JST班次）','08:00 备注JST','08:00至09:00 UTC']) {
    f.answer.raw.txn_time_text=raw;pending(f,'time_ambiguous');
    const valid=await check(f);assert.equal(valid.ok,true,JSON.stringify({raw,...valid}));
    pending(f,'timezone_marker');
    const wrong=await check(f);rejected(wrong);assert.ok(wrong.errors.some(e=>e.code==='TIME'));
  }
});

test('第41项冻结覆盖不能只靠其他时间项，两个缩写见证均移除时拒绝', async t => {
  const f=createReleaseFixture(t);
  f.pairs.get('time-zone-abbreviation').row.coverage=[];
  f.pairs.get('time-zone-abbreviation-ambiguous').row.coverage=[];
  const result=await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:f.pin()});
  rejected(result);assert.ok(result.errors.some(e=>e.code==='COVERAGE'&&e.at==='time_zone_abbreviation'));
});

test('普通批准币种映射行仅承担amount_a覆盖时仍能留在A层', async t => {
  const f=createFixture(t);f.rule.currency_map={'人民币':'CNY'};
  f.answer.raw.currency_text='人民币';f.answer.coverage=['amount_a'];
  const valid=await check(f);assert.equal(valid.ok,true,JSON.stringify(valid));
  assert.equal(f.answer.layer,'A');assert.equal(f.answer.expected.status,'confirmed');
});
