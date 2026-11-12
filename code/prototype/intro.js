(function () {
  'use strict';
  const preferenceKey='fundsift.skipIntro.v1';
  const intro=document.getElementById('intro-screen');
  const application=document.getElementById('application');
  const skipLink=document.getElementById('workspace-skip-link');
  const checkbox=document.getElementById('skip-intro');
  const note=document.getElementById('intro-preference-note');
  const theme=document.querySelector('meta[name="theme-color"]');
  const introRoute=hash=>/^#intro(?:$|-(?:top|capabilities|workflow)$)/.test(hash);
  const floatingUI=['inspector','modal-root','toast-root'];
  let remember=true, skip=false, entered=false;
  try {
    skip=window.localStorage.getItem(preferenceKey)==='true';
    // Verify that this browser permits writing before offering a saved preference.
    const probe=preferenceKey+'.probe';
    window.localStorage.setItem(probe,'1');
    window.localStorage.removeItem(probe);
  } catch (_) {remember=false;skip=false;}

  function syncPreference(){
    checkbox.checked=skip;
    checkbox.disabled=!remember;
    note.textContent=remember?'可在工作台「使用说明」中随时恢复':'当前浏览器无法保存启动偏好，每次打开将显示介绍页。';
  }
  function setSkip(value){
    if(!remember)return false;
    try {window.localStorage.setItem(preferenceKey,String(Boolean(value)));skip=Boolean(value);syncPreference();return true;}
    catch (_) {remember=false;skip=false;syncPreference();return false;}
  }
  function show(options={}){
    const isStartup=options.startup===true;
    document.dispatchEvent(new CustomEvent('fundsift:show-intro'));
    application.hidden=true;application.inert=true;skipLink.hidden=true;
    floatingUI.forEach(id=>{const el=document.getElementById(id);el.hidden=true;el.inert=true;});
    intro.hidden=false;intro.inert=false;
    document.body.classList.add('intro-visible');
    document.title='东启勘流 · 资金流水分析';theme.setAttribute('content','#ffffff');
    syncPreference();intro.scrollTop=0;
    if(!isStartup){location.hash='intro';document.getElementById('intro-title').focus({preventScroll:true});}
  }
  function activateWorkspace(){
    intro.hidden=true;intro.inert=true;
    application.hidden=false;application.inert=false;skipLink.hidden=false;
    floatingUI.forEach(id=>{const el=document.getElementById(id);el.hidden=false;el.inert=false;});
    document.body.classList.remove('intro-visible');theme.setAttribute('content','#203e5f');
    entered=true;
  }
  function enter(){
    const requestedSkip=checkbox.checked;
    const saved=setSkip(requestedSkip);
    activateWorkspace();
    document.dispatchEvent(new CustomEvent('fundsift:enter-workspace'));
    document.getElementById('main').focus({preventScroll:true});
    if(requestedSkip&&!saved){
      const message=document.createElement('div');message.className='toast';
      message.textContent='已进入工作台。浏览器未能保存选择，下次仍会显示介绍页。';
      document.getElementById('toast-root').append(message);setTimeout(()=>message.remove(),5500);
    }
  }
  document.getElementById('enter-workspace').addEventListener('click',enter);
  window.FUND_INTRO={show,enter,setSkip,shouldSkip:()=>skip,canRemember:()=>remember,isVisible:()=>!intro.hidden};
  window.addEventListener('hashchange',()=>{
    if(introRoute(location.hash)&&intro.hidden){
      show({startup:true});document.getElementById(location.hash.slice(1))?.scrollIntoView?.();
    }
    else if(entered&&!intro.hidden&&/^#(home|materials|flows|review|exports)$/.test(location.hash)){
      activateWorkspace();document.dispatchEvent(new CustomEvent('fundsift:resume-workspace'));
    }
  });
  syncPreference();
  if(skip&&!introRoute(location.hash)){
    activateWorkspace();document.dispatchEvent(new CustomEvent('fundsift:enter-workspace'));
  }else show({startup:true});
}());
