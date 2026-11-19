'use strict';

// Evidence candidates only. This module never merges records or produces an
// economic total. Missing/contradictory evidence stays visible on each side.
const { withCaseReadSnapshot } = require('./hardening.cjs');
const MAX_ROWS = 100000, MAX_CANDIDATES = 200, MAX_RAW_BYTES = 64 * 1024 * 1024;
const WX = 'wechat-trades-27col-v1', CCB = 'ccb-account-32col-v1';
function fail(code,message) { throw Object.assign(new Error(message),{code}); }
const decimal = value => typeof value === 'bigint' ? value.toString() : value;
function tick(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const result = Date.parse(value.replace(' ','T')+'Z');
  return Number.isFinite(result) ? result : null;
}
function card(value) { return typeof value === 'string' && /^\d{12,25}$/.test(value) ? value : null; }
function prepare(row) {
  let raw;
  try { raw = JSON.parse(row.raw_record); } catch (_) { return null; }
  const formatKey = raw?.format_key, width = formatKey === WX ? 27 : formatKey === CCB ? 32 : 0;
  if (!width || !Array.isArray(raw.values) || raw.values.length !== width || raw.source_loc !== row.source_loc) return null;
  const values = raw.values;
  if (values.some(value => typeof value !== 'string')) return null;
  const amount = row.amount === null ? null : BigInt(row.amount), time = tick(row.txn_time);
  const {raw_record,...metadata}=row;
  return { ...metadata, formatKey, time, magnitude: amount === null ? null : (amount < 0n ? -amount : amount).toString(),
    ownCard: card(values[formatKey === WX ? 10 : 11]), peerCard: formatKey === WX ? card(values[16]) : null,
    order: formatKey === WX && values[1].trim() ? values[1] : null };
}
function side(row, matchedCard = null) {
  return { id: decimal(row.id), fileName: row.source_file_name, sourceLoc: row.source_loc, platform: row.platform,
    time: row.txn_time, amount: decimal(row.amount), currency: row.currency, direction: row.direction, status: row.status,
    accountIdentity: row.acct_no, bankCard: matchedCard ?? row.ownCard };
}
function queryRelationCandidates(db,{caseId,limit=100}={}) {
  if (typeof caseId !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CANDIDATES) {
    fail('FS_QUERY_INPUT','关系候选查询参数无效。');
  }
  return withCaseReadSnapshot(db,() => {
    const state = db.prepare('SELECT case_uuid,data_version FROM case_data_state WHERE id=1').safeIntegers().get();
    if (state?.case_uuid !== caseId) fail('FS_CASE_IDENTITY','查询案件与当前数据库不符。');
    const statement = db.prepare(`SELECT f.id,f.source_file_id,f.source_loc,f.txn_time,f.amount,f.currency,f.direction,f.status,
      f.platform,f.acct_no,f.raw_record,s.file_name AS source_file_name
      FROM fund_flow f JOIN source_file s ON s.id=f.source_file_id AND s.case_id=f.case_id
      JOIN import_batch b ON b.id=s.current_batch_id AND b.id=f.batch_id AND b.source_file_id=s.id AND b.status='done'
      WHERE f.case_id=1 ORDER BY f.id LIMIT ?`).safeIntegers();
    const records=[];let sourceCount=0,rawBytes=0,scanTruncated=false;
    for(const row of statement.iterate(MAX_ROWS+1)) {
      const bytes=typeof row.raw_record==='string'?Buffer.byteLength(row.raw_record,'utf8'):0;
      if(sourceCount>=MAX_ROWS||rawBytes+bytes>MAX_RAW_BYTES){scanTruncated=true;break;}
      sourceCount++;rawBytes+=bytes;
      const record=prepare(row);if(record)records.push(record);
    }
    const wx=records.filter(r=>r.formatKey===WX), bank=records.filter(r=>r.formatKey===CCB);
    const bankByTimeAmount=new Map(), candidates=[], seen=new Set(); let truncated=scanTruncated;
    for(const row of bank) {
      if(row.time===null || row.magnitude===null || row.currency===null || !row.ownCard) continue;
      const key=JSON.stringify([row.time,row.magnitude,row.currency,row.ownCard]);
      const list=bankByTimeAmount.get(key)||[];list.push(row);bankByTimeAmount.set(key,list);
    }
    const push=candidate=>{
      if(seen.has(candidate.id))return true;
      seen.add(candidate.id);
      if(candidates.length>=limit){truncated=true;return false;}
      candidates.push(candidate);return true;
    };
    outer: for(const left of wx) {
      if(left.time===null || left.magnitude===null || left.currency===null)continue;
      const cards=[...new Set([left.ownCard,left.peerCard].filter(Boolean))];
      for(const offset of [-1000,0,1000]) for(const matchCard of cards) for(const right of bankByTimeAmount.get(JSON.stringify([left.time+offset,left.magnitude,left.currency,matchCard]))||[]) {
        const own=left.ownCard!==null&&left.ownCard===right.ownCard;
        const peer=left.peerCard!==null&&left.peerCard===right.ownCard;
        if(!own&&!peer)continue;
        const warnings=[];
        if(left.status!=='confirmed'||right.status!=='confirmed')warnings.push('至少一端待核，标准金额或其它字段仍需核对。');
        if(own&&left.direction!==right.direction)warnings.push('本方卡号相同但收付方向不一致，不能视为支付镜像。');
        if(peer&&left.direction===right.direction)warnings.push('命中对方卡号但收付方向相同，关系含义待核。');
        const candidate={id:`wx-bank:${left.id}:${right.id}`,kind:own?'payment_mirror_candidate':'counterparty_candidate',
          label:own?'同一付款记录候选':'对端账户候选',ambiguous:warnings.length>0,left:side(left,own?left.ownCard:left.peerCard),right:side(right),
          evidence:[{label:'卡号字段',value:own?'微信本方卡号 = 建行交易卡号':'微信对方卡号 = 建行交易卡号'},
            {label:'标准金额绝对值（分）',value:left.magnitude},{label:'币种',value:left.currency},
            {label:'时间差（秒）',value:String(Math.abs(offset)/1000)},{label:'方向',value:`${left.direction??'未知'} / ${right.direction??'未知'}`}],warnings};
        if(!push(candidate))break outer;
      }
    }
    const orders=new Map();
    for(const row of wx) {
      if(row.order===null||typeof row.acct_no!=='string'||!row.acct_no.trim())continue;
      const key=JSON.stringify([row.acct_no,row.order]), prior=orders.get(key)||[];
      for(const previous of prior) {
        const warnings=['同交易号可能包含手续费、不同视角或拆分行，不能仅按编号去重。'];
        if(previous.magnitude!==row.magnitude)warnings.push('同号记录的标准金额不同。');
        if(!push({id:`wx-order:${previous.id}:${row.id}`,kind:'same_order_multiple_rows',label:'同单号多行',ambiguous:true,
          left:side(previous),right:side(row),evidence:[{label:'本方身份',value:'完整平台用户ID相同'},
            {label:'原始交易号',value:row.order}],warnings}))break;
      }
      prior.push(row);orders.set(key,prior);
      if(candidates.length>=limit&&truncated)break;
    }
    const partnerCounts=new Map();
    for(const row of candidates)for(const endpoint of [row.left,row.right])partnerCounts.set(endpoint.id,(partnerCounts.get(endpoint.id)||0)+1);
    for(const row of candidates) {
      if(partnerCounts.get(row.left.id)>1||partnerCounts.get(row.right.id)>1) {
        row.ambiguous=true;row.warnings.push('至少一端命中多个候选，请逐一核对；当前列表可能已截取。');
      }
      if(truncated){row.ambiguous=true;row.warnings.push('候选集合已截取，无法据此判断是否一对一。');}
    }
    return {caseId,dataVersion:state.data_version.toString(),rows:candidates,truncated,eligibleRows:String(sourceCount),
      limitations:['仅按当前已发布批次生成只读候选，不自动确认、合并或去重，不据此计算全案总额。',
        '微信与建行候选要求完整数字卡号、同币种、同标准金额绝对值，且交易时间相差不超过1秒；无共享身份或只有平台字样不会配对。',
        '微信同单号关系要求完整本方平台用户ID相同；支付宝余额视角、充值提现和退款链尚未纳入本查询。',
        `最多扫描${MAX_ROWS}条当前记录及64MiB原文，并返回${limit}个候选；截取时不代表完整关联集合。`]};
  });
}
module.exports={queryRelationCandidates};
