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

test('纯合成完整冻结夹具走通38覆盖和五角色准入，但不是实际G0证据', async t => {
  const f=createReleaseFixture(t),r=await validateDataset(f.bundlePath,{sourceRoot:f.sourceRoot,release:true,expectedBundleSha256:f.expectedBundleSha256});
  assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.ready_for_m1,true);assert.equal(r.counts.coverage,38);
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

test('旧matrix版本不能在新38项契约中静默继续使用', async t => {
  const f=createFixture(t);f.bundle.matrix_version=1;rejected(await check(f));
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

test('正式38项基准缺少任一新增覆盖即拒绝', async t => {
  const f=createReleaseFixture(t);
  for(const [pair,coverage] of [['time-timezone','time_timezone_marker'],['amount-unparseable','amount_unparseable']]) {
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
