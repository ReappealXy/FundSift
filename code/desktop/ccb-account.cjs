'use strict';

// Only the approved concrete 32-column CCB export, never a generic Excel parser.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { crc32 } = require('node:zlib');
const yauzl = require('yauzl');
const { DOMParser } = require('@xmldom/xmldom');
const { normalizeMoney, validateMoneyRule, parseMinor, assertInt64 } = require('./money.cjs');
const FORMAT_KEY = 'ccb-account-32col-v1';
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED = 128 * 1024 * 1024;
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const HEADERS = Object.freeze(['序号','客户名称','账号','币种','钞汇','册号','笔号','存期','交易日期','交易时间',
  '活期存款账户明细号','交易卡号','摘要','借贷方向','交易金额','账户余额','柜员号','交易机构号','交易机构名称',
  '对方账号','对方户名','对方行名','对方行号','交易流水号','交易渠道','自助设备编号','扩充备注','IP地址','MAC地址',
  '第三方订单号','商户号','商户名称']);
const ACCOUNT_HEADERS = Object.freeze(['序号','账户名称','客户编号','证件类型','证件号码','账号','账户类型','借记卡主账户账号',
  '币种','钞汇','册号','笔号','存期','余额','可用余额','开户金额','可冻结金额','业务冻结金额','司法冻结金额','冻结状态',
  '转营业外余额','开户日期','开户机构号','开户机构名称','开户柜员号','结清日期','销户日期','销户机构号','销户机构名称',
  '存款种类','上次交易日','账户状态','借记卡介质状态','借记卡挂失状态','账户性质','资金用途','法人名称',
  '法人证件类型','法人证件号码','结算账户分类代码','可售产品编号','可售产品名称','备注']);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function abort(signal) { if (signal?.aborted) fail('FS_USER_CANCELLED','已取消建行文件读取，未发布结果。'); }
