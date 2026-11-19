'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {HEADERS,ACCOUNT_HEADERS}=require('../code/desktop/ccb-account.cjs');
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

function createImportFixtures(directory){
  fs.mkdirSync(directory,{recursive:true});
  const alipayHeaders=require('../code/desktop/alipay-account.cjs').HEADERS;
  const wxHeaders=require('../code/desktop/wechat-trades.cjs').HEADERS;
  const alipay=path.join(directory,'synthetic-alipay.csv'),wechat=path.join(directory,'synthetic-wechat.txt'),ccb=path.join(directory,'synthetic-ccb.xlsx');
  const csv=(row)=>row.map(v=>'"'+v.replaceAll('"','""')+'"').join(',');
  const aliRow=['ali-1','order','2026-02-28 12:34:55','2026-02-28 12:34:56','','source','type','00001(合成用户)','合成对手','合成消费','1.005','支出','交易成功','银行卡','','',''];
  fs.writeFileSync(alipay,'\ufeff'+[alipayHeaders,aliRow,[...aliRow.slice(0,10),'1.00','其它','交易中途关闭（未完成）',...aliRow.slice(13)]].map(csv).join('\r\n')+'\r\n');
  const wx=Array(27).fill('');Object.assign(wx,{0:'synthetic-user',1:'wx-order-duplicate',3:'合成用户',4:'出',5:'快捷支付',6:'消费',7:'2026-02-28 12:34:56',8:'101',9:'0',10:'00000000000000000002',14:'synthetic-peer',15:'合成对手',24:'101',26:'原文\u202e保留'});
  const wx2=[...wx];wx2[6]='手续费';wx2[8]='1';wx2[24]='2';
  fs.writeFileSync(wechat,[wxHeaders,wx,wx2].map(row=>row.join('\t')).join('\r\n')+'\r\n');
  fs.writeFileSync(ccb,zip(files([values(),values({0:'2',14:'-1.00',12:'消费退货'})])));
  return [{formatKey:'alipay-account-17col-v1',filePath:alipay},{formatKey:'wechat-trades-27col-v1',filePath:wechat},{formatKey:'ccb-account-32col-v1',filePath:ccb}];
}
module.exports={createImportFixtures};
