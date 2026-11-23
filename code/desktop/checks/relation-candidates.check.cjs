'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {WorkspaceStore}=require('../storage.cjs');
const {runCaseIntegrityTransaction,runCaseTransaction}=require('../hardening.cjs');
const {queryRelationCandidates}=require('../relation-candidates.cjs');
const WX='wechat-trades-27col-v1',CCB='ccb-account-32col-v1',CARD='0000000000000001234';
async function fixture(t,entries) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fundsift-relations-')),store=new WorkspaceStore({schemaPath:path.resolve(__dirname,'../../ddl_extract_check.sql')});
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  await store.openWorkspace(root);const c=await store.createCase({name:'合成关系候选',number:'RELATION'}),db=store.caseDb,record=store._caseRecord(c.id);
  runCaseIntegrityTransaction(db,record,()=>{
    for(const [index,key] of [WX,CCB].entries()) {
      const id=index+1;
      db.prepare(`INSERT INTO format_rule(id,platform,format_key,amount_expr,source_unit,unit_scale,verified,frozen)
        VALUES(?,?,?,'E','分',1,1,1)`).run(id,index?'建设银行':'微信',key);
      db.prepare(`INSERT INTO source_file(id,case_id,file_name,file_sha256) VALUES(?,1,?,?)`).run(id,`synthetic-${id}.txt`,`synthetic-hash-${id}`);
      db.prepare(`INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version) VALUES(?,1,?,'t','synthetic')`).run(id,id);
    }
    const insert=db.prepare(`INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,
      platform,acct_no,txn_time,amount,direction,currency,raw_currency_text,currency_evidence,raw_record,status)
      VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,'raw_iso',?,'confirmed')`);
    for(const [index,entry] of entries.entries()) {
      const bank=entry.format===CCB,id=bank?2:1,values=Array(bank?32:27).fill(''),sourceLoc=String(index+2);
      values[bank?11:10]=entry.card??CARD;
      if(!bank){values[1]=entry.order??`order-${index}`;values[16]=entry.peerCard??'';}
      insert.run(id,id,id,1,sourceLoc,bank?'建设银行':'微信',entry.account??(bank?'bank-account':'wx-user'),
        entry.time??'2026-11-19 08:00:00',entry.amount??-100n,entry.direction??'出',entry.currency??'CNY',entry.currency??'CNY',
        JSON.stringify({format_key:entry.format??WX,source_loc:sourceLoc,values}));
    }
    for(const id of [1,2]) {
      const count=db.prepare('SELECT count(*) n FROM fund_flow WHERE batch_id=?').get(id).n;
      db.prepare("UPDATE import_batch SET status='done',total_rows=?,imported_rows=?,skipped_rows=0 WHERE id=?").run(count,count,id);
      db.prepare("UPDATE source_file SET first_batch_id=?,current_batch_id=?,status='imported' WHERE id=?").run(id,id,id);
    }
  });
  return {store,c,db,record};
}

test('关系候选要求完整同卡同币种同额及一秒内，保留来源和负额，不改流水/版本',async t=>{
  const f=await fixture(t,[{format:WX},{format:CCB,time:'2026-11-19 08:00:01'},
    {format:CCB,time:'2026-11-19 08:00:02'},{format:CCB,currency:'USD'},
    {format:CCB,card:'0000000000000009999'},{format:CCB,amount:-101n}]);
  const version=f.db.prepare('SELECT data_version FROM case_data_state').get().data_version;
  const result=queryRelationCandidates(f.db,{caseId:f.c.id});
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].kind,'payment_mirror_candidate');
  assert.equal(result.rows[0].left.amount,'-100');assert.equal(result.rows[0].left.bankCard,CARD);
  assert.equal(result.rows[0].right.sourceLoc,'3');assert.equal(result.rows[0].evidence.find(e=>e.label==='时间差（秒）').value,'1');
  assert.equal(f.db.prepare('SELECT data_version FROM case_data_state').get().data_version,version);
  assert.equal(f.db.prepare('SELECT count(*) n FROM fund_flow').get().n,6);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
});

test('对端卡号候选与多对多冲突单列，未知卡号和尾号不拼配；有界截取明确告知',async t=>{
  const f=await fixture(t,[{format:WX,card:'9999',peerCard:CARD,amount:-100n},
    {format:CCB,amount:100n,direction:'进'},{format:CCB,amount:100n,direction:'进'},{format:WX,card:'1234',order:'tail'}]);
  const full=queryRelationCandidates(f.db,{caseId:f.c.id});
  assert.equal(full.rows.length,2);assert.ok(full.rows.every(r=>r.kind==='counterparty_candidate'&&r.ambiguous));
  assert.ok(full.rows.every(r=>r.warnings.some(w=>w.includes('多个候选'))));
  const limited=queryRelationCandidates(f.db,{caseId:f.c.id,limit:1});
  assert.equal(limited.rows.length,1);assert.equal(limited.truncated,true);
  assert.throws(()=>queryRelationCandidates(f.db,{caseId:'other'}),{code:'FS_CASE_IDENTITY'});
  assert.throws(()=>queryRelationCandidates(f.db,{caseId:f.c.id,limit:201}),{code:'FS_QUERY_INPUT'});
});

test('微信同单号只在完整本方身份一致时关联，金额不一致展示冲突，不删行且旧非current批次排除',async t=>{
  const f=await fixture(t,[{format:WX,order:'order-shared'},{format:WX,order:'order-shared',amount:-1n},
    {format:WX,order:'order-shared',account:'other-user'},{format:CCB,card:'other-card'}]);
  const result=queryRelationCandidates(f.db,{caseId:f.c.id});
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].kind,'same_order_multiple_rows');
  assert.ok(result.rows[0].warnings.some(w=>w.includes('金额不同')));
  runCaseTransaction(f.db,f.record,{sourceFileIds:[1]},()=>{
    f.db.exec(`INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version) VALUES(3,1,1,'t','synthetic-old');
      INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,platform,acct_no,txn_time,
        amount,direction,currency,raw_currency_text,currency_evidence,raw_record,status)
      SELECT case_id,3,source_file_id,format_rule_id,rule_version,source_loc,platform,acct_no,txn_time,
        amount,direction,currency,raw_currency_text,currency_evidence,raw_record,status FROM fund_flow WHERE id=1`);
  });
  assert.equal(queryRelationCandidates(f.db,{caseId:f.c.id}).rows.length,1);
});

test('关系扫描按原文字节截取并关闭迭代器，不一次加载全部原文或向界面输出大字段',()=>{
  const raw=JSON.stringify({format_key:WX,source_loc:'2',values:Array(27).fill(''),padding:'x'.repeat(1024*1024)});
  let pulled=0,closed=false;
  const db={inTransaction:true,pragma(){return 5;},prepare(sql){
    if(sql.includes('case_data_state'))return {safeIntegers(){return this;},get(){return {case_uuid:'case',data_version:1n};}};
    return {safeIntegers(){return this;},all(){assert.fail('must stream records');},
      *iterate(){try{for(let i=0;i<100;i++){pulled++;yield {id:BigInt(i+1),source_loc:'2',raw_record:raw,amount:null,txn_time:null};}}finally{closed=true;}}};
  }};
  const result=queryRelationCandidates(db,{caseId:'case'});
  assert.equal(result.truncated,true);assert.equal(closed,true);assert.ok(pulled<100);
  assert.equal(pulled,Number(result.eligibleRows)+1);assert.deepEqual(result.rows,[]);
  assert.ok(JSON.stringify(result).length<2000);
});
