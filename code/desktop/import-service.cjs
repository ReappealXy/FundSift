'use strict';

// Serialized-worker business service. Parsing/copying/hashing is asynchronous;
// each SQLite mutation is a short, explicitly scoped synchronous transaction.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ArchiveStore, hashFile } = require('./archive-store.cjs');
const { runCaseTransaction, runCaseIntegrityTransaction } = require('./hardening.cjs');
const { registerRuleConfig, validateRuleConfig, canonicalJSON, RULE_CONFIG_SCHEMA } = require('./foundation.cjs');
const { assertInt64, toWire } = require('./money.cjs');

const PARSER_VERSION = 'alipay-account-preview-1';
const FORMAT_KEY = 'alipay-account-17col-v1';
const FORMATS = {
  [FORMAT_KEY]: {version:PARSER_VERSION, width:17, module:'./alipay-account.cjs', open:'openAlipayAccount', read:'readAlipayRecordByCoordinate'},
  'wechat-trades-27col-v1': {version:'wechat-trades-preview-1', width:27, module:'./wechat-trades.cjs', open:'openWechatTrades', read:'readWechatTradeSource'},
  'ccb-account-32col-v1': {version:'ccb-account-preview-1', width:32, module:'./ccb-account.cjs', open:'openCcbAccount', read:'readCcbAccountSource'}
};
const MAX_BYTES = 64 * 1024 * 1024;
const CHUNK_SIZE = 250;
const active = new WeakSet();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = (code,message) => { throw Object.assign(new Error(message),{code}); };
const nonblank = value => typeof value==='string' && value.trim()!=='';
const progress = (observer,event) => { try { observer?.(event); } catch (_) { /* A view observer cannot abort a committed chunk. */ } };
function cancelled(signal) { if(signal?.aborted) fail('FS_USER_CANCELLED','已取消导入，未发布新批次。'); }
function id(db,table) {
  const next=db.prepare(`SELECT coalesce(max(id),0)+1 AS id FROM ${table}`).safeIntegers().get().id;
  if(next>BigInt(Number.MAX_SAFE_INTEGER))fail('FS_IMPORT_ID','当前预览版的记录编号已超出支持范围。');
  return Number(next);
}
function assertCase(db,record) {
  if(!record || typeof record.id!=='string' || db.pragma('user_version',{simple:true})!==3 ||
    db.prepare('SELECT case_uuid FROM desktop_case_identity WHERE id=1').get()?.case_uuid!==record.id) {
    fail('FS_CASE_IDENTITY','导入案件与当前数据库不一致，已停止操作。');
  }
  if(db.inTransaction)fail('FS_CASE_TRANSACTION','导入不能嵌套在其他数据库事务中。');
}
function assertCaseDirectory(db,caseDirectory) {
  if(typeof caseDirectory!=='string'||fs.realpathSync(db.name)!==path.join(fs.realpathSync(caseDirectory),'case.sqlite')) {
    fail('FS_CASE_IDENTITY','归档案件目录与当前数据库不一致。');
  }
}
function configFor(rule) {
  if(!rule || !nonblank(rule.platform) || !Object.hasOwn(FORMATS,rule.format_key) || !Number.isSafeInteger(rule.rule_version) || rule.rule_version<1) {
    fail('FS_IMPORT_RULE','请明确指定本格式的规则卡、平台及规则版本。');
  }
  const config={};
  for(const key of Object.keys(RULE_CONFIG_SCHEMA.properties)) {
    if(Object.hasOwn(rule,key))config[key]=rule[key];
  }
  if(!Object.hasOwn(config,'config_version'))config.config_version=1;
  validateRuleConfig(config);
  if(config.review.status!=='approved')fail('FS_IMPORT_APPROVAL','本格式规则尚未批准，不能导入。');
  const wx=rule.format_key==='wechat-trades-27col-v1', ccb=rule.format_key==='ccb-account-32col-v1';
  if(config.amount_expr!=='E' || config.source_unit!==(wx?'分':'元') || config.unit_scale!==(wx?1:100) || config.negative_policy!=='pending' ||
    config.zero_policy!=='pending' || canonicalJSON(config.direction_map)!==canonicalJSON(wx?{入:'进',出:'出'}:ccb?{借:'出',贷:'进'}:{收入:'进',支出:'出'})) {
    fail('FS_IMPORT_RULE','规则卡不属于本技术预览支持的具体结构。');
  }
  return JSON.parse(canonicalJSON(config));
}
function policyFor(policy,formatKey=FORMAT_KEY) {
  const wx=formatKey==='wechat-trades-27col-v1',ccb=formatKey==='ccb-account-32col-v1';
  const expected=wx?{timeColumn:'交易时间',accountIdentityPolicy:'raw_platform_user_id',receiverAmountPolicy:'mismatch_pending',balancePolicy:'preserve_unknown'}:
    ccb?{timeColumn:'交易日期+交易时间',accountIdentityPolicy:'raw_bank_account',balancePolicy:'preserve_unknown'}:
    {timeColumn:'付款时间',accountIdentityPolicy:'raw_platform_info',businessStatusPolicy:'exact_v1'};
  const allowed=[...Object.keys(expected),'review'];
  if(!policy || typeof policy!=='object' || Array.isArray(policy) || Object.keys(policy).some(key=>!allowed.includes(key)) ||
    Object.entries(expected).some(([key,value])=>policy[key]!==value) ||
    !policy.review || policy.review.status!=='approved' || ['by','at','reason'].some(key=>!nonblank(policy.review[key])) ||
    Object.keys(policy.review).some(key=>!['status','by','at','reason'].includes(key))) {
    fail('FS_IMPORT_APPROVAL','时间列、账户身份和交易状态口径须由规则卡明确批准后才能导入。');
  }
  return JSON.parse(canonicalJSON(policy));
}
function registerRule(db,record,rule,config) {
  let existing=db.prepare('SELECT * FROM format_rule WHERE platform=? AND format_key=? AND rule_version=?')
    .get(rule.platform,rule.format_key,rule.rule_version);
  const configHash=sha256(canonicalJSON(config));
  if(existing) {
    const stored=db.prepare('SELECT config_sha256,approved_by FROM format_rule_config WHERE rule_id=? AND rule_version=?').get(existing.id,existing.rule_version);
    if(!stored || stored.config_sha256!==configHash || stored.approved_by===null)fail('FS_RULE_VERSION_CONFLICT','该规则版本已有不同或未批准的配置，请新增规则版本。');
    return existing;
  }
  runCaseIntegrityTransaction(db,record,()=>{
    const ruleId=id(db,'format_rule');
    db.prepare(`INSERT INTO format_rule(id,platform,format_key,rule_version,amount_expr,direction_source,source_unit,unit_scale,
      rounding_rule,balance_scope,source_evidence) VALUES(?,?,?,?,?,'direction_col',?,?,?,?,?)`)
      .run(ruleId,rule.platform,rule.format_key,rule.rule_version,config.amount_expr,config.source_unit,config.unit_scale,
        config.rounding_rule,config.balance_scope,rule.source_evidence??null);
    registerRuleConfig(db,{rule_id:ruleId,rule_version:rule.rule_version,config});
    existing=db.prepare('SELECT * FROM format_rule WHERE id=?').get(ruleId);
  });
  return existing;
}
function archivePath(caseDirectory,relative,expected) {
  const root=path.resolve(caseDirectory);
  if(relative!==`archive/objects/${expected}.bin`)fail('FS_IMPORT_SOURCE','归档指针与原件身份不一致。');
  const target=path.resolve(root,relative);
  if(!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root)!==root ||
    fs.realpathSync(path.dirname(target))!==path.dirname(target) || !target.startsWith(root+path.sep))fail('FS_IMPORT_SOURCE','归档路径已越出案件目录。');
  const stat=fs.lstatSync(target);
  if(!stat.isFile() || stat.isSymbolicLink())fail('FS_IMPORT_SOURCE','归档副本不是普通文件。');
  return target;
}
function registerArchive(db,record,staged) {
  const existing=db.prepare('SELECT * FROM archive_entry WHERE final_relative_path=?').get(staged.finalRelativePath);
  if(existing) {
    if(existing.status!=='verified' || existing.expected_sha256!==staged.expectedSha256 ||
      existing.copied_sha256!==staged.copiedSha256 || BigInt(existing.size_bytes)!==BigInt(staged.sizeBytes))fail('FS_ARCHIVE_HASH','已有归档账本与本次核验结果不一致。');
    return existing.id;
  }
  let archiveId;
  runCaseIntegrityTransaction(db,record,()=>{
    archiveId=id(db,'archive_entry');
    db.prepare(`INSERT INTO archive_entry(id,batch_id,staging_relative_path,final_relative_path,expected_sha256,copied_sha256,
      size_bytes,status,created_at,verified_at) VALUES(?,NULL,?,?,?,?,?,'verified',?,?)`)
      .run(archiveId,staged.stagingRelativePath,staged.finalRelativePath,staged.expectedSha256,staged.copiedSha256,
        BigInt(staged.sizeBytes),staged.createdAt,staged.verifiedAt);
  });
  return archiveId;
}
function rowForStorage(row,formatKey=FORMAT_KEY) {
  if(!row || !nonblank(row.source_loc) || typeof row.raw_record!=='string')fail('FS_IMPORT_ROW','解析器未提供完整来源坐标或原文。');
  let raw;
  try{raw=JSON.parse(row.raw_record);}catch(_){fail('FS_IMPORT_ROW','原文记录不是有效JSON。');}
  if(!Array.isArray(raw.values) || raw.values.length!==FORMATS[formatKey].width || raw.source_loc!==row.source_loc || raw.format_key!==formatKey) {
    fail('FS_IMPORT_ROW','原文记录与本格式坐标不一致。');
  }
  let derivation;
  try { derivation=toWire(row.derivation); } catch(_) { fail('FS_IMPORT_ROW','解析解释元数据必须是无损JSON数据。'); }
  if(!derivation||typeof derivation!=='object'||Array.isArray(derivation)||!derivation.money||
    !Object.hasOwn(derivation,'time_column')||!Object.hasOwn(derivation,'account_identity_policy')||
    !Object.hasOwn(derivation,'business_status_policy'))fail('FS_IMPORT_ROW','解析解释缺少金额、时间、账户或状态依据。');
  const rawRecord=JSON.stringify({...raw,derivation});
  const reasons=row.pendingReasons??row.reasons;
  if(!Array.isArray(reasons))fail('FS_IMPORT_ROW','解析器未返回明确的待核原因清单。');
  const seen=new Set(), normalized=[];
  for(const reason of reasons) {
    if(!reason || !nonblank(reason.reason_code) || !nonblank(reason.detail))fail('FS_IMPORT_ROW','待核原因缺少原因码或说明。');
    if(!seen.has(reason.reason_code)){seen.add(reason.reason_code);normalized.push({reason_code:reason.reason_code,detail:reason.detail});}
  }
  const add=(reason_code,detail)=>{if(!seen.has(reason_code)){seen.add(reason_code);normalized.push({reason_code,detail});}};
  const amount=row.amount===null ? null : assertInt64(row.amount);
  const hasDimension=pattern=>normalized.some(reason=>pattern.test(reason.reason_code));
  if(amount===null&&!hasDimension(/^(?:amount_|direction_|sign_|negative_|zero_|columns_|both_columns_)/))add('amount_unknown','本记录标准金额尚未明确，保留待核。');
  if(row.currency==null&&!hasDimension(/^currency_/))add('currency_unknown','本记录币种尚未明确，保留待核。');
  if(row.currency!=null && row.currency!=='CNY')add('currency_unsupported','本技术预览保留外币证据，暂不确认。');
  if(row.txn_time==null&&!hasDimension(/^time_/))add('time_unknown','本记录没有可确认的交易时间。');
  if(!nonblank(row.acct_no)&&!nonblank(row.acct_name)&&!hasDimension(/^account_/))add('account_unknown','本记录账户身份尚未明确。');
  if(amount!==null && ((amount>0n&&row.direction!=='进')||(amount<0n&&row.direction!=='出')))fail('FS_IMPORT_ROW','解析金额与方向不一致。');
  const currencyEvidence={iso:'raw_iso',mapped:'approved_map',raw_iso:'raw_iso',approved_map:'approved_map',verified_cny:'verified_cny',unknown:'unknown'}[row.currency_evidence];
  if(!currencyEvidence)fail('FS_IMPORT_ROW','解析器返回了不支持的币种证据。');
  const stringFields=['platform','acct_no','acct_name','peer_acct','peer_name','txn_time','txn_time_text',
    'raw_amount_text','raw_income_text','raw_expense_text','raw_direction','raw_balance_text','raw_currency_text','txn_type','summary'];
  for(const key of stringFields)if(row[key]!==undefined&&row[key]!==null&&typeof row[key]!=='string')fail('FS_IMPORT_ROW','解析原始字段类型不合法。');
  const result=Object.fromEntries(stringFields.map(key=>[key,row[key]??null]));
  return {...result,source_loc:row.source_loc,raw_record:rawRecord,amount,direction:row.direction??null,
    balance:row.balance==null?null:assertInt64(row.balance),reversal_flag:row.reversal_flag??0,currency:row.currency??null,
    currency_evidence:currencyEvidence,status:normalized.length?'pending':'confirmed',reasons:normalized};
}
function writeChunk(db,record,sourceId,batchId,storedRule,rows) {
  runCaseTransaction(db,record,{sourceFileIds:[sourceId]},()=>{
    const insert=db.prepare(`INSERT INTO fund_flow(case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,
      platform,acct_no,acct_name,peer_acct,peer_name,txn_time,txn_time_text,raw_amount_text,raw_income_text,raw_expense_text,
      raw_direction,raw_balance_text,raw_currency_text,raw_record,currency,currency_evidence,amount,direction,balance,
      txn_type,summary,reversal_flag,status) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const reason=db.prepare('INSERT INTO pending_reason(fund_flow_id,reason_code,detail,created_at) VALUES(?,?,?,?)');
    for(const row of rows) {
      const got=insert.run(batchId,sourceId,storedRule.id,storedRule.rule_version,row.source_loc,row.platform,row.acct_no,row.acct_name,
        row.peer_acct,row.peer_name,row.txn_time,row.txn_time_text,row.raw_amount_text,row.raw_income_text,row.raw_expense_text,
        row.raw_direction,row.raw_balance_text,row.raw_currency_text,row.raw_record,row.currency,row.currency_evidence,row.amount,
        row.direction,row.balance,row.txn_type,row.summary,row.reversal_flag,row.status);
      const stamp=new Date().toISOString();
      for(const item of row.reasons)reason.run(got.lastInsertRowid,item.reason_code,item.detail,stamp);
    }
  });
}

async function importSourceFile({db,record,caseDirectory,filePath,rule,policy,signal,onProgress,reimport=false}={}) {
  assertCase(db,record);
  assertCaseDirectory(db,caseDirectory);
  if(active.has(db))fail('FS_IMPORT_BUSY','当前案件已有导入任务，请等待完成。');
  const config=configFor(rule),approvedPolicy=policyFor(policy,rule.format_key),adapter=FORMATS[rule.format_key];
  const binding={platform:rule.platform,format_key:rule.format_key,rule_version:rule.rule_version,source_evidence:rule.source_evidence??null};
  if(typeof reimport!=='boolean'||typeof filePath!=='string')fail('FS_IMPORT_INPUT','导入参数无效。');
  const inputStat=fs.lstatSync(filePath);
  if(!inputStat.isFile()||inputStat.isSymbolicLink()||inputStat.size>MAX_BYTES)fail('FS_IMPORT_SIZE','技术预览仅支持不超过64MiB的普通文件。');
  active.add(db);
  let sourceId=null,batchId=null,metadata=null,written=0,pending=0,unquantifiable=0;
  try {
    cancelled(signal);
    const archive=new ArchiveStore(caseDirectory);
    const staged=await archive.stage(filePath,{signal,onProgress:event=>progress(onProgress,event)});
    const found=db.prepare('SELECT * FROM source_file WHERE case_id=1 AND file_sha256=?').get(staged.expectedSha256);
    if(found&&!reimport){sourceId=found.id;fail('FS_IMPORT_DUPLICATE','本案件已登记相同原件；如需重新解析，请明确选择重新导入。');}
    const storedRule=registerRule(db,record,binding,config);
    const archiveId=registerArchive(db,record,staged),timestamp=new Date().toISOString();
    sourceId=found?.id??id(db,'source_file');batchId=id(db,'import_batch');
    const notes=canonicalJSON({preview:true,policy:approvedPolicy,policy_sha256:sha256(canonicalJSON(approvedPolicy)),
      rule_id:storedRule.id,rule_version:storedRule.rule_version,config_sha256:sha256(canonicalJSON(config)),archiveTaskId:staged.taskId});
    runCaseTransaction(db,record,{sourceFileIds:[sourceId]},()=>{
      if(!found)db.prepare(`INSERT INTO source_file(id,case_id,file_name,file_path,file_size,file_sha256,format_rule_id,archive_entry_id,perspective)
        VALUES(?,1,?,?,?,?,?,?,'transaction')`).run(sourceId,path.basename(filePath),staged.finalRelativePath,BigInt(staged.sizeBytes),staged.expectedSha256,storedRule.id,archiveId);
      db.prepare(`INSERT INTO import_batch(id,case_id,source_file_id,started_at,parser_version,status,archive_entry_id,notes)
        VALUES(?,1,?,? ,?,'parsing',?,?)`).run(batchId,sourceId,timestamp,adapter.version,archiveId,notes);
      db.prepare('UPDATE source_file SET first_batch_id=coalesce(first_batch_id,?) WHERE id=?').run(batchId,sourceId);
    });
    cancelled(signal);
    const openSource=require(adapter.module)[adapter.open];
    const archived=archivePath(caseDirectory,staged.finalRelativePath,staged.expectedSha256);
    progress(onProgress,{phase:'parsing'});
    const parsed=await openSource(archived,{rule:{...config,id:storedRule.id,rule_version:storedRule.rule_version},
      policy:approvedPolicy,expectedSha256:staged.expectedSha256,signal,maxBytes:MAX_BYTES});
    metadata=parsed.metadata;
    if(metadata.formatKey!==rule.format_key||metadata.sha256!==staged.expectedSha256||BigInt(metadata.sizeBytes)!==BigInt(staged.sizeBytes)||
      !Number.isSafeInteger(metadata.dataRecordCount)||metadata.dataRecordCount<0)fail('FS_IMPORT_METADATA','解析材料身份或数据行数与归档不一致。');
    runCaseTransaction(db,record,{sourceFileIds:[sourceId]},()=>{
      db.prepare(`UPDATE source_file SET encoding_observed=?,format_observed=?,header_rows=?,data_rows=?,trailer_rows=?,unclassified_rows=0,
        coverage_complete=1,observations_json=? WHERE id=?`).run(metadata.encoding,metadata.formatKey,metadata.headerRecordCount,
        metadata.dataRecordCount,metadata.nonDataRecordCount-metadata.headerRecordCount,
        canonicalJSON({bom:metadata.bom,columns:metadata.columns,sheetName:metadata.sheetName??null,referenceSheets:metadata.referenceSheets??[]}),sourceId);
      db.prepare("UPDATE import_batch SET status='importing',total_rows=? WHERE id=?").run(metadata.dataRecordCount,batchId);
    });
    const coordinates=new Set();let chunk=[];
    const flush=()=>{
      if(!chunk.length)return;
      cancelled(signal);writeChunk(db,record,sourceId,batchId,storedRule,chunk);
      for(const row of chunk){written++;if(row.status==='pending')pending++;if(row.amount===null)unquantifiable++;}
      progress(onProgress,{phase:'importing',parsedRows:coordinates.size,writtenRows:written,pendingRows:pending,totalRows:metadata.dataRecordCount});
      chunk=[];
    };
    for await(const row of parsed.rows) {
      cancelled(signal);const normalized=rowForStorage({...row,platform:binding.platform},rule.format_key);
      if(coordinates.has(normalized.source_loc))fail('FS_IMPORT_COORDINATE','解析结果出现重复来源坐标，未发布本次批次。');
      coordinates.add(normalized.source_loc);chunk.push(normalized);
      if(chunk.length>=CHUNK_SIZE)flush();
    }
    flush();cancelled(signal);
    if(coordinates.size!==metadata.dataRecordCount||written!==metadata.dataRecordCount)fail('FS_IMPORT_COUNT','解析、写入与原始数据行数不一致，未发布本次批次。');
    progress(onProgress,{phase:'verifying-archive'});
    if(await hashFile(archived,{signal})!==staged.expectedSha256)fail('FS_ARCHIVE_HASH','发布前归档复验失败，本次批次未发布。');
    cancelled(signal);
    progress(onProgress,{phase:'publishing'});
    runCaseTransaction(db,record,{sourceFileIds:[sourceId]},()=>{
      const counts=db.prepare(`SELECT count(*) AS total,count(DISTINCT source_loc) AS coordinates,
        sum(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
        sum(CASE WHEN amount IS NULL THEN 1 ELSE 0 END) AS unknown FROM fund_flow WHERE batch_id=?`).get(batchId);
      if(counts.total!==written||counts.coordinates!==written||(counts.pending??0)!==pending||(counts.unknown??0)!==unquantifiable) {
        fail('FS_IMPORT_COUNT','发布前数据库行数复核不一致。');
      }
      db.prepare(`UPDATE import_batch SET status='done',finished_at=?,total_rows=?,imported_rows=?,skipped_rows=0,
        pending_rows=?,unquantifiable_rows=?,error_rows=0,cancelled_rows=0 WHERE id=?`)
        .run(new Date().toISOString(),written,written,pending,unquantifiable,batchId);
      db.prepare(`UPDATE source_file SET current_batch_id=?,status='imported',imported_at=?,format_rule_id=?,raw_records=? WHERE id=?`)
        .run(batchId,new Date().toISOString(),storedRule.id,written,sourceId);
    });
    progress(onProgress,{phase:'completed',writtenRows:written,pendingRows:pending,totalRows:written});
    return {state:'completed',preview:true,sourceFileId:sourceId,batchId,parserVersion:adapter.version,totalRows:written,
      importedRows:written,skippedRows:0,pendingRows:pending,unquantifiableRows:unquantifiable,errorRows:0,cancelledRows:0};
  } catch(error) {
    const code=signal?.aborted||error.name==='AbortError'?'FS_USER_CANCELLED':error.code?.startsWith('FS_')?error.code:'FS_IMPORT_FAILED';
    if(batchId!==null) {
      const existing=db.prepare('SELECT status FROM import_batch WHERE id=?').get(batchId);
      if(existing&&!['done','failed','partial'].includes(existing.status)) {
        runCaseTransaction(db,record,{sourceFileIds:[sourceId]},()=>{
          db.prepare(`UPDATE import_batch SET status='failed',finished_at=?,imported_rows=?,pending_rows=?,unquantifiable_rows=?,
            error_code=?,cancel_reason=?,cancelled_rows=? WHERE id=?`).run(new Date().toISOString(),written,pending,unquantifiable,
              code,code==='FS_USER_CANCELLED'?'用户取消':null,code==='FS_USER_CANCELLED'&&metadata?metadata.dataRecordCount-written:null,batchId);
          db.prepare("UPDATE source_file SET status='failed' WHERE id=? AND current_batch_id IS NULL").run(sourceId);
        });
      }
    }
    const wrapped=Object.assign(new Error(code==='FS_USER_CANCELLED'?'已取消导入，原有效批次保持不变。':
      code==='FS_IMPORT_DUPLICATE'?error.message:'导入未发布，请根据错误码核对规则或材料；原有效批次保持不变。',{cause:error}),{code});
    wrapped.receipt={state:code==='FS_USER_CANCELLED'?'cancelled':'failed',sourceFileId:sourceId,batchId,
      importedRows:written,pendingRows:pending,unquantifiableRows:unquantifiable,errorCode:code};
    throw wrapped;
  } finally { active.delete(db); }
}

async function readFlowSource({db,record,caseDirectory,caseDir,flowId,signal}={}) {
  assertCase(db,record);
  assertCaseDirectory(db,caseDirectory??caseDir);
  let flow;
  try{flow=assertInt64(flowId);}catch(_){fail('FS_IMPORT_SOURCE','流水编号无效。');}
  if(flow<1n)fail('FS_IMPORT_SOURCE','流水编号无效。');
  const row=db.prepare(`SELECT f.source_loc,f.raw_record,s.file_name,s.file_sha256,a.size_bytes,a.final_relative_path,a.expected_sha256,
    a.copied_sha256,a.status AS archive_status FROM fund_flow f JOIN source_file s ON s.id=f.source_file_id
    JOIN import_batch b ON b.id=f.batch_id AND b.source_file_id=s.id
    JOIN archive_entry a ON a.id=b.archive_entry_id WHERE f.id=? AND f.case_id=1 AND s.case_id=1 AND b.case_id=1`).safeIntegers().get(flow);
  if(!row)fail('FS_IMPORT_SOURCE','流水或完整归档引用已失联。');
  if(row.archive_status!=='verified'||row.expected_sha256!==row.file_sha256||row.copied_sha256!==row.file_sha256)fail('FS_ARCHIVE_HASH','回源归档身份不一致。');
  const file=archivePath(caseDirectory??caseDir,row.final_relative_path,row.file_sha256);
  if(BigInt(fs.statSync(file).size)!==row.size_bytes)fail('FS_ARCHIVE_HASH','回源归档大小已变化。');
  let saved;
  try{saved=JSON.parse(row.raw_record);}catch(_){fail('FS_IMPORT_SOURCE','已保存的原文封装损坏。');}
  const adapter=FORMATS[saved.format_key];
  if(!adapter)fail('FS_IMPORT_SOURCE','此记录的来源格式尚未支持回源。');
  const raw=await require(adapter.module)[adapter.read](file,row.source_loc,{expectedSha256:row.file_sha256,signal,maxBytes:MAX_BYTES});
  if(saved.source_loc!==row.source_loc||canonicalJSON(saved.values)!==canonicalJSON(raw.values))fail('FS_IMPORT_SOURCE','原文封装与归档记录不一致。');
  return {fileName:row.file_name,sourceLoc:row.source_loc,sourceSha256:row.file_sha256,...raw,savedDerivation:saved.derivation??null};
}

function recoverInterruptedImports({db,record,caseDirectory}={}) {
  assertCase(db,record);assertCaseDirectory(db,caseDirectory);
  if(active.has(db))fail('FS_IMPORT_BUSY','当前案件仍有导入任务，不能执行中断恢复。');
  const recovered=[],diagnostics=[];
  const unfinished=db.prepare("SELECT * FROM import_batch WHERE status IN ('pending','parsing','importing') ORDER BY id").all();
  for(const batch of unfinished) {
    let owned=false;
    try {
      const notes=JSON.parse(batch.notes);
      const ruleConfig=Number.isSafeInteger(notes.rule_id)&&Number.isSafeInteger(notes.rule_version)?db.prepare(`SELECT c.config_sha256,r.format_key
        FROM format_rule_config c JOIN format_rule r ON r.id=c.rule_id AND r.rule_version=c.rule_version
        WHERE c.rule_id=? AND c.rule_version=?`).get(notes.rule_id,notes.rule_version):null;
      policyFor(notes.policy,ruleConfig?.format_key);
      owned=FORMATS[ruleConfig?.format_key]?.version===batch.parser_version&&notes.preview===true&&
        notes.policy_sha256===sha256(canonicalJSON(notes.policy))&&/^[a-f0-9]{64}$/.test(notes.config_sha256)&&
        ruleConfig?.config_sha256===notes.config_sha256&&
        !db.prepare('SELECT id FROM fund_flow WHERE batch_id=? AND (format_rule_id<>? OR rule_version<>?) LIMIT 1')
          .get(batch.id,notes.rule_id,notes.rule_version);
    } catch(_) { /* Unknown producers are reported for explicit review. */ }
    if(!owned) {
      diagnostics.push({batchId:batch.id,sourceFileId:batch.source_file_id,code:'FS_IMPORT_RECOVERY_UNRECOGNIZED',requiresReview:true});
      continue;
    }
    runCaseTransaction(db,record,{sourceFileIds:[batch.source_file_id]},()=>{
      const counts=db.prepare(`SELECT count(*) total,sum(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
        sum(CASE WHEN amount IS NULL THEN 1 ELSE 0 END) unknown FROM fund_flow WHERE batch_id=?`).get(batch.id);
      db.prepare(`UPDATE import_batch SET status='failed',finished_at=?,imported_rows=?,pending_rows=?,unquantifiable_rows=?,
        error_code='FS_IMPORT_INTERRUPTED',cancel_reason=NULL WHERE id=?`).run(new Date().toISOString(),counts.total,counts.pending??0,counts.unknown??0,batch.id);
      db.prepare("UPDATE source_file SET status='failed' WHERE id=? AND current_batch_id IS NULL").run(batch.source_file_id);
      recovered.push({batchId:batch.id,sourceFileId:batch.source_file_id,importedRows:counts.total,
        pendingRows:counts.pending??0,unquantifiableRows:counts.unknown??0,errorCode:'FS_IMPORT_INTERRUPTED'});
    });
  }
  let archive=[];
  if(fs.existsSync(path.join(caseDirectory,'archive/.journal')))archive=new ArchiveStore(caseDirectory).inspectRecovery();
  return {recovered,diagnostics,archive};
}

const importAlipayAccount=options=>{
  if(options?.rule?.format_key!==FORMAT_KEY)fail('FS_IMPORT_RULE','此入口仅支持支付宝账户明细。');
  return importSourceFile(options);
};
module.exports={importAlipayAccount,importSourceFile,readFlowSource,recoverInterruptedImports,PARSER_VERSION,MAX_BYTES};
