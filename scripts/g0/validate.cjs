'use strict';
// Independent G0 contract checker. Never imports the product parser or storage.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const Ajv = require('ajv/dist/2020');
const root = path.resolve(__dirname, '../..');
const schemaFile = path.join(root, 'schemas/g0/bundle.schema.json');
const matrixFile = path.join(root, 'schemas/g0/coverage-matrix.json');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const blank = value => value === null || value === undefined || String(value).trim() === '';
const key = (source, loc) => JSON.stringify([source, loc]);
const decimal=value=>typeof value==='string' && /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value.trim());
const subCent=value=>decimal(value)&&/\.\d{2}\d*[1-9]\d*$/.test(value.trim());
const currencyEvidence=value=>typeof value==='string'&&/^[A-Za-z]{3}$/.test(value.trim())?value.trim().toUpperCase():null;
const ambiguousTimeWords = new Set(['CST','IST','EST','PST','BST','AST','GST','MST']);
const timeWordPattern = /\b(?:CST|IST|EST|PST|BST|AST|GST|MST|UTC|GMT|JST|KST|HKT|SGT|AEST|AEDT|CET|CEST|MSK)\b/gi;
const rawTimePattern = /(?<![0-9:])(?:(\d{4}[-/]\d{2}[-/]\d{2})(T|\s+))?\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?![0-9:])/gi;
const numericTimeOffset = /[+-]\d{2}(?::?\d{2})?(?![A-Za-z0-9_:.])/g;
function timeEvidence(value) {
  if (typeof value !== 'string') return {kind:null,abbreviation:false};
  const text = value.trim();
  const words=[...text.matchAll(timeWordPattern)],times=[...text.matchAll(rawTimePattern)];
  const result=kind=>({kind,abbreviation:words.length>0});
  // Compare entire time endpoints before looking for offsets. A compact
  // ISO T timestamp ending in -HH:mm retains its existing offset meaning.
  for(let i=0;i<times.length-1;i++) {
    const first=times[i],next=times[i+1],end=first.index+first[0].length;
    const between=text.slice(end,next.index);
    if(!/^\s*(?:-|–|—|~|～|至|到)\s*$/.test(between))continue;
    const isoOffset=first[2]?.toUpperCase()==='T'&&between==='-'&&!next[1]&&/^\d{2}:\d{2}$/.test(next[0])&&!/[A-Za-z0-9_:.]/.test(text[next.index+next[0].length]||'');
    if(!isoOffset)return result('ambiguous');
  }
  if(words.some(word=>ambiguousTimeWords.has(word[0].toUpperCase())))return result('ambiguous');
  let marked=words.length>0;
  for(const time of times) {
    const end=time.index+time[0].length,tail=text.slice(end);
    // Z is only evidence next to a time, never inside Zebra or a note.
    if(/^\s*Z(?![A-Za-z0-9_:.])/i.test(tail))marked=true;
    for(const offset of tail.matchAll(numericTimeOffset)) {
      const adjacent=tail.slice(0,offset.index).trim()==='';
      // Non-adjacent date/identifier digits are not offset evidence.
      if(!adjacent&&/[0-9:]/.test(tail[offset.index-1]||''))continue;
      if(!adjacent||time[2]?.toUpperCase()!=='T'&&/^-\d{2}:\d{2}$/.test(offset[0]))return result('ambiguous');
      marked=true;
    }
  }
  for(const word of words) {
    const previous=times.filter(time=>time.index+time[0].length<=word.index).at(-1);
    if(previous&&text.slice(previous.index+previous[0].length,word.index).trim()!=='')return result('ambiguous');
  }
  return result(marked?'timezone':null);
}
const unparseableAmount=(raw,rule)=>(rule?.amount_expr==='D'?[raw.raw_income_text,raw.raw_expense_text]:[raw.raw_amount_text]).some(value=>!blank(value)&&!decimal(value));
function localTime(value) {
  const m=typeof value==='string'&&/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if(!m)return null;
  const normalized=`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]||'00'}.${(m[7]||'').padEnd(3,'0')}Z`;
  const date=new Date(normalized);
  return Number.isFinite(date.getTime()) && date.toISOString()===normalized ? date.getTime():null;
}
const int64 = value => {
  if (value === null) return null;
  if (!(typeof value==='number'&&Number.isSafeInteger(value)&&!Object.is(value,-0)) &&
      !(typeof value==='string'&&/^(?:0|-?[1-9][0-9]*)$/.test(value)))
    throw new Error('整数分必须为安全整数或规范十进制整数字符串，不能含空格、加号、前导零或负零');
  const n = BigInt(value);
  if (n < -9223372036854775808n || n > 9223372036854775807n) throw new Error('超出 SQLite INTEGER 的 int64 范围');
  return n;
};
// Reject lossy JSON numbers *before* AJV sees the rounded Number value. Amount
// int64 values may instead use canonical decimal strings, checked via BigInt.
function parseJSON(text) {
  const parsed = JSON.parse(text, (name, value, context) => {
    if (typeof value === 'number' && (!/^-?(?:0|[1-9]\d*)$/.test(context.source) || !Number.isSafeInteger(value) || Object.is(value, -0))) {
      throw new Error('JSON 数字必须是精确安全整数；int64 金额请用十进制整数字符串');
    }
    return value;
  });
  // JSON.parse silently keeps the last duplicate key. A reviewable answer must
  // have one unambiguous value for every field, including escaped key spellings.
  const stack=[];
  for(const token of text.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)||[]) {
    if(token==='{')stack.push({keys:new Set(),key:true});
    else if(token==='[')stack.push(null);
    else if(token==='}'||token===']')stack.pop();
    else if(token===':'&&stack.at(-1))stack.at(-1).key=false;
    else if(token===','&&stack.at(-1))stack.at(-1).key=true;
    else if(token.startsWith('"')&&stack.at(-1)?.key) {
      const name=JSON.parse(token),object=stack.at(-1);
      if(object.keys.has(name))throw new Error('JSON 对象不能有重复字段：'+name);
      object.keys.add(name);
    }
  }
  return parsed;
}
function decode(bytes) { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
function contained(base, relative) {
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\\') || relative.includes(':')) throw new Error('必须使用根目录内的相对路径和 / 分隔符');
  const resolvedBase = fs.realpathSync(base), target = fs.realpathSync(path.resolve(base, relative));
  const delta = path.relative(resolvedBase, target);
  if (!delta || delta === '..' || delta.startsWith('..' + path.sep) || path.isAbsolute(delta)) throw new Error('路径越出指定根目录或未指向文件');
  if (!fs.statSync(target).isFile()) throw new Error('路径必须指向文件');
  return target;
}

async function validateDataset(bundlePath, options = {}) {
  const report = { ok:false, ready_for_m1:false, errors:[], warnings:[], counts:{sources:0,answers:0,layer_a:0,layer_b:0,coverage:0}, hashes:{},
    assurance:'只核对契约与基础见证；不证明原始行抽取、规则判断、人工身份或生成器独立性。' };
  const error = (code, message, at = '') => report.errors.push({code,message,at});
  const warn = (code, message, at = '') => report.warnings.push({code,message,at});
  let bundle, answers, matrix, schema, base;
  const check = (condition, code, message, at) => { if (!condition) error(code,message,at); };
  try {
    base = path.dirname(path.resolve(bundlePath));
    const bytes = fs.readFileSync(bundlePath), schemaBytes = fs.readFileSync(schemaFile), matrixBytes = fs.readFileSync(matrixFile);
    report.hashes = {bundle:digest(bytes),schema:digest(schemaBytes),matrix:digest(matrixBytes)};
    bundle = parseJSON(decode(bytes)); schema = parseJSON(decode(schemaBytes)); matrix = parseJSON(decode(matrixBytes));
    const ajv = new Ajv({allErrors:true,strict:true});
    const validateBundle = ajv.compile(schema);
    if (!validateBundle(bundle)) {
      for (const item of validateBundle.errors) error('SCHEMA', item.message, item.instancePath);
      return report;
    }
    const answerPath = contained(base, bundle.answers_file), answerBytes = fs.readFileSync(answerPath);
    check(path.resolve(bundlePath) !== answerPath, 'PATH', '答案文件不能是清单自身', 'answers_file');
    report.hashes.answers = digest(answerBytes);
    const validateAnswer = ajv.getSchema(schema.$id + '#/$defs/answer');
    answers = [];
    for (const [index, line] of decode(answerBytes).split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        const row = parseJSON(line);
        if (!validateAnswer(row)) for (const item of validateAnswer.errors) error('SCHEMA', item.message, `answers:${index+1}${item.instancePath}`);
        else answers.push(row);
      } catch (e) { error('JSON', e.message, `answers:${index+1}`); }
    }
  } catch (e) { error('INPUT', e.message); return report; }

  const gate = options.release === true || bundle.state === 'frozen';
  function pinned(field, actual) {
    const expected = bundle[field];
    if (gate) check(Boolean(expected), 'PIN', '冻结基准必须记录内容哈希', field);
    if (expected) check(expected === actual, 'HASH', '内容与声明哈希不一致', field);
  }
  pinned('answers_sha256', report.hashes.answers); pinned('schema_sha256', report.hashes.schema); pinned('matrix_sha256', report.hashes.matrix);
  if (options.expectedBundleSha256) check(options.expectedBundleSha256.toLowerCase() === report.hashes.bundle, 'HASH', '清单与外部固定哈希不一致', 'bundle');
  if (gate) {
    check(bundle.state === 'frozen', 'RELEASE', '正式检查要求 state=frozen', 'state');
    check(/^[a-fA-F0-9]{64}$/.test(options.expectedBundleSha256 || ''), 'PIN', '正式检查必须提供独立保存的 --expected-bundle-sha256', 'bundle');
    check(bundle.sources.length > 0 && answers.length > 0 && bundle.rules.length > 0, 'RELEASE', '不能冻结空数据集');
  }
  function approved(review, at, required = gate) {
    if (review.status === 'approved') check(!blank(review.by) && !blank(review.reason) && !blank(review.at) && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(review.at) && Number.isFinite(Date.parse(review.at)), 'REVIEW', '批准必须有人员、有效时间及依据', at);
    else if (required) error('REVIEW','正式基准需要人工批准',at);
  }
  const sources = new Map(), rules = new Map(), questions = new Map(), rows = new Map(), fileIdentities=new Set(), indexes=new Map();
  const cases = new Map(matrix.cases.map(c => [c.id, c]));
  const coverage = new Map(matrix.cases.map(c => [c.id, 0]));
  const sourceCounts = new Map(), samples = new Map();
  for (const rule of bundle.rules) {
    const id = key(rule.id, rule.rule_version);
    check(!rules.has(id),'DUPLICATE','规则编号和版本重复',id); rules.set(id,rule);
    check(rule.unit_scale === (rule.source_unit === '元' ? 100 : 1),'RULE','来源单位与入库倍率不匹配',id);
    const policies = {A:'signed',B:'reverse',C:'magnitude',D:'column_defined',E:'pending',F:'pending'};
    check(rule.negative_policy === policies[rule.amount_expr] || rule.amount_expr === 'D' && rule.negative_policy === 'pending', 'RULE','金额类别与负号策略不匹配',id);
    check(!rule.balance_same_direction || rule.balance_scope === 'asset_ledger','RULE','资产同向公式不能用于其他余额口径',id);
    if (rule.amount_expr === 'A' || rule.amount_expr === 'D') check(Object.keys(rule.direction_map).length === 0,'RULE','A/D 类不执行方向词表',id);
    for (const alias of Object.keys(rule.currency_map)) check(!blank(alias) && alias === alias.trim() && currencyEvidence(alias) === null,'RULE','币种映射键必须是无首尾空白的非 ISO 原文，不得覆盖三字母币种',id);
    approved(rule.review, 'rule:' + id);
  }
  const sourceRoot = options.sourceRoot ? path.resolve(options.sourceRoot) : base;
  for (const source of bundle.sources) {
    const at = 'source:' + source.id, obs = source.observations;
    check(!sources.has(source.id),'DUPLICATE','材料编号重复',at); sources.set(source.id,source); sourceCounts.set(source.id,0); samples.set(source.id,0);
    const identity=key(source.case_ref,source.sha256);
    check(!fileIdentities.has(identity),'DUPLICATE','同一案件同一原件哈希只能登记一次',at);fileIdentities.add(identity);
    check(obs.logical_records === obs.header_records + obs.footer_records + obs.other_non_data_records + obs.data_records,'COUNT','逻辑记录总数须等于数据及非数据记录之和',at);
    if (source.disposition === 'rows') {
      check(source.format!=='unknown','FORMAT','未知格式不能宣称逐行解析',at);
      const rule=rules.get(key(source.rule_id,source.rule_version));
      check(Boolean(rule),'REFERENCE','材料绑定的规则版本不存在',at);
      if(rule)check(source.platform===rule.platform,'REFERENCE','材料来源与绑定规则平台不一致',at);
    }
    else {
      check(source.format==='unknown','FORMAT','未识别文件须明确标记 unknown 格式',at);
      check(source.rule_id === null && source.rule_version === null,'REFERENCE','未识别文件不能绑定已识别规则',at);
      coverage.set('unknown_format_file',coverage.get('unknown_format_file')+1);
    }
    approved(source.review,at);
    if(source.record_index) {
      try {
        const indexPath=contained(base,source.record_index.path), bytes=fs.readFileSync(indexPath), actual=digest(bytes);
        check(actual===source.record_index.sha256,'HASH','独立坐标索引 SHA256 不一致',at);
        if(gate)check(source.record_index.extractor.independent_of_parser,'INDEPENDENCE','坐标索引生成方法必须独立于被测解析器',at);
        const extractorPath=contained(base,source.record_index.extractor.implementation_path), extractorHash=digest(fs.readFileSync(extractorPath));
        check(source.record_index.extractor.sha256===extractorHash,'HASH','坐标索引生成方法内容哈希不一致',at);
        const listed=new Map();
        for(const [lineNo,line] of decode(bytes).split(/\r?\n/).entries()) {
          if(!line.trim())continue;
          const entry=parseJSON(line);
          check(entry&&Object.keys(entry).sort().join(',')==='kind,source_loc'&&['data','header','footer','other'].includes(entry.kind)&&typeof entry.source_loc==='string','INDEX','索引行必须仅含合法 source_loc 与 kind',`${at}:index:${lineNo+1}`);
          if(!entry||typeof entry.source_loc!=='string')continue;
          check(!listed.has(entry.source_loc),'INDEX','原始记录索引内坐标重复',`${at}:${entry.source_loc}`);listed.set(entry.source_loc,entry.kind);
          check(source.format==='xlsx'?/^.+![1-9]\d*$/.test(entry.source_loc):/^[1-9]\d*$/.test(entry.source_loc),'INDEX','原始记录索引坐标格式与文件格式不符',`${at}:${entry.source_loc}`);
        }
        const kinds=[...listed.values()];
        check(kinds.filter(v=>v==='data').length===obs.data_records&&kinds.filter(v=>v==='header').length===obs.header_records&&kinds.filter(v=>v==='footer').length===obs.footer_records&&kinds.filter(v=>v==='other').length===obs.other_non_data_records&&kinds.length===obs.logical_records,'INDEX','坐标索引分类数量与样本清单不一致',at);
        indexes.set(source.id,listed);
      } catch(e) {error('INDEX',e.message,at);}
    } else if(gate) error('INDEX','正式样本必须附有独立原始记录坐标索引',at);
    try {
      const file = contained(sourceRoot, source.path), hash = crypto.createHash('sha256'); let bytes = 0;
      // Sequential streams avoid retaining original files in memory or output.
      for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
      check(hash.digest('hex') === source.sha256 && bytes === source.size,'HASH','材料内容哈希或大小与清单不一致',at);
      check(path.basename(source.path) === source.file_name,'PATH','文件名称与相对路径不一致',at);
    } catch (e) { error('SOURCE',e.message,at); }
  }
  for (const question of bundle.questions) {
    check(!questions.has(question.id),'DUPLICATE','问题编号重复',question.id); questions.set(question.id,question);
    if (question.status === 'resolved') check(!blank(question.decision) && !blank(question.decided_by) && !blank(question.decided_at) && Number.isFinite(Date.parse(question.decided_at)),'QUESTION','已解决问题必须有裁决、人员和时间',question.id);
    else if (gate) error('QUESTION','正式基准仍有未决问题',question.id);
    for (const ref of question.affected) check(sources.has(ref.source_id),'REFERENCE','问题引用不存在的材料',question.id);
  }
  for (const row of answers) {
    const at = key(row.source_id,row.source_loc), source = sources.get(row.source_id), rule = rules.get(key(row.format_rule_id,row.rule_version)), e = row.expected, b = e.balance_check;
    check(!rows.has(at),'DUPLICATE','同一文件来源坐标重复',at); rows.set(at,row);
    check(Boolean(source) && source?.disposition === 'rows','REFERENCE','答案必须引用已识别的登记材料',at);
    if (source) {
      check(row.source_sha256 === source.sha256,'HASH','答案与材料哈希不一致',at);
      check(row.format_rule_id === source.rule_id && row.rule_version === source.rule_version,'REFERENCE','答案规则版本与材料不一致',at);
      check(source.format === 'xlsx' ? /^.+![1-9]\d*$/.test(row.source_loc) : /^[1-9]\d*$/.test(row.source_loc), 'COORDINATE','来源坐标须为 sheet!行号 或正整数逻辑记录号',at);
      if(source.format!=='xlsx'&&/^[1-9]\d*$/.test(row.source_loc))check(BigInt(row.source_loc)<=BigInt(source.observations.logical_records),'COORDINATE','逻辑坐标越出清单登记的记录范围',at);
      sourceCounts.set(source.id,sourceCounts.get(source.id)+1);
      const index=indexes.get(source.id);
      if(index)check(index.get(row.source_loc)==='data','COORDINATE','答案坐标必须与独立索引中的数据行一一对应',at);
      if(row.layer === 'A' && row.review.status === 'approved') samples.set(source.id,samples.get(source.id)+1);
    }
    check(Boolean(rule),'REFERENCE','答案规则版本不存在',at);
    approved(row.review,at,gate && row.layer === 'B');
    let amount, balance;
    try { amount=int64(e.amount);balance=int64(e.balance);int64(b.expect_balance);int64(b.diff); }
    catch (err) { error('INTEGER',err.message,at); continue; }
    if (amount !== null && amount !== 0n) check(e.direction === (amount > 0n ? '进':'出'),'DIRECTION','标准金额正负与方向不一致',at);
    check(e.status === 'pending' ? e.pending_reason.length > 0 : e.pending_reason.length === 0,'PENDING','pending 必须有原因；confirmed 不得有未解除原因',at);
    check(new Set(e.pending_reason.map(r=>r.reason_code)).size === e.pending_reason.length,'PENDING','待核原因代码重复',at);
    if(['B','C','E'].includes(rule?.amount_expr)) {
      const mapped=Object.hasOwn(rule.direction_map,row.raw.raw_direction);
      if(!mapped)check(e.status==='pending'&&e.pending_reason.some(r=>/direction|sign|format/.test(r.reason_code)),'DIRECTION','方向缺失或词表外必须进入 B 层待核',at);
    }
    if(rule?.negative_policy==='pending'&&[row.raw.raw_amount_text,row.raw.raw_income_text,row.raw.raw_expense_text].some(value=>typeof value==='string'&&value.trim().startsWith('-')))
      check(e.status==='pending'&&e.pending_reason.some(r=>/amount|sign|column|direction|format|negative/.test(r.reason_code)),'RULE','规则声明负号语义待核，人工记录不能悄悄越过规则卡确认',at);
    if (e.status === 'confirmed') check(amount !== null && !blank(e.direction) && !blank(e.txn_time) && !blank(e.acct_no) && !blank(e.currency),'CONFIRMED','confirmed 关键字段必须齐全',at);
    if(e.txn_time!==null)check(localTime(e.txn_time)!==null,'TIME','标准交易时间必须是有效本地时间，不含时区标记',at);
    const timeInfo=timeEvidence(row.raw.txn_time_text),timeKind=timeInfo.kind;
    const timeReason=e.pending_reason.some(r=>/time/.test(r.reason_code)&&r.reason_code!=='time_ambiguous');
    const ambiguousReason=e.pending_reason.some(r=>r.reason_code==='time_ambiguous');
    if(timeKind==='timezone')check(e.txn_time===null&&e.status==='pending'&&timeReason,'TIME','带时区标记的原始时间必须保留原文并以时间／时区原因待核，不得仅用 time_ambiguous 或静默转成本地时间',at);
    if(timeKind==='ambiguous')check(e.txn_time===null&&e.status==='pending'&&ambiguousReason,'TIME','时间区间或标记含义不明确，须保留原文、保持时间未知并记录 time_ambiguous；不得擅自取起点或终点',at);
    if(unparseableAmount(row.raw,rule))check(amount===null&&e.status==='pending'&&e.pending_reason.some(r=>/amount|format/.test(r.reason_code)),'PENDING','非空但无法解析的原始金额必须保持未知并给出待核原因',at);
    if(blank(e.txn_time))check(e.status==='pending' && e.pending_reason.some(r=>/time/.test(r.reason_code)),'PENDING','未知交易时间需要独立待核原因',at);
    if(blank(e.acct_no))check(e.status==='pending' && e.pending_reason.some(r=>/account|acct/.test(r.reason_code)),'PENDING','未知账户需要独立待核原因',at);
    if (amount === null) check(e.status === 'pending' && e.pending_reason.some(r=>/amount|direction|format|sign|column/.test(r.reason_code)),'PENDING','未知金额需要对应的独立待核原因',at);
    if (amount === 0n && e.status === 'confirmed') check(rule?.zero_policy === 'confirmed' && e.direction === rule.zero_direction,'ZERO','零金额确认须有规则声明方向与策略',at);
    if (blank(e.currency)) check(e.status === 'pending','CURRENCY','未知币种必须待核',at);
    const originalCurrency=currencyEvidence(row.raw.currency_text);
    const alias=!blank(row.raw.currency_text)&&!originalCurrency?row.raw.currency_text.trim():null;
    const mappedCurrency=alias!==null&&rule?.review.status==='approved'&&Object.hasOwn(rule.currency_map,alias)?rule.currency_map[alias]:null;
    const evidencedCurrency=originalCurrency||mappedCurrency;
    if(evidencedCurrency)check(e.currency===evidencedCurrency,'CURRENCY','标准币种必须保留原始 ISO 或该格式已批准映射的币种，不得替换或默认成 CNY',at);
    else if(e.currency!==null)check(blank(row.raw.currency_text)&&e.currency==='CNY'&&rule?.currency_policy==='verified_cny'&&rule.review.status==='approved','CURRENCY','标准币种须有原始 ISO 或该格式已批准映射的证据；缺原文只允许已批准规则明确声明 CNY',at);
    if (rule) check(e.balance_scope === rule.balance_scope,'BALANCE','余额口径须与绑定规则相同',at);
    if (['pass','fail'].includes(b.status)) {
      check(b.comparable && e.balance_scope === 'asset_ledger' && rule?.balance_same_direction && b.segment_complete && b.order === 'stable' && amount !== null && e.direction !== null && balance !== null && b.previous !== null,'BALANCE','余额 pass/fail 必须满足完整资产链的可比前提',at);
      check(b.expect_balance !== null && b.diff !== null,'BALANCE','余额检查必须保留期望余额与差额',at);
      if (b.diff !== null) check((b.status === 'pass') === (int64(b.diff) === 0n),'BALANCE','pass 差额必须为零，fail 差额必须非零',at);
    } else {
      check(!b.comparable && !blank(b.reason) && b.expect_balance === null && b.diff === null,'BALANCE','不可比余额须给原因，不得伪造计算值',at);
    }
    const reasons = new Set(e.pending_reason.map(r=>r.reason_code));
    check(!reasons.has('balance_fail'),'PENDING','余额 fail 不能自动成为记录阻断原因',at);
    const rawNegative=String(row.raw.raw_amount_text||'').trim().startsWith('-');
    const needsHuman = e.status === 'pending' || e.reversal_flag === 1 || amount === 0n || b.status==='fail' || b.order==='unknown' || !b.segment_complete || rule?.amount_expr==='D' || rawNegative&&['B','C','E'].includes(rule?.amount_expr) || rule?.source_unit==='元'&&subCent(row.raw.raw_amount_text) || /冲正|退款|抹[帐账]/.test(row.raw.summary||'') || row.coverage.some(id=>!/^amount_[abcde]$/.test(id) && id !== 'source_fen');
    if (needsHuman) check(row.layer === 'B','LAYER','异常与边界必须进入 B 层人工裁决',at);
    for (const id of row.question_ids) {
      check(questions.has(id),'REFERENCE','答案引用不存在的问题',at);
      const q=questions.get(id);
      if(q) check(q.affected.some(ref=>ref.source_id===row.source_id&&(ref.source_loc===null||ref.source_loc===row.source_loc)),'REFERENCE','问题影响范围未包含引用行',at);
    }
    for (const id of row.coverage) {
      const entry=cases.get(id);
      check(entry?.kind === 'row','COVERAGE','未知或非行级覆盖编号',at);
      if(entry?.kind === 'row') coverage.set(id,coverage.get(id)+1);
      // These are witness checks, not an alternative amount engine.
      const nonempty = value => !blank(value);
      // Lexical decimal witnesses never compute the oracle amount. Formatting
      // beyond this neutral grammar needs explicit human evidence.
      const nonzero=value=>decimal(value)&&/[1-9]/.test(value.replace(/[+\-.,]/g,''));
      const zero=value=>decimal(value)&&!nonzero(value);
      const negative=value=>decimal(value)&&value.trim().startsWith('-')&&nonzero(value);
      const dNeg=negative(row.raw.raw_income_text)||negative(row.raw.raw_expense_text);
      const dBoth=nonzero(row.raw.raw_income_text)&&nonzero(row.raw.raw_expense_text);
      const dEmpty=(blank(row.raw.raw_income_text)||zero(row.raw.raw_income_text))&&(blank(row.raw.raw_expense_text)||zero(row.raw.raw_expense_text));
      const knownDirection=rule&&Object.hasOwn(rule.direction_map,row.raw.raw_direction);
      const isRawZero=zero(row.raw.raw_amount_text)||rule?.amount_expr==='D'&&dEmpty&&(zero(row.raw.raw_income_text)||zero(row.raw.raw_expense_text));
      const witness = {
        amount_a:rule?.amount_expr==='A'&&nonzero(row.raw.raw_amount_text)&&blank(row.raw.raw_direction),amount_b:rule?.amount_expr==='B'&&decimal(row.raw.raw_amount_text)&&knownDirection,amount_c:rule?.amount_expr==='C'&&decimal(row.raw.raw_amount_text)&&knownDirection,amount_d:rule?.amount_expr==='D'&&!dBoth&&!dEmpty&&!dNeg&&e.status==='confirmed',amount_e:rule?.amount_expr==='E'&&nonzero(row.raw.raw_amount_text)&&!negative(row.raw.raw_amount_text)&&knownDirection,amount_f:e.status==='pending'&&(rule?.amount_expr==='F'||amount===null||e.direction===null),
        d_both_nonzero:rule?.amount_expr==='D'&&dBoth&&e.status==='pending',
        d_empty_or_zero:rule?.amount_expr==='D'&&dEmpty&&e.status==='pending',d_negative_defined:rule?.amount_expr==='D'&&rule.negative_policy==='column_defined'&&dNeg,d_negative_undefined:rule?.amount_expr==='D'&&rule.negative_policy==='pending'&&dNeg&&e.status==='pending',
        sign_conflict_defined:rule?.amount_expr==='B'&&knownDirection&&negative(row.raw.raw_amount_text),sign_conflict_undefined:knownDirection&&negative(row.raw.raw_amount_text)&&rule?.negative_policy==='pending'&&e.status==='pending',
        zero_defined:amount===0n&&isRawZero&&rule?.zero_policy==='confirmed',zero_undefined:amount===0n&&isRawZero&&e.status==='pending'&&rule?.zero_policy==='pending',missing_amount:amount===null&&blank(row.raw.raw_amount_text)&&blank(row.raw.raw_income_text)&&blank(row.raw.raw_expense_text)&&e.status==='pending',missing_time:e.txn_time===null&&blank(row.raw.txn_time_text)&&e.status==='pending',missing_account:e.acct_no===null&&blank(row.raw.acct_no)&&e.status==='pending',unknown_direction:!knownDirection&&nonempty(row.raw.raw_direction)&&e.direction===null&&e.status==='pending',
        time_timezone_marker:timeKind==='timezone'&&e.txn_time===null&&e.status==='pending'&&timeReason,
        time_ambiguous:timeKind==='ambiguous'&&e.txn_time===null&&e.status==='pending'&&ambiguousReason,
        time_zone_abbreviation:timeInfo.abbreviation&&e.txn_time===null&&e.status==='pending'&&(timeKind==='ambiguous'?ambiguousReason:timeKind==='timezone'&&timeReason),
        amount_unparseable:unparseableAmount(row.raw,rule)&&amount===null&&e.status==='pending'&&e.pending_reason.some(r=>/amount|format/.test(r.reason_code)),
        reversal_b:rule?.amount_expr==='B'&&negative(row.raw.raw_amount_text)&&knownDirection&&e.reversal_flag===1,reversal_memo_only:/冲正|退款|抹[帐账]/.test(row.raw.summary||'')&&e.reversal_flag===0,rounding_yuan:rule?.source_unit==='元'&&subCent(row.raw.raw_amount_text),source_fen:rule?.source_unit==='分'&&/^[+-]?\d+$/.test(row.raw.raw_amount_text||''),
        balance_scope_asset_ledger:e.balance_scope==='asset_ledger'&&b.comparable,balance_scope_debt:e.balance_scope==='debt',balance_scope_available:e.balance_scope==='available',balance_scope_unknown:e.balance_scope==='unknown',
        balance_fail_confirmed:b.status==='fail'&&e.status==='confirmed',pending_not_pass:e.status==='pending'&&amount===null&&b.status!=='pass',balance_no_previous:b.previous===null&&!b.comparable,same_second_stable:b.order==='stable'&&b.previous!==null&&b.comparable,same_second_unstable:b.order==='unknown'&&!b.comparable,incomplete_segment:!b.segment_complete&&!b.comparable,
        currency_foreign:e.currency!==null&&e.currency!=='CNY'&&evidencedCurrency===e.currency,currency_missing_verified:blank(row.raw.currency_text)&&e.currency==='CNY'&&rule?.currency_policy==='verified_cny',currency_missing_unknown:blank(row.raw.currency_text)&&e.currency===null&&e.status==='pending',
        currency_mapped_cny:originalCurrency===null&&mappedCurrency==='CNY'&&e.currency==='CNY'
      };
      if(Object.hasOwn(witness,id)) check(witness[id],'COVERAGE','该行不满足覆盖项的基础见证条件：'+id,at);
    }
  }
  for (const row of answers) {
    const at=key(row.source_id,row.source_loc), b=row.expected.balance_check;
    if (!b.previous) continue;
    const previous=rows.get(key(b.previous.source_id,b.previous.source_loc));
    check(Boolean(previous) && previous!==row,'REFERENCE','前项不存在或指向自身',at);
    if (!previous) continue;
    const nowTime=localTime(row.expected.txn_time),prevTime=localTime(previous.expected.txn_time);
    if(row.coverage.includes('same_second_stable')||row.coverage.includes('same_second_unstable'))check(nowTime!==null&&prevTime!==null&&Math.floor(nowTime/1000)===Math.floor(prevTime/1000),'COVERAGE','同秒用例的前项与本项时间必须同秒',at);
    check(nowTime!==null&&prevTime!==null&&prevTime<=nowTime,'BALANCE','前项交易时间不能晚于本项',at);
    if (b.comparable) {
      check(previous.expected.balance_scope==='asset_ledger' && nowTime!==null && prevTime!==null && prevTime<=nowTime,'BALANCE','前项须为资产余额且时间不晚于本项',at);
      check(!blank(row.expected.acct_no)&&!blank(previous.expected.acct_no)&&!blank(row.expected.currency)&&!blank(previous.expected.currency),'BALANCE','未知账户或币种不能构成可比余额链',at);
      check(row.expected.status==='confirmed'&&previous.expected.status==='confirmed','BALANCE','pending记录不能参与余额判平',at);
      check(row.expected.acct_no === previous.expected.acct_no && row.expected.currency === previous.expected.currency && sources.get(row.source_id)?.case_ref === sources.get(previous.source_id)?.case_ref,'BALANCE','余额链不得跨账户、币种或案件',at);
      try {
        const prevBalance=int64(previous.expected.balance),amount=int64(row.expected.amount),actual=int64(row.expected.balance);
        check(prevBalance!==null&&amount!==null&&actual!==null,'BALANCE','余额链输入不能未知',at);
        if(prevBalance!==null&&amount!==null&&actual!==null) {
          const expected=prevBalance+amount;
          check(int64(b.expect_balance)===expected && int64(b.diff)===actual-expected,'BALANCE','余额公式或差额不一致（diff=实际-期望）',at);
        }
      } catch(e) {error('BALANCE',e.message,at);}
    }
  }
  // A previous-pointer graph must be acyclic even when equal timestamps exist.
  const completed=new Set();
  for(const row of answers) {
    const chain=new Set();let cursor=row;
    while(cursor) {
      const id=key(cursor.source_id,cursor.source_loc);
      if(completed.has(id))break;
      if(chain.has(id)){error('BALANCE','余额前项引用形成循环',id);break;}
      chain.add(id);const ref=cursor.expected.balance_check.previous;
      cursor=ref?rows.get(key(ref.source_id,ref.source_loc)):null;
    }
    for(const id of chain)completed.add(id);
  }
  for (const source of bundle.sources) {
    const count=sourceCounts.get(source.id);
    check(source.disposition === 'rows' ? count===source.observations.data_records : count===0,'COUNT','逐文件答案数与登记数据行数不一致，未知格式不得伪造行',source.id);
    const index=indexes.get(source.id);
    if(index) {
      const answerLocs=new Set(answers.filter(row=>row.source_id===source.id).map(row=>row.source_loc));
      const dataLocs=new Set([...index].filter(([,kind])=>kind==='data').map(([loc])=>loc));
      check(answerLocs.size===dataLocs.size&&[...dataLocs].every(loc=>answerLocs.has(loc)),'COORDINATE','答案坐标必须完整等于独立索引的数据坐标集合',source.id);
    }
    if(gate && source.disposition==='rows' && answers.some(r=>r.source_id===source.id&&r.layer==='A')) check(samples.get(source.id)>0,'REVIEW','每个包含 A 层的材料至少需要一次人工抽查；这只是最低门槛',source.id);
  }
  for(const q of bundle.questions) for(const ref of q.affected) if(ref.source_loc!==null) check(rows.has(key(ref.source_id,ref.source_loc)),'REFERENCE','问题引用不存在的行',q.id);
  if (gate) {
    for (const entry of matrix.cases) check(coverage.get(entry.id)>=entry.min_count,'COVERAGE','缺少必需覆盖：'+entry.id,entry.id);
    const formats={ccb_xlsx:'xlsx',wechat_txt:'txt',alipay_account_csv:'csv',alipay_balance_csv:'csv'};
    for (const role of ['ccb_xlsx','wechat_txt','alipay_account_csv','alipay_balance_csv','case_b_reversal']) check(bundle.sources.some(s=>s.kind==='real'&&s.sample_role===role&&s.disposition==='rows'&&s.observations.data_records>0&&(!formats[role]||s.format===formats[role])),'SAMPLES','缺少已核实的真实样本角色或格式：'+role,role);
    const primary=bundle.sources.filter(s=>s.kind==='real'&&Object.hasOwn(formats,s.sample_role));
    check(new Set(primary.map(s=>s.case_ref)).size===1,'SAMPLES','三渠道真实样本应属于同一主案件');
    check(bundle.sources.some(s=>s.sample_role==='case_b_reversal'&&s.kind==='real'&&s.case_ref!==primary[0]?.case_ref),'SAMPLES','案件B抹账样本应独立于主案件');
    check(answers.some(row=>sources.get(row.source_id)?.sample_role==='case_b_reversal'&&row.layer==='B'&&row.review.status==='approved'&&row.expected.reversal_flag===1),'SAMPLES','案件B样本需要已裁决的实际冲回见证行');
  } else {
    warn('DRAFT','草稿结构通过不等于 G0 完成；未覆盖、未批准和真实样本仍需补齐');
  }
  if (bundle.generator.implementation_path) {
    try {
      report.hashes.generator=digest(fs.readFileSync(contained(base,bundle.generator.implementation_path)));
      if(bundle.generator.sha256) check(bundle.generator.sha256===report.hashes.generator,'HASH','生成器哈希不一致','generator');
      if(gate) check(Boolean(bundle.generator.sha256),'PIN','正式基准需固定生成器哈希','generator');
    } catch(e) {error('GENERATOR',e.message,'generator');}
  } else if(gate) error('GENERATOR','正式基准需登记独立生成器文件与哈希','generator');
  report.counts={sources:sources.size,answers:answers.length,layer_a:answers.filter(r=>r.layer==='A').length,layer_b:answers.filter(r=>r.layer==='B').length,coverage:[...coverage.values()].filter(n=>n>0).length,required_coverage:matrix.cases.length};
  report.coverage=matrix.cases.map(entry=>({id:entry.id,kind:entry.kind,required:entry.min_count,observed:coverage.get(entry.id)}));
  report.ok=report.errors.length===0;report.ready_for_m1=report.ok&&gate;
  return report;
}

