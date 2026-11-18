'use strict';
// Only synthetic, temporary data. These records are test inputs, not G0 answers
// approved by a human, nor a generator for any future business parser.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const approved = () => ({status:'approved',by:'synthetic-test-reviewer',at:'2026-11-18T00:00:00Z',reason:'纯合成夹具批准记录，不代表真实人工裁决'});
const unreviewed = () => ({status:'unreviewed',by:null,at:null,reason:null});

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fundsift-g0-contract-'));
  const sourceRoot = path.join(root, 'sources');
  fs.mkdirSync(sourceRoot);
  const sourcePath = path.join(sourceRoot, 'synthetic.txt');
  const sourceBytes = Buffer.from('-1.00\n', 'utf8');
  fs.writeFileSync(sourcePath, sourceBytes);
  const source = {
    id:'s1',kind:'synthetic',case_ref:'synthetic-case',sample_role:'boundary',path:'synthetic.txt',file_name:'synthetic.txt',size:sourceBytes.length,sha256:digest(sourceBytes),
    platform:'synthetic',format:'txt',account_ref:'synthetic-account',time_range:{from:'2026-11-18 08:00:00',to:'2026-11-18 08:00:00'},
    observations:{encoding:'UTF-8',bom:false,merged_cells:false,logical_records:1,header_records:0,footer_records:0,other_non_data_records:0,data_records:1},
    rule_id:'r1',rule_version:1,disposition:'rows',review:approved(),record_index:null
  };
  const rule = {
    id:'r1',rule_version:1,platform:'synthetic',format_key:'synthetic-A-v1',amount_expr:'A',source_unit:'元',unit_scale:100,
    rounding_rule:'ROUND_HALF_UP',direction_map:{},negative_policy:'signed',zero_policy:'pending',zero_direction:null,
    balance_scope:'unknown',balance_same_direction:false,currency_policy:'explicit',reversal_note:'合成A类金额符号表示方向，无冲正推断',review:approved()
  };
  const answer = {
    source_id:'s1',source_sha256:source.sha256,source_loc:'1',format_rule_id:'r1',rule_version:1,layer:'A',
    raw:{raw_amount_text:'-1.00',raw_direction:null,raw_balance_text:null,raw_income_text:null,raw_expense_text:null,txn_time_text:'2026-11-18 08:00:00',acct_no:'synthetic-account',currency_text:'CNY',summary:'普通合成交易'},
    expected:{amount:-100,direction:'出',status:'confirmed',pending_reason:[],balance:null,balance_scope:'unknown',currency:'CNY',txn_time:'2026-11-18 08:00:00',acct_no:'synthetic-account',reversal_flag:0,
      balance_check:{status:'unchecked',comparable:false,reason:'未声明资产余额口径',previous:null,expect_balance:null,diff:null,segment_complete:true,order:'stable'}},
    basis:'纯合成规则A，负号代表支出；-1.00元为-100分。',review:unreviewed(),coverage:[],question_ids:[]
  };
  const bundle = {
    schema_version:1,matrix_version:2,dataset_id:'synthetic-contract-test',dataset_version:1,state:'draft',
    generator:{name:'synthetic-fixture-only',version:'1',implementation_path:null,sha256:null,independence:'只构造测试数据，不导入将来解析器和金额引擎。'},
    answers_file:'answers.jsonl',answers_sha256:null,schema_sha256:null,matrix_sha256:null,sources:[source],rules:[rule],questions:[]
  };
  const answers = [answer];
  const bundlePath = path.join(root, 'bundle.json');
  const answersPath = path.join(root, 'answers.jsonl');
  function save({answerText} = {}) {
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + '\n');
    fs.writeFileSync(answersPath, answerText === undefined ? answers.map(row => JSON.stringify(row)).join('\n') + (answers.length ? '\n' : '') : answerText);
    return bundlePath;
  }
  function setSourceText(text) {
    const bytes = Buffer.from(text, 'utf8');
    fs.writeFileSync(sourcePath, bytes);
    source.size = bytes.length; source.sha256 = digest(bytes);
    for (const row of answers) if (row.source_id === source.id) row.source_sha256 = source.sha256;
  }
  function addAnswer() {
    const row = clone(answer); row.source_loc = String(answers.length + 1); answers.push(row);
    source.observations.logical_records = answers.length;
    source.observations.data_records = answers.length;
    return row;
  }
  save();
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  return {root,sourceRoot,sourcePath,bundlePath,answersPath,bundle,source,rule,answer,answers,save,setSourceText,addAnswer};
}

