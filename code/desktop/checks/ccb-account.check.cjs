'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {FORMAT_KEY,HEADERS,ACCOUNT_HEADERS,parseCcbAccountBytes,openCcbAccount,readCcbAccountSource}=require('../ccb-account.cjs');
const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function rule(extra={}){return {id:1,rule_version:1,amount_expr:'E',source_unit:'元',unit_scale:100,rounding_rule:'ROUND_HALF_UP',
  direction_map:{借:'出',贷:'进'},negative_policy:'pending',zero_policy:'pending',zero_direction:null,currency_policy:'explicit',
  currency_map:{人民币元:'CNY'},review:{status:'approved',by:'合成审核',at:'2026-11-19',reason:'仅测试'},...extra};}
function policy(extra={}){return {timeColumn:'交易日期+交易时间',accountIdentityPolicy:'raw_bank_account',balancePolicy:'preserve_unknown',
  review:{status:'approved',by:'合成审核',at:'2026-11-19',reason:'仅测试'},...extra};}
function values(extra={}){const v=Array(32).fill('');Object.assign(v,{0:'1',1:'合成主体',2:'00000000000000000001',3:'人民币元',8:'2026-02-28',9:'12:34:56',
  11:'00000000000000000002',12:'合成消费',13:'借',14:'1.005',15:'8.99',19:'000peer',20:'合成对手',23:'duplicate-id',26:'原始备注',29:'third-party'});
  for(const [index,value]of Object.entries(extra))v[Number(index)]=value;return v;}