module.exports={validateDataset,int64};
if(require.main===module) {
  (async()=>{
    const args=process.argv.slice(2), options={};let file,json=false;
    for(let i=0;i<args.length;i++) {
      const arg=args[i];
      if(arg==='--release')options.release=true;
      else if(arg==='--json')json=true;
      else if(arg==='--source-root'||arg==='--expected-bundle-sha256') {
        if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('参数缺少值：'+arg);
        options[arg==='--source-root'?'sourceRoot':'expectedBundleSha256']=args[++i];
      } else if(!arg.startsWith('--')&&!file)file=arg;
      else throw new Error('未知参数：'+arg);
    }
    if(!file)throw new Error('用法：node scripts/g0/validate.cjs bundle.json [--release --expected-bundle-sha256 HASH] [--source-root DIR] [--json]');
    const report=await validateDataset(file,options);
    if(json)console.log(JSON.stringify(report,null,2));
    else {
      console.log(`${report.ok?'PASS':'FAIL'}: ${report.counts.answers} 行；G0正式契约${report.ready_for_m1?'通过':'未通过／未请求'}`);
      for(const issue of [...report.errors,...report.warnings])console.log(`${issue.code} ${issue.at}: ${issue.message}`);
      console.log('Bundle SHA256: '+(report.hashes.bundle||'未读取'));
    }
    process.exitCode=report.ok?0:1;
  })().catch(e=>{console.error(e.message);process.exitCode=1;});
}