// Full release fixture exercises the gate, including its five `real` role
// branches. Every byte below is invented: marking a synthetic file `real` here
// is deliberately test-only and cannot establish that a real G0 was reviewed.
function createReleaseFixture(t) {
  const f=createFixture(t),baseSource=clone(f.source),baseRule=clone(f.rule),baseAnswer=clone(f.answer);
  f.bundle.sources=[];f.bundle.rules=[];f.answers.length=0;f.bundle.state='frozen';
  f.bundle.dataset_id='synthetic-release-gate-test-only';
  const pairs=new Map();
  function add(id,tags,customize=()=>{}) {
    const source=clone(baseSource),rule=clone(baseRule),row=clone(baseAnswer);
    source.id='s-'+id;source.path='synthetic-'+id+'.txt';source.file_name=source.path;
    source.kind='synthetic';source.sample_role='boundary';source.case_ref='synthetic-case';
    rule.id='r-'+id;rule.format_key='synthetic-'+id;rule.review=approved();source.rule_id=rule.id;
    row.source_id=source.id;row.format_rule_id=rule.id;row.layer='B';row.review=approved();row.coverage=tags;
    const p={source,rule,row};customize(p);
    f.bundle.sources.push(source);f.bundle.rules.push(rule);f.answers.push(row);pairs.set(id,p);return p;
  }
  function setPending(p,code='amount_unknown') {p.row.expected.status='pending';p.row.expected.pending_reason=[{reason_code:code,detail:'合成边界待核原因'}];}
  function setPositive(p) {p.row.raw.raw_amount_text='1.00';p.row.expected.amount=100;p.row.expected.direction='进';}
  function expr(p,e) {
    p.rule.amount_expr=e;p.rule.negative_policy={A:'signed',B:'reverse',C:'magnitude',D:'column_defined',E:'pending',F:'pending'}[e];
    if(['B','C','E'].includes(e)){p.rule.direction_map={'收入':'进','支出':'出'};p.row.raw.raw_direction='支出';}
  }
  function unknown(p,code) {setPending(p,code);p.row.expected.amount=null;p.row.expected.direction=null;}
  const a=add('amount-a',['amount_a'],p=>{p.row.layer='A';});
  add('amount-b',['amount_b','reversal_b','sign_conflict_defined'],p=>{expr(p,'B');p.row.expected.amount=100;p.row.expected.direction='进';p.row.expected.reversal_flag=1;});
  add('amount-c',['amount_c'],p=>expr(p,'C'));
  add('amount-d',['amount_d'],p=>{expr(p,'D');p.row.raw.raw_amount_text=null;p.row.raw.raw_income_text='0';p.row.raw.raw_expense_text='1.00';});
  add('amount-e',['amount_e'],p=>{expr(p,'E');p.row.raw.raw_amount_text='1.00';});
  add('amount-f',['amount_f','pending_not_pass'],p=>{expr(p,'F');unknown(p,'amount_semantics_unknown');p.row.raw.raw_amount_text='?';});
  add('d-both',['d_both_nonzero'],p=>{expr(p,'D');unknown(p,'both_columns_nonzero');p.row.raw.raw_amount_text=null;p.row.raw.raw_income_text='1.00';p.row.raw.raw_expense_text='2.00';});
  add('d-empty',['d_empty_or_zero'],p=>{expr(p,'D');unknown(p,'columns_empty');p.row.raw.raw_amount_text=null;p.row.raw.raw_income_text=null;p.row.raw.raw_expense_text='0';});
  add('d-negative-defined',['d_negative_defined'],p=>{expr(p,'D');p.row.raw.raw_amount_text=null;p.row.raw.raw_income_text='0';p.row.raw.raw_expense_text='-1.00';p.row.expected.amount=100;p.row.expected.direction='进';p.row.expected.reversal_flag=1;p.rule.reversal_note='合成已验证规则：支出列负值反转为流入';});
  add('d-negative-undefined',['d_negative_undefined'],p=>{expr(p,'D');p.rule.negative_policy='pending';unknown(p,'negative_column_undefined');p.row.raw.raw_amount_text=null;p.row.raw.raw_income_text=null;p.row.raw.raw_expense_text='-1.00';});
  add('sign-conflict-undefined',['sign_conflict_undefined'],p=>{expr(p,'E');unknown(p,'sign_semantics_undefined');});
  add('zero-defined',['zero_defined'],p=>{p.rule.zero_policy='confirmed';p.rule.zero_direction='进';p.row.raw.raw_amount_text='0.00';p.row.expected.amount=0;p.row.expected.direction='进';});
  add('zero-undefined',['zero_undefined'],p=>{setPending(p,'zero_rule_undefined');p.row.raw.raw_amount_text='0';p.row.expected.amount=0;p.row.expected.direction=null;});
  add('missing-amount',['missing_amount'],p=>{unknown(p,'amount_missing');p.row.raw.raw_amount_text=null;});
  add('missing-time',['missing_time'],p=>{setPending(p,'time_missing');p.row.raw.txn_time_text=null;p.row.expected.txn_time=null;});
  add('time-timezone',['time_timezone_marker'],p=>{setPending(p,'timezone_marker');p.row.raw.txn_time_text='2026-03-01T10:00:00+08:00';p.row.expected.txn_time=null;});
  add('amount-unparseable',['amount_unparseable'],p=>{unknown(p,'amount_unparseable');p.row.raw.raw_amount_text='N/A';});
  add('missing-account',['missing_account'],p=>{setPending(p,'account_missing');p.source.account_ref=null;p.row.raw.acct_no=null;p.row.expected.acct_no=null;});
  add('unknown-direction',['unknown_direction'],p=>{expr(p,'E');unknown(p,'direction_unknown');p.row.raw.raw_amount_text='1.00';p.row.raw.raw_direction='未收录方向';});
  add('reversal-memo',['reversal_memo_only'],p=>{p.row.raw.summary='冲正关键词仅作线索，不改向';});
  add('rounding',['rounding_yuan'],p=>{p.row.raw.raw_amount_text='-1.005';p.row.expected.amount=-101;});
  add('fen',['source_fen'],p=>{p.rule.source_unit='分';p.rule.unit_scale=1;p.row.raw.raw_amount_text='-100';});
  for(const scope of ['debt','available','unknown'])add('scope-'+scope,['balance_scope_'+scope],p=>{p.rule.balance_scope=scope;p.row.expected.balance_scope=scope;p.row.raw.raw_balance_text='10.00';p.row.expected.balance=1000;p.row.expected.balance_check.reason='合成'+scope+'口径不适用资产公式';});
  const previous=add('asset-previous',['balance_no_previous'],p=>{p.rule.balance_scope='asset_ledger';p.rule.balance_same_direction=true;p.row.expected.balance_scope='asset_ledger';p.row.expected.balance=1000;p.row.raw.raw_balance_text='10.00';p.row.expected.balance_check.reason='无可用前项';});
  add('asset-fail',['balance_scope_asset_ledger','balance_fail_confirmed','same_second_stable'],p=>{
    setPositive(p);p.rule.balance_scope='asset_ledger';p.rule.balance_same_direction=true;p.row.expected.balance_scope='asset_ledger';p.row.expected.balance=1200;p.row.raw.raw_balance_text='12.00';
    p.row.expected.balance_check={status:'fail',comparable:true,reason:'合成期望1100实际1200差100分',previous:{source_id:previous.source.id,source_loc:'1'},expect_balance:1100,diff:100,segment_complete:true,order:'stable'};
  });
  add('same-second-unstable',['same_second_unstable'],p=>{p.row.expected.balance_check.order='unknown';p.row.expected.balance_check.previous={source_id:previous.source.id,source_loc:'1'};p.row.expected.balance_check.reason='同秒且业务顺序未知';});
  add('incomplete',['incomplete_segment'],p=>{p.row.expected.balance_check.segment_complete=false;p.row.expected.balance_check.reason='合成链段有缺口';});
  add('foreign',['currency_foreign'],p=>{p.row.raw.currency_text='USD';p.row.expected.currency='USD';setPending(p,'currency_unsupported');});
  add('currency-known',['currency_missing_verified'],p=>{p.rule.currency_policy='verified_cny';p.row.raw.currency_text=null;});
  add('currency-unknown',['currency_missing_unknown'],p=>{p.rule.currency_policy='unverified';p.row.raw.currency_text=null;p.row.expected.currency=null;setPending(p,'currency_missing');});
  const unknownSource=clone(baseSource);
  Object.assign(unknownSource,{id:'s-unknown-file',path:'synthetic-unknown.bin',file_name:'synthetic-unknown.bin',format:'unknown',rule_id:null,rule_version:null,disposition:'unrecognized'});
  unknownSource.observations={encoding:null,bom:null,merged_cells:null,logical_records:1,header_records:0,footer_records:0,other_non_data_records:1,data_records:0};
  f.bundle.sources.push(unknownSource);
  const roles=[['amount-a','ccb_xlsx','xlsx'],['amount-b','case_b_reversal','txt'],['amount-c','wechat_txt','txt'],['amount-d','alipay_account_csv','csv'],['amount-e','alipay_balance_csv','csv']];
  for(const [id,role,format] of roles){const p=pairs.get(id);p.source.kind='real';p.source.sample_role=role;p.source.format=format;if(role==='case_b_reversal')p.source.case_ref='synthetic-case-b';if(format==='xlsx')p.row.source_loc='SyntheticSheet!1';}
  const generator=Buffer.from('// Pure synthetic test fixture; this file is not a business generator.\n','utf8');
  fs.writeFileSync(path.join(f.root,'synthetic-generator.cjs'),generator);
  f.bundle.generator={name:'synthetic-release-gate-fixture',version:'1',implementation_path:'synthetic-generator.cjs',sha256:digest(generator),independence:'This test data does not import product parsers or money engines. No genuine case or human approval is claimed.'};
  const schemaFile=path.resolve(__dirname,'../../..','schemas/g0/bundle.schema.json');
  const matrixFile=path.resolve(__dirname,'../../..','schemas/g0/coverage-matrix.json');
  const extractor=Buffer.from('// Synthetic-only record index writer fixture; not an extractor for real sources.\n','utf8');
  const extractorPath=path.join(f.root,'synthetic-indexer.cjs');
  fs.writeFileSync(extractorPath,extractor);
  function pin() {
    for(const source of f.bundle.sources){
      const rs=f.answers.filter(r=>r.source_id===source.id);
      const bytes=Buffer.from(JSON.stringify({test_only:true,id:source.id,raw:rs.map(r=>({source_loc:r.source_loc,...r.raw}))})+'\n');
      fs.writeFileSync(path.join(f.sourceRoot,source.path),bytes);source.size=bytes.length;source.sha256=digest(bytes);
      for(const row of rs)row.source_sha256=source.sha256;
      const entries=rs.map(row=>({source_loc:row.source_loc,kind:'data'}));
      const obs=source.observations;
      for(const [kind,count] of [['header',obs.header_records],['footer',obs.footer_records],['other',obs.other_non_data_records]]) {
        for(let i=0;i<count;i++)entries.push({source_loc:String(entries.length+1),kind});
      }
      entries.sort((a,b)=>a.source_loc.localeCompare(b.source_loc,undefined,{numeric:true}));
      const indexBytes=Buffer.from(entries.map(entry=>JSON.stringify(entry)).join('\n')+(entries.length?'\n':''));
      const indexPath='indexes/'+source.id+'.jsonl';
      fs.mkdirSync(path.join(f.root,'indexes'),{recursive:true});fs.writeFileSync(path.join(f.root,indexPath),indexBytes);
      source.record_index={path:indexPath,sha256:digest(indexBytes),extractor:{name:'synthetic-index-fixture',version:'1',implementation_path:'synthetic-indexer.cjs',sha256:digest(extractor),independent_of_parser:true}};
    }
    f.bundle.answers_sha256=null;f.save();
    f.bundle.answers_sha256=digest(fs.readFileSync(f.answersPath));
    f.bundle.schema_sha256=digest(fs.readFileSync(schemaFile));f.bundle.matrix_sha256=digest(fs.readFileSync(matrixFile));
    f.save();return digest(fs.readFileSync(f.bundlePath));
  }
  const expectedBundleSha256=pin();
  return {...f,pairs,pin,expectedBundleSha256,ordinaryA:a.row};
}

module.exports = {createFixture,createReleaseFixture,digest,clone,approved,unreviewed};
