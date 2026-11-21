(function () {
  'use strict';
  const preferenceKey='fundsift.skipIntro.v1';
  const intro=document.getElementById('intro-screen');
  const application=document.getElementById('application');
  const skipLink=document.getElementById('workspace-skip-link');
  const checkbox=document.getElementById('skip-intro');
  const note=document.getElementById('intro-preference-note');
  const theme=document.querySelector('meta[name="theme-color"]');
  const enterButton=document.getElementById('enter-workspace');
  const copy=window.FUND_COPY.intro;
  const text=(selector,value)=>intro.querySelector(selector).textContent=value;
  text('[data-intro-edition]',copy.edition);
  text('[data-intro-description]',copy.description);
  text('[data-intro-status]',copy.status);
  text('#enter-workspace > span',copy.enter);
  text('#intro-help',copy.help);
  text('[data-intro-footer]',copy.footer);
  intro.dataset.ready='true';
  const introRoute=hash=>/^#intro(?:$|-(?:top|capabilities|workflow)$)/.test(hash);
  const floatingUI=['inspector','modal-root','toast-root'];
  let remember=true, skip=false, entered=false, entering=false, transitionTimer;
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
    note.hidden=remember;
    note.textContent=remember?'':copy.preferenceUnavailable;
  }
  function setSkip(value){
    if(!remember)return false;
    try {window.localStorage.setItem(preferenceKey,String(Boolean(value)));skip=Boolean(value);syncPreference();return true;}
    catch (_) {remember=false;skip=false;syncPreference();return false;}
  }
  function show(options={}){
    const isStartup=options.startup===true;
    clearTimeout(transitionTimer);entering=false;enterButton.disabled=false;
    document.body.classList.remove('intro-transition','intro-departing');
    document.dispatchEvent(new CustomEvent('fundsift:show-intro'));
    application.hidden=true;application.inert=true;skipLink.hidden=true;
    floatingUI.forEach(id=>{const el=document.getElementById(id);el.hidden=true;el.inert=true;});
    intro.hidden=false;intro.inert=false;
    document.body.classList.add('intro-visible');
    document.title='东启勘流 · 资金流水分析';theme.setAttribute('content','#f2f0ea');
    syncPreference();intro.scrollTop=0;
    if(!isStartup){location.hash='intro';document.getElementById('intro-title').focus({preventScroll:true});}
  }
  function activateWorkspace(){
    clearTimeout(transitionTimer);entering=false;enterButton.disabled=false;
    intro.hidden=true;intro.inert=true;
    application.hidden=false;application.inert=false;skipLink.hidden=false;
    floatingUI.forEach(id=>{const el=document.getElementById(id);el.hidden=false;el.inert=false;});
    document.body.classList.remove('intro-visible','intro-transition','intro-departing');theme.setAttribute('content','#203e5f');
    entered=true;
  }
  function enter(){
    if(entering||intro.hidden)return;
    const requestedSkip=checkbox.checked;
    const saved=setSkip(requestedSkip);
    const finish=()=>{
      activateWorkspace();
      document.getElementById('main').focus({preventScroll:true});
      if(requestedSkip&&!saved){
        const message=document.createElement('div');message.className='toast';
        message.textContent=copy.preferenceFailed;
        document.getElementById('toast-root').append(message);setTimeout(()=>message.remove(),5500);
      }
    };
    // Reduced motion and DOM-only environments enter immediately. Startup skip also stays instant.
    const animate=typeof window.matchMedia==='function'&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if(animate){
      entering=true;enterButton.disabled=true;intro.inert=true;
      application.hidden=false;application.inert=true;
      document.body.classList.add('intro-transition');
      // Commit the visible layer before starting the fade.
      void intro.offsetWidth;
      document.body.classList.add('intro-departing');
    }
    document.dispatchEvent(new CustomEvent('fundsift:enter-workspace'));
    if(animate)transitionTimer=setTimeout(finish,320);else finish();
  }
  enterButton.addEventListener('click',enter);
  window.FUND_INTRO={show,enter,setSkip,shouldSkip:()=>skip,canRemember:()=>remember,isVisible:()=>!intro.hidden};
  window.addEventListener('hashchange',()=>{
    if(entering)return;
    if(introRoute(location.hash)&&intro.hidden){
      show({startup:true});
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