const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function letters(index){let out='';for(index++;index;index=Math.floor((index-1)/26))out=String.fromCharCode(65+(index-1)%26)+out;return out;}
function rowXML(v,row){return `<row r="${row}">${v.map((value,index)=>`<c r="${letters(index)}${row}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`).join('')}</row>`;}
function sheet(header,rows){return `<worksheet xmlns="${NS}"><sheetData>${[header,...rows].map((v,index)=>rowXML(v,index+1)).join('')}</sheetData></worksheet>`;}
// Test-only stored ZIP construction: production uses yauzl, not this fixture helper.
function crc(data){let value=0xffffffff;for(const byte of data){value^=byte;for(let bit=0;bit<8;bit++)value=value>>>1^(value&1?0xedb88320:0);}return (value^0xffffffff)>>>0;}
function zip(files){const entries=[],directory=[];let offset=0;for(const [filename,content]of Object.entries(files)){const name=Buffer.from(filename),data=Buffer.from(content),sum=crc(data);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(sum,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt32LE(sum,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
  entries.push(local,name,data);directory.push(central,name);offset+=local.length+name.length+data.length;
}const central=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...entries,central,end]);}
function files(rows=[values()]){return {'[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  'xl/workbook.xml':`<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="交易明细" sheetId="1" r:id="r1"/><sheet name="开户信息" sheetId="2" r:id="r2"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
  'xl/worksheets/sheet1.xml':sheet(HEADERS,rows),'xl/worksheets/sheet2.xml':sheet(ACCOUNT_HEADERS,[ACCOUNT_HEADERS.map((_,index)=>index===0?'1':index===5?'synthetic-account':'')])};}
async function parse(data,extra={}){const parsed=await parseCcbAccountBytes(data,{rule:rule(),policy:policy(),...extra}),rows=[];for await(const row of parsed.rows)rows.push(row);return {metadata:parsed.metadata,rows};}
const codes=row=>row.reasons.map(reason=>reason.reason_code);

test('CCB原始32列、来源工作表坐标和开户参考计数完整，借出贷进精确转分',async()=>{
  const original=values(),out=await parse(zip(files([original,values({0:'2',13:'贷',14:'0.01'})])));
  assert.equal(out.metadata.formatKey,FORMAT_KEY);assert.equal(out.metadata.dataRecordCount,2);assert.equal(out.metadata.nonDataRecordCount,3);
  assert.deepEqual(out.rows.map(row=>row.source_loc),['交易明细!2','交易明细!3']);assert.deepEqual(out.rows[0].raw_values,original);
  assert.deepEqual(JSON.parse(out.rows[0].raw_record).values,original);assert.equal(JSON.parse(out.rows[0].raw_record).cells.length,32);
  assert.equal(out.rows[0].amount,'-101');assert.equal(out.rows[1].amount,'1');assert.equal(out.rows[0].currency,'CNY');assert.equal(out.rows[0].currency_evidence,'approved_map');
  assert.equal(out.rows[0].acct_no,original[2]);assert.equal(out.rows[0].bank_card,original[11]);assert.equal(out.rows[0].txn_time,'2026-02-28 12:34:56');
  assert.equal(out.rows[0].balance,'899');assert.equal(out.rows[0].balance_scope,'unknown');assert.equal(out.rows[0].status,'confirmed');
});
test('CCB负数不反转，零值未知方向币种非法金额均待核；多原因不丢失',async()=>{
  const out=await parse(zip(files([values({14:'-1.34',12:'消费退货'}),values({14:'0'}),values({13:'未知',3:'美元',8:'2026-02-30',14:'N/A',2:''})])));
  assert.equal(out.rows[0].status,'pending');assert.equal(out.rows[0].amount,null);assert.equal(out.rows[0].reversal_flag,0);
  assert.ok(codes(out.rows[0]).includes('sign_semantics_undefined'));assert.equal(out.rows[1].status,'pending');
  for(const code of ['direction_unknown','currency_unknown','amount_unparseable','time_invalid','account_missing'])assert.ok(codes(out.rows[2]).includes(code),code);
});
test('CCB精确int64两端与非法范围不损失数字，已知外币保留待核',async()=>{
  const out=await parse(zip(files([values({14:'92233720368547758.08'}),values({13:'贷',14:'92233720368547758.07'}),values({13:'贷',14:'92233720368547758.08'}),values({3:'usd'})])));
  assert.equal(out.rows[0].amount,'-9223372036854775808');assert.equal(out.rows[1].amount,'9223372036854775807');assert.ok(codes(out.rows[2]).includes('amount_out_of_range'));
  assert.equal(out.rows[3].currency,'USD');assert.ok(codes(out.rows[3]).includes('currency_unsupported'));
});
test('CCB缺卡号不拿卡号补账号，重复交易号与同秒同额保留两行',async()=>{
  const out=await parse(zip(files([values({11:''}),values({11:''})])));assert.equal(out.rows.length,2);assert.equal(out.rows[0].status,'confirmed');assert.equal(out.rows[0].bank_card,'');
});
test('CCB未批准政策或规则保留待核，错误规则绑定直接拒绝',async()=>{
  const out=await parse(zip(files()),{policy:policy({review:{status:'draft'}}),rule:rule({review:{status:'draft'}})});
  assert.equal(out.rows[0].status,'pending');assert.ok(codes(out.rows[0]).includes('rule_unapproved'));assert.ok(codes(out.rows[0]).includes('time_policy_unapproved'));
  await assert.rejects(parse(zip(files()),{rule:rule({amount_expr:'B',negative_policy:'reverse'})}),{code:'FS_FORMAT_RULE'});
});
test('CCB严格日历不补时间，不转换时区或备注，余额非法保留并待核',async()=>{
  const out=await parse(zip(files([values({8:'2026-02-29'}),values({9:'24:00:00'}),values({9:'08:00:00Z'}),values({9:''}),values({15:'N/A'})])));
  assert.ok(out.rows.slice(0,4).every(row=>row.txn_time===null&&row.status==='pending'));assert.ok(codes(out.rows[4]).includes('balance_unparseable'));assert.equal(out.rows[4].raw_balance_text,'N/A');
});
test('CCB时间及来源坐标拒绝尾部换行，不把正则行尾误当字段结尾',async t=>{
  const out=await parse(zip(files([values({9:'12:34:56\n'}),values({9:'12:34:56\r'}),values({8:'2026-02-28\n'})])));
  assert.ok(out.rows.every(row=>row.txn_time===null&&codes(row).includes('time_invalid')));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fundsift-ccb-boundary-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'synthetic.xlsx');fs.writeFileSync(file,zip(files()));
  await assert.rejects(readCcbAccountSource(file,'交易明细!2\n'),{code:'FS_SOURCE_COORDINATE'});
  const input=files();input['xl/sharedStrings.xml']=`<sst xmlns="${NS}"><si><t>original</t></si></sst>`;
  input['xl/worksheets/sheet1.xml']=input['xl/worksheets/sheet1.xml'].replace('r="AA2" t="inlineStr"><is><t xml:space="preserve">原始备注</t></is>','r="AA2" t="s"><v>0\n</v>');
  await assert.rejects(parse(zip(input)),{code:'FS_FORMAT_STRUCTURE'});
});
test('CCB所有工作表中的公式或合并均整文件拒绝，不用缓存值',async()=>{
  for(const [file,content]of [['xl/worksheets/sheet1.xml','<f>1+1</f><v>2</v>'],['xl/worksheets/sheet2.xml','<f>1+1</f><v>2</v>']]){
    const input=files();input[file]=input[file].replace('<is>',content+'<is>');await assert.rejects(parse(zip(input)),{code:'FS_FORMAT_UNSUPPORTED'});
  }
  const input=files();input['xl/worksheets/sheet2.xml']=input['xl/worksheets/sheet2.xml'].replace('</worksheet>','<mergeCells><mergeCell ref="A1:B1"/></mergeCells></worksheet>');await assert.rejects(parse(zip(input)),{code:'FS_FORMAT_UNSUPPORTED'});
});
test('CCB非模板、多工作表、错表头、超列、数字单元格不会静默发布',async()=>{
  for(const mutation of [
    f=>{f['xl/workbook.xml']=f['xl/workbook.xml'].replace('交易明细','其它');},
    f=>{f['xl/worksheets/sheet1.xml']=f['xl/worksheets/sheet1.xml'].replace('客户名称','客户名称 ');},
    f=>{f['xl/worksheets/sheet1.xml']=f['xl/worksheets/sheet1.xml'].replace('r="AF2"','r="AG2"');},
    f=>{f['xl/worksheets/sheet1.xml']=f['xl/worksheets/sheet1.xml'].replace('r="O2" t="inlineStr"><is><t xml:space="preserve">1.005</t></is>','r="O2"><v>1.005</v>');}
  ]){const input=files();mutation(input);await assert.rejects(parse(zip(input)),error=>['FS_FORMAT_UNSUPPORTED','FS_FORMAT_STRUCTURE'].includes(error.code));}
});
test('CCB外链、宏、DTD、破损XML与ZIP、越界关系明确拒绝',async()=>{
  for(const mutation of [
    f=>{f['xl/_rels/workbook.xml.rels']=f['xl/_rels/workbook.xml.rels'].replace('Target="worksheets/sheet1.xml"','Target="https://example.invalid/a" TargetMode="External"');},
    f=>{f['xl/vbaProject.bin']='macro';},
    f=>{f['xl/workbook.xml']='<!DOCTYPE workbook [<!ENTITY x "x">]>'+f['xl/workbook.xml'];},
    f=>{f['xl/worksheets/sheet1.xml']=f['xl/worksheets/sheet1.xml'].replace('</sheetData>','');},
    f=>{f['xl/_rels/workbook.xml.rels']=f['xl/_rels/workbook.xml.rels'].replace('worksheets/sheet1.xml','../sheet1.xml');}
  ]){const input=files();mutation(input);await assert.rejects(parse(zip(input)),error=>['FS_FORMAT_UNSUPPORTED','FS_FORMAT_STRUCTURE'].includes(error.code));}
  await assert.rejects(parse(Buffer.from('not zip')),{code:'FS_FORMAT_STRUCTURE'});
});
test('CCB共享字符串支持精确文本，重复索引坐标和越界字符串索引拒绝',async()=>{
  const input=files();input['xl/sharedStrings.xml']=`<sst xmlns="${NS}"><si><t>shared-original</t></si></sst>`;
  input['xl/worksheets/sheet1.xml']=input['xl/worksheets/sheet1.xml'].replace('r="AA2" t="inlineStr"><is><t xml:space="preserve">原始备注</t></is>','r="AA2" t="s"><v>0</v>');
  assert.equal((await parse(zip(input))).rows[0].remark,'shared-original');input['xl/worksheets/sheet1.xml']=input['xl/worksheets/sheet1.xml'].replace('t="s"><v>0</v>','t="s"><v>99</v>');await assert.rejects(parse(zip(input)),{code:'FS_FORMAT_STRUCTURE'});
});
test('CCB未知数据节点、重复单元格/行号和未声明工作表不被静默忽略',async()=>{
  for(const mutation of [
    f=>{f['xl/worksheets/sheet1.xml']=f['xl/worksheets/sheet1.xml'].replace('</sheetData>','<unknown/></sheetData>');},
    f=>{f['xl/worksheets/sheet1.xml']=f['xl/worksheets/sheet1.xml'].replace('r="B2"','r="A2"');},
    f=>{f['xl/worksheets/sheet1.xml']=f['xl/worksheets/sheet1.xml'].replace('<row r="2">','<row r="1">');},
    f=>{f['xl/worksheets/sheet3.xml']=sheet(HEADERS,[values()]);},
    f=>{f['xl/worksheets/sheet1.xml']=f['xl/worksheets/sheet1.xml'].replace('</worksheet>','<extLst/></worksheet>');}
  ]){const input=files();mutation(input);await assert.rejects(parse(zip(input)),error=>['FS_FORMAT_UNSUPPORTED','FS_FORMAT_STRUCTURE'].includes(error.code));}
});
test('CCB ZIP部件CRC必须吻合，不发布损坏但仍可解析的金额字节',async()=>{
  const changed=zip(files()),index=changed.indexOf(Buffer.from('1.005'));assert.ok(index>0);changed[index]=50;
  await assert.rejects(parse(changed),{code:'FS_FORMAT_STRUCTURE'});
  const checksum=zip(files()),at=checksum.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));assert.ok(at>=0);checksum.writeUInt32LE(0,at+16);
  await assert.rejects(parse(checksum),{code:'FS_FORMAT_STRUCTURE'});
});
test('CCB文本和单元格子结构闭合，未知附加值、嵌套元素或外来公式不被拼接忽略',async()=>{
  for(const mutation of [
    f=>{f['xl/worksheets/sheet1.xml']=f['xl/worksheets/sheet1.xml'].replace('>1.005</t>','><extra>1.005</extra></t>');},
    f=>{f['xl/worksheets/sheet1.xml']=f['xl/worksheets/sheet1.xml'].replace('>1.005</t></is>','>1.005</t></is><extra>999</extra>');},
    f=>{f['xl/worksheets/sheet1.xml']=f['xl/worksheets/sheet1.xml'].replace('>1.005</t></is>','>1.005</t></is><f xmlns="urn:foreign">9+9</f>');},
    f=>{f['xl/worksheets/sheet1.xml']=f['xl/worksheets/sheet1.xml'].replace('r="O2" t="inlineStr"><is><t xml:space="preserve">1.005</t></is>','r="O2"><extra>999</extra>');},
    f=>{f['xl/sharedStrings.xml']=`<sst xmlns="${NS}"><si><t><extra>999</extra></t></si></sst>`;},
    f=>{f['xl/sharedStrings.xml']=`<sst xmlns="${NS}"><si><t>999</t><extra>1</extra></si></sst>`;}
  ]){const input=files();mutation(input);await assert.rejects(parse(zip(input)),{code:'FS_FORMAT_STRUCTURE'});}
});
test('CCB归档身份、大小上限、取消与按工作表坐标回源',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fundsift-ccb-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const data=zip(files()),file=path.join(dir,'synthetic.xlsx');fs.writeFileSync(file,data);const sha=createHash('sha256').update(data).digest('hex');
  const opened=await openCcbAccount(file,{rule:rule(),policy:policy(),expectedSha256:sha});assert.equal(opened.metadata.fileName,'synthetic.xlsx');
  const source=await readCcbAccountSource(file,'交易明细!2',{expectedSha256:sha});assert.deepEqual(source.values,values());assert.equal(source.sheet,'交易明细');assert.equal(source.row,2);
  await assert.rejects(readCcbAccountSource(file,'交易明细!1'),{code:'FS_SOURCE_COORDINATE'});await assert.rejects(readCcbAccountSource(file,'2'),{code:'FS_SOURCE_COORDINATE'});
  await assert.rejects(parse(data,{expectedSha256:'0'.repeat(64)}),{code:'FS_FORMAT_IDENTITY'});await assert.rejects(parse(data,{maxBytes:10}),{code:'FS_FORMAT_TOO_LARGE'});
  await assert.rejects(parse(data,{signal:AbortSignal.abort()}),{code:'FS_USER_CANCELLED'});
});