const elements = (node, name, namespace = NS) => [...Array.from(node.getElementsByTagNameNS(namespace, name))];
const children = (node, name) => Array.from(node.childNodes).filter(child => child.nodeType === 1 && child.namespaceURI === NS && child.localName === name);
function cap(options) {
  const value = options.maxBytes ?? MAX_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BYTES) fail('FS_FORMAT_INPUT','文件上限必须介于1字节和64MiB。');
  return value;
}
function xml(bytes) {
  let text;
  try { text = new TextDecoder('utf-8',{ fatal:true }).decode(bytes); }
  catch { fail('FS_FORMAT_ENCODING','OOXML部件不是有效UTF-8。'); }
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || text.includes('\0')) fail('FS_FORMAT_STRUCTURE','不接受DTD、实体声明或空字符。');
  let document;
  const reject = () => fail('FS_FORMAT_STRUCTURE','OOXML部件不是完整且有效的XML。');
  try { document = new DOMParser({ onError:reject }).parseFromString(text,'application/xml'); }
  catch (error) { if (error.code) throw error; reject(); }
  if (!document?.documentElement || document.getElementsByTagName('parsererror').length) reject();
  return document;
}
async function unzip(bytes, options) {
  abort(options.signal);
  return new Promise((resolve,reject) => {
    yauzl.fromBuffer(bytes,{ lazyEntries:true, strictFileNames:true, validateEntrySizes:true },(error,zip) => {
      if (error) { reject(Object.assign(new Error('无法读取有效的XLSX ZIP容器。'),{code:'FS_FORMAT_STRUCTURE'})); return; }
      const files = new Map(); let total = 0, count = 0, settled = false;
      const stop = error => { if (settled) return; settled = true; zip.close(); reject(error.code?.startsWith('FS_') ? error : Object.assign(new Error('XLSX容器损坏或解压失败。'),{code:'FS_FORMAT_STRUCTURE'})); };
      zip.on('error',stop);
      zip.on('entry',entry => {
        try {
          abort(options.signal);
          if (++count > 2048 || entry.uncompressedSize > MAX_BYTES || (total += entry.uncompressedSize) > MAX_EXPANDED) fail('FS_FORMAT_TOO_LARGE','XLSX解压内容超过技术预览限制。');
          const name = entry.fileName;
          if (entry.generalPurposeBitFlag & 1) fail('FS_FORMAT_UNSUPPORTED','不支持加密XLSX。');
          if (name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.') || files.has(name)) fail('FS_FORMAT_STRUCTURE','XLSX部件名称越界或重复。');
          if (/vbaProject|externalLinks|activeX|embeddings/i.test(name)) fail('FS_FORMAT_UNSUPPORTED','不支持宏、外部链接或嵌入对象。');
          if (name.endsWith('/')) { files.set(name,null); zip.readEntry(); return; }
          zip.openReadStream(entry,(error,stream) => {
            if (error) { stop(error); return; }
            const chunks=[]; let length=0,checksum=0;
            stream.on('error',stop);
            stream.on('data',chunk => {
              try { abort(options.signal); length += chunk.length; if (length > entry.uncompressedSize || length > MAX_BYTES) fail('FS_FORMAT_TOO_LARGE','XLSX部件解压超限。'); checksum=crc32(chunk,checksum);chunks.push(chunk); }
              catch (error) { stream.destroy(); stop(error); }
            });
            stream.on('end',() => {
              if (settled) return;
              if (length !== entry.uncompressedSize) { stop(Object.assign(new Error('XLSX部件长度不符。'),{code:'FS_FORMAT_STRUCTURE'})); return; }
              if (checksum!==entry.crc32) { stop(Object.assign(new Error('XLSX部件CRC校验失败，文件内容可能损坏。'),{code:'FS_FORMAT_STRUCTURE'})); return; }
              files.set(name,Buffer.concat(chunks,length)); zip.readEntry();
            });
          });
        } catch (error) { stop(error); }
      });
      zip.on('end',() => { if (!settled) { settled = true; resolve(files); } });
      zip.readEntry();
    });
  });
}
function localTime(text) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?![\s\S])/.test(text)) return null;
  const year=Number(text.slice(0,4)), month=Number(text.slice(5,7)), day=Number(text.slice(8,10));
  const leap=year%4===0&&(year%100!==0||year%400===0), days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  return month>=1&&month<=12&&day>=1&&day<=days[month-1]&&Number(text.slice(11,13))<=23&&Number(text.slice(14,16))<=59&&Number(text.slice(17,19))<=59 ? text : null;
}
function exactChildren(node,names) {
  const items=Array.from(node.childNodes).filter(child=>child.nodeType===1);
  if(items.some(child=>child.namespaceURI!==NS||!names.includes(child.localName)))fail('FS_FORMAT_STRUCTURE','单元格或字符串含未知子结构，不忽略附加原始值。');
  return items;
}
function scalarText(node) {
  if(Array.from(node.childNodes).some(child=>child.nodeType===1))fail('FS_FORMAT_STRUCTURE','文本或索引节点含嵌套元素，不能拼接为金额或原文。');
  return node.textContent;
}
function readSheet(document, headers, sharedStrings, name) {
  if (document.documentElement.namespaceURI!==NS || document.documentElement.localName!=='worksheet') fail('FS_FORMAT_UNSUPPORTED','不支持的工作表命名空间。');
  const allowed=new Set(['dimension','sheetViews','sheetFormatPr','sheetData','sheetProtection','autoFilter','pageMargins']);
  if(Array.from(document.documentElement.childNodes).some(node=>node.nodeType===1&&(node.namespaceURI!==NS||!allowed.has(node.localName))))fail('FS_FORMAT_UNSUPPORTED','工作表存在本具体结构未支持的附加数据，不静默跳过。');
  if (['f','mergeCell','mergeCells','tablePart','oleObject'].some(tag => elements(document,tag).length)) fail('FS_FORMAT_UNSUPPORTED','本结构不支持公式、合并单元格或嵌入对象，不读取缓存结果。');
  const data=elements(document,'sheetData');
  if (data.length!==1) fail('FS_FORMAT_STRUCTURE','工作表数据区缺失或重复。');
  if (Array.from(data[0].childNodes).some(node=>node.nodeType===1&&(node.namespaceURI!==NS||node.localName!=='row'))) fail('FS_FORMAT_STRUCTURE','数据区含不支持的行结构，不跳过未知记录。');
  const output=[]; let prior=0;
  for (const row of children(data[0],'row')) {
    const number=Number(row.getAttribute('r'));
    if (!Number.isSafeInteger(number)||number<=prior||number>1048576) fail('FS_FORMAT_STRUCTURE','工作表行号缺失、重复或越界。');
    const values=Array(headers.length).fill(''), cells=[]; let lastColumn=-1;
    if (Array.from(row.childNodes).some(node=>node.nodeType===1&&(node.namespaceURI!==NS||node.localName!=='c'))) fail('FS_FORMAT_STRUCTURE','数据行含不支持的单元格结构。');
    for (const cell of children(row,'c')) {
      const ref=cell.getAttribute('r'), match=/^([A-Z]+)([1-9]\d*)(?![\s\S])/.exec(ref);
      let column=0;
      if (!match||Number(match[2])!==number) fail('FS_FORMAT_STRUCTURE','单元格坐标与行号不一致。');
      for (const letter of match[1]) column=column*26+letter.charCodeAt(0)-64;
      column--;
      if (column<=lastColumn||column>=headers.length) fail('FS_FORMAT_STRUCTURE','单元格重复、乱序或超出本结构列数。');
      lastColumn=column;
      const type=cell.getAttribute('t'); let value;
      if (type==='inlineStr') {
        exactChildren(cell,['is']);
        const inline=children(cell,'is');
        if (inline.length!==1||children(cell,'v').length||elements(inline[0],'r').length) fail('FS_FORMAT_UNSUPPORTED','不支持的内联富文本或混合单元格。');
        exactChildren(inline[0],['t']);
        const texts=children(inline[0],'t');
        if (texts.length!==1) fail('FS_FORMAT_STRUCTURE','内联文本缺失或重复。');
        value=scalarText(texts[0]);
      } else if (type==='s') {
        exactChildren(cell,['v']);
        const nodes=children(cell,'v');
        if (nodes.length!==1||!/^\d+(?![\s\S])/.test(scalarText(nodes[0]))) fail('FS_FORMAT_STRUCTURE','共享字符串索引无效。');
        const index=Number(scalarText(nodes[0]));
        if (!Number.isSafeInteger(index)||index>=sharedStrings.length) fail('FS_FORMAT_STRUCTURE','共享字符串索引越界。');
        value=sharedStrings[index];
      } else if (!type && !children(cell,'v').length && !children(cell,'is').length) {exactChildren(cell,[]);value='';}
      else fail('FS_FORMAT_UNSUPPORTED','本具体结构只接受文本单元格，不能猜测数字格式、日期序列或布尔值。');
      values[column]=value; cells.push({cell:ref,type:type||'empty',value});
    }
    if (values.every(value=>value==='')) fail('FS_FORMAT_STRUCTURE','工作表含空的存储行，不静默跳过。');
    output.push({number,values,cells}); prior=number;
  }
  if (!output.length||output[0].number!==1||!headers.every((value,index)=>value===output[0].values[index])) fail('FS_FORMAT_UNSUPPORTED',`${name}表头与已支持结构不符。`);
  return output;
}
async function structure(bytes,options={}) {
  if (!Buffer.isBuffer(bytes)) fail('FS_FORMAT_INPUT','解析入口需要文件字节Buffer。');
  if (bytes.length>cap(options)) fail('FS_FORMAT_TOO_LARGE','本预览只支持不超过64MiB的单个文件。');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  if (options.expectedSha256!==undefined&&options.expectedSha256!==sha256) fail('FS_FORMAT_IDENTITY','文件字节与预期归档身份不符。');
  const files=await unzip(bytes,options), documents=new Map();
  for (const [name,data] of files) if (data&&(name.endsWith('.xml')||name.endsWith('.rels'))) documents.set(name,xml(data));
  const required=['[Content_Types].xml','xl/workbook.xml','xl/_rels/workbook.xml.rels'];
  if (required.some(name=>!documents.has(name))) fail('FS_FORMAT_UNSUPPORTED','缺少标准XLSX工作簿部件。');
  for (const [name,doc] of documents) {
    if (name.endsWith('.rels')) for (const relation of elements(doc,'Relationship',REL_NS)) {
      if (relation.getAttribute('TargetMode')==='External') fail('FS_FORMAT_UNSUPPORTED','不支持外部关系引用。');
    }
    if (elements(doc,'f').length||elements(doc,'mergeCell').length) fail('FS_FORMAT_UNSUPPORTED','工作簿含公式或合并单元格。');
  }
  for (const content of Array.from(documents.get('[Content_Types].xml').documentElement.childNodes).filter(node=>node.nodeType===1)) {
    if (/macroEnabled|vba|externalLink/i.test(content.getAttribute('ContentType'))) fail('FS_FORMAT_UNSUPPORTED','不支持宏或外部链接工作簿。');
  }
  const workbook=documents.get('xl/workbook.xml');
  if (workbook.documentElement.namespaceURI!==NS||workbook.documentElement.localName!=='workbook') fail('FS_FORMAT_UNSUPPORTED','不支持此工作簿命名空间。');
  const shared=[];
  if (documents.has('xl/sharedStrings.xml')) {
    const table=documents.get('xl/sharedStrings.xml').documentElement;
    if(table.namespaceURI!==NS||table.localName!=='sst')fail('FS_FORMAT_STRUCTURE','共享字符串表结构无效。');
    exactChildren(table,['si']);
    for (const item of children(table,'si')) {
      exactChildren(item,['t']);
      if (elements(item,'r').length||children(item,'t').length!==1) fail('FS_FORMAT_UNSUPPORTED','不支持富文本共享字符串。');
      shared.push(scalarText(children(item,'t')[0]));
    }
  }
  const relationships=new Map();
  for (const relation of elements(documents.get('xl/_rels/workbook.xml.rels'),'Relationship',REL_NS)) {
    const id=relation.getAttribute('Id');
    if (!id||relationships.has(id)) fail('FS_FORMAT_STRUCTURE','工作表关系标识缺失或重复。');
    relationships.set(id,relation);
  }
  const sheets=elements(workbook,'sheet');
  if (sheets.length!==2||new Set(sheets.map(sheet=>sheet.getAttribute('name'))).size!==2||
      !sheets.every(sheet=>['交易明细','开户信息'].includes(sheet.getAttribute('name')))) fail('FS_FORMAT_UNSUPPORTED','仅支持明确的交易明细及开户信息两工作表结构。');
  const rows=new Map(), targets=new Set();
  for (const sheet of sheets) {
    if (sheet.getAttribute('state')&&sheet.getAttribute('state')!=='visible') fail('FS_FORMAT_UNSUPPORTED','本结构不支持隐藏工作表。');
    const name=sheet.getAttribute('name'), relation=relationships.get(sheet.getAttributeNS(DOC_REL,'id'));
    if (!relation||relation.getAttribute('Type')!==DOC_REL+'/worksheet') fail('FS_FORMAT_STRUCTURE','工作表关系无效。');
    const target=relation.getAttribute('Target');
    if (!target||target.includes('\\')||target.includes(':')||target.split('/').some(part=>part==='..'||part==='.')||target.startsWith('/')) fail('FS_FORMAT_STRUCTURE','工作表部件路径越界。');
    const filename=path.posix.join('xl',target);
    if (targets.has(filename)||!documents.has(filename)) fail('FS_FORMAT_STRUCTURE','工作表部件重复或缺失。');
    targets.add(filename); rows.set(name,readSheet(documents.get(filename),name==='交易明细'?HEADERS:ACCOUNT_HEADERS,shared,name));
  }
  if([...documents.keys()].some(name=>/^xl\/worksheets\/[^/]+\.xml$/.test(name)&&!targets.has(name)))fail('FS_FORMAT_UNSUPPORTED','存在工作簿未声明的附加工作表，不静默忽略。');
  const trades=rows.get('交易明细');
  if (trades.length<2) fail('FS_FORMAT_EMPTY','交易明细只有表头，没有可导入记录。');
  return {records:trades.slice(1),metadata:{formatKey:FORMAT_KEY,encoding:'xlsx-ooxml-utf8',bom:false,sha256,sizeBytes:String(bytes.length),
    headerRecordCount:1,dataRecordCount:trades.length-1,nonDataRecordCount:1+rows.get('开户信息').length,
    columns:[...HEADERS],sheetName:'交易明细',referenceSheets:[{name:'开户信息',headerRecordCount:1,dataRecordCount:rows.get('开户信息').length-1}]}};
}
function binding(rule) {
  validateMoneyRule(rule);
  if (rule.amount_expr!=='E'||rule.source_unit!=='元'||rule.unit_scale!==100||rule.negative_policy!=='pending'||rule.zero_policy!=='pending'||
      Object.keys(rule.direction_map).length!==2||rule.direction_map.借!=='出'||rule.direction_map.贷!=='进'||rule.currency_policy!=='explicit'||
      Object.keys(rule.currency_map).length!==1||rule.currency_map['人民币元']!=='CNY') fail('FS_FORMAT_RULE','建行规则须声明元、借出贷进、负数待核及人民币元映射。');
}
function normalize(record,rule,policy) {
  const v=record.values,source_loc=`交易明细!${record.number}`,money=normalizeMoney({raw_amount_text:v[14],raw_direction:v[13],currency_text:v[3]},rule);
  const reasons=money.reasons.map(reason=>({...reason}));
  const add=(reason_code,detail)=>{if(!reasons.some(reason=>reason.reason_code===reason_code))reasons.push({reason_code,detail});};
  const approved=policy?.review?.status==='approved'&&['by','at','reason'].every(key=>typeof policy.review[key]==='string'&&policy.review[key].trim());
  let txn_time=null,acct_no=null,balance=null;
  if (!approved||policy.timeColumn!=='交易日期+交易时间') add('time_policy_unapproved','日期与时间拼接政策尚未批准。');
  else if(!v[8].trim()||!v[9].trim())add('time_missing','交易日期或交易时间缺失，不补其它字段。');
  else if((txn_time=localTime(v[8]+' '+v[9]))===null)add('time_invalid','本格式只确认完整合法本地日期时间，保留原文待核。');
  if(!approved||policy.accountIdentityPolicy!=='raw_bank_account') add('account_identity_policy_unapproved','本方账号原文政策未批准。');
  else if(!v[2].trim())add('account_missing','本方账号缺失，不用卡号或姓名补位。');
  else acct_no=v[2];
  if(acct_no===null&&!reasons.some(reason=>reason.reason_code==='account_missing'))add('account_missing','标准本方标识尚未确定。');
  if(!approved||policy.balancePolicy!=='preserve_unknown')add('balance_policy_unapproved','余额保留及未知口径政策未批准。');
  else if(v[15].trim())try { balance=assertInt64(parseMinor(v[15],'元').value).toString(); }
  catch(error) {if(!['FS_MONEY_FORMAT','FS_MONEY_INT64'].includes(error.code))throw error;add('balance_unparseable','余额无法精确解释为int64分，原文保留。');}
  const derivation={money:money.derivation,time_column:'交易日期+交易时间',time_fallback:false,account_identity_policy:approved?policy.accountIdentityPolicy??null:null,
    account_identity_type:acct_no===null?null:'bank_account_raw',business_status_policy:'not_available',balance_policy:approved?policy.balancePolicy??null:null};
  return {source_loc,source_sheet:'交易明细',source_row:record.number,raw_values:[...v],raw_fields:Object.fromEntries(HEADERS.map((header,index)=>[header,v[index]])),
    raw_record:JSON.stringify({format_key:FORMAT_KEY,source_loc,values:v,sheet:'交易明细',row:record.number,cells:record.cells}),
    raw_amount_text:v[14],raw_direction:v[13],raw_balance_text:v[15],raw_currency_text:v[3],txn_time_text:v[8]+' '+v[9],
    trade_no:v[23],order_no:v[29],acct_no,acct_name:v[1]||null,peer_acct:v[19]||null,peer_name:v[20]||null,peer_info:v[21],
    summary:v[12],remark:v[26],business_status:null,bank_card:v[11],
    amount:money.amount,direction:money.direction,currency:money.currency,currency_evidence:{iso:'raw_iso',approved_map:'approved_map',verified_cny:'verified_cny',unknown:'unknown'}[money.derivation.currency.source]??'unknown',
    reversal_flag:money.reversal_flag,txn_time,balance,balance_scope:'unknown',status:reasons.length?'pending':'confirmed',pendingReasons:reasons,reasons,derivation};
}
async function parseCcbAccountBytes(bytes,options={}) {
  binding(options.rule);
  const rule=structuredClone(options.rule),policy=structuredClone(options.policy??{}),parsed=await structure(bytes,options);
  async function* rows(){for(let index=0;index<parsed.records.length;index++){if(index%250===0)await new Promise(resolve=>setImmediate(resolve));abort(options.signal);yield normalize(parsed.records[index],rule,policy);}}
  return {metadata:parsed.metadata,rows:rows()};
}
async function readBytes(filePath,options={}) {
  if(typeof filePath!=='string'||!filePath)fail('FS_FORMAT_INPUT','需要明确归档路径。');
  const limit=cap(options);abort(options.signal);
  try {
    const before=fs.lstatSync(filePath,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink())fail('FS_FORMAT_SOURCE','请选择普通归档文件。');
    if(before.size>BigInt(limit))fail('FS_FORMAT_TOO_LARGE','文件超过64MiB预览上限。');
    const chunks=[];let length=0;
    for await(const chunk of fs.createReadStream(filePath,{signal:options.signal,highWaterMark:65536})){length+=chunk.length;if(length>limit)fail('FS_FORMAT_TOO_LARGE','读取期间文件超过预览上限。');chunks.push(chunk);}
    const after=fs.lstatSync(filePath,{bigint:true});
    if(after.isSymbolicLink()||['dev','ino','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key])||BigInt(length)!==before.size)fail('FS_FORMAT_IDENTITY','归档读取期间发生变化。');
    return Buffer.concat(chunks,length);
  }catch(error){if(error.code?.startsWith('FS_'))throw error;if(error.name==='AbortError')fail('FS_USER_CANCELLED','已取消文件读取。');fail('FS_FORMAT_SOURCE','无法读取归档文件。');}
}
async function openCcbAccount(filePath,options={}){const parsed=await parseCcbAccountBytes(await readBytes(filePath,options),options);parsed.metadata.fileName=path.basename(filePath);return parsed;}
async function readCcbAccountSource(filePath,sourceLoc,options={}){
  const match=typeof sourceLoc==='string'&&/^交易明细!([1-9]\d{0,6})(?![\s\S])/.exec(sourceLoc);
  if(!match)fail('FS_SOURCE_COORDINATE','来源坐标必须是交易明细工作表行号。');
  const parsed=await structure(await readBytes(filePath,options),options),record=parsed.records.find(record=>record.number===Number(match[1]));
  if(!record)fail('FS_SOURCE_COORDINATE','坐标不在数据行范围。');
  return {metadata:parsed.metadata,source_loc:sourceLoc,sheet:'交易明细',row:record.number,values:[...record.values],cells:record.cells,
    fields:Object.fromEntries(HEADERS.map((header,index)=>[header,record.values[index]]))};
}
module.exports={FORMAT_KEY,MAX_BYTES,HEADERS,ACCOUNT_HEADERS,parseCcbAccountBytes,openCcbAccount,readCcbAccountSource};
