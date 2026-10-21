#!/usr/bin/env node
// Additional qualification of the built application, never a remote deployment.
// Certificates/profiles/databases are disposable. No personal browser profile.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium,firefox,webkit,_android} from 'playwright';
import {startFixture,eventually} from './phase4-fixture.mjs';
import {freePort,fingerprint} from './certification/core.mjs';
import {readAccountStore} from './certification/browser-db.mjs';
import {createNetworkGate} from './certification/network-gate.mjs';
const root=resolve(import.meta.dirname,'..');
const output=resolve(process.env.CROSS_QA_ARTIFACT_DIR??`.artifacts/cross-platform/${new Date().toISOString().replaceAll(':','-')}`);
mkdirSync(output,{recursive:true});
if(!process.env.TCG_QA_CERT){
 const dir=mkdtempSync(join(tmpdir(),'tcg-qa-tls-')),cert=join(dir,'cert.pem'),key=join(dir,'key.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});chmodSync(key,0o600);
 const result=spawnSync(process.execPath,[import.meta.filename,...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,CROSS_QA_ARTIFACT_DIR:output,TCG_QA_CERT:cert,TCG_QA_KEY:key,NODE_EXTRA_CA_CERTS:cert}});
 process.exit(result.status??1);
}
const source={sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),fingerprint:fingerprint(root),clean:!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()};
const tls={cert:process.env.TCG_QA_CERT,key:process.env.TCG_QA_KEY},useTls=!process.argv.includes('--http');
const pub=execFileSync('openssl',['x509','-in',tls.cert,'-pubkey','-noout']);
const der=execFileSync('openssl',['pkey','-pubin','-outform','DER'],{input:pub});
const spki=createHash('sha256').update(der).digest('base64');
const results=[];let fixture,diagnosticPage,networkGate;
function save(){writeFileSync(join(output,'results.json'),JSON.stringify({source,https:{scope:useTls?'Loopback TLS, disposable local Worker/D1/KV/DO':'HTTP loopback secure-context exception, not HTTPS acceptance',nodeCertificateValidation:'Temporary CA, verification enabled',browserCertificateTrust:'Exact certificate SPKI exception in isolated Chromium profiles; other engines test-only ignoreHTTPSErrors',fingerprint256:createHash('sha256').update(readFileSync(tls.cert)).digest('hex')},permissionMode:'DISABLED platform/offline parity; enabled authorization covered by certify:ai',results},null,2));}
async function test(platform,name,fn){const at=Date.now();try{const evidence=await fn();results.push({platform,name,status:'PASS',exitCode:0,durationMs:Date.now()-at,evidence});console.log(`PASS [${platform}] ${name}`);}catch(e){results.push({platform,name,status:e.code==='EXTERNAL_GUI'?'BLOCKED':'FAIL',exitCode:e.code==='EXTERNAL_GUI'?2:1,durationMs:Date.now()-at,error:e.message});console.error(`FAIL [${platform}] ${name}: ${e.message}`);if(diagnosticPage&&!diagnosticPage.isClosed()){const key=platform+'-'+results.length;await diagnosticPage.screenshot({path:join(output,key+'-failure.png')}).catch(()=>{});writeFileSync(join(output,key+'-failure.txt'),await diagnosticPage.locator('body').innerText().catch(()=>''));}}save();}
async function api(path,{token,method='GET',body}={}){const r=await fetch(fixture.base+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});return {status:r.status,data:await r.json()};}
async function pull(token){const result=await api('/api/sync/pull?since=0',{token});assert.equal(result.status,200);return result.data.records;}
async function login(page){await page.goto(fixture.base+'/pages/qa-page');await page.getByRole('textbox',{name:'Username',exact:true}).fill('admin');await page.getByLabel('Password',{exact:true}).fill('password123');await page.getByRole('form',{name:'Sign in form',exact:true}).getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('textbox',{name:"Type '/' for commands",exact:true}).waitFor();}
async function offline(context,platform,value){if(platform==='mac-webkit')networkGate.setAvailable(!value);else await context.setOffline(value);}
async function journey(context,platform,token){
 const page=context.pages()[0]??await context.newPage();diagnosticPage=page;page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await test(platform,'Secure-origin login, headers, OAuth resource and live socket',async()=>{
  await login(page);assert.equal(await page.evaluate(()=>isSecureContext),true);
  const challenge=await page.request.get(fixture.base+'/mcp');assert.equal(challenge.status(),401);const resource=challenge.headers()['www-authenticate']?.match(/resource_metadata="([^"]+)"/)?.[1];assert.ok(resource?.startsWith(fixture.base+'/'));const meta=await page.request.get(resource);assert.equal(meta.status(),200);assert.equal((await meta.json()).resource,fixture.base+'/mcp');
  const headers=(await page.request.get(fixture.base+'/')).headers();assert.equal(headers['x-content-type-options'],'nosniff');
  const socket=await page.evaluate(()=>new Promise(resolve=>{const ws=new WebSocket(location.origin.replace(/^http/,'ws')+'/api/live',['ws-auth',localStorage.getItem('ws_token')]);const timer=setTimeout(()=>{ws.close();resolve(false)},10000);ws.onopen=()=>{clearTimeout(timer);ws.close();resolve(true)};ws.onerror=()=>{clearTimeout(timer);resolve(false)};}));assert.equal(socket,true,'Real TLS WebSocket upgrades');
  return {url:page.url(),secureContext:true,oauthResource:fixture.base+'/mcp',webSocket:true};
 });
 await test(platform,'Interrupted required-asset installation retains the complete active shell',async()=>{
  await page.waitForFunction(async()=>(await navigator.serviceWorker.getRegistration())?.active);await page.reload();await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  const swPath=join(fixture.directory,'client','sw.js'),indexPath=join(fixture.directory,'client','index.html'),sw=readFileSync(swPath,'utf8'),index=readFileSync(indexPath,'utf8');
  const main=index.match(/src="(\/assets\/[^"\n]+\.js)"/)?.[1];assert.ok(main,'Actual built entry script required');
  const marker='qa-broken-'+Date.now(),missing='/assets/qa-required-missing.js',text=await page.getByRole('textbox',{name:"Type '/' for commands",exact:true}).innerText();
  const before=await page.evaluate(async()=>({keys:await caches.keys(),user:localStorage.getItem('ws_uid')}));networkGate.setAssetFailure(missing);
  try{
   assert.equal((await page.request.get(fixture.base+missing)).status(),503,'A real required-asset response must fail');
   const broken=sw.replaceAll(main.slice(1),missing.slice(1)).replace(/"revision":"[^"\n]+","url":"index.html"/,`"revision":"${marker}","url":"index.html"`);assert.notEqual(broken,sw);
   writeFileSync(indexPath,index.replace(main,missing));writeFileSync(swPath,broken);
   const state=await page.evaluate(()=>new Promise(async(resolve,reject)=>{
    const registration=await navigator.serviceWorker.getRegistration();window.__qaPreviousActive=registration.active;
    const timer=setTimeout(()=>reject(new Error('No bounded install completion')),15000);
    registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker.addEventListener('statechange',()=>{if(worker.state==='redundant'||worker.state==='activated'){clearTimeout(timer);resolve(worker.state)}})},{once:true});registration.update().catch(error=>{clearTimeout(timer);reject(error)});
   }));
   assert.equal(state,'redundant','An incomplete new shell must never activate');
   assert.equal(await page.evaluate(async()=>(await navigator.serviceWorker.getRegistration()).active===window.__qaPreviousActive),true);
   assert.deepEqual(await page.evaluate(()=>caches.keys()),before.keys,'Failed candidate cache must not consume retained-build storage');
   await offline(context,platform,true);await page.reload();const editor=page.getByRole('textbox',{name:"Type '/' for commands",exact:true});await editor.waitFor();assert.equal(await editor.innerText(),text);assert.equal(await page.evaluate(()=>localStorage.getItem('ws_uid')),before.user);
   return {requiredAssetStatus:503,installState:state,activeUnchanged:true,offlineEditorRetained:true,accountRetained:true};
  }finally{networkGate.setAssetFailure(null);await offline(context,platform,false);writeFileSync(swPath,sw);writeFileSync(indexPath,index);}
 });
 await test(platform,'Service worker controlled offline edit/reload/reconnect persists once',async()=>{
  await page.waitForFunction(async()=>(await navigator.serviceWorker.getRegistrations()).some(r=>r.active));await page.reload();await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  writeFileSync(join(output,platform+'-cache-before-offline.json'),JSON.stringify(await page.evaluate(async()=>{const out=[];for(const key of await caches.keys()){const c=await caches.open(key);for(const req of await c.keys()){if(req.url.includes('index.html')){const r=await c.match(req);out.push({key,url:req.url,status:r.status,redirected:r.redirected,type:r.type,headers:Object.fromEntries(r.headers),bytes:(await r.clone().arrayBuffer()).byteLength});}}}return out}),null,2));
  const text=`Offline ${platform} café 日本語 ${Date.now()}`,editor=page.getByRole('textbox',{name:"Type '/' for commands",exact:true});await editor.waitFor();
  try{await offline(context,platform,true);await editor.fill(text);await editor.press('Tab');await eventually(async()=>(await readAccountStore(page,'blocks',{id:'qa-block'}))?.text===text);await page.reload();await editor.waitFor();await eventually(async()=>await editor.innerText()===text);
  const stores=await page.evaluate(async()=>({databases:(await indexedDB.databases()).map(d=>d.name),controlled:!!navigator.serviceWorker.controller,cacheNames:await caches.keys()}));assert.ok(stores.databases.some(n=>n.startsWith('workspace-')));assert.equal(stores.controlled,true);
  await offline(context,platform,false);await eventually(async()=>(await pull(token)).find(r=>r.id==='qa-block')?.data?.text===text,{timeout:25000});
  await page.reload();await editor.waitFor();assert.equal(await editor.innerText(),text);await page.screenshot({path:join(output,platform+'-offline-recovered.png')});assert.deepEqual(errors,[]);return {text,persistence:true,...stores};}finally{await offline(context,platform,false);}
 });
 await test(platform,'Service worker upgrade replaces offline shell without losing account data',async()=>{
  const swPath=join(fixture.directory,'client','sw.js'),indexPath=join(fixture.directory,'client','index.html');const sw=readFileSync(swPath,'utf8'),index=readFileSync(indexPath,'utf8');
  const marker=`qa-upgrade-${platform}-${Date.now()}`,oldAsset='/assets/'+marker+'-previous.js';
  await page.evaluate(async path=>{const key=(await caches.keys()).find(k=>k.startsWith('ws-precache-'));if(!key)throw new Error('Current shell cache required');await(await caches.open(key)).put(path,new Response('/* retained previous chunk */',{headers:{'Content-Type':'application/javascript'}}))},oldAsset);
  try{
   writeFileSync(indexPath,index.replace('</head>',`<meta name="qa-upgrade" content="${marker}"></head>`));
   const next=sw.replace(/"revision":"[^"]+","url":"index.html"/,`"revision":"${marker}","url":"index.html"`);assert.notEqual(next,sw,'Actual shell revision must change');writeFileSync(swPath,next);
   await page.evaluate(async()=>{window.__qaControllerChanged=false;navigator.serviceWorker.addEventListener('controllerchange',()=>{window.__qaControllerChanged=true},{once:true});const r=await navigator.serviceWorker.getRegistration();await r.update()});await page.waitForFunction(()=>window.__qaControllerChanged);
   await page.waitForFunction(async marker=>{const keys=await caches.keys();for(const key of keys){const r=await(await caches.open(key)).match('index.html',{ignoreSearch:true});if(r&&(await r.text()).includes(marker))return true}return false},marker);
   await offline(context,platform,true);await page.reload();assert.equal(await page.locator('meta[name="qa-upgrade"]').getAttribute('content'),marker,'Offline navigation must use the NEW shell, not the first old revision');
   assert.equal(await page.evaluate(async path=>(await fetch(path)).text(),oldAsset),'/* retained previous chunk */','Open old tabs retain their immutable lazy chunks');
   assert.ok(await page.evaluate(()=>!!localStorage.getItem('ws_uid')));const retained=await page.evaluate(()=>caches.keys());assert.ok(retained.filter(k=>k.startsWith('ws-precache-')).length<=2,'At most two shell builds retained');return {marker,newShell:true,accountRetained:true,retained};
  }finally{await offline(context,platform,false);writeFileSync(swPath,sw);writeFileSync(indexPath,index);}
 });
 if(platform!=='mac-chrome')await page.close();
}
try{
 fixture=await startFixture({port:await freePort(),build:!process.argv.includes('--skip-build'),artifactDirectory:join(output,'fixture'),tls:useTls?tls:undefined});
 networkGate=await createNetworkGate(fixture.base,useTls?tls:undefined);fixture.base=networkGate.base;
 const signup=await api('/api/auth/signup',{method:'POST',body:{username:'admin',name:'Synthetic QA Admin',password:'password123'}});assert.equal(signup.status,200);const admin=signup.data;
 assert.ok(admin.token);const seeded=await api('/api/sync/push',{token:admin.token,method:'POST',body:{changes:[{id:'qa-page',collection:'pages',patch:{title:'Cross-platform QA',order:'a0'},ts:Date.now()},{id:'qa-block',collection:'blocks',patch:{pageId:'qa-page',type:'p',text:'QA fixture body',order:'a0'},ts:Date.now()}]}});assert.equal(seeded.status,200);assert.ok(!seeded.data.rejected);
 const only=process.argv.find(a=>a.startsWith('--only='))?.slice(7)??'chromium,firefox,webkit,chrome';
 for(const name of only.split(',').filter(n=>n!=='android')){
  const type={chromium,firefox,webkit,chrome:chromium}[name];assert.ok(type,'Unknown browser');let browser;
  try{
   let context;
   if(name==='chrome'&&process.argv.includes('--pwa')){context=await type.launchPersistentContext(mkdtempSync(join(tmpdir(),'tcg-pwa-profile-')),{channel:'chrome',headless:false,ignoreHTTPSErrors:true,args:[`--ignore-certificate-errors-spki-list=${spki}`,'--window-size=1280,900'],viewport:null});browser=context.browser();}
   else {browser=await type.launch({headless:true,...(name==='chrome'?{channel:'chrome'}:{}),...(name==='chrome'||name==='chromium'?{args:[`--ignore-certificate-errors-spki-list=${spki}`]}:{})});context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1024,height:768}});}
   await journey(context,`mac-${name}`,admin.token);
   if(name==='chrome'&&process.argv.includes('--native-zoom'))await test('mac-chrome','Native browser 400% zoom, reflow and keyboard search',async()=>{
    const page=await context.newPage();diagnosticPage=page;await page.goto(fixture.base+'/settings');await page.getByRole('button',{name:/^Search/}).first().waitFor();
    const pageSession=await context.newCDPSession(page);const {windowId}=await pageSession.send('Browser.getWindowForTarget');await pageSession.send('Browser.setWindowBounds',{windowId,bounds:{left:20,top:30,width:1280,height:900,windowState:'normal'}});await pageSession.detach();const cdp=await browser.newBrowserCDPSession(),processes=await cdp.send('SystemInfo.getProcessInfo'),pid=processes.processInfo.find(p=>p.type==='browser').id;
    const cua=process.env.CUA_DRIVER??'/Users/trinity/.local/bin/cua-driver',session='tcg-qa-native-zoom';
    const call=(tool,args)=>{const data=execFileSync(cua,['call',tool,JSON.stringify({session,...args})],{encoding:'utf8',timeout:15000,maxBuffer:10*1024*1024});return JSON.parse(data);};
    call('start_session',{});const observed=call('list_windows',{});writeFileSync(join(output,'native-zoom-windows.json'),JSON.stringify(observed));const windows=observed.windows.filter(w=>w.pid===pid&&w.is_on_screen&&w.bounds.width>400);if(!windows.length){const error=new Error('Exact isolated Chrome window unavailable to the native GUI driver on this macOS Stage; expose the test window and rerun --native-zoom');error.code='EXTERNAL_GUI';throw error;}const window_id=windows[0].window_id,target={pid,window_id};
    writeFileSync(join(output,'native-zoom-before.json'),JSON.stringify(call('get_window_state',{...target,include_screenshot:false})));
    const baseline=await page.evaluate(()=>({dpr:devicePixelRatio,width:innerWidth}));
    try{for(let i=0;i<8;i++){const previous=await page.evaluate(()=>devicePixelRatio);const action=call('invoke_menu',{...target,path:['View','Zoom In']});writeFileSync(join(output,`native-zoom-action-${i}.json`),JSON.stringify(action));assert.ok(!action.error,JSON.stringify(action));await page.waitForFunction(dpr=>devicePixelRatio>dpr,previous,{timeout:5000});}
     await page.waitForFunction(dpr=>Math.abs(devicePixelRatio/dpr-4)<.05,baseline.dpr);
     const actual=await page.evaluate(()=>({dpr:devicePixelRatio,width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(actual.scroll<=actual.width+1,'Native zoom root reflow');
     const search=page.getByRole('button',{name:/^Search/}).first();await search.focus();await search.press('Enter');await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');assert.equal(await search.evaluate(e=>e===document.activeElement),true);
     await page.screenshot({path:join(output,'native-chrome-400-percent.png')});writeFileSync(join(output,'native-zoom-after.json'),JSON.stringify(call('get_window_state',{...target,include_screenshot:false})));return {baseline,actual,zoomFactor:actual.dpr/baseline.dpr,method:'Native Chrome View/Zoom In menu through Cua, exact owned window; not viewport emulation'};
    }finally{call('hotkey',{...target,keys:['cmd','0']});call('end_session',{});await page.close();await cdp.detach();}
   });
   if(name==='chrome'&&process.argv.includes('--pwa'))await test('mac-chrome','Installed PWA launch, offline relaunch and account persistence',async()=>{
    const session=await browser.newBrowserCDPSession(),manifestId=fixture.base+'/';let installed=false;
    try{const tab=await context.newPage();await tab.goto(manifestId);await session.send('PWA.install',{manifestId,installUrlOrBundleUrl:manifestId});installed=true;const state=await session.send('PWA.getOsAppState',{manifestId});await session.send('PWA.changeAppUserSettings',{manifestId,displayMode:'standalone'});
     const opened=context.waitForEvent('page');await session.send('PWA.launch',{manifestId,url:fixture.base+'/pages/qa-page'});const app=await opened;diagnosticPage=app;await app.waitForLoadState();await app.waitForFunction(()=>matchMedia('(display-mode: standalone)').matches);assert.ok(await app.evaluate(()=>!!localStorage.getItem('ws_uid')));await app.screenshot({path:join(output,'mac-chrome-installed-pwa.png')});await app.close();
     await context.setOffline(true);const relaunched=context.waitForEvent('page');await session.send('PWA.launch',{manifestId,url:fixture.base+'/pages/qa-page'});const again=await relaunched;await again.getByRole('textbox',{name:"Type '/' for commands",exact:true}).waitFor();assert.equal(await again.evaluate(()=>matchMedia('(display-mode: standalone)').matches),true);await again.close();return {installed:true,standalone:true,offlineRelaunch:true,osState:state};
    }finally{await context.setOffline(false);if(installed)await session.send('PWA.uninstall',{manifestId});await session.detach();}
   });
   await context.close();
  }finally{await browser?.close();}
 }
 if(only.split(',').includes('android')){
  const adb=process.env.ANDROID_ADB??'/Users/trinity/Library/Android/sdk/platform-tools/adb',serial=process.env.QA_ANDROID_SERIAL;
  assert.ok(serial?.startsWith('emulator-'),'Explicit disposable emulator serial required');execFileSync(adb,['-s',serial,'reverse',`tcp:${new URL(fixture.base).port}`,`tcp:${new URL(fixture.base).port}`]);
  const device=(await _android.devices()).find(d=>d.serial()===serial);assert.ok(device,'Owned Android emulator must be connected');
  const version=String(await device.shell('getprop ro.build.version.release')).trim();writeFileSync(join(output,'android-device.json'),JSON.stringify({serial,version,model:device.model(),physical:false}));
  try{for(const [name,size,density] of [['small','720x1280','320'],['large','1080x2400','420'],['tablet','1600x2560','240']]){
   await device.shell(`wm size ${size}`);await device.shell(`wm density ${density}`);await device.shell('pm clear com.android.chrome');
   const context=await device.launchBrowser({args:[`--ignore-certificate-errors-spki-list=${spki}`],ignoreHTTPSErrors:true});try{
    await journey(context,`android-${version}-chrome-${name}`,admin.token);writeFileSync(join(output,`android-${name}.png`),await device.screenshot());
    if(name==='small'&&process.argv.includes('--android-pwa'))await test('android-chrome','Native Home Screen PWA installation and standalone launch',async()=>{
     const page=await context.newPage();diagnosticPage=page;await page.goto(fixture.base+'/pages/qa-page');await page.getByRole('textbox',{name:"Type '/' for commands",exact:true}).waitFor();let step=0;
     const native=()=>{const dumped=execFileSync(adb,['-s',serial,'shell','uiautomator','dump','/sdcard/tcg-pwa-qa.xml'],{timeout:15000,encoding:'utf8'});assert.ok(dumped.includes('dumped'),'Fresh native hierarchy required');const xml=execFileSync(adb,['-s',serial,'shell','cat','/sdcard/tcg-pwa-qa.xml'],{encoding:'utf8'});writeFileSync(join(output,`android-pwa-${++step}.xml`),xml);return xml;};
     const tap=(xml,label)=>{const node=[...xml.matchAll(/<node[^>]+>/g)].map(m=>m[0]).find(n=>n.includes(`text="${label}"`)||n.includes(`content-desc="${label}"`));if(!node)return false;const b=node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);assert.ok(b);const [x,y,r,bottom]=b.slice(1).map(Number);execFileSync(adb,['-s',serial,'shell','cmd','input','tap',String(Math.round((x+r)/2)),String(Math.round((y+bottom)/2))]);return true;};
     execFileSync(adb,['-s',serial,'shell','am','force-stop','com.microsoft.playwright.androiddriver']);
     let xml=native();if(xml.includes('text="No thanks"')){tap(xml,'No thanks');xml=native();}assert.ok((tap(xml,'More options')||tap(xml,'Customize and control Google Chrome')),'Observed native Chrome menu required');xml=native();
     if(!tap(xml,'Install app')&&!tap(xml,'Add to Home screen')){const e=new Error('Native Chrome exposes no install/Home Screen action for this disposable origin');e.code='EXTERNAL_GUI';throw e;}
     xml=native();for(let i=0;i<4;i++){if(tap(xml,'Install')||tap(xml,'Add')||tap(xml,'Create shortcut')||tap(xml,'Open'))xml=native();else break;}
     writeFileSync(join(output,'android-pwa-install-screen.png'),await device.screenshot());
     const standalone=async()=>{for(const p of context.pages()){if(p.url().startsWith(fixture.base)&&await p.evaluate(()=>matchMedia('(display-mode: standalone)').matches).catch(()=>false))return p;}return false;};
     let app=await standalone();if(!app){execFileSync(adb,['-s',serial,'shell','cmd','input','keyevent','KEYCODE_HOME']);xml=native();if(tap(xml,'Workspace'))app=await eventually(standalone,{timeout:15000}).catch(()=>false);}
     if(!app){const e=new Error('Home Screen install did not yield a verifiable standalone target; private HTTPS origin/WebAPK launcher acceptance requires external verification');e.code='EXTERNAL_GUI';throw e;}
     await app.getByRole('textbox',{name:"Type '/' for commands",exact:true}).waitFor();return {standalone:true,accountRetained:await app.evaluate(()=>!!localStorage.getItem('ws_uid'))};
    });
   }finally{await context.close();}
  }}finally{await device.close();execFileSync(adb,['-s',serial,'reverse','--remove',`tcp:${new URL(fixture.base).port}`]);}
 }
 assert.equal(fingerprint(root),source.fingerprint,'Source unchanged during qualification');
}finally{await networkGate?.stop();await fixture?.stop();save();}
process.exitCode=results.some(r=>r.status==='FAIL')?1:results.some(r=>r.status==='BLOCKED')?2:0;
console.log(output);
