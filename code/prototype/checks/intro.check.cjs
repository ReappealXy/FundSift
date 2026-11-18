/* Startup and preference integration checks; runs locally in jsdom, no browser. */
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),key='fundsift.skipIntro.v1';
let passed=0;
function verify(condition,message){assert.ok(condition,message);passed++;}
function setup({skip=null,storage='ok',hash='',reducedMotion=null}={}){
  const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{runScripts:'outside-only',pretendToBeVisual:true,url:'https://fundsift.example/'+hash});
  const w=dom.window;w.TextEncoder=TextEncoder;w.Blob=Blob;
  if(reducedMotion!==null)w.matchMedia=()=>({matches:reducedMotion});
  if(skip!==null)w.localStorage.setItem(key,skip);
  if(storage==='blocked')Object.defineProperty(w,'localStorage',{get(){throw new w.DOMException('Storage disabled','SecurityError');}});
  if(storage==='readonly'){const storageProxy={getItem:k=>k===key?skip:null,setItem(){throw new w.DOMException('Quota exceeded','QuotaExceededError');},removeItem(){}};Object.defineProperty(w,'localStorage',{value:storageProxy});}
  for(const file of ['icons.js','data.js','exporter.js','copy.js','app.js','intro.js'])w.eval(fs.readFileSync(path.join(root,file),'utf8'));
  const $=s=>w.document.querySelector(s);
  const click=s=>{assert.ok($(s),s);$(s).click();};
  const action=name=>click('[data-action="'+name+'"]');
  return {dom,w,$,click,action};
}
async function main(){
  let t=setup();
  verify(!t.$('#intro-screen').hidden&&t.$('#application').hidden,'First open shows introduction');
  verify(t.$('#application').inert&&!t.$('#intro-screen').inert,'Hidden workspace is inert');
  verify(t.w.document.title==='东启勘流 · 资金流水分析','Introduction has proper title');
  verify(!t.$('#skip-intro').checked&&!t.$('#skip-intro').disabled,'Skip unchecked by default');
  t.w.document.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));verify(!t.$('.modal'),'Workspace shortcuts inactive on introduction');
  verify(!t.$('#intro-screen').textContent.includes('235万'),'Introduction makes no fabricated scale claims');
  t.$('#skip-intro').checked=true;verify(t.w.localStorage.getItem(key)===null,'Checking alone does not persist before entering');
  t.click('#enter-workspace');
  verify(t.$('#intro-screen').hidden&&!t.$('#application').hidden,'Enter displays workspace');
  verify(t.$('#intro-screen').inert&&!t.$('#application').inert,'Workspace and intro inert states switch');
  verify(t.$('#main h1').textContent==='案件工作台','Enter goes to case workbench');
  verify(t.w.document.activeElement.id==='main','Keyboard focus enters workspace');
  verify(t.w.localStorage.getItem(key)==='true','Skip preference saved');
  verify(t.w.document.title==='东启勘流 · 案件工作台','Workspace title restored');
  t.action('help');verify(!t.$('#startup-intro').checked,'Help reflects saved skip preference');
  t.action('intro');verify(!t.$('#intro-screen').hidden&&!t.$('.modal'),'Help reopens introduction and closes modal');
  verify(t.$('#skip-intro').checked,'Reopened intro reflects saved preference');
  verify(t.w.document.activeElement.id==='intro-title','Reopened intro receives focus');
  t.$('#skip-intro').checked=false;t.click('#enter-workspace');verify(t.w.localStorage.getItem(key)==='false','Unchecking restores introduction on next launch');
  t.action('help');verify(t.$('#startup-intro').checked,'Startup setting reflects restoration');
  t.click('#startup-intro');verify(t.w.localStorage.getItem(key)==='true','Help can enable skip');
  t.click('#startup-intro');verify(t.w.localStorage.getItem(key)==='false','Help can restore startup intro');
  t.action('close-modal');t.dom.window.close();
  t=setup({skip:'true',hash:'#flows'});verify(t.$('#intro-screen').hidden&&t.$('#main h1').textContent==='案件工作台','Saved skip opens workbench even from prior route');t.dom.window.close();
  t=setup({skip:'false'});verify(!t.$('#intro-screen').hidden,'Restored preference survives a fresh document');t.dom.window.close();
  t=setup({skip:'true',hash:'#intro'});verify(!t.$('#intro-screen').hidden,'Explicit intro route permits revisiting with skip saved');t.dom.window.close();
  t=setup({skip:'true',hash:'#intro-workflow'});verify(!t.$('#intro-screen').hidden,'Intro section bookmark overrides skip');t.dom.window.close();
  t=setup({skip:'invalid'});verify(!t.$('#intro-screen').hidden,'Unexpected preference value safely shows intro');t.dom.window.close();
  for(const storage of ['blocked','readonly']){
    t=setup({skip:'true',storage});verify(!t.$('#intro-screen').hidden&&t.$('#skip-intro').disabled,storage+' storage shows intro with preference disabled');
    verify(t.$('#intro-preference-note').textContent.includes('无法保存'),'Storage limit is explained');
    t.click('#enter-workspace');verify(!t.$('#application').hidden,'Entry works without storage');
    t.action('help');verify(t.$('#startup-intro').disabled,'Help respects unavailable storage');t.dom.window.close();
  }
  // Storage can become unavailable after initialization; entry must remain usable.
  t=setup();t.$('#skip-intro').checked=true;Object.defineProperty(t.w,'localStorage',{get(){throw new Error('Storage lost');}});t.click('#enter-workspace');
  verify(!t.$('#application').hidden&&t.$('#toast-root').textContent.includes('未能保存'),'Mid-session storage failure does not block entry');
  t.dom.window.close();
  t=setup();t.click('#enter-workspace');t.click('#sidebar [data-route="flows"]');t.action('inspect');t.action('help');t.action('intro');
  verify(t.$('#inspector').hidden&&!t.$('.inspector'),'Introduction clears and hides flow inspector');
  verify(t.$('#modal-root').hidden&&!t.$('.modal'),'Introduction closes and hides workspace dialogs');
  verify(t.$('#toast-root').hidden,'Workspace notifications do not float over introduction');
  t.click('#enter-workspace');verify(!t.$('#modal-root').hidden&&!t.$('#inspector').hidden,'Floating UI containers restored on entry');
  t.action('help');verify(!!t.$('.modal'),'Dialogs still work after returning');
  t.w.location.hash='intro-capabilities';t.w.dispatchEvent(new t.w.HashChangeEvent('hashchange'));
  verify(!t.$('#intro-screen').hidden&&!t.$('.modal'),'Back to intro section closes workspace overlays');
  t.w.location.hash='home';t.w.dispatchEvent(new t.w.HashChangeEvent('hashchange'));
  verify(t.$('#intro-screen').hidden&&t.w.document.title==='东启勘流 · 案件工作台','Forward to workspace restores screen and title');
  t.dom.window.close();
  t=setup({reducedMotion:false});let entries=0;
  t.w.document.addEventListener('fundsift:enter-workspace',()=>entries++);
  t.click('#enter-workspace');
  verify(t.w.document.body.classList.contains('intro-departing'),'Entry starts the staged transition');
  verify(!t.$('#application').hidden&&t.$('#application').inert&&t.$('#intro-screen').inert,'Both layers remain inert during transition');
  verify(t.$('#enter-workspace').disabled,'Entry button cannot repeat during transition');
  t.w.FUND_INTRO.enter();verify(entries===1,'Repeated entry does not restart the transition');
  await new Promise(resolve=>setTimeout(resolve,1160));
  verify(t.$('#intro-screen').hidden&&!t.$('#application').inert&&!t.w.document.body.classList.contains('intro-transition'),'Transition finishes and restores workspace interaction');
  verify(t.w.document.activeElement.id==='main','Animated entry moves focus after transition');
  t.w.FUND_INTRO.show();t.click('#enter-workspace');t.w.FUND_INTRO.show();
  await new Promise(resolve=>setTimeout(resolve,1160));
  verify(!t.$('#intro-screen').hidden&&t.$('#application').hidden&&!t.$('#enter-workspace').disabled,'Returning to introduction cancels a pending transition');
  t.dom.window.close();
  t=setup({reducedMotion:true});t.click('#enter-workspace');
  verify(t.$('#intro-screen').hidden&&!t.w.document.body.classList.contains('intro-departing'),'Reduced motion enters immediately');t.dom.window.close();
  console.log('PASS: '+passed+' introduction and startup preference assertions');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
