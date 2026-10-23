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
async function login(page,touch=false){await page.goto(fixture.base+'/pages/qa-page');await page.getByRole('textbox',{name:'Username',exact:true}).fill('admin');await page.getByLabel('Password',{exact:true}).fill('password123');if(touch)await page.getByLabel('Password',{exact:true}).press('Enter');else await page.getByRole('form',{name:'Sign in form',exact:true}).getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('textbox',{name:"Type '/' for commands",exact:true}).waitFor();}
async function offline(context,platform,value){if(platform==='mac-webkit'||platform==='mac-firefox')networkGate.setAvailable(!value);else await context.setOffline(value);}
async function journey(context,platform,token,androidDevice){
 const page=context.pages()[0]??await context.newPage();diagnosticPage=page;page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>{errors.push({name:e.name,message:e.message,stack:e.stack});writeFileSync(join(output,platform+'-page-errors.json'),JSON.stringify(errors,null,2));});
 await test(platform,'Secure-origin login, headers, OAuth resource and live socket',async()=>{
  await login(page,platform.startsWith('android-'));assert.equal(await page.evaluate(()=>isSecureContext),true);
  const challenge=await page.request.get(fixture.base+'/mcp');assert.equal(challenge.status(),401);const resource=challenge.headers()['www-authenticate']?.match(/resource_metadata="([^"]+)"/)?.[1];assert.ok(resource?.startsWith(fixture.base+'/'));const meta=await page.request.get(resource);assert.equal(meta.status(),200);assert.equal((await meta.json()).resource,fixture.base+'/mcp');
  const headers=(await page.request.get(fixture.base+'/')).headers();assert.equal(headers['x-content-type-options'],'nosniff');
  const socket=await page.evaluate(()=>new Promise(resolve=>{const ws=new WebSocket(location.origin.replace(/^http/,'ws')+'/api/live',['ws-auth',localStorage.getItem('ws_token')]);const timer=setTimeout(()=>{ws.close();resolve(false)},10000);ws.onopen=()=>{clearTimeout(timer);ws.close();resolve(true)};ws.onerror=()=>{clearTimeout(timer);resolve(false)};}));assert.equal(socket,true,'Real TLS WebSocket upgrades');
  return {url:page.url(),secureContext:true,oauthResource:fixture.base+'/mcp',webSocket:true};
 });
 if(androidDevice){await page.waitForFunction(async()=>(await navigator.serviceWorker.getRegistration())?.active);await page.goto(page.url(),{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!!navigator.serviceWorker.controller);if(platform.endsWith('-small'))await androidRotation(context,platform,token,androidDevice,page);await androidInteractions(context,platform,token,androidDevice);diagnosticPage=page;await page.bringToFront();}
 await test(platform,'Interrupted required-asset installation retains the complete active shell',async()=>{
  await page.waitForFunction(async()=>(await navigator.serviceWorker.getRegistration())?.active);await page.reload();await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  const swPath=join(fixture.directory,'client','sw.js'),indexPath=join(fixture.directory,'client','index.html'),sw=readFileSync(swPath,'utf8'),index=readFileSync(indexPath,'utf8');
  const main=index.match(/src="(\/assets\/[^"\n]+\.js)"/)?.[1];assert.ok(main,'Actual built entry script required');
  const editor=page.getByRole('textbox',{name:"Type '/' for commands",exact:true});
  // RichInput's DOM-fill effect follows element creation. Existence alone can
  // capture an empty mount before the already-loaded record is rendered.
  const canonical=(await pull(token)).find(r=>r.id==='qa-block')?.data?.text;
  assert.equal(typeof canonical,'string','Canonical fixture text required before the fault');
  await eventually(async()=>await editor.innerText()===canonical,{timeout:20000});
  const marker='qa-broken-'+Date.now(),missing='/assets/qa-required-missing.js',text=await editor.innerText();
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
async function androidRotation(context,platform,token,device,page){
 await test(platform,'Native Android landscape and background retain a durable unacknowledged edit',async()=>{
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  const editor=page.getByRole('textbox',{name:"Type '/' for commands",exact:true});
  const original=(await pull(token)).find(r=>r.id==='qa-block').data.text;
  await eventually(async()=>await editor.innerText()===original);
  const text='Android landscape offline café 日本語 '+Date.now();
  await editor.tap();await context.setOffline(true);await editor.fill(text);
  await eventually(async()=>/\bmInputShown=true\b/.test(String(await device.shell('dumpsys input_method'))),{timeout:10000});
  await eventually(async()=>(await readAccountStore(page,'blocks',{id:'qa-block'}))?.text===text);
  assert.ok((await readAccountStore(page,'outbox')).some(r=>r.id==='qa-block'),'The edit must still be pending, not acknowledged');
  assert.notEqual((await pull(token)).find(r=>r.id==='qa-block').data.text,text);
  const screen=async landscape=>{let image;await eventually(async()=>{image=await device.screenshot();return landscape?image.readUInt32BE(16)>image.readUInt32BE(20):image.readUInt32BE(20)>image.readUInt32BE(16)},{timeout:15000});return image;};
  try{
   await device.shell('wm user-rotation lock 1');
   writeFileSync(join(output,'android-landscape-native.png'),await screen(true));
   writeFileSync(join(output,'android-landscape-display.txt'),String(await device.shell('dumpsys display')));
   const metrics=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,visual:{width:visualViewport.width,height:visualViewport.height,offsetTop:visualViewport.offsetTop},orientation:screen.orientation.type}));
   writeFileSync(join(output,'android-landscape-metrics.json'),JSON.stringify(metrics));assert.ok(metrics.scroll<=metrics.width+1);
   assert.equal(await editor.innerText(),text);
   const activity=async()=>String(await device.shell('dumpsys activity activities')).split('\n').filter(line=>/topResumedActivity|mResumedActivity/.test(line)).join('\n');
   await device.shell('input keyevent KEYCODE_HOME');
   const background=await eventually(async()=>{const value=await activity();return /launcher/i.test(value)?value:false},{timeout:10000});
   writeFileSync(join(output,'android-background-activity.txt'),background);
   const debugVisibility=await page.evaluate(()=>document.visibilityState);
   await device.shell('am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p com.android.chrome');
   const foreground=await eventually(async()=>{const value=await activity();return value.includes('com.android.chrome')?value:false},{timeout:10000});
   writeFileSync(join(output,'android-foreground-activity.txt'),foreground);writeFileSync(join(output,'android-background-dom-visibility.json'),JSON.stringify({debugVisibility,note:'CDP may keep a page visible; native activity is the app-switch assertion. This does not prove real process suspension.'}));
   assert.equal(await editor.innerText(),text);
   await device.shell('wm user-rotation lock 0');writeFileSync(join(output,'android-portrait-return-native.png'),await screen(false));
   await context.setOffline(false);await eventually(async()=>(await pull(token)).find(r=>r.id==='qa-block').data.text===text,{timeout:25000});
   await eventually(async()=>!(await readAccountStore(page,'outbox')).some(r=>r.id==='qa-block'));
   await page.reload({waitUntil:'domcontentloaded'});await editor.waitFor();await eventually(async()=>await editor.innerText()===text);
   return {nativeLandscape:true,nativePortraitReturn:true,actualIme:true,backgroundForeground:true,localPendingBeforeReconnect:true,serverPersistence:true,outboxAcknowledged:true,text};
  }finally{await context.setOffline(false);await device.shell('wm user-rotation lock 0');}
 });
}
async function androidInteractions(context,platform,token,device){
 // A CDP-created background tab cannot exercise the native IME. Open the
 // route with a real Android VIEW intent, then adopt its visible browser tab.
 const nativeUrl=fixture.base+'/boards/board-default/tasks/qa-task?qa='+Date.now();
 await device.shell('am start -a android.intent.action.VIEW -d '+nativeUrl+' -p com.android.chrome');
 const page=await eventually(async()=>{for(const candidate of context.pages()){if(candidate.url().startsWith(fixture.base+'/boards/board-default/tasks/qa-task')&&await candidate.evaluate(()=>document.visibilityState==='visible').catch(()=>false))return candidate;}return false;},{timeout:20000});
 diagnosticPage=page;page.setDefaultTimeout(20000);
 let nativeStep=0;
 async function nativeTap(label){
  if(label==='Send message')await page.waitForFunction(()=>document.querySelector('[data-testid=assistant-send]')?.disabled===false);
  const selector={pkg:'com.android.chrome',text:new RegExp('^'+label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$'),enabled:true,clickable:true};
  const step=++nativeStep;
  try{
   await device.wait(selector,{timeout:15000});
   const observed=await device.info(selector);
   writeFileSync(join(output,platform+'-native-button-'+step+'.json'),JSON.stringify({label,...observed}));
   const image=await device.screenshot();writeFileSync(join(output,platform+'-native-button-'+step+'.png'),image);
   const b=observed.bounds;assert.ok(b.width>0&&b.height>0&&b.x>=0&&b.y>=0&&b.x+b.width<=image.readUInt32BE(16)&&b.y+b.height<=image.readUInt32BE(20),'Native target must fit inside the actual device screen');
   // Resolve the same named native widget again at input time. CSS coordinates
   // do not account for Android's keyboard-induced viewport panning.
   await device.tap(selector,{timeout:15000});
  }catch(error){
   writeFileSync(join(output,platform+'-native-button-'+step+'-failure.png'),await device.screenshot());
   writeFileSync(join(output,platform+'-native-button-'+step+'-failure.json'),JSON.stringify({label,error:error.message,viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight,visual:{height:visualViewport.height,offsetTop:visualViewport.offsetTop}}))}));
   throw new Error('Native '+label+': '+error.message);
  }
 }
 const ime=async()=>String(await device.shell('dumpsys input_method'));
 const shown=text=>/\bmInputShown=true\b/.test(text);
 await test(platform,'Task edit and keyboard-open simulated assistant approval persist exactly once',async()=>{
  await page.getByRole('textbox',{name:'Task title',exact:true}).waitFor();
  const text='Android task café '+Date.now(),description=page.getByRole('textbox',{name:'Task description',exact:true});await description.fill(text);await description.press('Tab');
  await eventually(async()=>(await pull(token)).find(r=>r.id==='qa-task')?.data?.description===text);await page.reload({waitUntil:'domcontentloaded'});await description.waitFor();assert.equal(await description.inputValue(),text);
  await page.goto(fixture.base+'/pages/qa-page',{waitUntil:'domcontentloaded'});await page.getByRole('textbox',{name:"Type '/' for commands",exact:true}).waitFor();await page.getByTestId('assistant-toggle').filter({visible:true}).first().tap();
  const panel=page.getByTestId('assistant-panel');await panel.waitFor();await panel.getByTestId('assistant-provider-select').selectOption('simulated');
  const title='android approved '+Date.now(),input=panel.getByTestId('assistant-input');
  await page.waitForFunction(()=>document.activeElement?.matches('[data-testid=assistant-input]'));assert.equal(await input.inputValue(),'');
  // Android's native key-code API cannot type the synthetic tool command's
  // punctuation. Seed only that syntax, type the actual title through the OS,
  // verify the exact draft, then close the JSON before the native Send tap.
  const prefix='/tool create_page {"title":"';await input.fill(prefix);await device.input.type(title);await eventually(async()=>await input.inputValue()===prefix+title);
  const command='/tool create_page '+JSON.stringify({title});await input.fill(command);assert.equal(await input.inputValue(),command);await nativeTap('Send message');
  const card=panel.getByTestId('assistant-approval-card').last();await card.waitFor();await panel.getByTestId('assistant-stop').waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.matches('[data-testid=assistant-input]'));const approve=card.getByTestId('assistant-approve');await approve.scrollIntoViewIfNeeded();
  // A tablet transcript may fit without overflow and therefore has no native
  // scrollable widget. Scroll only when the rendered region actually needs it.
  if(await panel.getByTestId('assistant-transcript').evaluate(el=>el.scrollHeight>el.clientHeight+1))
   await device.scroll({pkg:'com.android.chrome',text:'Assistant messages',scrollable:true},'down',0.8,{timeout:15000});
  const keyboard=await eventually(async()=>{const state=await ime();return shown(state)?state:false},{timeout:10000});writeFileSync(join(output,platform+'-approval-ime.txt'),keyboard);assert.equal(shown(keyboard),true,'Actual Android IME must be shown, not a substituted viewport');
  assert.equal(await approve.evaluate(el=>{const r=el.getBoundingClientRect(),v=visualViewport;return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))&&r.y+r.height/2>=(v?.offsetTop??0)&&r.y+r.height/2<(v?.height??innerHeight)+(v?.offsetTop??0)}),true,'Keyboard-open approval receives the intended tap');
  await page.screenshot({path:join(output,platform+'-approval-keyboard.png')});writeFileSync(join(output,platform+'-approval-keyboard-native.png'),await device.screenshot());await nativeTap('Approve & execute');await panel.getByText(/Changeset/i).last().waitFor();
  await eventually(async()=>(await pull(token)).filter(r=>r.collection==='pages'&&r.data?.title===title).length===1);const close=panel.getByRole('button',{name:'Close assistant',exact:true});await close.focus();await close.scrollIntoViewIfNeeded();await nativeTap('Close assistant');await panel.waitFor({state:'hidden'});
  return {taskReloaded:true,taskText:text,approvalTitle:title,proposalCount:1,actualIme:true,provider:'SIMULATED'};
 });
 await test(platform,'Canvas item-list nudge, actual browser touch pan and pinch',async()=>{
  await page.goto(fixture.base+'/moodboards/qa-mood',{waitUntil:'domcontentloaded'});const canvas=page.getByTestId('mood-canvas');await canvas.waitFor();
  const mode=page.getByTestId('mode-toggle');if((await mode.getAttribute('title')).startsWith('Edit'))await mode.tap();await page.getByRole('button',{name:'Fit to content',exact:true}).tap();
  const x=Number((await pull(token)).find(r=>r.id==='qa-note').data.x);await page.getByRole('button',{name:'Item list',exact:true}).tap();await page.getByRole('button',{name:'Nudge right',exact:true}).tap();
  await eventually(async()=>Number((await pull(token)).find(r=>r.id==='qa-note')?.data?.x)===x+10);await page.getByRole('button',{name:'Close item list',exact:true}).tap();
  const note=page.locator('[data-mooditem="qa-note"]'),before=await note.boundingBox(),box=await canvas.boundingBox();assert.ok(before&&box);
  const cdp=await context.newCDPSession(page),center={x:box.x+box.width/2,y:box.y+box.height/2};
  try{
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[center]});
   for(const dx of [20,40,60])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...center,x:center.x-dx}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await eventually(async()=>Math.abs((await note.boundingBox()).x-before.x)>30,{timeout:5000});const panned=await note.boundingBox();assert.ok(Math.abs(panned.width-before.width)<2);
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...center,x:center.x-20},{...center,x:center.x+20}]});
   for(const dx of [30,40,55])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...center,x:center.x-dx},{...center,x:center.x+dx}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await eventually(async()=>(await note.boundingBox()).width>panned.width+5,{timeout:5000});assert.equal(Number((await pull(token)).find(r=>r.id==='qa-note').data.x),x+10,'Browse gestures must not mutate item position');
   await page.screenshot({path:join(output,platform+'-canvas-gestures.png')});return {nudgePersisted:true,pan:true,pinch:true,method:'CDP touch streams in real Android Chrome; not physical fingers'};
  }finally{await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]}).catch(()=>{});await cdp.detach();}
 });
 await page.close();
}
try{
 fixture=await startFixture({port:await freePort(),build:!process.argv.includes('--skip-build'),artifactDirectory:join(output,'fixture'),tls:useTls?tls:undefined});
 networkGate=await createNetworkGate(fixture.base,useTls?tls:undefined);fixture.base=networkGate.base;
 const signup=await api('/api/auth/signup',{method:'POST',body:{username:'admin',name:'Synthetic QA Admin',password:'password123'}});assert.equal(signup.status,200);const admin=signup.data;
 assert.ok(admin.token);const seeded=await api('/api/sync/push',{token:admin.token,method:'POST',body:{changes:[{id:'qa-page',collection:'pages',patch:{title:'Cross-platform QA',order:'a0'},ts:Date.now()},{id:'qa-block',collection:'blocks',patch:{pageId:'qa-page',type:'p',text:'QA fixture body',order:'a0'},ts:Date.now()},{id:'qa-task',collection:'tasks',patch:{boardId:'board-default',title:'Android task fixture',status:'todo',order:'a0'},ts:Date.now()},{id:'qa-mood',collection:'moodboards',patch:{title:'Android canvas fixture',order:'a0'},ts:Date.now()},{id:'qa-note',collection:'mooditems',patch:{boardId:'qa-mood',type:'note',text:'Android canvas note',x:100,y:100,w:220,h:140,z:1},ts:Date.now()}]}});assert.equal(seeded.status,200);assert.ok(!seeded.data.rejected);assert.deepEqual(seeded.data.rejectedItems??[],[]);
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
    // A visible WindowServer surface is not proof of an available AX window.
    // Activate ONLY the disposable browser's exact window and verify it before
    // native input; never fall back to the user's Chrome process or pixels.
    const activation=JSON.parse(execFileSync(cua,['call','bring_to_front',JSON.stringify(target)],{encoding:'utf8',timeout:15000}));
    writeFileSync(join(output,'native-zoom-activation.json'),JSON.stringify(activation));
    const observedState=call('get_window_state',{...target,include_screenshot:false});writeFileSync(join(output,'native-zoom-before.json'),JSON.stringify(observedState));
    if(!activation.activated||!activation.exact_window_effect?.verified||observedState.background_input?.exact_window?.status==='ax_unresolved'){
     call('end_session',{});const error=new Error('Exact owned Chrome accessibility window unavailable; native zoom requires an exposed authorized GUI surface');error.code='EXTERNAL_GUI';throw error;
    }
    const baseline=await page.evaluate(()=>({dpr:devicePixelRatio,width:innerWidth}));
    try{for(let i=0;i<8;i++){const previous=await page.evaluate(()=>devicePixelRatio);const action=call('invoke_menu',{...target,path:['View','Zoom In']});writeFileSync(join(output,`native-zoom-action-${i}.json`),JSON.stringify(action));if(action.status==='refused'||action.refusal){const error=new Error('Native GUI zoom action refused: '+JSON.stringify(action));error.code='EXTERNAL_GUI';throw error;}assert.ok(!action.error,JSON.stringify(action));await page.waitForFunction(dpr=>devicePixelRatio>dpr,previous,{timeout:5000});}
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
  let device=(await _android.devices()).find(d=>d.serial()===serial);assert.ok(device,'Owned Android emulator must be connected');
  await device.shell('settings put secure show_ime_with_hard_keyboard 1');
  const version=String(await device.shell('getprop ro.build.version.release')).trim();writeFileSync(join(output,'android-device.json'),JSON.stringify({serial,version,model:device.model(),physical:false}));
  try{for(const [name,size,density] of [['small','720x1280','320'],['large','1080x2400','420'],['tablet','1600x2560','240']]){
   await device.close();
   for(const args of [['am','force-stop','com.microsoft.playwright.androiddriver'],['wm','size',size],['wm','density',density],['pm','clear','com.android.chrome']])execFileSync(adb,['-s',serial,'shell',...args],{timeout:10000,stdio:'ignore'});
   await eventually(async()=>{try{if(execFileSync(adb,['-s',serial,'get-state'],{encoding:'utf8',timeout:3000}).trim()!=='device')return false;device=(await _android.devices()).find(d=>d.serial()===serial);return !!device}catch{return false}},{timeout:30000});
   writeFileSync(join(output,`android-${name}-display.txt`),execFileSync(adb,['-s',serial,'shell','wm','size'],{encoding:'utf8'})+'\n'+execFileSync(adb,['-s',serial,'shell','wm','density'],{encoding:'utf8'}));
   const context=await device.launchBrowser({hasTouch:true,args:[`--ignore-certificate-errors-spki-list=${spki}`],ignoreHTTPSErrors:true});try{
    // The browser DOM can respond behind Chrome's native first-run modal.
    // Inspect a fresh hierarchy and decline notifications before claiming real
    // touch/IME acceptance. Never grant a permission or adopt a personal profile.
    // Use one UiAutomation owner. A separate `uiautomator dump` process
    // returned 137 even after printing its XML receipt in the retained run.
    // Initialize the public native driver, inspect the real prompt, and only
    // treat only its explicit missing-widget response as absence; transport
    // and driver errors still fail.
    await device.wait({pkg:'com.android.chrome'},{timeout:20000});
    const nativeInfo=async selector=>{
     try{return await device.info(selector);}
     catch(error){
      // In the pinned Java driver, info(findObject(...)) dereferences null
      // for an absent widget. Match that exact lookup result, never a generic
      // NullPointerException or an ADB/transport/timeout failure.
      const missing="androidDevice.info: java.lang.NullPointerException: Attempt to invoke virtual method 'java.lang.String androidx.test.uiautomator.UiObject2.getClassName()' on a null object reference";
      if(error.message.split('\n')[0]===missing)return null;
      throw error; // A disconnected/hung driver is never widget absence.
     }
    };
    assert.ok(await nativeInfo({pkg:'com.android.chrome'}),'Native present-widget contract');
    assert.equal(await nativeInfo({pkg:'com.android.chrome',text:'__TCG_absent_preflight_widget__'}),null,'Native absence query contract');
    const prompt={pkg:'com.android.chrome',text:'Chrome notifications make things easier'},detectStarted=Date.now();
    const detected=await eventually(async()=>{const info=await nativeInfo(prompt);return info||Date.now()-detectStarted>=3000?{info}:false;},{timeout:5000});
    const promptVisible=!!detected.info;
    const setupEvidence={promptVisible,nativeApi:'Playwright AndroidDevice',permissionDecision:'No permission granted'};
    if(promptVisible){
     const decline={pkg:'com.android.chrome',text:'No thanks',clickable:true,enabled:true};
     await device.wait(decline,{timeout:5000});
     setupEvidence.declineTarget=await device.info(decline);
     writeFileSync(join(output,`android-${name}-setup.png`),await device.screenshot());
     writeFileSync(join(output,`android-${name}-setup-decline-target.json`),JSON.stringify(setupEvidence.declineTarget,null,2));
     await device.tap(decline,{timeout:5000});
     writeFileSync(join(output,`android-${name}-setup-after-tap.png`),await device.screenshot());
     // Playwright 1.63's Java wait handler ignores `state: gone`. Probe
     // explicit native absence; the exact missing-widget response is allowed.
     await eventually(async()=>(await nativeInfo(prompt))===null,{timeout:5000});
     setupEvidence.declined=true;
    }
    writeFileSync(join(output,`android-${name}-setup.json`),JSON.stringify(setupEvidence,null,2));
    await device.wait({pkg:'com.android.chrome',clazz:'android.webkit.WebView'},{timeout:15000});
    await journey(context,`android-${version}-chrome-${name}`,admin.token,(name==='small'||name==='tablet')?device:undefined);writeFileSync(join(output,`android-${name}.png`),await device.screenshot());
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
  }}finally{
   // AndroidDevice.close can leave its instrumentation transport alive. Stop
   // only this disposable device's test driver before closing the ADB client.
   try{execFileSync(adb,['-s',serial,'shell','am','force-stop','com.microsoft.playwright.androiddriver'],{timeout:10000,stdio:'ignore'});}
   finally{await device.close().catch(()=>{});try{execFileSync(adb,['-s',serial,'reverse','--remove',`tcp:${new URL(fixture.base).port}`]);}catch(e){writeFileSync(join(output,'android-cleanup-error.txt'),e.message);}}
  }
 }
 assert.equal(fingerprint(root),source.fingerprint,'Source unchanged during qualification');
}finally{await networkGate?.stop();await fixture?.stop();save();}
process.exitCode=results.some(r=>r.status==='FAIL')?1:results.some(r=>r.status==='BLOCKED')?2:0;
console.log(output);
