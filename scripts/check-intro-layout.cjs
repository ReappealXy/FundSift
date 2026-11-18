'use strict';
// Run: node node_modules/electron/cli.js scripts/check-intro-layout.cjs
// Uses standalone Electron offscreen rendering, never the Codex browser.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const out=path.join(root,'artifacts/m0-hardening-intro');
fs.mkdirSync(out,{recursive:true});
app.setPath('userData',path.join(out,'profile'));
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed',()=>{});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  const results=[];let win;
  try{
    for(const [width,height] of [[1024,720],[1440,960],[1920,1080],[390,844]]){
      win=new BrowserWindow({width,height,show:false,autoHideMenuBar:true,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
      win.removeMenu();await win.loadFile(path.join(root,'code/prototype/index.html'));await pause(120);
      const metrics=await win.webContents.executeJavaScript(`(()=>{
        const screen=document.querySelector('#intro-screen');const frame=document.querySelector('.intro-frame');
        const rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}};
        const items=[...document.querySelectorAll('.intro-header,.intro-copy,.intro-capabilities,.intro-workflow,.intro-footer')].map(e=>({class:e.className,...rect(e)}));
        const art=rect(document.querySelector('.intro-flow-art'));
        screen.scrollTop=100;window.scrollTo(0,100);
        return {viewport:{width:innerWidth,height:innerHeight},screen:{clientHeight:screen.clientHeight,scrollHeight:screen.scrollHeight,scrollTop:screen.scrollTop,overflow:getComputedStyle(screen).overflow},pageScroll:scrollY,frame:rect(frame),items,art};
      })()`);
      assert.equal(metrics.screen.scrollTop,0,'intro must not be scrollable');assert.equal(metrics.pageScroll,0);
      for(const r of metrics.items){assert.ok(r.top>=-1&&r.bottom<=metrics.viewport.height+1,JSON.stringify({width,height,overflow:r}));assert.ok(r.left>=-1&&r.right<=metrics.viewport.width+1);}
      assert.equal(metrics.screen.clientHeight,metrics.screen.scrollHeight,'no clipped vertical content');
      await fs.promises.writeFile(path.join(out,`intro-${width}x${height}.png`),(await win.webContents.capturePage()).toPNG());
      results.push({width,height,metrics});
      if(width===1440){
        await win.webContents.executeJavaScript('document.querySelector("#enter-workspace").click()');await pause(360);
        const mid=await win.webContents.executeJavaScript(`({transition:document.body.classList.contains('intro-departing'),art:getComputedStyle(document.querySelector('.intro-art-bank')).transform,inert:document.querySelector('#application').inert,animations:document.getAnimations().map(a=>({name:a.animationName,time:a.currentTime,state:a.playState})),style:getComputedStyle(document.querySelector('.intro-art-bank')).animation})`);
        assert.ok(mid.transition&&mid.inert&&mid.art!=='none'&&mid.art!=='matrix(1, 0, 0, 1, 0, 0)',JSON.stringify(mid));
        await fs.promises.writeFile(path.join(out,'transition-360ms.png'),(await win.webContents.capturePage()).toPNG());
        await pause(290);
        const reveal=await win.webContents.executeJavaScript(`({parts:[...document.querySelectorAll('#main>.page>*')].map(e=>({class:e.className,opacity:Number(getComputedStyle(e).opacity),delay:getComputedStyle(e).animationDelay}))})`);
        assert.ok(reveal.parts.length>=3&&reveal.parts[0].opacity>reveal.parts[2].opacity,'workspace information reveals in sequence');
        await fs.promises.writeFile(path.join(out,'transition-650ms.png'),(await win.webContents.capturePage()).toPNG());
        await pause(560);
        const done=await win.webContents.executeJavaScript(`({hidden:document.querySelector('#intro-screen').hidden,inert:document.querySelector('#application').inert,focused:document.activeElement.id})`);
        assert.deepEqual(done,{hidden:true,inert:false,focused:'main'});
        await fs.promises.writeFile(path.join(out,'workspace.png'),(await win.webContents.capturePage()).toPNG());
        results.push({transition:{mid,reveal,done}});
      }
      win.destroy();win=null;
    }
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({ok:true,results},null,2));console.log('PASS: fitted introduction at 4 window sizes, animated mid-frame, completion and keyboard focus');
  }catch(error){fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({ok:false,error:error.stack,results},null,2));console.error(error);process.exitCode=1;}
  finally{if(win)win.destroy();app.exit(process.exitCode||0);}
});
