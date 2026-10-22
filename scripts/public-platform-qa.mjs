#!/usr/bin/env node
// Real browser execution on an anonymous, guarded HTTPS fixture, not deployment.
import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {fixtureTlsEnvironment,startPublicFixture} from './certification/public-fixture.mjs';
import {fingerprint,freePort} from './certification/core.mjs';
import {eventually} from './phase4-fixture.mjs';
const root=resolve(import.meta.dirname,'..'),output=resolve(process.env.PUBLIC_QA_ARTIFACT_DIR??`.artifacts/release-closure/public-${Date.now()}`);mkdirSync(output,{recursive:true});
const tls=fixtureTlsEnvironment('TCG_PUBLIC_CERT');
if(tls.reexec){const r=spawnSync(process.execPath,[import.meta.filename,...process.argv.slice(2)],{stdio:'inherit',env:{...tls.reexec,PUBLIC_QA_ARTIFACT_DIR:output}});process.exit(r.status??1);}
const git=(...a)=>execFileSync('git',a,{cwd:root,encoding:'utf8'}).trim();
const source={sha:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),fingerprint:fingerprint(root),clean:!git('status','--porcelain')};
const results=[];let fixture,browser,driver,session,adb,serial,forwardPort;
const adbRun=(...args)=>execFileSync(adb,['-s',serial,...args],{timeout:30000,encoding:'utf8'});
const screenshot=name=>writeFileSync(join(output,name+'.png'),execFileSync(adb,['-s',serial,'exec-out','screencap','-p'],{timeout:15000}));
let nativeStep=0;
function hierarchy(){adbRun('shell','uiautomator','dump','/sdcard/tcg-public-pwa.xml');const xml=adbRun('shell','cat','/sdcard/tcg-public-pwa.xml');assert.ok(xml.includes('<hierarchy'));writeFileSync(join(output,`native-${++nativeStep}.xml`),xml);return xml;}
function tap(xml,labels){for(const label of labels){const node=[...xml.matchAll(/<node\b[^>]*>/g)].map(m=>m[0]).find(n=>n.includes(`text="${label}"`)||n.includes(`content-desc="${label}"`));if(!node)continue;const b=node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);if(!b)continue;const [x,y,r,bottom]=b.slice(1).map(Number);if(r<=x||bottom<=y)continue;adbRun('shell','input','tap',String(Math.round((x+r)/2)),String(Math.round((y+bottom)/2)));return label;}return null;}
async function record(name,fn){const start=Date.now();try{const evidence=await fn();results.push({name,status:'PASS',exitCode:0,durationMs:Date.now()-start,evidence});}catch(error){results.push({name,status:error.code==='EXTERNAL_GUI'?'BLOCKED':'FAIL',exitCode:error.code==='EXTERNAL_GUI'?2:1,durationMs:Date.now()-start,error:String(error.message).replaceAll(fixture?.entry??'NEVER_MATCH','[private entry]')});throw error;}}
async function row(){return (await fixture.serverRows()).find(r=>r.id==='qa-block');}
async function connectAndroid(){await eventually(async()=>{try{return (await fetch(`http://127.0.0.1:${forwardPort}/json/version`)).ok;}catch{return false;}},{timeout:30000});browser=await chromium.connectOverCDP(`http://127.0.0.1:${forwardPort}`);return browser.contexts()[0];}
async function targetStates(){
 const targets=await(await fetch(`http://127.0.0.1:${forwardPort}/json/list`)).json();const rows=[];
 for(const target of targets.filter(t=>t.type==='page'&&t.url.startsWith(fixture.base))){
  assert.ok(target.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${forwardPort}/`));
  let value;try{value=await new Promise((resolve,reject)=>{const ws=new WebSocket(target.webSocketDebuggerUrl);const timer=setTimeout(()=>{ws.close();reject(new Error('Owned target evaluation timed out'));},5000);ws.onopen=()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:'JSON.stringify({standalone:matchMedia("(display-mode: standalone)").matches,modes:["standalone","minimal-ui","fullscreen","browser"].filter(v=>matchMedia("(display-mode: "+v+")").matches),ready:document.readyState,hasAccount:!!localStorage.getItem("ws_uid"),bodyLength:document.body?.innerText.length})',returnByValue:true}}));ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.id===1){clearTimeout(timer);ws.close();r.error?reject(new Error('Owned target evaluation failed')):resolve(JSON.parse(r.result.result.value));}};ws.onerror=()=>{clearTimeout(timer);reject(new Error('Owned target connection failed'));};});}catch(error){value={observationError:error.message};}
  rows.push({id:target.id,url:target.url,...value});
 }
 writeFileSync(join(output,'standalone-target-states.json'),JSON.stringify(rows,null,2));return rows;
}
async function observedStandalonePage(){
 for(const context of browser.contexts())for(const p of context.pages()){
  if(!p.url().startsWith(fixture.base))continue;
  let timer;
  const value=await Promise.race([p.evaluate(()=>matchMedia('(display-mode: standalone)').matches).catch(()=>false),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),3000);})]);clearTimeout(timer);
  if(value)return p;
 }
 return false;
}
async function standalone(){
 // A background Chrome tab can freeze while the native launcher owns focus.
 // Bound every target read and require real display-mode proof, not AX geometry.
 if(!(await targetStates()).some(t=>t.standalone))return false;
 let page=await observedStandalonePage();if(page)return page;
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${forwardPort}`);
 return observedStandalonePage();
}
try {
 fixture=await startPublicFixture({output,tls});
 if(process.argv.includes('--android')){
  const owned=JSON.parse(readFileSync(process.env.QA_ANDROID_OWNERSHIP??'','utf8'));serial=process.env.QA_ANDROID_SERIAL;adb=process.env.ANDROID_ADB;
  assert.equal(owned.serial,serial);assert.equal(owned.physical,false);assert.equal(owned.existingAvdsUntouched,true);assert.match(basename(owned.avdHome),/^tcg-qa-avd-/);assert.equal(realpathSync(resolve(owned.avdHome,'..')),realpathSync(tmpdir()));process.kill(owned.pid,0);assert.match(serial,/^emulator-\d+$/);assert.ok(adb?.endsWith('/platform-tools/adb'));
  adbRun('shell','am','force-stop','com.microsoft.playwright.androiddriver');adbRun('shell','am','force-stop','com.android.chrome');adbRun('shell','pm','clear','com.android.chrome');adbRun('shell','wm','size','720x1280');adbRun('shell','wm','density','320');
  const flags='_ --remote-debugging-socket-name=tcg_public_devtools_remote --disable-fre --no-first-run';
  adbRun('shell',`echo ${Buffer.from(flags).toString('base64')} | base64 -d > /data/local/tmp/chrome-command-line`);
  adbRun('shell','am','start','-a','android.intent.action.VIEW','-d','about:blank','com.android.chrome');
  forwardPort=await freePort();adbRun('forward',`tcp:${forwardPort}`,'localabstract:tcg_public_devtools_remote');
  let context=await connectAndroid(),page=context.pages()[0]??await context.newPage();page.setDefaultTimeout(25000);
  await record('Public-CA Android Chrome login and installability',async()=>{
   await page.goto(fixture.entry);await page.getByLabel('Username',{exact:true}).fill(fixture.username);await page.getByLabel('Password',{exact:true}).fill(fixture.password);await page.getByLabel('Password',{exact:true}).press('Enter');
   await page.getByRole('textbox',{name:"Type '/' for commands",exact:true}).waitFor();await page.waitForFunction(()=>!!navigator.serviceWorker.controller,undefined,{timeout:60000});
   const client=await context.newCDPSession(page);const installability=await client.send('Page.getInstallabilityErrors');const manifest=await client.send('Page.getAppManifest');await client.detach();
   writeFileSync(join(output,'installability.json'),JSON.stringify({installability,manifest},null,2));
   assert.equal(await page.evaluate(()=>isSecureContext),true);assert.equal(await page.evaluate(()=>localStorage.getItem('ws_uid')),fixture.userId);
   return {publicCaTrusted:true,tlsBypasses:false,chromeVersion:browser.version(),manifestErrors:manifest.errors,installabilityErrors:installability.installabilityErrors};
  });
  let app;
  await record('Android native installation produces a real standalone app',async()=>{
   let xml=hierarchy();if(xml.includes('Chrome notifications make things easier')){assert.ok(tap(xml,['No thanks']));xml=hierarchy();}
   assert.ok(tap(xml,['More options','Customize and control Google Chrome']));xml=hierarchy();
   if(!tap(xml,['Install app','Add to Home screen'])){const e=new Error('No native install action on public-trust HTTPS origin; inspect installability and native UI');e.code='EXTERNAL_GUI';throw e;}
   xml=await eventually(async()=>{const value=hierarchy();return value.includes('text="Cancel"')&&value.includes('text="Install"')?value:false;},{timeout:15000});assert.equal(tap(xml,['Install']),'Install');
   // Packaging/shortcut confirmation is asynchronous. Keep Chrome visible until
   // the launcher request has been handled; HOME can hide the pending dialog.
   let miniConfirmed=false;
   await eventually(async()=>{
    const value=hierarchy();
    if(tap(value,['Add to home screen']))return true;
    // Chrome may offer its mini-infobar after the menu install request. Confirm
    // that separately once, based on its exact observed label, never in a loop.
    if(!miniConfirmed&&value.includes('text="Install Workspace"')&&!value.includes('text="Cancel"')){miniConfirmed=!!tap(value,['Install']);}
    return false;
   },{timeout:30000}).catch(()=>false);
   screenshot('after-install');
   app=await standalone();if(!app){adbRun('shell','input','keyevent','KEYCODE_HOME');xml=hierarchy();app=await eventually(async()=>{const value=hierarchy();if(tap(value,['Add to home screen']))return false;if(tap(value,['Workspace']))return await standalone();return false;},{timeout:90000}).catch(()=>false);}
   if(!app){writeFileSync(join(output,'webapk-log.txt'),adbRun('logcat','-d','-t','3000'));writeFileSync(join(output,'installed-packages.txt'),adbRun('shell','pm','list','packages'));writeFileSync(join(output,'activity-after-install.txt'),adbRun('shell','dumpsys','activity','activities'));writeFileSync(join(output,'targets-after-install.json'),JSON.stringify(await (await fetch(`http://127.0.0.1:${forwardPort}/json/list`)).json(),null,2));const e=new Error('Installation did not yield observed standalone mode despite public CA and minimal Chrome flags');e.code='EXTERNAL_GUI';throw e;}
   await app.getByRole('textbox',{name:"Type '/' for commands",exact:true}).waitFor();assert.equal(await app.evaluate(()=>localStorage.getItem('ws_uid')),fixture.userId);screenshot('standalone');return {standalone:true,accountRetained:true};
  });
  await record('Installed Android offline edit, cold relaunch and exactly-once reconnect',async()=>{
   const before=(await row()).data.text,historyBefore=await fixture.fixture.sql("SELECT COUNT(*) n FROM record_history WHERE record_id='qa-block'");
   writeFileSync(join(output,'history-before.json'),JSON.stringify(historyBefore));
   adbRun('shell','cmd','connectivity','airplane-mode','enable');adbRun('shell','svc','wifi','disable');adbRun('shell','svc','data','disable');
   await app.waitForFunction(()=>!navigator.onLine);assert.equal(await app.evaluate(async()=>{try{await fetch('/api/auth/status',{cache:'no-store'});return false;}catch{return true;}}),true);
   const text='Android installed offline café 日本語 '+Date.now();const editor=app.getByRole('textbox',{name:"Type '/' for commands",exact:true});await editor.fill(text);await editor.press('Tab');
   await app.waitForFunction(async text=>{const uid=localStorage.getItem('ws_uid');const open=indexedDB.open('workspace-'+uid);const db=await new Promise((ok,no)=>{open.onsuccess=()=>ok(open.result);open.onerror=()=>no(open.error)});const tx=db.transaction(['blocks','outbox'],'readonly');const get=tx.objectStore('blocks').get('qa-block'),count=tx.objectStore('outbox').count();const result=await new Promise(ok=>{tx.oncomplete=()=>ok(get.result?.text===text&&count.result>0)});db.close();return result;},text);
   assert.equal((await row()).data.text,before);screenshot('offline-durable');adbRun('shell','am','force-stop','com.android.chrome');
   adbRun('shell','input','keyevent','KEYCODE_HOME');assert.ok(tap(hierarchy(),['Workspace']),'Real launcher icon must cold launch the app');
   context=await connectAndroid();app=await eventually(standalone,{timeout:30000});await app.getByRole('textbox',{name:"Type '/' for commands",exact:true}).waitFor();assert.equal(await app.getByRole('textbox',{name:"Type '/' for commands",exact:true}).textContent(),text);assert.equal(await app.evaluate(()=>localStorage.getItem('ws_uid')),fixture.userId);screenshot('cold-offline-relaunch');
   adbRun('shell','cmd','connectivity','airplane-mode','disable');adbRun('shell','svc','wifi','enable');await app.waitForFunction(()=>navigator.onLine);
   await eventually(async()=>{const r=await row();return r.data.text===text;},{timeout:45000});
   const historyAfter=await fixture.fixture.sql("SELECT COUNT(*) n FROM record_history WHERE record_id='qa-block'");
   const count=result=>result.flatMap(r=>r.results??[])[0]?.n;assert.equal(count(historyAfter)-count(historyBefore),1,'One committed history revision for the reconnect edit');
   writeFileSync(join(output,'persistence.json'),JSON.stringify({text,server:await row(),historyBefore,historyAfter,accountRetained:true,coldRelaunch:true,network:'Owned Android airplane/Wi-Fi/data controls; host network unchanged'},null,2));return {serverEqual:true,historyDelta:1,coldOfflineRelaunch:true};
  });
 } else if(process.argv.includes('--safari')||process.argv.includes('--firefox')) {
  const firefoxMode=process.argv.includes('--firefox');
  const browserName=firefoxMode?'firefox':'safari';
  const port=await freePort();driver=spawn(firefoxMode?resolve(process.env.GECKODRIVER??'.artifacts/cross-platform/geckodriver'):'/usr/bin/safaridriver',firefoxMode?['--port',String(port),'--binary',resolve(process.env.FIREFOX_BINARY??'.artifacts/release-closure/firefox-shipping/Firefox.app/Contents/MacOS/firefox')]:['-p',String(port)],{stdio:'ignore'});
  const wd=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(40000)});const d=await r.json();if(!r.ok)throw new Error(d.value?.message??'Safari WebDriver failed');return d.value;};
  await eventually(async()=>{try{return await wd('/status')}catch{return false}},{timeout:10000});
  const created=await wd('/session',{capabilities:{alwaysMatch:{browserName}}});session={id:created.sessionId,port};
  const command=(path,body)=>wd(`/session/${session.id}${path}`,body);
  const js=(script,...args)=>command('/execute/sync',{script,args});
  const installPageProbe=async()=>{
   // Observe the document realm directly and bridge only a boolean via DOM,
   // never fixture credentials or a fabricated service-worker state.
   const probe='(()=>{const update=()=>document.documentElement.setAttribute("data-qa-sw-controlled",String(!!navigator.serviceWorker.controller));update();navigator.serviceWorker.addEventListener("controllerchange",update);})();';
   await js('const s=document.createElement("script");s.textContent=arguments[0];document.head.append(s);',probe);
  };
  const element=async selector=>{const r=await command('/element',{using:'css selector',value:selector});return r['element-6066-11e4-a52e-4f735466cecf'];};
  const fill=async(selector,text)=>{const id=await element(selector);await command('/element/'+id+'/click',{});await command('/element/'+id+'/value',{text,value:[text]});};
  await record(`Shipping macOS ${browserName} public HTTPS sign-in and Unicode persistence`,async()=>{
   await command('/url',{url:fixture.entry});await eventually(()=>js("return !!document.querySelector('input[autocomplete=username]')"),{timeout:20000});
   await fill('input[autocomplete=username]',fixture.username);await fill('input[type=password]',fixture.password);await command('/element/'+await element('button[type=submit]')+'/click',{});
   await eventually(()=>js("return !!document.querySelector('[contenteditable=true][aria-label]')"),{timeout:20000});
   assert.equal(await js('return isSecureContext'),true);assert.equal(await js("return localStorage.getItem('ws_uid')"),fixture.userId);
   const text=' Safari shipping browser café 日本語 '+Date.now();await fill('[contenteditable=true][aria-label]',text);await js('document.activeElement.blur()');
   await eventually(async()=>String((await row()).data.text).includes(text),{timeout:15000});await command('/refresh',{});await eventually(()=>js('return [...document.querySelectorAll("[contenteditable=true]")].some(e=>e.textContent.includes(arguments[0]))',text),{timeout:20000});
   writeFileSync(join(output,'safari-persisted.png'),Buffer.from(await command('/screenshot'),'base64'));return {capabilities:created.capabilities,publicCaTrusted:true,accountRetained:true,reloaded:true,unicode:true};
  });
  await record(`Shipping ${browserName} service worker complete shell and authenticated search`,async()=>{
   // A first navigation can finish before installation. Revisit only after the
   // real worker is activated, then assert actual control of the new document.
   await command('/execute/async',{script:'const done=arguments[arguments.length-1];navigator.serviceWorker.ready.then(r=>done(r.active?.state));',args:[]});await command('/url',{url:fixture.base+'/pages/qa-page'});await installPageProbe();
   try{await eventually(()=>js('return document.documentElement.getAttribute("data-qa-sw-controlled")==="true"'),{timeout:60000});}catch(e){const state=await command('/execute/async',{script:'const done=arguments[arguments.length-1];(async()=>({ready:document.readyState,url:location.pathname,secure:isSecureContext,pageControlled:document.documentElement.getAttribute("data-qa-sw-controlled"),webdriverControlled:!!navigator.serviceWorker.controller,cache:await caches.keys(),registrations:(await navigator.serviceWorker.getRegistrations()).map(r=>({scope:r.scope,active:r.active?.state,installing:r.installing?.state,waiting:r.waiting?.state}))}))().then(done);',args:[]});writeFileSync(join(output,'service-worker-failure.json'),JSON.stringify(state,null,2));throw e;}
   const cache=await command('/execute/async',{script:'const done=arguments[arguments.length-1];(async()=>{const keys=(await caches.keys()).filter(k=>k.startsWith("ws-precache-v4-"));const c=await caches.open(keys.at(-1));const r=await c.match("/index.html",{ignoreSearch:true});return {keys,index:!!r,assets:(await c.keys()).length}})().then(done);',args:[]});writeFileSync(join(output,'shell-cache.json'),JSON.stringify(cache,null,2));assert.ok(cache.index&&cache.assets>10);
   const query=await command('/execute/async',{script:'const done=arguments[arguments.length-1];fetch("/api/search?q=Cross",{headers:{Authorization:"Bearer "+localStorage.getItem("ws_token")}}).then(r=>r.json()).then(r=>done({hasFixture:JSON.stringify(r).includes("Cross-platform QA")}));',args:[]});assert.equal(query.hasFixture,true);return {cache,search:query};
  });
 } else throw new Error('Specify --android, --safari or --firefox');
 assert.equal(fingerprint(root),source.fingerprint,'Source unchanged');
}catch(error){if(!results.length)results.push({name:'Platform prerequisites',status:'BLOCKED',exitCode:2,error:error.message});process.exitCode=results.some(r=>r.status==='BLOCKED')&&!results.some(r=>r.status==='FAIL')?2:1;console.error(String(error.message).replaceAll(fixture?.entry??'NEVER_MATCH','[private entry]'));}
finally {
 if(adb&&serial){try{adbRun('shell','cmd','connectivity','airplane-mode','disable');adbRun('shell','svc','wifi','enable');adbRun('forward','--remove',`tcp:${forwardPort}`);}catch{}}
 await browser?.close().catch(()=>{});
 if(session)await fetch(`http://127.0.0.1:${session.port}/session/${session.id}`,{method:'DELETE'}).catch(()=>{});driver?.kill();await fixture?.stop();
 writeFileSync(join(output,'results.json'),JSON.stringify({source,platform:process.argv.includes('--android')?'Android Chrome':process.argv.includes('--firefox')?'Shipping Firefox macOS':'Native macOS Safari',provider:'No inference',results,limitations:['Synthetic data only','Permissions disabled for platform parity; enabled security is separately certified','No physical-device or human assistive-technology claim','Public ingress is temporary, not a production/staging deployment']},null,2));console.log(output);
}
