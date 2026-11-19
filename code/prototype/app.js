(function () {
  'use strict';
  const desktopBridge = window.fundsiftDesktop || null;
  const copy = window.FUND_COPY;
  if (!copy) throw new Error('使用说明未加载，请重启软件。');
  const desktop = desktopBridge ? {loading:true,busy:false,saving:false,workspacePath:null,needsWorkspace:true,locationKnown:false,error:'',notice:''} : null;
  const data = desktop ? {cases:[],files:[],flows:[],exports:[]} : JSON.parse(JSON.stringify(window.FUND_DATA));
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ico = (name, size = 17) => window.icon(name, size);
  const money = (v, signed = false) => v == null ? '—' : (signed && v > 0 ? '+' : '') + (v / 100).toLocaleString('zh-CN', {minimumFractionDigits:2, maximumFractionDigits:2});
  const count = v => Number(v).toLocaleString('zh-CN');
  const caseNumberKey = v => String(v).replace(/[A-Z]/g,c=>c.toLowerCase());
  function localTimestamp(value){
    if(typeof value!=='string')return '—';
    const parts=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if(!parts)return '—';
    const date=new Date(value),day=new Date(value.slice(0,10)+'T00:00:00Z');
    if(!Number.isFinite(date.getTime())||day.getUTCDate()!==Number(parts[3])||Number(parts[4])>23||Number(parts[5])>59||Number(parts[6])>59)return '—';
    const pad=n=>String(n).padStart(2,'0');
    return `${String(date.getFullYear()).padStart(4,'0')}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  const now = () => new Date().toLocaleString('sv-SE').slice(0, 16);
  const labels = {home:'案件工作台',materials:'材料管理',flows:copy.terms.flows,review:'异常复核',exports:'结果导出'};
  const state = {route:'home',caseId:desktop?null:'case-1',caseQuery:'',caseTab:'all',fileQuery:'',fileTab:'all',filePlatform:'all',flowQuery:'',flowTab:'all',flowPlatform:'all',sourceId:'',page:1,pageSize:15,selected:new Set(),inspected:null,reviewTab:'all',reviewId:null,density:false,dateFrom:'',dateTo:'',minAmount:'',maxAmount:'',exportScope:'all',exportFormat:'xlsx',exportSource:true};
  let lastFocus = null, importQueue = [], modalLayers = null;
  const desktopOperations = new Map();
  const live = {materials:[],page:null,cursor:null,history:[],source:'',filter:'all',loading:false,error:'',receipt:null,
    workpaper:null,exportError:'',exporting:false,cleanup:null,epoch:0};
  const formatNames = new Map([
    ['alipay-account-17col-v1','支付宝账户 CSV'],
    ['wechat-trades-27col-v1','微信交易 TXT'],
    ['ccb-account-32col-v1','建行账户 XLSX']
  ]);
  const exactMoney = value => {
    if(value===null||value===undefined)return '—';
    if(!/^(?:0|-?[1-9]\d*)$/.test(String(value)))return '—';
    const n=BigInt(value),digits=(n<0n?-n:n).toString().padStart(3,'0');
    return (n<0n?'-':n>0n?'+':'')+digits.slice(0,-2).replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+digits.slice(-2);
  };
  const readable = value => String(value??'').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
  function rawUnit(row){try{return JSON.parse(row.raw_record).derivation.money.source_unit||'单位未知';}catch(_){return '单位未知';}}
  let finishedOperationId = 0;
  function showOperationStatus(event){
    if(!desktop||!event||!Number.isSafeInteger(event.operationId)||event.operationId<1||
      !Object.hasOwn(copy.operation.names,event.operation)||!Object.hasOwn(copy.operation.phases,event.phase)||
      typeof event.active!=='boolean'||typeof event.waitingLong!=='boolean'||!Number.isFinite(event.elapsedMs)||event.elapsedMs<0)return;
    if(event.active===['completed','failed'].includes(event.phase))return;
    if(event.operationId<=finishedOperationId&&!desktopOperations.has(event.operationId))return;
    if(!event.active){
      finishedOperationId=Math.max(finishedOperationId,event.operationId);
      desktopOperations.delete(event.operationId);
    }else desktopOperations.set(event.operationId,event);
    const operations=[...desktopOperations.values()];
    const current=operations.filter(item=>item.phase!=='queued').sort((a,b)=>b.operationId-a.operationId)[0]||operations.sort((a,b)=>a.operationId-b.operationId)[0];
    const panel=$('#desktop-operation-status');
    if(!panel)return;
    panel.hidden=!current;
    if(!current){panel.replaceChildren();return;}
    panel.dataset.operationId=String(current.operationId);
    panel.classList.toggle('is-waiting',current.waitingLong);
    const phase=current.operation==='export-workpaper'&&current.phase==='publishing'?'正在保存底稿':copy.operation.phases[current.phase];
    const title=`${copy.operation.names[current.operation]} · ${phase}`;
    const duration=current.elapsedMs>=1000?` · ${copy.operation.elapsed.replace('{seconds}',String(Math.floor(current.elapsedMs/1000)))}`:'';
    let measured='';
    if(current.progress?.writtenRows!==undefined){
      const rows=`${current.progress.writtenRows} / ${current.progress.totalRows??'—'} 条`;
      measured=current.operation==='export-workpaper'?`已生成 ${rows}。`:`已写入 ${rows}。待核 ${current.progress.pendingRows??'—'} 条。`;
    }else if(current.progress?.copiedBytes!==undefined){
      measured=`已归档 ${current.progress.copiedBytes} / ${current.progress.totalBytes??'—'} 字节。`;
    }
    const detail=['choosing-location','confirming-location','choosing-file','confirming-import'].includes(current.phase)?copy.operation.awaitingChoice:measured||(current.waitingLong?copy.operation.waiting:copy.operation.pending);
    if(!panel.firstChild)panel.innerHTML='<div class="operation-heading"><span class="dot" aria-hidden="true"></span><strong></strong><span class="operation-duration num" aria-hidden="true"></span></div><p></p>';
    // Keep the live region stable: announce stage changes, not each elapsed second.
    for(const [selector,value] of [['strong',title],['.operation-duration',duration],['p',detail]]){
      const element=$(selector,panel);if(element.textContent!==value)element.textContent=value;
    }
  }
  const currentCase = () => data.cases.find(c => c.id === state.caseId);
  const caseFlows = (id = state.caseId) => data.flows.filter(f => f.caseId === id);
  const caseFiles = (id = state.caseId) => data.files.filter(f => f.caseId === id);
  const issues = (id = state.caseId) => caseFlows(id).filter(f => f.status === 'pending' || f.balanceStatus === 'fail');
  const status = (key, text) => `<span class="status ${esc(key)}"><span class="dot"></span>${esc(text || ({active:'进行中',review:'待复核',archived:'已归档',confirmed:'已确认',pending:'待核对',ready:'已并表',error:'读取失败',pass:'通过',fail:'余额差异',na:'不适用',manual:'已接受差异',done:'已导出'}[key] || key))}</span>`;
  const btn = (text, action, iconName, cls = '', attrs = '') => `<button class="btn ${cls}" data-action="${action}" ${attrs}>${iconName ? ico(iconName) : ''}${text}</button>`;
  const empty = (title, desc, action = '') => `<div class="empty-state">${ico('folderOpen',32)}<h3>${title}</h3><p>${desc}</p>${action}</div>`;
  const options = (values, selected, first = '全部渠道') => `<option value="all">${first}</option>` + values.map(v => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const platformMark = p => `<span class="platform-mark ${p.includes('微信') ? 'wx' : p.includes('支付宝') ? 'ali' : ''}">${p.includes('微信') ? '微' : p.includes('支付宝') ? '支' : '银'}</span>`;
  const search = (id, placeholder, value) => `<label class="searchbox">${ico('search',15)}<input id="${id}" placeholder="${placeholder}" value="${esc(value)}" aria-label="${placeholder}" autocomplete="off"></label>`;
  function resetFlowFilters() {Object.assign(state,{flowQuery:'',flowTab:'all',flowPlatform:'all',sourceId:'',page:1,dateFrom:'',dateTo:'',minAmount:'',maxAmount:''});state.selected.clear();}
  function navigate(route, caseId) {
    if (caseId && caseId !== state.caseId) {state.caseId = caseId;resetFlowFilters();Object.assign(state,{fileQuery:'',fileTab:'all',filePlatform:'all',reviewId:null,reviewTab:'all'});if(desktop){live.epoch++;Object.assign(live,{materials:[],page:null,cursor:null,history:[],source:'',filter:'all',receipt:null,error:'',workpaper:null,exportError:'',cleanup:null});}}
    state.inspected = null;state.route = labels[route] ? route : 'home';
    if (location.hash !== '#' + state.route) location.hash = state.route;
    render();$('#main').scrollTop = 0;
    if(desktop)loadDesktopPage(true);
  }
  function renderShell() {
    if(desktop){renderDesktopShell();return;}
    const c = currentCase(), rows = caseFlows();
    $('#sidebar').innerHTML = `<div class="brand"><div class="brand-mark">${ico('table',24)}</div><div class="brand-copy"><div class="brand-name">东启勘流</div><div class="brand-sub">资金流水分析工作台</div></div></div>
      <nav aria-label="案件导航"><div class="nav-group"><button class="nav-item ${state.route === 'home' ? 'active' : ''}" data-action="nav" data-route="home" title="案件工作台" ${state.route === 'home' ? 'aria-current="page"' : ''}>${ico('home')}<span class="nav-label">案件工作台</span></button></div>
      <div class="nav-title">当前案件</div><button class="case-switch" data-action="switch-case" title="切换案件"><span class="switch-symbol">${ico('folder',16)}</span><span class="grow"><span class="case-label">${esc(c.number)}</span><span class="case-name truncate" style="display:block">${esc(c.name)}</span></span>${ico('chevronDown',12)}</button>
      <div class="nav-group">${[['materials','files',caseFiles().length],['flows','table',rows.length],['review','alert',issues().length],['exports','download','']].map(([r,i,n]) => `<button class="nav-item ${state.route === r ? 'active' : ''}" data-action="nav" data-route="${r}" title="${labels[r]}" ${state.route === r ? 'aria-current="page"' : ''}>${ico(i)}<span class="nav-label">${labels[r]}</span><span class="nav-count ${r === 'review' && n ? 'warn' : ''}">${n}</span></button>`).join('')}</div></nav>
      <div class="sidebar-bottom"><button class="nav-item" data-action="help" title="使用说明">${ico('help')}<span class="nav-label">使用说明</span></button><div class="demo-chip"><span class="dot"></span>示例案件 · 合成数据</div></div>`;
    $('#topbar').innerHTML = `<div class="breadcrumb"><button data-action="nav" data-route="home" aria-label="返回工作台">${ico('home',15)}</button>${ico('chevronRight',11)}${state.route !== 'home' ? `<span class="truncate">${esc(c.name)}</span>${ico('chevronRight',11)}` : ''}<strong>${labels[state.route]}</strong></div><div class="top-right"><button class="global-search" data-action="global-search">${ico('search',16)}搜索案件、流水<kbd>Ctrl K</kbd></button><span class="local-tag">${ico('shield',13)}本地桌面版</span><span class="avatar" title="内部使用">内</span></div>`;
    $('#statusbar').innerHTML = `<span><span class="dot"></span>本地 HTML 原型</span><span class="divider"></span><span>${state.route === 'home' ? `${data.cases.length} 个示例案件` : esc(c.number)}</span><span class="last">合成数据仅供体验 · 刷新后恢复初始状态</span>`;
    document.title = `东启勘流 · ${labels[state.route]}`;
  }
  function render() {
    const focused=document.activeElement;
    const focusId=focused?.id;
    const scope=['sidebar','topbar','main','inspector'].find(id=>document.getElementById(id).contains(focused));
    const focusData=focused?.dataset?{...focused.dataset}:{};
    const tag=focused?.tagName;
    renderShell();$('#main').innerHTML = `<div class="page ${state.density ? 'density-compact' : ''}">${desktop?desktopPage():({home:homePage,materials:materialsPage,flows:flowsPage,review:reviewPage,exports:exportsPage}[state.route])()}</div>`;renderInspector();
    if(scope){
      const replacement=focusId?document.getElementById(focusId):focusData.action?$$('[data-action]',document.getElementById(scope)).find(el=>el.tagName===tag&&Object.entries(focusData).every(([k,v])=>el.dataset[k]===v)):null;
      (replacement||$('#main')).focus({preventScroll:true});
    }
  }
  function renderDesktopShell(){
    const c=currentCase(),ready=!desktop.loading&&!desktop.error&&!desktop.needsWorkspace;
    const canOpen=ready&&c?.available!==false&&Boolean(c),locked=desktop.busy||desktop.saving;
    $('#sidebar').innerHTML=`<div class="brand"><div class="brand-mark">${ico('table',24)}</div><div class="brand-copy"><div class="brand-name">东启勘流</div><div class="brand-sub">资金流水分析工作台</div></div></div>
      <nav aria-label="案件导航"><div class="nav-group"><button class="nav-item ${state.route==='home'?'active':''}" data-action="nav" data-route="home" ${state.route==='home'?'aria-current="page"':''} ${locked?'disabled':''}>${ico('home')}<span class="nav-label">案件工作台</span></button></div>
      <div class="nav-title">当前案件</div><button class="case-switch" data-action="switch-case" title="切换案件" ${!ready||!data.cases.length||locked?'disabled':''}><span class="switch-symbol">${ico('folder',16)}</span><span class="grow"><span class="case-label">${esc(c?.number||'尚未打开案件')}</span><span class="case-name truncate" style="display:block">${esc(c?.name||'请先新建或打开案件')}</span></span>${ico('chevronDown',12)}</button>
      <div class="nav-group">${[['materials','files'],['flows','table'],['review','alert'],['exports','download']].map(([r,i])=>`<button class="nav-item ${state.route===r?'active':''}" data-action="nav" data-route="${r}" ${state.route===r?'aria-current="page"':''} ${!canOpen||locked?'disabled':''}>${ico(i)}<span class="nav-label">${labels[r]}</span></button>`).join('')}</div></nav>
      <div class="sidebar-bottom"><button class="nav-item" data-action="help" title="${copy.terms.help}" ${locked?'disabled':''}>${ico('help')}<span class="nav-label">${copy.terms.help}</span></button><div class="demo-chip desktop-chip"><span class="dot"></span>本地桌面版 · 导入技术预览</div></div>`;
    $('#topbar').innerHTML=`<div class="breadcrumb"><button data-action="nav" data-route="home" aria-label="返回工作台" ${locked?'disabled':''}>${ico('home',15)}</button>${ico('chevronRight',11)}${state.route!=='home'&&c?`<span class="truncate">${esc(c.name)}</span>${ico('chevronRight',11)}`:''}<strong>${labels[state.route]}</strong></div><div class="top-right"><button class="global-search" data-action="global-search" ${!ready||locked?'disabled':''}>${ico('search',16)}搜索案件名称、编号<kbd>Ctrl K</kbd></button><span class="local-tag">${ico('shield',13)}本地桌面版</span><span class="avatar" title="内部使用">内</span></div>`;
    $('#statusbar').innerHTML=`<span><span class="dot"></span>${desktop.loading?copy.home.loading:desktop.error?copy.home.readFailed:desktop.needsWorkspace?'尚未设置数据存放位置':'本地桌面版'}</span><span class="divider"></span><span>${desktop.loading||desktop.error?'案件数量待读取':state.route==='home'?`${data.cases.length} 个已登记案件`:esc(c?.number||'未打开案件')}</span><span class="last" title="${esc(desktop.workspacePath||'')}">${esc(desktop.workspacePath||'')}</span>`;
    document.title=`东启勘流 · ${labels[state.route]}`;
  }
  function desktopPage(){
    const heading=`<div class="page-head"><div><h1>${labels[state.route]}</h1><p class="page-sub">${state.route==='home'?copy.home.subtitle:esc(currentCase()?.name||'尚未打开案件')}</p></div></div>`;
    if(desktop.loading)return heading+`<section class="panel" aria-busy="true">${empty(copy.home.loading,copy.home.loadingBody)}</section>`;
    if(desktop.error)return heading+`<section class="panel desktop-error" role="alert">${empty(copy.home.readFailed,esc(desktop.error),btn(copy.home.retry,'retry-workspace','refresh','primary')+(desktop.locationKnown&&desktop.needsWorkspace?btn(copy.setup.choose,'choose-workspace','folderOpen'):''))}</section>`;
    if(desktop.needsWorkspace)return heading+`<section class="panel desktop-setup"><div class="setup-copy"><span class="setup-icon">${ico('folderOpen',24)}</span><div><h2>${copy.setup.title}</h2><p>${copy.setup.body}</p><p class="setup-input-note">${copy.setup.inputNote}</p><p class="setup-status">${copy.setup.status}</p>${btn(desktop.busy?copy.setup.choosing:copy.setup.choose,'choose-workspace','folderOpen','primary',desktop.busy?'disabled':'')}</div></div><details class="setup-details"><summary>${copy.setup.existingTitle}</summary><div class="setup-details-body">${copy.setup.existing.map(item=>`<p>${item}</p>`).join('')}</div></details>${desktop.notice?`<p class="desktop-notice" role="status">${esc(desktop.notice)}</p>`:''}</section>`;
    if(state.route==='home')return desktopHomePage();
    const c=currentCase();
    if(!c)return heading+`<section class="panel">${empty('请先打开案件','从案件工作台新建案件，或打开已有案件。',btn('返回案件工作台','nav','home','primary','data-route="home"'))}</section>`;
    if(c.available===false)return heading+`<section class="panel desktop-error" role="alert">${empty('案件暂不可用',esc(c.error||'无法读取案件数据，请核对数据存放位置。'),btn('返回案件工作台','nav','home','primary','data-route="home"'))}</section>`;
    if(['materials','flows','review'].includes(state.route))return heading+desktopDataPage();
    if(state.route==='exports'&&typeof desktopBridge.exportWorkpaper==='function')return heading+desktopExportPage();
    const detail=copy.stages[state.route];
    return heading+`<section class="panel desktop-stage"><div class="desktop-stage-symbol">${ico(detail.icon,29)}</div><h2>${detail.title}</h2><p>${detail.body}</p><div class="desktop-saved">${ico('checkCircle',15)}${copy.case.savedNote}</div>${btn('返回案件工作台','nav','home','','data-route="home"')}</section>`;
  }
  function previewNote(){return '<p class="preview-note">技术预览 · 完整 G0 尚未完成。待核记录可查看原文与处理依据，人工复核开发中。</p>';}
  function receiptView(){
    const r=live.receipt;
    if(!r)return '';
    const diagnostics=r.diagnosticRows==null?'':`<span>附加诊断涉及 ${esc(r.diagnosticRows)} 条</span>`;
    return `<div class="import-receipt" role="status"><strong>${r.state==='completed'?'导入已发布':'导入未发布'}</strong><span>写入 ${esc(r.importedRows??0)} 条 · 待核 ${esc(r.pendingRows??0)} 条 · 金额未确定 ${esc(r.unquantifiableRows??0)} 条</span>${diagnostics}${r.errorCode?`<span>${esc(r.errorCode)}</span>`:''}</div>`;
  }
  function stagingCleanupView(){
    const cleanup=live.cleanup;
    if(!cleanup?.removed&&!cleanup?.warnings)return '';
    const parts=[];
    if(cleanup.removed)parts.push(`已清理 ${cleanup.removed} 份超期导入暂存`);
    if(cleanup.warnings)parts.push(`${cleanup.warnings} 项暂存需检查`);
    return `<p class="desktop-notice staging-cleanup" role="status">${esc(parts.join('。'))}。</p>`;
  }
  function materialRow(material, disabled){
    const title=esc(readable(material.fileName));
    const format=esc(formatNames.get(material.formatKey)||'未识别');
    const formatHint=material.formatKey?`格式标识 ${material.formatKey}`:'';
    const latestError=material.latestErrorCode?`最近尝试：${esc(material.latestErrorCode)}`:'仅当前已发布批次可查';
    const counts=`${esc(material.importedRows??'—')} / ${esc(material.pendingRows??'—')}`;
    const diagnostics=material.diagnosticRows==null?'':`<div class="cell-note">附加诊断涉及 ${esc(material.diagnosticRows)} 条</div>`;
    const attrs=`data-id="${esc(material.id)}" ${disabled}`;
    let action='';
    if(material.currentBatchId){
      action=btn('查看流水','material-flows','table','small',attrs);
      if(material.canReimport&&typeof desktopBridge.reimportMaterial==='function'){
        action+=` <span class="material-reimport">${btn('按新规则重导','desktop-reimport-material','refresh','small',`${attrs} data-batch="${esc(material.currentBatchId)}"`)}</span>`;
      }
    }
    else if(material.canRetry&&typeof desktopBridge.retryImport==='function')action=btn('重试导入','desktop-retry-import','refresh','small',attrs);
    const rule=material.ruleVersion?` · 规则 v${esc(material.ruleVersion)}`:'';
    return `<tr><td><div class="cell-title">${title}</div><div class="cell-note num" title="${esc(material.sha256)}">SHA256 ${esc(material.sha256?.slice(0,16)||'—')}…</div></td><td title="${esc(formatHint)}">${format}<div class="cell-note">${esc(material.encoding||'—')}${rule}</div></td><td>${esc(material.batchStatus||material.status)}<div class="cell-note">${latestError}</div></td><td class="num">${counts}${diagnostics}</td><td>${action}</td></tr>`;
  }
  function internalTransfer(row){
    if(row.rule_version!=='2'&&row.rule_version!==2)return null;
    try {
      const raw=JSON.parse(row.raw_record);
      return raw?.format_key==='alipay-account-17col-v1'&&raw.derivation?.internal_transfer?.kind==='balance_to_yuebao'
        ? raw.derivation.internal_transfer : null;
    } catch (_) { return null; }
  }
  function ledgerRow(row, disabled){
    const reasons=row.pendingReasons.map(reason=>reason.detail).join('；');
    const classification=internalTransfer(row)?'<div class="cell-note">内部划转 · 不计入经济收支</div>':'';
    return `<tr><td class="num">${esc(row.txn_time||'时间待核')}<div class="cell-note">${esc(readable(row.source_file_name))} · ${esc(row.source_loc)}</div>${btn('查看原文','desktop-source','external','small ledger-source-button',`data-id="${esc(row.id)}" ${disabled}`)}</td><td>${status(row.status)}${classification}<div class="cell-note" title="${esc(reasons)}">${esc(reasons)}</div></td><td><div class="cell-title">${esc(readable(row.acct_no||'身份待核'))}</div><div class="cell-note">${esc(readable(row.peer_name||row.peer_acct||row.summary||'—'))}</div></td><td class="num">${esc(readable(row.raw_amount_text??'（空）'))} ${esc(rawUnit(row))}<div class="cell-note">${esc(row.raw_direction||'未知方向')}</div></td><td class="num">${exactMoney(row.amount)}<div class="cell-note">${esc(row.currency||'币种未覆盖，不计算')}</div></td></tr>`;
  }
  function desktopDataPage(){
    const disabled=desktop.busy||live.loading?'disabled':'';
    const notice=live.error?`<div class="desktop-data-error" role="alert">${esc(live.error)} ${btn('刷新列表','refresh-data','refresh','small',disabled)}</div>`:'';
    if(state.route==='materials')return previewNote()+stagingCleanupView()+receiptView()+notice+`<section class="panel desktop-materials"><div class="desktop-materials-head"><div class="spread"><p class="feature-status">真实导入技术预览</p>${btn('选择原始材料','desktop-import','upload','primary',disabled)}</div><p>支持指定支付宝账户 CSV、微信 27 列 TXT、建行 32 列 XLSX。按来源坐标保留每一行。</p></div><div class="table-scroll"><table class="data-table"><thead><tr><th>材料 / 原件身份</th><th>格式</th><th>当前批次</th><th>写入 / 待核</th><th scope="col">操作</th></tr></thead><tbody>${live.materials.map(material=>materialRow(material,disabled)).join('')}</tbody></table>${live.loading?empty('正在读取材料','请等待本地数据返回。'):live.materials.length?'':empty('还没有已导入材料','点击“选择原始材料”，选择一个受支持模板的文件。')}</div><p class="field-note">请保留原件，不删行或改表头。同一原件重复导入会被拒绝；未知模板明确报错。</p><div class="desktop-saved">${ico('checkCircle',15)}${copy.case.savedNote}</div></section>`;
    const page=live.page,rows=page?.rows||[],review=state.route==='review';
    return previewNote()+notice+`<section class="panel desktop-flows"><div class="table-tools"><span>${review?'待核只读清单':'当前已发布流水'}</span><select id="desktop-source" class="select" aria-label="按来源材料筛选"><option value="">全部材料</option>${live.materials.filter(m=>m.currentBatchId).map(m=>`<option value="${esc(m.id)}" ${live.source===m.id?'selected':''}>${esc(readable(m.fileName))}</option>`).join('')}</select>${review?'':`<select id="desktop-status" class="select" aria-label="按记录状态筛选">${[['all','全部状态'],['confirmed','已确认'],['pending','待核']].map(([v,t])=>`<option value="${v}" ${live.filter===v?'selected':''}>${t}</option>`).join('')}</select>`}<span class="push"></span>${btn('关联候选','desktop-relations','link','small',disabled)}${btn('刷新列表','refresh-data','refresh','small',disabled)}</div><div class="table-scroll"><table class="data-table desktop-ledger"><thead><tr><th>交易时间 / 来源原文</th><th>状态 / 待核原因</th><th>本方 / 交易对方</th><th>原始金额 / 方向</th><th>标准金额（元）</th></tr></thead><tbody>${rows.map(row=>ledgerRow(row,disabled)).join('')}</tbody></table>${live.loading?empty('正在读取流水','请等待本地数据返回。'):rows.length?'':empty(review?'暂无待核记录':'暂无已发布流水',live.error?'先处理上方错误，再刷新。':'可先在材料管理中导入受支持的原始材料。')}</div><div class="table-footer"><span>共 ${esc(page?.total??'—')} 条 · 第 ${live.history.length+1} 页 · 金额以整数分保存</span><span class="push"></span>${btn('上一页','desktop-prev',null,'small',!live.history.length||disabled?'disabled':'')}${btn('下一页','desktop-next',null,'small',!page?.nextCursor||disabled?'disabled':'')}</div></section><p class="quiet-note">${review?'待核原因保留原值与依据，本版没有保存或确认按钮。':'来源材料可能反映同一资金活动的不同视角，本版不自动去重或合计。'}</p>`;
  }
  async function loadDesktopPage(reset=false){
    if(!desktop||!['materials','flows','review'].includes(state.route)||!currentCase()||desktop.error)return;
    const epoch=++live.epoch,caseId=state.caseId,route=state.route;
    if(reset){live.cursor=null;live.history=[];live.page=null;}
    live.loading=true;live.error='';render();
    try{
      const materials=await desktopCall('listMaterials',caseId);
      if(epoch!==live.epoch||caseId!==state.caseId||route!==state.route)return;
      live.materials=materials.materials;
      if(route!=='materials'){
        const filters={};if(live.source)filters.sourceFileId=Number(live.source);
        if(route==='review'||live.filter!=='all')filters.status=route==='review'?'pending':live.filter;
        const page=await desktopCall('queryFlows',caseId,{limit:50,cursor:live.cursor,filters});
        if(epoch!==live.epoch||caseId!==state.caseId||route!==state.route)return;
        live.page=page;
      }
    }catch(error){if(epoch===live.epoch){live.error=desktopError(error);live.page=null;}}
    finally{if(epoch===live.epoch){live.loading=false;render();}}
  }
  async function desktopImport(sourceFileId,batchId){
    if(desktop.busy||live.loading||!currentCase())return;
    const reimport=batchId!==undefined;
    const retry=sourceFileId!==undefined&&!reimport;
    if(retry&&!live.materials.some(material=>material.id===sourceFileId&&material.canRetry&&!material.currentBatchId))return;
    if(reimport&&!live.materials.some(material=>material.id===sourceFileId&&material.canReimport&&material.currentBatchId===batchId))return;
    const caseId=state.caseId;desktop.busy=true;live.error='';live.receipt=null;render();
    try{
      const result=reimport?await desktopCall('reimportMaterial',caseId,sourceFileId,batchId)
        :retry?await desktopCall('retryImport',caseId,sourceFileId):await desktopCall('chooseImport',caseId);
      if(result.cancelled){toast(reimport?'已取消重导。':'已取消选择，未导入材料。');return;}
      live.receipt=result.receipt;live.materials=result.materials.materials;upsertDesktopCase(result.case);
      toast('导入已发布，可查看流水和待核原因。');
    }catch(error){
      live.error=desktopError(error);live.receipt=error.receipt||null;
      try{const materials=await desktopCall('listMaterials',caseId);live.materials=materials.materials;const cases=await desktopCall('listCases');const c=cases.find(item=>item.id===caseId);if(c)upsertDesktopCase(c);}catch(_){/* Retain the import failure; a refresh can retry reading separately. */}
    }
    finally{desktop.busy=false;render();}
  }
  function desktopExportPage(){
    const receipt=live.workpaper;
    const error=live.exportError?`<p class="desktop-data-error" role="alert">${esc(live.exportError)}</p>`:'';
    const saved=receipt?`<section class="panel workpaper-receipt" role="status" data-version="${esc(receipt.dataVersion)}"><div class="panel-head"><h2>底稿已保存</h2><span class="secondary num">数据版本 ${esc(receipt.dataVersion)}</span></div><div class="workpaper-receipt-body"><p class="workpaper-file">${esc(receipt.filePath)}</p><dl class="workpaper-counts">${[['总行数',receipt.totalRows],['已确认',receipt.confirmedRows],['待核',receipt.pendingRows],['金额未知',receipt.unknownAmountRows]].map(([label,value])=>`<div><dt>${label}</dt><dd class="num">${esc(value)}</dd></div>`).join('')}</dl></div></section>`:'';
    return `<section class="panel workpaper-panel" aria-busy="${live.exporting}"><div class="panel-head"><h2>Excel 核对底稿</h2><span class="secondary">.xlsx</span></div><div class="workpaper-body"><p>导出本案件当前有效流水。表中并列展示原文、标准值、待核原因和来源位置，说明页记录底稿格式、数据版本和各平台行数。</p><p class="quiet-note">请保存到可写的本地 NTFS 文件夹，例如本机的文档文件夹。底稿为规则结果，在 Excel 中修改底稿不计为复核。</p>${btn(live.exporting?'正在导出…':'导出 Excel 底稿','desktop-export-workpaper','download','primary',desktop.busy?'disabled':'')}</div></section>${error}${saved}`;
  }
  async function desktopExport(){
    if(desktop.busy||state.route!=='exports'||!currentCase()||typeof desktopBridge.exportWorkpaper!=='function')return;
    const caseId=state.caseId;
    desktop.busy=true;
    live.exporting=true;
    live.workpaper=null;
    live.exportError='';
    render();
    try{
      const result=await desktopCall('exportWorkpaper',caseId);
      if(result.cancelled){
        toast('已取消导出。');
        return;
      }
      live.workpaper=result;
    }catch(error){
      live.exportError=desktopError(error);
    }finally{
      desktop.busy=false;
      live.exporting=false;
      render();
      $('[data-action="desktop-export-workpaper"]')?.focus({preventScroll:true});
    }
  }
  function sourceMoneyExplanation(source){
    const money=source.savedDerivation?.money;
    const row=source.standard;
    const unit=money?.source_unit;
    if(unit!=='元'&&unit!=='分')return '';
    const parts=[unit==='元'?'原始单位为元，软件换算成整数分保存。':'原始单位为分，直接按整数分保存。'];
    if(money.rounding?.some(item=>item.field==='raw_amount_text'&&item.rounded)){
      const original=readable(row.raw_amount_text);
      const display=exactMoney(row.amount).replace(/^[+-]/,'');
      const rounded=display==='—'?'':` → ${display} 元（绝对值）`;
      parts.push(`四舍五入到分：${original} ${unit}${rounded}。`);
    }
    if(row.amount!=null&&row.direction){
      const direction=readable(row.raw_direction||'原始记录');
      const signed=row.direction==='出'?'支出记负数':'收入记正数';
      parts.push(`方向依据：${direction} → ${row.direction}，${signed}。`);
    }else if(row.amount==null){
      parts.push('标准金额待核。');
    }
    const transfer=internalTransfer(row);
    if(transfer){
      const shown=transfer.amount_minor==null?'划转金额待核。':`原件划转金额 ${exactMoney(transfer.amount_minor)} 元。`;
      parts.push(`内部划转：余额转入余额宝，保留账户变动证据，排除经济收支。${shown}`);
    }
    return `<div class="source-money-explanation">${parts.map(part=>`<p>${esc(part)}</p>`).join('')}</div>`;
  }
  async function desktopSource(id){
    if(desktop.busy||live.loading||!live.page)return;
    desktop.busy=true;render();
    try{
      const source=await desktopCall('readFlowSource',state.caseId,{flowId:id,dataVersion:live.page.dataVersion});
      const r=source.standard,entries=source.fieldEntries||Object.entries(source.fields).map(([header,value],i)=>({column:i+1,header,value}));
      modal('原始记录 · 只读',`<p class="preview-note">归档原件已核验。格式控制字符显示为转义文本；原始字节与字段保留。</p><p>${esc(readable(source.fileName))} · ${esc(source.sourceLoc)}</p><div class="cell-note num source-hash">SHA256 ${esc(source.sourceSha256)}</div><div class="source-standard">标准金额：${exactMoney(r.amount)} 元 · ${esc(r.currency||'币种未知')} · ${status(r.status)}<br>${esc(r.pendingReasons.map(p=>p.detail).join('；')||'没有未解决待核原因')}${sourceMoneyExplanation(source)}</div><table class="data-table raw-evidence"><thead><tr><th>列 / 字段</th><th>原始值</th></tr></thead><tbody>${entries.map(e=>`<tr><td>${esc(e.column)} · ${esc(e.header)}</td><td>${esc(readable(e.value))}</td></tr>`).join('')}</tbody></table><details><summary>保存时的处理依据</summary><pre class="derivation-json">${esc(JSON.stringify(source.savedDerivation,null,2))}</pre></details>`,btn('关闭','close-modal'),true);
    }catch(error){live.error=desktopError(error);toast(live.error);}
    finally{desktop.busy=false;render();}
  }
  async function desktopRelations(){
    if(desktop.busy||live.loading||!currentCase())return;
    desktop.busy=true;render();
    try{
      const result=await desktopCall('queryRelations',state.caseId,{limit:100});
      const side=r=>`<strong>${esc(readable(r.fileName))} · ${esc(r.sourceLoc)}</strong><div>${esc(r.platform)} · ${esc(r.time||'时间未知')} · ${exactMoney(r.amount)} ${esc(r.currency||'币种未知')}</div><div>方向 ${esc(r.direction||'未知')} · 本方 ${esc(readable(r.accountIdentity))} · 卡号 ${esc(readable(r.bankCard||'—'))}</div>`;
      modal('关联候选 · 只读',`<p class="preview-note">每个候选只说明证据相似，仍需判断具体业务关系；两端记录均保留，不合并、不去重、不计算净额。</p><p>本次返回 ${result.rows.length} 组候选${result.truncated?'，结果达到展示上限':''}。扫描 ${esc(result.eligibleRows)} 条当前记录。</p>${result.rows.map(r=>`<article class="relation-candidate"><h3>${esc(r.label)}${r.ambiguous?' · 多候选待核':''}</h3><div class="relation-sides"><div>${side(r.left)}</div><div>${side(r.right)}</div></div><ul>${r.evidence.map(e=>`<li>${esc(e.label)}：${esc(readable(e.value))}</li>`).join('')}</ul><p>${esc(r.warnings.join('；'))}</p></article>`).join('')||empty('尚未找到候选','先导入有关联证据的微信与建行材料；未命中不代表没有关系。')}<p class="field-note">${esc(result.limitations.join('；'))}</p>`,btn('关闭','close-modal'),true);
    }catch(error){toast(desktopError(error));}finally{desktop.busy=false;render();}
  }
  function desktopHomePage(){
    const locked=desktop.busy||desktop.saving,query=state.caseQuery.toLowerCase();
    const cases=data.cases.filter(c=>(c.name+' '+c.number).toLowerCase().includes(query)).sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''));
    const incomplete=data.cases.filter(c=>c.available===false||!c.stats||['files','flows','pending'].some(key=>!Number.isFinite(c.stats[key])));
    const summary=(field)=>data.cases.some(c=>c.available===false||!Number.isFinite(c.stats?.[field]))?null:data.cases.reduce((sum,c)=>sum+c.stats[field],0);
    const summaries=[['folder','已登记案件',data.cases.length,'个','按案件独立保存'],['files','材料',summary('files'),'份','已登记材料'],['table','有效流水',summary('flows'),'条','当前有效批次'],['alert','待核记录',summary('pending'),'条','仍需核对的记录']];
    const c=currentCase(),date=new Date().toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long'});
    const guidance=c?copy.home.current:cases.length?copy.home.hasCases:copy.home.noCases;
    return `<div class="page-head"><div><h1>案件工作台</h1><p class="page-sub">${copy.home.subtitle}</p></div><div class="page-actions"><span class="date-note">${esc(date)}</span>${btn('新建案件','new-case','plus','primary',locked?'disabled':'')}</div></div>
      <div class="desktop-workspace-line">${ico('folderOpen',15)}<span>${copy.terms.location}</span><span class="desktop-path" title="${esc(desktop.workspacePath)}">${esc(desktop.workspacePath)}</span>${btn(desktop.busy?copy.setup.choosing:copy.home.refresh,'retry-workspace','refresh','quiet small',locked?'disabled':'')}</div>
      <div class="desktop-guidance" role="status">${ico(c?'checkCircle':'info',15)}<span>${guidance}</span>${!c&&!cases.length?btn('新建案件','new-case','plus','quiet small',locked?'disabled':''):''}</div>
      ${desktop.notice?`<div class="desktop-notice" role="status">${esc(desktop.notice)}</div>`:''}
      <div class="summary-strip">${summaries.map(([i,l,n,u,d])=>`<div class="summary-item"><div class="summary-label">${ico(i,14)} ${l}</div><div class="summary-number num">${n===null?'—':count(n)}<span class="unit">${u}</span></div><div class="summary-detail">${esc(n===null?'统计尚未完整确认':d)}</div></div>`).join('')}</div>
      <div class="desktop-stats-note">${copy.home.unknown} ${copy.home.overview}</div>
      ${incomplete.length?`<div class="desktop-unavailable" role="status">${ico('alert',15)}${copy.home.incomplete}</div>`:''}
      ${c&&c.available!==false?`<section class="panel desktop-current"><div><div class="muted">当前案件</div><h2>${esc(c.name)}</h2><span class="num secondary">${esc(c.number)}</span></div><div class="desktop-current-action"><span class="muted">名称与编号已保存在本地</span>${btn('打开案件','open-case','arrowRight','primary',`data-id="${esc(c.id)}" ${locked?'disabled':''}`)}</div></section>`:''}
      <div class="section-title"><h2>案件列表 <span class="subcount">${cases.length}</span></h2><span class="muted">名称与编号</span></div>
      <section class="panel"><div class="table-tools">${search('case-query','搜索案件名称或编号',state.caseQuery)}<span class="push muted" style="font-size:11px">按最近更新时间排列</span></div><div class="table-scroll"><table class="data-table case-table desktop-case-table"><thead><tr><th>案件名称 / 编号</th><th>材料</th><th>有效流水</th><th>待核记录</th><th>数据状态</th><th>最近更新</th><th></th></tr></thead><tbody>${cases.map(row=>`<tr class="click-row" data-action="open-case" data-id="${esc(row.id)}" tabindex="0"><td><div class="case-cell"><span class="folder-symbol">${ico('folder',21)}</span><div><div class="cell-title">${esc(row.name)}</div><div class="cell-note num">${esc(row.number)}</div></div></div></td>${['files','flows','pending'].map(key=>`<td class="num">${row.available===false||!row.stats||!Number.isFinite(row.stats[key])?'—':count(row.stats[key])}</td>`).join('')}<td>${row.available===false?status('error','暂不可用'):row.statisticsNotice?status('review','统计待检查'):status('confirmed','可打开')}${row.error||row.statisticsNotice?`<div class="cell-note desktop-case-error">${esc(row.error||row.statisticsNotice)}</div>`:''}</td><td class="num secondary" style="font-size:11px">${esc(localTimestamp(row.updatedAt))}</td><td class="right">${ico('arrowRight',15)}</td></tr>`).join('')}</tbody></table>${cases.length?'':empty(data.cases.length?'没有找到案件':'还没有案件',data.cases.length?'换个名称或编号再试试。':'新建第一个案件，名称与编号会保存在本地。',data.cases.length?'':btn('新建案件','new-case','plus','primary',locked?'disabled':''))}</div><div class="table-footer">共 ${cases.length} 个案件<span style="margin-left:auto">${copy.home.persistence}</span></div></section>`;
  }
  function desktopError(error){
    const message=typeof error==='string'?error:typeof error?.message==='string'?error.message:copy.feedback.generic;
    const code=error?.code||'';
    const next=/MISSING$/.test(code)?copy.feedback.locationMissing:code==='SETTINGS_WRITE'?copy.feedback.uncertainSave:/SQLITE_FULL/.test(code)?copy.feedback.space:/SQLITE_READONLY|SQLITE_CANTOPEN/.test(code)?copy.feedback.readonly:/MIGRAT|BACKUP|SCHEMA/.test(code)?copy.feedback.upgradeFailed:'';
    return next&&!message.includes(next)?`${message} ${next}`:message;
  }
  function normalizeDesktopCase(value){return {...value,error:value?.error?desktopError(value.error):null,statisticsNotice:value?.statisticsNotice||(value?.diagnostics||[]).map(d=>typeof d==='string'?d:d.message||d.reason||'统计需检查').join('；')};}
  async function desktopCall(method,...args){
    const result=await desktopBridge[method](...args);
    if(!result||result.ok!==true)throw Object.assign(new Error(result?.error?.message||copy.feedback.generic),{code:result?.error?.code||'DESKTOP_ERROR',receipt:result?.error?.receipt});
    return result.data;
  }
  function applyDesktopState(value){
    if(!value||!Array.isArray(value.cases))throw new Error('案件数据返回不完整，请重试读取。');
    desktop.workspacePath=value.workspacePath||null;desktop.needsWorkspace=Boolean(value.needsWorkspace);desktop.locationKnown=true;
    data.cases=value.cases.map(normalizeDesktopCase);data.files=[];data.flows=[];data.exports=[];
    state.caseId=data.cases.some(c=>c.id===value.currentCaseId&&c.available!==false)?value.currentCaseId:null;
    state.route='home';resetFlowFilters();state.inspected=null;
    Object.assign(live,{materials:[],page:null,cursor:null,history:[],source:'',receipt:null,error:'',loading:false,
      workpaper:null,exportError:'',cleanup:value.stagingCleanup??null});live.epoch++;
  }
  async function loadDesktop(choose=false){
    if(desktop.busy||desktop.saving||choose&&!desktop.needsWorkspace)return;
    desktop.busy=true;desktop.loading=!choose;desktop.error='';desktop.notice='';render();
    try{
      const value=await desktopCall(choose?'chooseWorkspace':'getState');
      if(value?.cancelled){desktop.notice=copy.feedback.cancelled;return;}
      applyDesktopState(value);
    }catch(error){desktop.error=desktopError(error);}
    finally{desktop.busy=false;desktop.loading=false;render();document.dispatchEvent(new CustomEvent('fundsift:desktop-ready'));}
  }
  function desktopNewCase(){
    if(desktop.busy||desktop.saving||desktop.needsWorkspace||desktop.error)return;
    modal(copy.case.create,`<div class="field"><label for="new-name">${copy.case.name}</label><input id="new-name" class="text-input" maxlength="40" placeholder="${copy.case.nameExample}"><div class="field-note">${copy.case.nameHint}</div></div><div class="field"><label for="new-number">${copy.case.number}</label><input id="new-number" class="text-input" maxlength="30" placeholder="${copy.case.numberExample}"><div class="field-note">${copy.case.numberHint}<br>${copy.case.numberExampleHint}</div></div><div class="case-save-location">${copy.case.location} <span>${esc(desktop.workspacePath||copy.home.locationUnset)}</span></div><div class="inline-error" id="form-error" role="alert"></div>`,`${btn('取消','close-modal')}${btn(copy.case.submit,'save-case','check','primary')}`);
  }
  function upsertDesktopCase(value){
    value=normalizeDesktopCase(value);
    const found=data.cases.findIndex(c=>c.id===value.id);
    if(found<0)data.cases.unshift(value);else data.cases[found]=value;
  }
  async function saveDesktopCase(){
    if(desktop.saving||desktop.busy)return;
    const name=$('#new-name')?.value.trim(),number=$('#new-number')?.value.trim(),errorEl=$('#form-error');
    if(!errorEl)return;
    if(!name||!number||name.length>40||number.length>30){errorEl.textContent=copy.case.required;return;}
    if(data.cases.some(c=>caseNumberKey(c.number)===caseNumberKey(number))){errorEl.textContent=copy.case.duplicate;return;}
    desktop.saving=true;errorEl.textContent='';$$('button,input', $('.modal')).forEach(el=>el.disabled=true);
    const saveButton=$('[data-action="save-case"]');if(saveButton)saveButton.textContent=copy.case.saving;
    try{
      const value=await desktopCall('createCase',{name,number});
      if(!value?.id)throw Object.assign(new Error('案件保存结果不完整，请先刷新列表核对，避免重复创建。'),{code:'SETTINGS_WRITE'});
      upsertDesktopCase(value);desktop.notice='';closeModal();navigate('materials',value.id);toast(copy.case.saved);
    }catch(error){if(errorEl.isConnected)errorEl.textContent=desktopError(error);}
    finally{desktop.saving=false;$$('button,input', $('.modal')||document.createElement('div')).forEach(el=>el.disabled=false);const button=$('[data-action="save-case"]');if(button)button.textContent=copy.case.submit;render();}
  }
  async function openDesktopCase(id){
    if(desktop.busy||desktop.saving||desktop.needsWorkspace)return;
    desktop.busy=true;desktop.notice='';render();
    try{
      const value=await desktopCall('openCase',id);
      if(!value?.id||value.id!==id||value.available===false)throw new Error(value?.error?desktopError(value.error):'案件数据库暂不可读。');
      upsertDesktopCase(value);closeModal();navigate('materials',value.id);
      live.cleanup=value.stagingCleanup??null;
    }catch(error){
      const c=data.cases.find(row=>row.id===id);if(c){c.available=false;c.error=desktopError(error);c.stats=null;}
      desktop.notice=desktopError(error);closeModal();navigate('home');
    }finally{desktop.busy=false;render();}
  }
  function desktopSwitchCase(){
    if(desktop.busy||desktop.saving)return;
    modal('切换案件',`<div class="search-results" style="margin:0">${data.cases.map(c=>`<button class="search-result" data-action="choose-case" data-id="${esc(c.id)}">${ico('folder',20)}<span class="grow"><span>${esc(c.name)}</span><span class="cell-note" style="display:block">${esc(c.number)}</span></span>${c.available===false?status('error','暂不可用'):c.id===state.caseId?ico('check',17):ico('arrowRight',14)}</button>`).join('')}</div>`,btn('新建案件','new-case','plus'));
  }
  function desktopHelp(){
    const guide=copy.help.sections.map(section=>`<section class="help-section"><h3>${section.title}</h3>${section.body.map(body=>`<p>${body}</p>`).join('')}</section>`).join('');
    const move=desktop?`<section class="help-section"><h3>${copy.help.moveTitle}</h3>${copy.help.move.map(body=>`<p>${body}</p>`).join('')}</section>`:'';
    const location=desktop?`<div class="desktop-workspace-info"><b>${copy.terms.location}</b><div class="help-path">${esc(desktop.workspacePath||copy.home.locationUnset)}</div>${desktop.locationKnown&&desktop.needsWorkspace?btn(copy.setup.choose,'choose-workspace','folderOpen','',desktop.busy?'disabled':''):''}</div>`:'';
    modal(copy.help.title,`${guide}${location}${move}<div class="shortcut-list"><span><kbd>Ctrl K</kbd> ${desktop?'搜索案件名称 / 编号':'搜索示例案件与流水'}</span><span><kbd>Esc</kbd> 关闭弹窗</span></div><div class="help-preference"><label class="form-check"><input id="startup-intro" type="checkbox" ${!window.FUND_INTRO?.shouldSkip()?'checked':''} ${window.FUND_INTRO&&!window.FUND_INTRO.canRemember()?'disabled':''}>${copy.help.preference}</label><div class="field-note">${copy.help.preferenceNote}${window.FUND_INTRO&&!window.FUND_INTRO.canRemember()?copy.intro.preferenceUnavailable:''}</div></div>`,btn(copy.help.intro,'intro','home')+btn(copy.help.close,'close-modal',null,'primary'),true);
    $('.modal').dataset.help='true';
  }
  function homePage() {
    const c=currentCase(),rows=caseFlows(),files=caseFiles();
    const cases=data.cases.filter(c=>(state.caseTab==='all'||(state.caseTab==='active'?c.status!=='archived':c.status==='archived'))&&(c.name+c.number).toLowerCase().includes(state.caseQuery.toLowerCase())).sort((a,b)=>b.updated.localeCompare(a.updated));
    return `<div class="page-head"><div><h1>案件工作台</h1><p class="page-sub">整理材料，核对流水，从这里继续工作。</p></div><div class="page-actions"><span class="date-note">2026 年 11 月 12 日　星期四</span>${btn('新建案件','new-case','plus','primary')}</div></div>
    <div class="summary-strip">${[[ico('folder',14)+' 案件',data.cases.length,'个',data.cases.filter(c=>c.status!=='archived').length+' 个进行中'],[ico('files',14)+' 流水材料',data.files.length,'份','银行 / 微信 / 支付宝'],[ico('table',14)+' 并表记录',data.flows.length,'条','按案件独立整理'],[ico('alert',14)+' 金额待核',data.flows.filter(f=>f.status==='pending').length,'条','待核金额不计入收支汇总']].map(([l,n,u,d])=>`<div class="summary-item"><div class="summary-label">${l}</div><div class="summary-number num">${count(n)}<span class="unit">${u}</span></div><div class="summary-detail">${d}</div></div>`).join('')}</div>
    <div class="home-workrow"><section class="panel continue-panel"><div class="continue-top">${ico('clock',13)}上次工作案件<span style="margin-left:auto" class="num">${esc(c.updated)}</span></div><div class="continue-title">${esc(c.name)}</div><p class="continue-desc">${esc(c.description)}</p><div class="continue-bottom"><div class="platform-dots">${[...new Set(files.map(f=>f.platform))].slice(0,3).map(p=>`<span class="platform-chip">${ico(p==='建设银行'?'bank':'wallet',12)}${esc(p)}</span>`).join('')}<span class="num">${rows.length} 条流水</span></div>${btn('继续核查','continue','arrowRight','primary')}</div></section>
    <section class="panel task-panel"><div class="task-head">当前案件待办<span class="muted" style="font-size:10px;font-weight:400">${esc(c.number)}</span></div>${[['amount','alert','金额方向待核',rows.filter(f=>f.status==='pending').length],['balance','receipt','余额存在差异',rows.filter(f=>f.balanceStatus==='fail').length],['files','files','材料尚未完成',files.filter(f=>f.status!=='ready').length]].map(([t,i,l,n])=>`<button class="task-row" data-action="task" data-kind="${t}"><span class="task-icon ${t==='files'?'slate':''}">${ico(i,14)}</span><span class="task-text">${l}</span><span class="task-number">${n}</span>${ico('chevronRight',12)}</button>`).join('')}</section></div>
    <div class="section-title"><h2>案件列表 <span class="subcount">${cases.length}</span></h2><div class="segmented">${[['all','全部'],['active','进行中'],['archived','已归档']].map(([v,l])=>`<button class="${state.caseTab===v?'active':''}" data-action="case-tab" data-value="${v}">${l}</button>`).join('')}</div></div>
    <section class="panel"><div class="table-tools">${search('case-query','搜索案件名称或编号',state.caseQuery)}<span class="push muted" style="font-size:11px">按最近更新时间排列</span></div><div class="table-scroll"><table class="data-table case-table"><thead><tr><th>案件名称 / 编号</th><th>材料</th><th>并表记录</th><th>金额待核</th><th>案件状态</th><th>最近更新</th><th></th></tr></thead><tbody>${cases.map(c=>`<tr class="click-row" data-action="open-case" data-id="${c.id}" tabindex="0"><td><div class="case-cell"><span class="folder-symbol">${ico('folder',21)}</span><div><div class="cell-title">${esc(c.name)}</div><div class="cell-note num">${esc(c.number)}<span style="margin:0 8px">/</span>${esc(c.type)}</div></div></div></td><td class="num">${caseFiles(c.id).length}<small class="muted"> 份</small></td><td class="num">${caseFlows(c.id).length}<small class="muted"> 条</small></td><td class="num ${caseFlows(c.id).some(f=>f.status==='pending')?'amber':'muted'}">${caseFlows(c.id).filter(f=>f.status==='pending').length||'—'}</td><td>${status(c.status)}</td><td class="num secondary" style="font-size:11px">${esc(c.updated)}</td><td class="right"><span class="enter-btn">${ico('arrowRight',15)}</span></td></tr>`).join('')}</tbody></table>${cases.length?'':empty('没有找到案件','换个名称或编号再试试。')}</div><div class="table-footer">共 ${cases.length} 个案件<span style="margin-left:auto">所有数据保存在本次示例会话中</span></div></section>`;
  }
  function materialsPage() {
    const files=caseFiles(),matchesTab=f=>state.fileTab==='all'||(state.fileTab==='unresolved'?f.status!=='ready':f.status===state.fileTab),filtered=files.filter(f=>matchesTab(f)&&(state.filePlatform==='all'||f.platform===state.filePlatform)&&f.name.toLowerCase().includes(state.fileQuery.toLowerCase()));
    return `<div class="page-head"><div><h1>材料管理</h1><p class="page-sub">${esc(currentCase().name)}<span style="margin:0 10px">/</span>保留每份材料的来源与处理结果</p></div><div class="page-actions">${btn('添加示例材料','demo-import','plus')}${btn('导入材料','pick-files','upload','primary')}</div></div>
    <div class="upload-area" id="drop-zone"><span class="upload-symbol">${ico('upload',23)}</span><div class="grow"><div class="upload-title">将流水文件拖到这里，或选择文件</div><div class="upload-note">支持 Excel、CSV、TXT 文件。当前原型登记文件信息，正式解析将在后续版本接入。</div></div>${btn('选择文件','pick-files','folderOpen')}</div>
    <div class="file-summary"><span><b>${files.length}</b>份材料</span><span><b>${files.filter(f=>f.status==='ready').length}</b>份已并表</span><span><b class="amber">${files.filter(f=>f.status==='pending').length}</b>份待处理</span><span><b>${caseFlows().length}</b>条并表记录</span></div>
    <section class="panel"><div class="tabs">${[['all','全部材料'],['ready','已并表'],['unresolved','需处理'],['error','读取失败']].map(([v,l])=>`<button class="tab ${state.fileTab===v?'active':''}" data-action="file-tab" data-value="${v}">${l}<b>${files.filter(f=>v==='all'||(v==='unresolved'?f.status!=='ready':f.status===v)).length}</b></button>`).join('')}</div><div class="table-tools">${search('file-query','搜索文件名',state.fileQuery)}<select class="select" id="file-platform" aria-label="材料渠道">${options([...new Set(files.map(f=>f.platform))],state.filePlatform)}</select><span class="push muted" style="font-size:11px">原件信息保留，不覆盖</span></div><div class="table-scroll"><table class="data-table"><thead><tr><th>文件名称</th><th>渠道</th><th>记录数</th><th>处理状态</th><th>添加时间</th><th></th></tr></thead><tbody>${filtered.map(f=>`<tr class="click-row" data-action="file-detail" data-id="${f.id}" tabindex="0"><td><div class="file-cell"><span class="file-icon ${f.type.toLowerCase()}">${esc(f.type)}</span><div><div class="cell-title">${esc(f.name)}</div><div class="cell-note">${esc(f.size)}<span style="margin:0 7px">·</span>${esc(f.period)}</div></div></div></td><td><span class="flex">${platformMark(f.platform)}${esc(f.platform)}</span></td><td class="num">${data.flows.filter(r=>r.sourceId===f.id).length||'—'}</td><td>${status(f.status,f.status==='pending'?'待识别':null)}${f.status==='error'?`<div class="cell-note" style="margin-top:5px">${esc(f.rule)}</div>`:''}</td><td class="num secondary" style="font-size:11px">${esc(f.importedAt)}</td><td class="right">${ico('chevronRight',14)}</td></tr>`).join('')}</tbody></table>${filtered.length?'':empty('还没有符合条件的材料','可先添加一份示例材料，体验并表和回源操作。',btn('添加示例材料','demo-import','plus'))}</div><div class="table-footer">${filtered.length} 份材料<span style="margin-left:auto">点击文件查看来源与处理详情</span></div></section>`;
  }
  function filteredFlows() {
    return caseFlows().filter(f=>(state.flowTab==='all'||(state.flowTab==='pending'?f.status==='pending':f.balanceStatus==='fail'))&&(state.flowPlatform==='all'||f.platform===state.flowPlatform)&&(!state.sourceId||f.sourceId===state.sourceId)&&(!state.dateFrom||f.time.slice(0,10)>=state.dateFrom)&&(!state.dateTo||f.time.slice(0,10)<=state.dateTo)&&(state.minAmount===''||(f.amount!=null&&f.amount>=Number(state.minAmount)*100))&&(state.maxAmount===''||(f.amount!=null&&f.amount<=Number(state.maxAmount)*100))&&(f.peer+' '+f.account+' '+f.summary+' '+f.time).toLowerCase().includes(state.flowQuery.toLowerCase())).sort((a,b)=>b.time.localeCompare(a.time));
  }
  function flowsPage() {
    const rows=caseFlows(),confirmed=rows.filter(f=>f.status==='confirmed'),filtered=filteredFlows();
    const pages=Math.max(1,Math.ceil(filtered.length/state.pageSize));state.page=Math.min(state.page,pages);
    const page=filtered.slice((state.page-1)*state.pageSize,state.page*state.pageSize),sum=confirmed.reduce((s,f)=>s+(f.amount>0?f.amount:0),0),out=confirmed.reduce((s,f)=>s+(f.amount<0?-f.amount:0),0);
    const selected=rows.filter(f=>state.selected.has(f.id)),selectedSum=selected.filter(f=>f.status==='confirmed').reduce((s,f)=>s+f.amount,0);
    const activeFilters=state.sourceId||state.dateFrom||state.dateTo||state.minAmount!==''||state.maxAmount!=='';
    return `<div class="page-head ledger-heading"><div><h1>流水明细</h1><p class="page-sub">${esc(currentCase().name)}</p><div class="ledger-stats"><span>流水 <b class="num">${rows.length}</b>条</span><span>账户 <b class="num">${new Set(rows.map(f=>f.account)).size}</b>个</span><span class="sep"></span><span>已确认收入 <b class="num">${money(sum)}</b></span><span>已确认支出 <b class="num">${money(out)}</b></span><span>单位：元</span></div></div><div class="page-actions">${btn('材料管理','nav','files','','data-route="materials"')}${btn('导出结果','nav','download','primary','data-route="exports"')}</div></div>
    <section class="panel"><div class="tabs">${[['all','全部流水',rows.length],['pending','金额待核',rows.filter(f=>f.status==='pending').length],['balance','余额差异',rows.filter(f=>f.balanceStatus==='fail').length]].map(([v,l,n])=>`<button class="tab ${state.flowTab===v?'active':''}" data-action="flow-tab" data-value="${v}">${l}<b>${n}</b></button>`).join('')}</div><div class="table-tools">${search('flow-query','搜索对方、账号、摘要',state.flowQuery)}<select id="flow-platform" class="select" aria-label="流水渠道">${options([...new Set(rows.map(f=>f.platform))],state.flowPlatform)}</select>${btn(activeFilters?'筛选中':'更多筛选','filters','filter',activeFilters?'soft':'')}${activeFilters?btn('清除','clear-filters',null,'quiet'):''}<span class="push"></span><button class="icon-btn" data-action="density" aria-label="${state.density?'标准行高':'紧凑行高'}" title="切换表格行高">${ico('list',17)}</button><button class="icon-btn" data-action="refresh-flows" aria-label="重置视图" title="重置视图">${ico('refresh',16)}</button></div>
    ${state.sourceId?`<div class="quiet-note" style="margin:10px 16px">${ico('file',13)}仅查看：${esc(data.files.find(f=>f.id===state.sourceId)?.name||'')}${btn('取消','clear-filters','close','quiet small')}</div>`:''}
    <div class="table-scroll ledger-scroll"><table class="data-table ledger-table"><thead><tr><th style="width:35px"><input type="checkbox" class="check" id="select-page" aria-label="选择本页" ${page.length&&page.every(f=>state.selected.has(f.id))?'checked':''}></th><th>#</th><th>交易时间</th><th>渠道 / 本方账户</th><th>交易对方</th><th>摘要</th><th class="right">金额（元）</th><th class="right">余额（元）</th><th>金额状态</th><th>余额校验</th></tr></thead><tbody>${page.map((f,i)=>`<tr class="click-row ${state.inspected===f.id?'selected':''}" data-action="inspect" data-id="${f.id}" tabindex="0"><td><input type="checkbox" class="check row-check" id="select-${f.id}" data-id="${f.id}" aria-label="选择第 ${(state.page-1)*state.pageSize+i+1} 条流水" ${state.selected.has(f.id)?'checked':''}></td><td class="row-index">${(state.page-1)*state.pageSize+i+1}</td><td class="num secondary">${esc(f.time.slice(0,16))}</td><td><div style="margin-bottom:5px">${esc(f.platform)}</div><div class="account-cell">${esc(f.account)}</div></td><td>${esc(f.peer)}</td><td class="summary-cell" title="${esc(f.summary)}">${esc(f.summary)}</td><td class="right money ${f.amount>0?'positive':f.amount==null?'muted':'negative'}">${money(f.amount,true)}</td><td class="right money secondary">${money(f.balance)}</td><td>${status(f.status)}</td><td>${status(f.balanceStatus)}</td></tr>`).join('')}</tbody></table>${page.length?'':empty('没有符合条件的流水','调整筛选条件，或在材料管理中添加示例材料。')}</div>
    <div class="table-footer"><div class="ledger-bottom"><span>共 <b class="num">${filtered.length}</b> 条</span><span>已选 <b class="num">${selected.length}</b> 条</span>${selected.length?`<span>已确认净额 <b class="num">${money(selectedSum,true)}</b></span>`:''}</div><div class="pagination"><button class="page-num" data-action="page" data-value="${Math.max(1,state.page-1)}" ${state.page===1?'disabled':''} aria-label="上一页">${ico('chevronLeft',13)}</button>${Array.from({length:pages},(_,i)=>`<button class="page-num ${state.page===i+1?'active':''}" data-action="page" data-value="${i+1}">${i+1}</button>`).join('')}<button class="page-num" data-action="page" data-value="${Math.min(pages,state.page+1)}" ${state.page===pages?'disabled':''} aria-label="下一页">${ico('chevronRight',13)}</button><select class="select" id="page-size" aria-label="每页条数" style="min-height:26px;margin-left:8px">${[15,30,50].map(n=>`<option ${n===state.pageSize?'selected':''} value="${n}">${n} 条 / 页</option>`).join('')}</select></div></div></section><div class="quiet-note">${ico('info',13)}待核记录保留原值，金额未确定前不计入收支汇总。点击任一行，可查看规则和原始记录。</div>`;
  }
  function detailRow(label,value) {return `<div class="detail-row"><span class="label">${label}</span><span class="value">${value}</span></div>`;}
  function renderInspector() {
    const f=data.flows.find(f=>f.id===state.inspected);
    if(!f||state.route!=='flows'){$('#inspector').innerHTML='';return;}
    const file=data.files.find(v=>v.id===f.sourceId);
    $('#inspector').innerHTML=`<aside class="inspector" aria-label="流水详情"><div class="inspector-head"><div><h3>流水详情</h3><div class="inspector-sub num">${esc(f.id)} · ${esc(f.time)}</div></div><button class="icon-btn" data-action="close-inspector" aria-label="关闭详情">${ico('close')}</button></div><div class="inspector-body"><div class="detail-group"><h3>交易信息</h3>${detailRow('本方户名',esc(f.owner))}${detailRow('本方账户',esc(f.account))}${detailRow('交易对方',esc(f.peer))}${detailRow('对方账户',esc(f.peerAccount))}${detailRow('交易摘要',esc(f.summary))}</div><div class="detail-group"><h3>金额处理</h3><div class="detail-rule">原始金额 <b class="num">${esc(f.rawAmount)||'（空）'}</b>　原始方向 ${esc(f.rawDirection)}<div class="result num">${money(f.amount,true)} <small>元</small></div>${status(f.status)}<div style="margin-top:8px;color:var(--muted)">${esc(f.rule)}</div></div>${detailRow('余额',money(f.balance)+' 元')}${detailRow('余额校验',status(f.balanceStatus))}</div><div class="detail-group"><h3>记录来源</h3><div class="source-box"><div class="source-name">${esc(file.name)}</div><div class="muted">${esc(f.sourceLoc)}</div>${btn('查看原始记录','source','external','','data-id="'+f.id+'"')}</div></div></div><div class="inspector-foot"><span>${f.status==='pending'||f.balanceStatus==='fail'?'此记录需要人工复核':'金额与余额分别记录状态'}</span>${f.status==='pending'||f.balanceStatus==='fail'?btn('去复核','review-flow','arrowRight','small','data-id="'+f.id+'"'):btn('收起','close-inspector',null,'small')}</div></aside>`;
  }
  function reviewPage() {
    const all=issues(),rows=all.filter(f=>state.reviewTab==='all'||(state.reviewTab==='pending'?f.status==='pending':f.balanceStatus==='fail'));
    const f=rows.find(f=>f.id===state.reviewId)||rows[0];state.reviewId=f?.id||null;
    return `<div class="page-head"><div><h1>异常复核</h1><p class="page-sub">${esc(currentCase().name)}<span style="margin:0 10px">/</span>逐笔确认，保留原始值与处理依据</p></div><div class="page-actions">${btn('查看全部流水','nav','table','','data-route="flows"')}</div></div><div class="review-intro">${ico('info',15)}金额待核与余额差异分开处理。接受余额差异，不会改变交易金额和收付方向。</div>
    <div class="review-layout"><section class="panel"><div class="tabs" style="gap:17px;padding:0 15px">${[['all','全部',all.length],['pending','金额',all.filter(f=>f.status==='pending').length],['balance','余额',all.filter(f=>f.balanceStatus==='fail').length]].map(([v,l,n])=>`<button class="tab ${state.reviewTab===v?'active':''}" data-action="review-tab" data-value="${v}">${l}<b>${n}</b></button>`).join('')}</div><div class="issue-list">${rows.map(r=>`<button class="issue-item ${r.id===f?.id?'active':''}" data-action="select-issue" data-id="${r.id}"><div class="issue-title">${esc(r.peer)}${ico('chevronRight',12)}</div><div class="issue-meta num">${esc(r.time.slice(0,16))}</div><div class="issue-meta">${esc(r.platform)}<span>·</span>${esc(r.account)}</div><div class="issue-foot">${status(r.status==='pending'?'pending':'fail',r.status==='pending'?'金额待核':'余额差异')}<span class="num ${r.amount==null?'muted':''}">${r.amount==null?'原值 '+esc(r.rawAmount||'空'):money(r.amount,true)}</span></div></button>`).join('')}${rows.length?'':empty('此类记录已处理完','可切换上方分类查看其他待办。')}</div></section>
    <section class="panel review-detail">${f?reviewDetail(f):empty('没有需要复核的记录','当前案件的复核队列已清空。可以继续查看流水明细，或导出本次结果。',btn('查看流水','nav','table','','data-route="flows"'))}</section></div>`;
  }
  function reviewDetail(f) {
    const file=data.files.find(v=>v.id===f.sourceId),pending=f.status==='pending';
    return `<div class="review-detail-head"><div class="review-detail-title">${ico(pending?'alert':'receipt',18)}${pending?'确认金额与方向':'核对余额差异'}</div><div class="review-detail-desc">${esc(f.issue)}<br>${esc(file.name)}　${esc(f.sourceLoc)}</div></div><div class="review-detail-body"><div class="spread"><h3>${esc(f.peer)}</h3><span class="num muted" style="font-size:11px">${esc(f.time)}</span></div><div class="compare-grid"><div class="compare-side"><div class="compare-label">来源记录</div><div class="small">方向：${esc(f.rawDirection)}　单位：元</div><div class="compare-amount">${esc(f.rawAmount)||'（空）'}</div></div><div class="compare-side"><div class="compare-label">标准金额</div><div class="small">${pending?'尚未确认，不参与汇总':'金额已确认，保持不变'}</div><div class="compare-amount ${pending?'muted':''}">${pending?'待确认':money(f.amount,true)}</div></div></div><div class="detail-pairs">${detailRow('本方账户',esc(f.account))}${detailRow('交易摘要',esc(f.summary))}${detailRow('金额状态',status(f.status))}${detailRow('余额状态',status(f.balanceStatus))}</div>${pending?`<div class="detail-rule">匹配规则：${esc(f.rule)}<br>请对照来源材料确认金额与方向。缺少金额时，保持待核，避免把空值当作 0。</div>`:`<h3 style="margin-top:20px">余额链对照</h3><div class="math-line"><span class="math-unit"><small>前笔账面余额</small>${money(f.previousBalance)}</span><span>+</span><span class="math-unit"><small>已确认金额</small>${money(f.amount,true)}</span><span>≠</span><span class="math-unit"><small>本笔账面余额</small>${money(f.balance)}</span></div><div class="field-note">差额 ${money(f.balance-f.previousBalance-f.amount)} 元。先检查流水是否完整、余额口径与排序是否正确，再决定是否接受差异。</div>`}<div style="margin-top:18px">${btn('查看原始记录','source','external','','data-id="'+f.id+'"')}</div></div><div class="review-foot"><button class="text-btn" data-action="keep-pending" data-id="${f.id}">保留${pending?'待核':'差异'}，查看下一笔</button>${pending?btn('确认金额与方向','confirm-amount','check','primary','data-id="'+f.id+'"'):btn('接受余额差异','accept-balance','check','primary','data-id="'+f.id+'"')}</div>`;
  }
  function exportRows(scope=state.exportScope,caseId=state.caseId){return caseFlows(caseId).filter(f=>scope==='all'||(scope==='confirmed'?f.status==='confirmed':f.status==='pending'));}
  function exportsPage() {
    const rows=exportRows(),pending=rows.filter(f=>f.status==='pending').length,history=data.exports.filter(e=>e.caseId===state.caseId);
    return `<div class="page-head"><div><h1>结果导出</h1><p class="page-sub">${esc(currentCase().name)}<span style="margin:0 10px">/</span>导出并表结果，并单独列明待核记录</p></div></div><div class="export-layout"><section class="panel"><div class="panel-head"><h2>导出设置</h2><span class="muted" style="font-size:11px">金额单位：元</span></div><div class="form-body"><div class="form-section"><label class="field-label">选择导出范围</label><div class="radio-options">${[['all','全部流水','保留完整记录'],['confirmed','已确认流水','用于收支分析'],['pending','仅金额待核','用于人工复核']].map(([v,l,n])=>`<label class="radio-tile"><input type="radio" id="export-scope-${v}" name="export-scope" value="${v}" ${state.exportScope===v?'checked':''}><span><b>${l}</b><small>${n}</small></span></label>`).join('')}</div><p class="field-note">待核记录的标准金额留空，保留来源金额和方向，不计入金额汇总。</p></div><div class="form-section"><label class="field-label">文件格式</label><div class="radio-options">${[['xlsx','Excel 工作簿','.xlsx · 分类工作表'],['csv','CSV 表格','.csv · 通用文本格式']].map(([v,l,n])=>`<label class="radio-tile"><input type="radio" id="export-format-${v}" name="export-format" value="${v}" ${state.exportFormat===v?'checked':''}><span>${ico(v==='xlsx'?'table':'csv',19)}</span><span><b>${l}</b><small>${n}</small></span></label>`).join('')}</div></div><div class="form-section"><label class="field-label">附加内容</label><label class="form-check"><input id="export-source" type="checkbox" ${state.exportSource?'checked':''}>包含来源文件与原始记录位置</label><p class="field-note">始终保留原始金额、原始方向、金额状态与余额校验状态。</p></div><div class="export-summary"><span>将导出 <strong>${rows.length}</strong> 条，其中金额待核 <strong>${pending}</strong> 条</span>${btn('导出文件','do-export','download','primary',rows.length?'':'disabled')}</div></div></section><aside class="preview-panel"><div class="paper-preview"><div class="paper-kicker">东启勘流 / 并表结果</div><div class="paper-title">${esc(currentCase().name)}</div><div class="paper-subtitle">${state.exportScope==='pending'?'待核清单':'资金流水明细'}　${rows.length} 条记录　单位：元</div><table class="mini-table"><thead><tr><th>日期</th><th>交易对方</th><th>金额</th><th>状态</th></tr></thead><tbody>${rows.slice(0,5).map(f=>`<tr><td class="num">${f.time.slice(5,10)}</td><td>${esc(f.peer.slice(0,5))}</td><td class="num">${money(f.amount,true)}</td><td>${f.status==='pending'?'待核':'已确认'}</td></tr>`).join('')}</tbody></table><div class="paper-footer">${state.exportFormat==='xlsx'?'工作表：流水明细 / 待核清单 / 导出说明':'单表输出，按金额状态区分已确认与待核'}<br>待核金额留空，原始值完整保留。</div></div><div class="preview-note">${ico('eye',12)}内容预览，非打印版式</div></aside></div><div class="section-title"><h2>导出记录 <span class="subcount">${history.length}</span></h2><span class="muted" style="font-size:11px">仅本次示例会话</span></div><section class="panel"><div class="table-scroll"><table class="data-table"><thead><tr><th>文件名称</th><th>导出范围</th><th>记录数</th><th>时间</th><th></th></tr></thead><tbody>${history.map(e=>`<tr><td><span class="flex">${ico('file',16)}${esc(e.name)}</span>${e.seed===false?'':`<div class="cell-note" style="margin:6px 0 0 24px">示例历史 · 按当前数据重新生成</div>`}</td><td class="secondary">${esc(e.scope)}</td><td class="num">${e.rows}</td><td class="num secondary" style="font-size:11px">${esc(e.created)}</td><td class="right"><button class="text-btn" data-action="download-history" data-id="${e.id}">${ico('download',13)}重新下载</button></td></tr>`).join('')}</tbody></table>${history.length?'':empty('还没有导出记录','选择范围后导出，记录会显示在这里。')}</div></section>`;
  }
  function modal(title,body,foot='',wide=false) {
    if(!$('#modal-root').firstChild){
      lastFocus=document.activeElement;
      modalLayers=['application','intro-screen','main','sidebar','topbar','inspector','toast-root','modal-root'].map(id=>{const el=document.getElementById(id);return {el,hidden:el.hidden,inert:el.inert};});
    }
    $('#modal-root').hidden=false;$('#modal-root').inert=false;
    $('#modal-root').innerHTML=`<div class="modal-overlay"><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><h2 id="modal-title">${title}</h2><button class="icon-btn" data-action="close-modal" aria-label="关闭弹窗">${ico('close')}</button></div><div class="modal-body">${body}</div>${foot?`<div class="modal-foot">${foot}</div>`:''}</section></div>`;
    ['application','intro-screen','main','sidebar','topbar','inspector','toast-root'].forEach(id=>document.getElementById(id).inert=true);
    const dialog=$('.modal');
    requestAnimationFrame(()=>{if(!dialog?.isConnected)return;const focus=focusableElements($('.modal-body',dialog))[0]||$('.modal-head button',dialog);focus?.focus();});
  }
  function closeModal(){
    $('#modal-root').innerHTML='';
    modalLayers?.forEach(({el,hidden,inert})=>{el.hidden=hidden;el.inert=inert;});
    modalLayers=null;
    if(lastFocus?.isConnected)lastFocus.focus();
  }
  function canCloseModal(){return !desktop||!desktop.saving&&(!desktop.busy||$('.modal')?.dataset.help==='true');}
  function focusableElements(root){
    return $$('button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]',root).filter(el=>{
      if(el.closest('[hidden],[inert]'))return false;
      for(let parent=el.parentElement;parent&&parent!==root;parent=parent.parentElement){
        if(parent.tagName==='DETAILS'&&!parent.open&&el!==parent.querySelector(':scope > summary'))return false;
      }
      return true;
    });
  }
  function toast(message){const el=document.createElement('div');el.className='toast';el.innerHTML=ico('checkCircle',17)+`<span>${esc(message)}</span>`;$('#toast-root').append(el);setTimeout(()=>el.remove(),3500);}
  function sourceModal(id){
    const f=data.flows.find(r=>r.id===id),file=data.files.find(v=>v.id===f.sourceId),nearby=data.flows.filter(r=>r.sourceId===f.sourceId),at=nearby.indexOf(f);
    modal('原始记录',`<div class="spread" style="margin-bottom:15px"><span>${ico('file',15)} ${esc(file.name)}</span><span class="muted">${esc(f.sourceLoc)}</span></div><div class="source-preview-scroll"><table class="data-table source-preview-table"><thead><tr><th>原始位置</th><th>交易时间</th><th>对方</th><th>原始金额</th><th>原始方向</th><th>摘要</th></tr></thead><tbody>${nearby.slice(Math.max(0,at-1),at+2).map(r=>`<tr class="${r.id===id?'highlight':''}"><td>${esc(r.sourceLoc)}</td><td class="num">${esc(r.time)}</td><td>${esc(r.peer)}</td><td class="num">${esc(r.rawAmount)||'（空）'}</td><td>${esc(r.rawDirection)}</td><td>${esc(r.summary)}</td></tr>`).join('')}</tbody></table></div><div class="quiet-note">${ico('info',13)}此处展示合成样本的来源字段。正式版本将定位到材料中的对应记录。</div>`,btn('关闭','close-modal'),true);
  }
  function newCaseModal(){modal('新建案件',`<div class="field"><label for="new-name">案件名称</label><input id="new-name" class="text-input" maxlength="40" placeholder="例如：某公司资金核查"></div><div class="field"><label for="new-number">案件编号</label><input id="new-number" class="text-input" maxlength="30" placeholder="例如：DQ-2026-019"></div><div class="field"><label for="new-type">案件类型</label><select id="new-type" class="text-input"><option>资金核查</option><option>往来审计</option><option>专项核查</option><option>收支核对</option></select></div><div class="inline-error" id="form-error" role="alert"></div>`,`<span class="footnote">仅保留在本次会话</span>${btn('取消','close-modal')}${btn('创建案件','save-case','check','primary')}`);}
  function fileDetail(id){
    const f=data.files.find(v=>v.id===id),rows=data.flows.filter(r=>r.sourceId===id);
    modal('材料详情',`${detailRow('文件名称',esc(f.name))}${detailRow('文件大小',esc(f.size))}${detailRow('渠道',esc(f.platform))}${detailRow('添加时间',esc(f.importedAt))}${detailRow('处理状态',status(f.status))}${detailRow('并表记录',rows.length+' 条')}${detailRow('格式规则',esc(f.rule))}<div class="quiet-note">${ico('info',13)}${f.status==='ready'?'来源定位保留在每条流水中，可进入流水明细逐笔查看。':'此材料尚未进入并表结果。原型只登记外部文件信息，实际解析将在后续接入。'}</div>`,`${btn('关闭','close-modal')}${rows.length?btn('查看此文件流水','file-flows','table','primary','data-id="'+id+'"'):btn('选择其他文件','pick-files','upload','primary')}`);
  }
  function importModal(queue){
    importQueue=queue;
    modal('登记流水材料',`<p class="secondary" style="margin-bottom:17px">文件将添加到「${esc(currentCase().name)}」。本次只登记名称与大小，不读取文件内容，状态设为待识别。</p>${queue.map(f=>`<div class="queue-item">${ico('file',19)}<div class="grow"><div class="file-name">${esc(f.name)}</div><div class="muted">${(f.size/1024).toFixed(1)} KB</div></div>${status('pending','待登记')}</div>`).join('')}<div class="field-note">要体验完整并表流程，可使用页面上的「添加示例材料」。</div>`,`${btn('取消','close-modal')}${btn('登记 '+queue.length+' 份材料','register-files','check','primary')}`);
  }
  function confirmAmount(id){
    const f=data.flows.find(r=>r.id===id);
    modal('确认金额与方向',`<div class="source-box" style="margin-bottom:18px">${esc(f.peer)}　${esc(f.time)}<br>原始金额：<b class="num">${esc(f.rawAmount)||'（空）'}</b>　原始方向：${esc(f.rawDirection)}</div><div class="field"><label for="review-direction">确认收付方向</label><select id="review-direction" class="text-input"><option value="">请选择，不自动推断</option><option value="income">收入</option><option value="expense">支出</option></select></div><div class="field"><label for="review-amount">确认金额（元，填写绝对值）</label><input id="review-amount" class="text-input num" inputmode="decimal" value="${esc(f.rawAmount.replace(/^[-+]/,''))}" placeholder="例如：100.00"></div><div class="field"><label for="review-reason">确认依据</label><textarea id="review-reason" class="text-input" rows="2" maxlength="200" placeholder="简要记录核对依据"></textarea></div><div class="inline-error" id="form-error" role="alert"></div>`,`<span class="footnote">原始值保持不变</span>${btn('取消','close-modal')}${btn('确认并保存','save-amount','check','primary','data-id="'+id+'"')}`);
  }
  function filterModal(){
    modal('筛选流水',`<div class="filter-fields"><div class="field"><label for="date-from">开始日期</label><input type="date" id="date-from" class="text-input" value="${state.dateFrom}"></div><div class="field"><label for="date-to">结束日期</label><input type="date" id="date-to" class="text-input" value="${state.dateTo}"></div><div class="field"><label for="min-amount">金额下限（元，允许负数）</label><input type="number" step="0.01" id="min-amount" class="text-input" value="${esc(state.minAmount)}"></div><div class="field"><label for="max-amount">金额上限（元，允许负数）</label><input type="number" step="0.01" id="max-amount" class="text-input" value="${esc(state.maxAmount)}"></div></div><div class="field"><label for="filter-source">来源材料</label><select id="filter-source" class="text-input"><option value="">全部材料</option>${caseFiles().map(f=>`<option value="${f.id}" ${f.id===state.sourceId?'selected':''}>${esc(f.name)}</option>`).join('')}</select></div><div class="inline-error" id="form-error" role="alert"></div>`,`${btn('取消','close-modal')}${btn('应用筛选','apply-filters','filter','primary')}`);
  }
  function globalSearch(){
    if(desktop){
      if(desktop.busy||desktop.saving||desktop.loading||desktop.needsWorkspace||desktop.error)return;
      modal('搜索案件',`<input class="text-input" id="global-query" placeholder="输入案件名称或编号" autocomplete="off" aria-label="搜索案件名称或编号"><div class="field-note">${copy.home.searchScope}</div><div id="global-results" class="search-results"><div class="muted" style="padding:12px 0">输入关键字开始搜索。</div></div>`,'',true);return;
    }
    modal('搜索示例案件',`<input class="text-input" id="global-query" placeholder="输入案件名称、对方名称或摘要" autocomplete="off" aria-label="搜索示例案件"><div id="global-results" class="search-results"><div class="muted" style="padding:12px 0">搜索示例案件中的案件与流水。</div></div>`,'',true);
  }
  function renderSearch(q){
    const query=q.trim().toLowerCase();
    if(!query){$('#global-results').innerHTML='<span class="muted">输入关键字开始搜索。</span>';return;}
    if(desktop){
      const cases=data.cases.filter(c=>(c.name+' '+c.number).toLowerCase().includes(query));
      $('#global-results').innerHTML=cases.map(c=>`<button class="search-result" data-action="search-case" data-id="${esc(c.id)}">${ico('folder',19)}<span class="grow"><b>${esc(c.name)}</b><span class="cell-note" style="display:block">${esc(c.number)} / 案件</span></span>${c.available===false?status('error','暂不可用'):ico('arrowRight',14)}</button>`).join('')+(cases.length?'':'<div class="muted">未找到匹配案件。</div>');return;
    }
    const cases=data.cases.filter(c=>(c.name+c.number).toLowerCase().includes(query)),flows=data.flows.filter(f=>(f.peer+f.summary+f.account).toLowerCase().includes(query)).slice(0,8);
    $('#global-results').innerHTML=cases.map(c=>`<button class="search-result" data-action="search-case" data-id="${c.id}">${ico('folder',19)}<span class="grow"><b>${esc(c.name)}</b><span class="cell-note" style="display:block">${esc(c.number)} / 案件</span></span>${ico('arrowRight',14)}</button>`).join('')+flows.map(f=>`<button class="search-result" data-action="search-flow" data-id="${f.id}">${ico('receipt',19)}<span class="grow"><span>${esc(f.peer)} · ${esc(f.summary)}</span><span class="cell-note" style="display:block">${esc(data.cases.find(c=>c.id===f.caseId).name)} / ${esc(f.time)}</span></span><span class="num">${money(f.amount,true)}</span></button>`).join('')+(!cases.length&&!flows.length?'<div class="muted">未找到匹配结果。</div>':'');
  }
  function nextIssue(id){const rows=issues().filter(f=>state.reviewTab==='all'||(state.reviewTab==='pending'?f.status==='pending':f.balanceStatus==='fail')),i=rows.findIndex(f=>f.id===id);state.reviewId=rows[(i+1)%rows.length]?.id||null;}
  function prepareSheets(rows,source){
    const headers=['记录编号','交易时间','渠道','本方账户','本方户名','交易对方','对方账户','标准金额（元）','余额（元）','原始金额文本','原始方向','摘要','金额状态','余额状态','格式规则','金额确认依据','余额处理依据'];if(source)headers.push('来源文件','来源位置');
    const values=f=>{const row=[f.id,f.time,f.platform,f.account,f.owner,f.peer,f.peerAccount,f.amount==null?null:f.amount/100,f.balance==null?null:f.balance/100,f.rawAmount,f.rawDirection,f.summary,f.status==='pending'?'待核':'已确认',({pass:'通过',fail:'余额差异',na:'不适用',manual:'已接受差异'})[f.balanceStatus],f.rule,f.amountReviewReason||'',f.balanceReviewReason||''];if(source)row.push(data.files.find(v=>v.id===f.sourceId).name,f.sourceLoc);return row;};
    return {headers,values};
  }
  function downloadExport(scope=state.exportScope,format=state.exportFormat,source=state.exportSource,history=null){
    const rows=history?.snapshot||exportRows(scope),c=currentCase(),{headers,values}=prepareSheets(rows,source),title=scope==='pending'?'待核清单':scope==='confirmed'?'已确认流水':copy.terms.flows;
    const blob=format==='csv'?window.FUND_EXPORT.csv([headers,...rows.map(values)]):window.FUND_EXPORT.xlsx([{name:copy.terms.flows,rows:[headers,...rows.filter(f=>f.status==='confirmed').map(values)]},{name:'待核清单',rows:[headers,...rows.filter(f=>f.status==='pending').map(values)]},{name:'导出说明',rows:[['项目','内容'],['案件',c.name],['数据性质','合成演示数据'],['范围',title],['记录数',rows.length],['金额已确认',rows.filter(f=>f.status==='confirmed').length],['金额待核',rows.filter(f=>f.status==='pending').length],['金额单位','元；待核金额留空'],['待核说明','待核记录单列于待核清单，不参与收支汇总'],['生成时间',now()]]}]);
    const name=history?.name||`${c.name}_${title}_${new Date().toISOString().slice(0,10).replaceAll('-','')}.${format}`;window.FUND_EXPORT.download(blob,name);
    if(!history)data.exports.unshift({id:'export-'+Date.now(),caseId:state.caseId,name,format,rows:rows.length,scope:{all:'全部流水，含待核清单',confirmed:'仅已确认流水',pending:'仅待核流水'}[scope],scopeKey:scope,includeSource:source,created:now(),status:'done',seed:false,snapshot:JSON.parse(JSON.stringify(rows))});
    render();toast('已生成 '+rows.length+' 条示例记录，请查看浏览器下载。');
  }
  const actions={
    nav:el=>navigate(el.dataset.route),'continue':()=>navigate('flows'),'new-case':newCaseModal,
    'open-case':el=>{resetFlowFilters();navigate('flows',el.dataset.id);},'case-tab':el=>{state.caseTab=el.dataset.value;render();},
    'switch-case':()=>modal('切换案件',`<div class="search-results" style="margin:0">${data.cases.map(c=>`<button class="search-result" data-action="choose-case" data-id="${c.id}">${ico('folder',20)}<span class="grow"><span>${esc(c.name)}</span><span class="cell-note" style="display:block">${esc(c.number)} / ${caseFlows(c.id).length} 条流水</span></span>${c.id===state.caseId?ico('check',17):status(c.status)}</button>`).join('')}</div>`,btn('新建案件','new-case','plus')),
    'choose-case':el=>{closeModal();navigate(state.route,el.dataset.id);},
    'task':el=>{if(el.dataset.kind==='files'){state.fileTab='unresolved';state.filePlatform='all';state.fileQuery='';navigate('materials');}else{state.reviewTab=el.dataset.kind==='amount'?'pending':'balance';state.reviewId=null;navigate('review');}},
    'save-case':()=>{
      const name=$('#new-name').value.trim(),number=$('#new-number').value.trim();if(!name||!number){$('#form-error').textContent='请填写案件名称和编号。';return;}
      if(data.cases.some(c=>c.number===number)){$('#form-error').textContent='此案件编号已存在，请换一个编号。';return;}
      const id='case-'+Date.now();data.cases.unshift({id,name,number,type:$('#new-type').value,status:'active',updated:now(),description:'新建案件，等待导入流水材料。'});closeModal();navigate('materials',id);toast('案件已创建，可以添加材料。');
    },
    'file-tab':el=>{state.fileTab=el.dataset.value;render();},'file-detail':el=>fileDetail(el.dataset.id),
    'file-flows':el=>{resetFlowFilters();state.sourceId=el.dataset.id;closeModal();navigate('flows');},
    'pick-files':()=>{$('#file-picker').value='';$('#file-picker').click();},
    'register-files':()=>{
      importQueue.forEach((f,i)=>data.files.push({id:'file-'+Date.now()+'-'+i,caseId:state.caseId,name:f.name,platform:'未识别',type:f.name.split('.').pop().toUpperCase(),size:(f.size/1024).toFixed(1)+' KB',records:0,accounts:0,period:'待解析',status:'pending',importedAt:now(),rule:'已登记，解析引擎待接入'}));
      const n=importQueue.length;closeModal();state.fileTab='unresolved';state.filePlatform='all';state.fileQuery='';navigate('materials');toast('已登记 '+n+' 份材料，尚未解析内容。');
    },
    'demo-import':()=>modal('添加示例材料',`<div class="queue-item"><span class="file-icon csv">CSV</span><div class="grow"><div class="file-name">示例_补充流水.csv</div><div class="muted">3 条合成流水 · 1 个演示账户</div></div></div><p class="field-note">将添加到「${esc(currentCase().name)}」。数据完全虚构，可体验材料、并表、回源和导出之间的关联。</p>`,`${btn('取消','close-modal')}${btn('添加并查看','add-demo','check','primary')}`),
    'add-demo':()=>{
      const uid=Date.now(),sourceId='demo-file-'+uid;data.files.push({id:sourceId,caseId:state.caseId,name:'示例_补充流水.csv',platform:'建设银行',type:'CSV',size:'1.2 KB',records:3,accounts:1,period:'2026-11-12',status:'ready',importedAt:now(),rule:'演示格式 · v1'});
      let balance=1000000;[128000,-32000,5600].forEach((amount,i)=>{const previousBalance=balance;balance+=amount;data.flows.push({id:'demo-flow-'+uid+'-'+i,caseId:state.caseId,sourceId,sourceLoc:'记录 '+(i+1),time:'2026-11-12 15:0'+i+':00',platform:'建设银行',account:'示例账户 · 尾号 0088',owner:currentCase().name,peer:['示例供货单位','示例办公商户','示例服务单位'][i],peerAccount:'示例对方账户',amount,balance,previousBalance,summary:['补充货款','办公采购','服务退款'][i],txnType:'转账',status:'confirmed',balanceStatus:'pass',rawAmount:(Math.abs(amount)/100).toFixed(2),rawDirection:amount>0?'收入':'支出',rule:'演示格式 · v1',issue:''});});
      closeModal();resetFlowFilters();state.sourceId=sourceId;navigate('flows');toast('示例材料已添加，3 条流水已进入并表。');
    },
    'flow-tab':el=>{state.flowTab=el.dataset.value;state.page=1;state.inspected=null;render();},'page':el=>{state.page=Number(el.dataset.value);state.inspected=null;render();},
    'inspect':el=>{state.inspected=el.dataset.id;render();$('#inspector [data-action="close-inspector"]')?.focus();},'close-inspector':closeInspector,
    'source':el=>sourceModal(el.dataset.id),'review-flow':el=>{state.reviewId=el.dataset.id;state.reviewTab='all';navigate('review');},
    'review-tab':el=>{state.reviewTab=el.dataset.value;state.reviewId=null;render();},'select-issue':el=>{state.reviewId=el.dataset.id;render();},
    'keep-pending':el=>{nextIssue(el.dataset.id);render();toast('处理状态保留，已查看下一笔。');},'confirm-amount':el=>confirmAmount(el.dataset.id),
    'save-amount':el=>{
      const direction=$('#review-direction').value,text=$('#review-amount').value.trim(),reason=$('#review-reason').value.trim();
      if(!direction||!/^\d+(\.\d{1,2})?$/.test(text)||!reason){$('#form-error').textContent='请选择方向，填写非负金额（最多两位小数）和确认依据。';return;}
      const [whole,fraction='']=text.split('.'),cents=Number(whole)*100+Number(fraction.padEnd(2,'0'));if(!Number.isSafeInteger(cents)){$('#form-error').textContent='金额过大，请核对原始记录。';return;}
      const f=data.flows.find(r=>r.id===el.dataset.id);f.amount=direction==='expense'?-cents:cents;f.status='confirmed';f.amountReviewReason=reason;f.issue=f.balanceStatus==='fail'?'金额已人工确认；余额差异仍需单独复核':'';closeModal();state.reviewId=null;render();toast('金额已确认；原始值保留，余额校验单独处理。');
    },
    'accept-balance':el=>modal('接受余额差异',`<p>确认已核查该笔余额差异？接受后，金额和收付方向保持不变，余额状态记为「已接受差异」。</p><div class="field" style="margin-top:18px"><label for="balance-reason">处理依据</label><textarea id="balance-reason" class="text-input" rows="2" maxlength="200" placeholder="例如：已核对原件，该段流水存在缺页"></textarea></div><div id="form-error" class="inline-error" role="alert"></div>`,`${btn('取消','close-modal')}${btn('确认接受','save-balance','check','primary','data-id="'+el.dataset.id+'"')}`),
    'save-balance':el=>{const reason=$('#balance-reason').value.trim();if(!reason){$('#form-error').textContent='请记录接受差异的依据。';return;}const f=data.flows.find(r=>r.id===el.dataset.id);f.balanceStatus='manual';f.balanceReviewReason=reason;closeModal();state.reviewId=null;render();toast('已接受余额差异，交易金额保持不变。');},
    'filters':filterModal,'apply-filters':()=>{
      const from=$('#date-from').value,to=$('#date-to').value,min=$('#min-amount').value,max=$('#max-amount').value;
      if((from&&to&&from>to)||(min!==''&&max!==''&&Number(min)>Number(max))){$('#form-error').textContent='开始值不能大于结束值。';return;}
      Object.assign(state,{dateFrom:from,dateTo:to,minAmount:min,maxAmount:max,sourceId:$('#filter-source').value,page:1});closeModal();render();
    },
    'clear-filters':()=>{resetFlowFilters();render();},'refresh-flows':()=>{resetFlowFilters();state.inspected=null;render();toast('已重置筛选与选择。');},'density':()=>{state.density=!state.density;render();},
    'close-modal':closeModal,'global-search':globalSearch,'intro':()=>{closeModal();window.FUND_INTRO?.show();},
    'search-case':el=>{closeModal();resetFlowFilters();navigate('flows',el.dataset.id);},
    'search-flow':el=>{const f=data.flows.find(r=>r.id===el.dataset.id);closeModal();navigate('flows',f.caseId);resetFlowFilters();state.page=Math.floor(filteredFlows().findIndex(r=>r.id===f.id)/state.pageSize)+1;state.inspected=f.id;render();},
    'do-export':()=>downloadExport(),
    'download-history':el=>{const h=data.exports.find(e=>e.id===el.dataset.id),scope=h.scopeKey||(h.scope.includes('仅待核')?'pending':h.scope.includes('仅已确认')?'confirmed':'all');downloadExport(scope,h.format==='csv'?'csv':'xlsx',h.includeSource!==false,h);},
    'help':desktopHelp
  };
  if(desktop){
    // Keep every demonstration write action unavailable in the production shell.
    Object.keys(actions).forEach(key=>{actions[key]=()=>{};});
    Object.assign(actions,{
      nav:el=>{if(!desktop.busy&&!desktop.saving&&(el.dataset.route==='home'||currentCase()?.available!==false&&currentCase()))navigate(el.dataset.route);},
      'retry-workspace':()=>loadDesktop(),
      'choose-workspace':()=>{if(desktop.locationKnown&&desktop.needsWorkspace){closeModal();if(document.body.classList.contains('intro-visible'))window.FUND_INTRO?.enter();loadDesktop(true);}},
      'new-case':desktopNewCase,'save-case':saveDesktopCase,
      'open-case':el=>openDesktopCase(el.dataset.id),'choose-case':el=>openDesktopCase(el.dataset.id),
      'search-case':el=>openDesktopCase(el.dataset.id),'switch-case':desktopSwitchCase,
      'continue':()=>currentCase()&&openDesktopCase(state.caseId),
      'close-modal':()=>{if(canCloseModal())closeModal();},
      'global-search':globalSearch,'help':desktopHelp,
      'desktop-import':()=>desktopImport(),'desktop-retry-import':el=>desktopImport(el.dataset.id),
      'desktop-reimport-material':el=>desktopImport(el.dataset.id,el.dataset.batch),
      'desktop-export-workpaper':desktopExport,'refresh-data':()=>loadDesktopPage(true),
      'material-flows':el=>{live.source=el.dataset.id;navigate('flows');},
      'desktop-source':el=>desktopSource(el.dataset.id),
      'desktop-relations':desktopRelations,
      'desktop-next':()=>{if(!live.loading&&live.page?.nextCursor){live.history.push(live.cursor);live.cursor=live.page.nextCursor;loadDesktopPage();}},
      'desktop-prev':()=>{if(!live.loading&&live.history.length){live.cursor=live.history.pop();loadDesktopPage();}},
      'intro':()=>{if(!desktop.saving&&!desktop.busy){closeModal();window.FUND_INTRO?.show();}}
    });
  }
  document.addEventListener('click',event=>{
    if(event.target.matches('input,select,textarea,label')||event.target.closest('label'))return;
    const el=event.target.closest('[data-action]');if(el&&!el.disabled)actions[el.dataset.action]?.(el);else if(event.target.classList.contains('modal-overlay')&&canCloseModal())closeModal();
  });
  function closeInspector(){const id=state.inspected;state.inspected=null;render();$$('tr[data-action="inspect"]').find(el=>el.dataset.id===id)?.focus({preventScroll:true});}
  let composing=false;
  function handleInput(el){
    const map={'case-query':'caseQuery','file-query':'fileQuery','flow-query':'flowQuery'};
    if(map[el.id]){const caret=el.selectionStart;state[map[el.id]]=el.value;state.page=1;render();const replacement=document.getElementById(el.id);replacement.focus();replacement.setSelectionRange(caret,caret);}
    if(el.id==='global-query')renderSearch(el.value);
  }
  document.addEventListener('compositionstart',()=>{composing=true;});
  document.addEventListener('compositionend',event=>{composing=false;handleInput(event.target);});
  document.addEventListener('input',event=>{if(!event.isComposing&&!composing)handleInput(event.target);});
  document.addEventListener('change',event=>{
    const el=event.target,map={'file-platform':'filePlatform','flow-platform':'flowPlatform','page-size':'pageSize'};
    if(desktop&&['desktop-source','desktop-status'].includes(el.id)){if(el.id==='desktop-source')live.source=el.value;else live.filter=el.value;loadDesktopPage(true);return;}
    if(map[el.id]){state[map[el.id]]=el.id==='page-size'?Number(el.value):el.value;state.page=1;render();}
    if(el.classList.contains('row-check')){el.checked?state.selected.add(el.dataset.id):state.selected.delete(el.dataset.id);render();}
    if(el.id==='select-page'){filteredFlows().slice((state.page-1)*state.pageSize,state.page*state.pageSize).forEach(f=>el.checked?state.selected.add(f.id):state.selected.delete(f.id));render();}
    if(el.id==='startup-intro'){if(!window.FUND_INTRO?.setSkip(!el.checked)){el.checked=!window.FUND_INTRO?.shouldSkip();el.disabled=true;toast(copy.intro.preferenceUnavailable);}}
    if(el.name==='export-scope'){state.exportScope=el.value;render();}if(el.name==='export-format'){state.exportFormat=el.value;render();}if(el.id==='export-source'){state.exportSource=el.checked;render();}
    if(el.id==='file-picker'&&el.files.length)handleFiles(Array.from(el.files));
  });
  function handleFiles(files){if(desktop){toast(copy.feedback.blockedImport);return;}const allowed=files.filter(f=>/\.(xlsx?|csv|txt)$/i.test(f.name));if(!allowed.length){toast('请选择 Excel、CSV 或 TXT 文件。');return;}if(allowed.length!==files.length)toast('已跳过不支持的文件类型。');importModal(allowed);}
  document.addEventListener('dragover',event=>{if(desktop){event.preventDefault();return;}if(event.target.closest('#drop-zone')){event.preventDefault();$('#drop-zone').classList.add('dragging');}});
  document.addEventListener('dragleave',event=>{if(event.target.closest('#drop-zone'))$('#drop-zone').classList.remove('dragging');});
  document.addEventListener('drop',event=>{if(desktop){event.preventDefault();toast(copy.feedback.blockedImport);return;}if(event.target.closest('#drop-zone')){event.preventDefault();$('#drop-zone').classList.remove('dragging');handleFiles(Array.from(event.dataTransfer.files));}});
  document.addEventListener('keydown',event=>{
    const dialog=$('.modal');
    if(dialog){
      if(event.key==='Escape'){if(canCloseModal()){event.preventDefault();closeModal();}return;}
      if(event.key==='Tab'){
        const focusable=focusableElements(dialog),first=focusable[0],last=focusable.at(-1);
        if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first?.focus();}
      }
      return;
    }
    if(document.body.classList.contains('intro-visible'))return;
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();globalSearch();return;}
    if(event.key==='Escape'){if(desktop&&(desktop.busy||desktop.saving))return;if(state.inspected)closeInspector();return;}
    const row=event.target.closest('tr[data-action]');if(row&&event.target===row&&['Enter',' '].includes(event.key)){event.preventDefault();actions[row.dataset.action]?.(row);}
  });
  window.addEventListener('hashchange',()=>{const route=location.hash.slice(1);if(desktop&&(desktop.busy||desktop.saving))return;if(labels[route]&&route!==state.route){navigate(route);}});
  document.addEventListener('fundsift:enter-workspace',()=>navigate('home'));
  document.addEventListener('fundsift:show-intro',()=>{closeModal();state.inspected=null;renderInspector();$('#toast-root').replaceChildren();});
  document.addEventListener('fundsift:resume-workspace',()=>render());
  if(!desktop&&labels[location.hash.slice(1)])state.route=location.hash.slice(1);
  if(desktop&&typeof desktopBridge.onOperationStatus==='function'){
    const panel=document.createElement('div');
    panel.id='desktop-operation-status';panel.className='desktop-operation-status';panel.hidden=true;
    panel.setAttribute('role','status');panel.setAttribute('aria-live','polite');panel.setAttribute('aria-atomic','true');
    $('#feedback-root').prepend(panel);
    const unsubscribe=desktopBridge.onOperationStatus(showOperationStatus);
    window.addEventListener('pagehide',()=>{if(typeof unsubscribe==='function')unsubscribe();desktopOperations.clear();panel.remove();},{once:true});
  }
  render();
  if(desktop)loadDesktop();
}());
