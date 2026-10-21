#!/usr/bin/env node
// Shipping Firefox for Android via Mozilla geckodriver, not a desktop UA.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,openSync,closeSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {startFixture,bootstrap,push,pull,eventually} from './phase4-fixture.mjs';
import {freePort,fingerprint} from './certification/core.mjs';
const root=resolve(import.meta.dirname,'..'),out=resolve(process.env.CROSS_QA_ARTIFACT_DIR??`.artifacts/cross-platform/firefox-android-${Date.now()}`);mkdirSync(out,{recursive:true});
const serial=process.env.QA_ANDROID_SERIAL,driver=resolve(process.env.GECKODRIVER_BIN??'.artifacts/cross-platform/geckodriver'),adb=process.env.ANDROID_ADB??'/Users/trinity/Library/Android/sdk/platform-tools/adb';
assert.ok(serial?.startsWith('emulator-'),'Explicit disposable emulator required');assert.ok(existsSync(driver),'Install the official Mozilla geckodriver in an ignored tool directory');
const source={sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),fingerprint:fingerprint(root),clean:!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()},results=[];
const port=await freePort(),driverBase=`http://127.0.0.1:${port}`,fd=openSync(join(out,'geckodriver.log'),'w',0o600);
const child=spawn(driver,['--host','127.0.0.1','--port',String(port)],{stdio:['ignore',fd,fd],env:{...process.env,ANDROID_HOME:resolve(adb,'../..'),PATH:resolve(adb,'..')+':'+process.env.PATH}});let session,fixture;
async function request(path,method='GET',body){const r=await fetch(driverBase+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});const d=(await r.json()).value;if(!r.ok||d?.error)throw new Error(d?.message??`WebDriver ${r.status}`);return d;}
const call=(path,method='GET',body)=>request(`/session/${session}${path}`,method,body);
const script=(value,args=[])=>call('/execute/sync','POST',{script:value,args});
let nativeStep=0;
function nativeTree(){
 const path='/sdcard/tcg-firefox-qa.xml';const result=execFileSync(adb,['-s',serial,'shell','uiautomator','dump',path],{encoding:'utf8',timeout:15000});assert.ok(result.includes('dumped'),'Fresh native hierarchy required; stale files cannot satisfy setup');
 const xml=execFileSync(adb,['-s',serial,'shell','cat',path],{encoding:'utf8'});writeFileSync(join(out,`native-setup-${++nativeStep}.xml`),xml);return xml;
}
function tapNative(xml,text){
 const node=xml.match(new RegExp('<node[^>]*text="'+text+'"[^>]*>'))?.[0];assert.ok(node,`Observed native ${text} control required`);const bounds=node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);assert.ok(bounds);const [x,y,right,bottom]=bounds.slice(1).map(Number);execFileSync(adb,['-s',serial,'shell','cmd','input','tap',String(Math.round((x+right)/2)),String(Math.round((y+bottom)/2))]);
}
async function find(selector){return eventually(async()=>{try{return (await call('/element','POST',{using:'css selector',value:selector}))['element-6066-11e4-a52e-4f735466cecf']}catch{return false}},{timeout:20000});}
async function type(selector,text){const id=await find(selector);await call(`/element/${id}/value`,'POST',{text});}
async function test(name,fn){try{const evidence=await fn();results.push({name,status:'PASS',evidence});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:e.message});console.error('FAIL '+name+': '+e.message);try{writeFileSync(join(out,`native-failure-${results.length}.png`),execFileSync(adb,['-s',serial,'exec-out','screencap','-p']));}catch{}if(session)try{writeFileSync(join(out,`failure-${results.length}.png`),Buffer.from(await call('/screenshot'),'base64'));}catch{}}}
try{
 await eventually(async()=>{try{return (await request('/status')).ready}catch{return false}},{timeout:10000});
 fixture=await startFixture({port:await freePort(),build:!process.argv.includes('--skip-build'),artifactDirectory:join(out,'fixture')});const {admin}=await bootstrap(fixture.base);
 await push(fixture.base,admin.token,[{id:'ff-page',collection:'pages',patch:{title:'Firefox Android acceptance',order:'a0'}},{id:'ff-block',collection:'blocks',patch:{pageId:'ff-page',type:'p',text:'Firefox fixture body',order:'a0'}}]);
 execFileSync(adb,['-s',serial,'reverse',`tcp:${new URL(fixture.base).port}`,`tcp:${new URL(fixture.base).port}`]);
 execFileSync(adb,['-s',serial,'shell','am','force-stop','com.android.chrome']);execFileSync(adb,['-s',serial,'shell','am','force-stop','com.microsoft.playwright.androiddriver']);execFileSync(adb,['-s',serial,'shell','wm','size','720x1280']);execFileSync(adb,['-s',serial,'shell','wm','density','320']);const created=await request('/session','POST',{capabilities:{alwaysMatch:{browserName:'firefox','moz:firefoxOptions':{androidPackage:'org.mozilla.firefox',androidDeviceSerial:serial}}}});session=created.sessionId;writeFileSync(join(out,'device.json'),JSON.stringify({serial,capabilities:created.capabilities,physical:false,origin:fixture.base,protocol:'HTTP loopback, not HTTPS staging'}));
 // Geckodriver resets Fenix app data for each session. Native onboarding covers
 // the browser even though Marionette can already see the document underneath.
 let xml=nativeTree();for(let i=0;i<6;i++){if(xml.includes('Welcome to Firefox'))tapNative(xml,'Continue');else if(xml.includes('default browser app?')&&xml.includes('text="Cancel"'))tapNative(xml,'Cancel');else if(xml.includes('text="Not now"'))tapNative(xml,'Not now');else break;xml=nativeTree();}
 assert.ok(!xml.includes('Welcome to Firefox')&&!xml.includes('default browser app?'),'Real native onboarding must finish before content interaction');
 await test('Shipping Android Firefox interactive login and Unicode persistence',async()=>{
  execFileSync(adb,['-s',serial,'shell','am','start','-a','android.intent.action.VIEW','-d',fixture.base+'/pages/ff-page','-p','org.mozilla.firefox']);await eventually(async()=>{for(const handle of await call('/window/handles')){await call('/window','POST',{handle});if((await call('/url')).startsWith(fixture.base+'/pages/ff-page'))return true}return false},{timeout:20000});await type('input[autocomplete="username"]','admin');await type('input[type="password"]','password123');const submit=await find('form[aria-label="Sign in form"] button[type="submit"]');await call(`/element/${submit}/click`,'POST',{});
  const editor=await find('[data-block-id="ff-block"] [contenteditable="true"]');await call(`/element/${editor}/click`,'POST',{});const text=' Android Firefox café 日本語';await call(`/element/${editor}/value`,'POST',{text});await script('document.activeElement.blur()');
  await eventually(async()=>(await pull(fixture.base,admin.token)).find(r=>r.id==='ff-block')?.data?.text?.includes(text),{timeout:25000});await call('/refresh','POST',{});await find('[data-block-id="ff-block"] [contenteditable="true"]');assert.ok((await script('return document.querySelector(\'[data-block-id="ff-block"] [contenteditable="true"]\').textContent')).includes(text));
  writeFileSync(join(out,'firefox-android-saved.png'),Buffer.from(await call('/screenshot'),'base64'));return {persisted:true,reloaded:true,unicode:true};
 });
 await test('Android Firefox search navigation and responsive root',async()=>{
  const search=await find('button[aria-label^="Search"]');await call(`/element/${search}/click`,'POST',{});await type('input[aria-label="Search workspace"]','Firefox');await eventually(async()=>await script('return [...document.querySelectorAll(\'[role="dialog"] a,[role="option"]\')].some(e=>e.textContent.includes("Firefox Android acceptance"))'));
  const geometry=await script('return {width:innerWidth,scroll:document.documentElement.scrollWidth}');assert.ok(geometry.scroll<=geometry.width+1);return geometry;
 });
 assert.equal(fingerprint(root),source.fingerprint);
}finally{if(session)await request(`/session/${session}`,'DELETE').catch(()=>{});if(fixture){execFileSync(adb,['-s',serial,'reverse','--remove',`tcp:${new URL(fixture.base).port}`]);await fixture.stop();}child.kill('SIGTERM');closeSync(fd);writeFileSync(join(out,'results.json'),JSON.stringify({source,platform:'Android Firefox, real emulator browser',provider:'NONE',results},null,2));}
process.exitCode=results.some(r=>r.status!=='PASS')?1:0;console.log(out);
