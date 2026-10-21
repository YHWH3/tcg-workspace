#!/usr/bin/env node
// Test-only XCUITest runner for the existing HTTPS application's Safari surface.
// Generates a temporary UI-test bundle; never creates a native production app.
// Apple Simulator Safari is additional evidence, not physical-device acceptance.
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,copyFileSync,writeFileSync,unlinkSync,readFileSync,openSync,closeSync,statSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {randomUUID} from 'node:crypto';
import {startFixture,bootstrap,eventually} from './phase4-fixture.mjs';
import {freePort,fingerprint,fetchFixtureApi} from './certification/core.mjs';
async function fixtureApi(base,path,{token,method='GET',body}={}){
 const response=await (base.startsWith('https://127.0.0.1:')?fetch:fetchFixtureApi)(base+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 return {status:response.status,data:await response.json()};
}
async function fixturePush(base,token,changes){
 const result=await fixtureApi(base,'/api/sync/push',{token,method:'POST',body:{changes:changes.map(change=>({ts:Date.now(),...change}))}});
 if(result.status!==200||result.data.rejected||result.data.rejectedItems?.length)throw new Error(`Apple fixture push failed (${result.status})`);
 return result;
}
async function fixturePull(base,token){
 let since=0,rows=[];
 for(let page=0;page<1000;page++){
  const result=await fixtureApi(base,`/api/sync/pull?since=${since}`,{token});
  if(result.status!==200)throw new Error('Apple fixture pull failed');
  rows.push(...result.data.records);if(!result.data.hasMore)return rows;
  if(!Number.isFinite(result.data.cursor)||result.data.cursor<=since)throw new Error('Apple fixture pull cursor did not advance');
  since=result.data.cursor;
 }
 throw new Error('Apple fixture pull exceeded 1000 pages');
}
const root=resolve(import.meta.dirname,'..');
const output=resolve(process.env.APPLE_ARTIFACT_DIR??join(root,'.artifacts/pr13-apple',new Date().toISOString().replaceAll(':','-')));mkdirSync(output,{recursive:true});
const useTls=process.argv.includes('--https');
if(useTls&&!process.env.TCG_APPLE_CERT){
 const dir=mkdtempSync(join(tmpdir(),'tcg-apple-tls-')),cert=join(dir,'cert.pem'),key=join(dir,'key.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
 chmodSync(key,0o600);
 // Trust only inside owned simulator clones, never the host/user keychain.
 const child=spawnSync(process.execPath,[import.meta.filename,...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,APPLE_ARTIFACT_DIR:output,TCG_APPLE_CERT:cert,TCG_APPLE_KEY:key,NODE_EXTRA_CA_CERTS:cert}});process.exit(child.status??1);
}
const tls=useTls?{cert:process.env.TCG_APPLE_CERT,key:process.env.TCG_APPLE_KEY}:undefined;
const run=(file,args,opts={})=>execFileSync(file,args,{cwd:root,encoding:'utf8',timeout:30000,...opts});
async function xcodeTest(args,logPath){
 // Keep the event loop free so fixture stdout, API sockets and timers continue
 // while native Safari runs. Blocking spawnSync can leave fixture logs stale.
 const fd=openSync(logPath,'w',0o600);let error=null,timedOut=false;
 try{return await new Promise(resolve=>{
  const child=spawn('xcodebuild',args,{cwd:root,stdio:['ignore',fd,fd],detached:true});
  const signal=kind=>{try{process.kill(-child.pid,kind);}catch{try{child.kill(kind);}catch{}}};
  const onExit=()=>signal('SIGTERM');process.once('exit',onExit);
  const outputLimit=setInterval(()=>{try{if(statSync(logPath).size>20*1024*1024){error=new Error('Native Xcode output exceeded 20 MiB');signal('SIGTERM');}}catch{}},500);
  const timer=setTimeout(()=>{timedOut=true;signal('SIGTERM');},600000);
  const killer=setTimeout(()=>signal('SIGKILL'),602000);
  child.once('error',e=>{error=e;});
  child.once('close',(status,exitSignal)=>{clearTimeout(timer);clearTimeout(killer);clearInterval(outputLimit);process.removeListener('exit',onExit);resolve({status,error:timedOut?new Error('Native Xcode test timed out after 600000ms'):error,signal:exitSignal});});
 });}finally{closeSync(fd);}
}

const source={sha:run('git',['rev-parse','HEAD']).trim(),tree:run('git',['rev-parse','HEAD^{tree}']).trim(),fingerprint:fingerprint(root),clean:!run('git',['status','--porcelain']).trim()};
const xcode=run('xcodebuild',['-version']),selectedPath=run('xcode-select',['-p']);
const runtimeInfo=JSON.parse(run('xcrun',['simctl','list','-j','runtimes']));
const inventory=JSON.parse(run('xcrun',['simctl','list','-j','devices','available']));
const desired=['TCG compact SE3 acceptance','iPhone 17','iPhone 17 Pro Max','iPad (A16)','iPad Pro 13-inch (M5)'];
const explicit=process.argv.find(a=>a.startsWith('--devices='))?.slice(10).split(',');
const interactiveIpad=!process.argv.includes('--preauthenticated-ipad');
const onlyTest=process.argv.find(a=>a.startsWith('--only-test='))?.slice(12);
const repetitions=Number(process.argv.find(a=>a.startsWith('--repetitions='))?.slice(14)??1);
if(!Number.isInteger(repetitions)||repetitions<1||repetitions>5)throw new Error('Native repetitions must be 1–5; every attempt is retained and required');
if(onlyTest&&!['test01LoginEditingRotation','test02AssistantProposal','test03SearchNavigation','test04CanvasAlternatives','test05CanvasPinch'].includes(onlyTest))throw new Error('Unknown Safari test');
const all=Object.entries(inventory.devices).flatMap(([runtime,devices])=>devices.map(d=>({...d,runtime})));
let devices=explicit?explicit.map(id=>all.find(d=>d.udid===id)).filter(Boolean):desired.map(name=>all.find(d=>d.name===name)).filter(Boolean);
if(!devices.length||devices.length!==(explicit??desired).length)throw new Error('Requested installed Apple simulator devices unavailable');
writeFileSync(join(output,'toolchain.json'),JSON.stringify({date:new Date().toISOString(),xcode,selectedPath,runtimeInfo,inventory,source},null,2));
const project=mkdtempSync(join(tmpdir(),'tcg-apple-safari-'));mkdirSync(join(project,'SafariTests.xcodeproj'));mkdirSync(join(project,'Tests'));
copyFileSync(join(root,'scripts/apple-safari/project.pbxproj'),join(project,'SafariTests.xcodeproj/project.pbxproj'));
copyFileSync(join(root,'scripts/apple-safari/SafariTests.swift'),join(project,'Tests/SafariTests.swift'));
let fixture;const results=[],ownedClones=[];
let probeBytes=0;const probePath='/'+randomUUID(),probeLog=join(output,'native-probe.jsonl');
const probeListener=(req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','*');
 if(req.method!=='POST'||req.url!==probePath){res.writeHead(404);res.end();return;}
 let body='';req.on('data',chunk=>{body+=chunk;if(body.length>65536)req.destroy();});req.on('end',()=>{
  try{const data=JSON.parse(body);if(probeBytes<8*1024*1024){const line=JSON.stringify({at:Date.now(),...data})+'\n';probeBytes+=line.length;writeFileSync(probeLog,line,{flag:'a',mode:0o600});}res.end('ok');}catch{res.writeHead(400);res.end();}
 });
};
const probe=useTls?createHttpsServer({key:readFileSync(tls.key),cert:readFileSync(tls.cert)},probeListener):createServer(probeListener);
await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const sink=`${useTls?'https':'http'}://127.0.0.1:${probe.address().port}${probePath}`;
try{
 if(useTls){devices=devices.map(device=>{const udid=run('xcrun',['simctl','clone',device.udid,`TCG HTTPS ${device.name} ${Date.now()}`],{timeout:120000}).trim();ownedClones.push(udid);return {...device,originalUdid:device.udid,udid,state:'Shutdown'};});writeFileSync(join(output,'owned-simulator-clones.json'),JSON.stringify({scope:'Disposable clones only; host and original simulator keychains unchanged',devices},null,2));}
 fixture=await startFixture({port:await freePort(),build:!process.argv.includes('--skip-build'),artifactDirectory:join(output,'fixture'),tls});
 const {admin}=useTls?{admin:(await fixtureApi(fixture.base,'/api/auth/signup',{method:'POST',body:{username:'admin',name:'Synthetic Safari Admin',password:'password123'}})).data}:await bootstrap(fixture.base);
 if(!admin.token)throw new Error('Disposable Safari authentication fixture failed');
 const index=join(fixture.directory,'client','index.html');
 writeFileSync(index,readFileSync(index,'utf8').replace('</head>','<script type="module" src="/apple-probe.mjs"></script></head>'));
 writeFileSync(join(fixture.directory,'client','apple-probe.mjs'),readFileSync(join(root,'scripts/apple-safari/probe.mjs'),'utf8').replace('__PROBE_SINK__',JSON.stringify(sink)));
 await fixturePush(fixture.base,admin.token,[
  {id:'apple-page',collection:'pages',patch:{title:'Apple Safari acceptance',order:'a0'}},
  {id:'apple-block',collection:'blocks',patch:{pageId:'apple-page',type:'p',text:'Safari fixture text: café 中文 🚀. Edit this paragraph and verify persistence.',order:'a0'}},
  {id:'apple-task',collection:'tasks',patch:{title:'Safari task fixture',boardId:'board-default',status:'todo',order:'a0'}},
  {id:'apple-mood',collection:'moodboards',patch:{title:'Apple Safari canvas',order:'a0'}},
  {id:'apple-note',collection:'mooditems',patch:{boardId:'apple-mood',type:'note',text:'Apple canvas note',x:100,y:100,w:220,h:140,z:1}},
 ]);
 // Explicit fallback only: --preauthenticated-ipad bypasses interactive sign-in.
 // Default acceptance always uses Safari's real sign-in form on all devices.
 // Tokens are in temporary local asset files, never URLs, logs or source.
 writeFileSync(join(fixture.directory,'client','apple-entry.mjs'),`localStorage.setItem('ws_token',${JSON.stringify(admin.token)});localStorage.setItem('ws_uid',${JSON.stringify(admin.user.id)});localStorage.setItem('ws_user',${JSON.stringify(JSON.stringify(admin.user))});location.replace('/pages/apple-page');`,{mode:0o600});
 writeFileSync(join(fixture.directory,'client','apple-entry.html'),'<!doctype html><title>Disposable Safari test entry</title><script type="module" src="/apple-entry.mjs"></script>',{mode:0o600});
 await new Promise(resolve=>setTimeout(resolve,2000));
 for(const {device,attempt} of devices.flatMap(device=>Array.from({length:repetitions},(_,i)=>({device,attempt:i+1})))){
  const dir=join(output,device.udid+(repetitions>1?`-attempt-${attempt}`:''));mkdirSync(dir);const bootedHere=device.state!=='Booted';let status='FAIL',error=null,exitCode=null;
  try{
   const marker=`${device.udid.slice(0,8)}-${Date.now().toString(36)}`;
   const pageMarker=`Safari edit café ${marker}`,taskMarker=`Safari property edit café ${marker}`,proposalTitle=`Apple simulator proposed page ${marker}`;
   await fixturePush(fixture.base,admin.token,[{id:'apple-block',collection:'blocks',patch:{text:'Safari fixture text: café 中文 🚀. Edit this paragraph and verify persistence.'}},{id:'apple-task',collection:'tasks',patch:{description:''}},{id:'apple-note',collection:'mooditems',patch:{x:100,y:100}}]);
   const swift=readFileSync(join(root,'scripts/apple-safari/SafariTests.swift'),'utf8').replaceAll('Safari edit café',pageMarker).replaceAll('Safari property edit café',taskMarker).replaceAll('Apple simulator proposed page',proposalTitle).replaceAll('__FIXTURE_BASE__',fixture.base).replaceAll('__FIXTURE_ENTRY__',device.name.startsWith('iPad')&&!interactiveIpad?'/apple-entry.html':'/pages/apple-page');
   const before=await fixturePull(fixture.base,admin.token);if(before.some(r=>r.collection==='pages'&&r.data?.title===proposalTitle))throw new Error('Proposal fixture title must not already exist');
   writeFileSync(join(project,'Tests/SafariTests.swift'),swift);
   if(bootedHere)run('xcrun',['simctl','boot',device.udid]);
   run('xcrun',['simctl','bootstatus',device.udid,'-b'],{timeout:120000});
   if(useTls)run('xcrun',['simctl','keychain',device.udid,'add-root-cert',tls.cert]);
   // XCTest opens the exact URL synchronously in every setUp; never trust an old Safari tab.
   const logStart=readFileSync(join(output,'fixture','worker.log'),'utf8').length;
   const child=await xcodeTest(['test','-project',join(project,'SafariTests.xcodeproj'),'-scheme','SafariTests','-destination',`platform=iOS Simulator,id=${device.udid}`,'-derivedDataPath',join(project,'DerivedData'),'-resultBundlePath',join(dir,'Safari.xcresult'),'-parallel-testing-enabled','NO','-test-timeouts-enabled','YES','-default-test-execution-time-allowance','120','-maximum-test-execution-time-allowance','180','CODE_SIGNING_ALLOWED=NO',...(onlyTest?[`-only-testing:SafariTests/SafariTests/${onlyTest}`]:[])],join(dir,'xcodebuild.log'));exitCode=child.status;
   if(child.error)throw child.error;
   try{run('xcrun',['xcresulttool','export','attachments','--path',join(dir,'Safari.xcresult'),'--output-path',join(dir,'screenshots')]);}catch{}
   try{for(const item of ['summary','tests'])writeFileSync(join(dir,`test-${item}.json`),run('xcrun',['xcresulttool','get','test-results',item,'--path',join(dir,'Safari.xcresult'),'--format','json']));}catch{}
   await new Promise(resolve=>setTimeout(resolve,200));
   const browserLog=readFileSync(join(output,'fixture','worker.log'),'utf8').slice(logStart);
   const navigationVerified=browserLog.includes('GET /pages/apple-page ')||device.name.startsWith('iPad')&&browserLog.includes('GET /apple-entry.html ');
   writeFileSync(join(dir,'navigation.json'),JSON.stringify({base:fixture.base,entry:device.name.startsWith('iPad')&&!interactiveIpad?'/apple-entry.html':'/pages/apple-page',navigationVerified}));
   const persisted=await fixturePull(fixture.base,admin.token);
   const persistence={pageEdit:String(persisted.find(r=>r.id==='apple-block')?.data?.text??'').includes(pageMarker),taskDescription:String(persisted.find(r=>r.id==='apple-task')?.data?.description??'').includes(taskMarker),canvasNudge:Number(persisted.find(r=>r.id==='apple-note')?.data?.x??0)===110,proposalCount:persisted.filter(r=>r.collection==='pages'&&r.data?.title===proposalTitle).length};
   writeFileSync(join(dir,'persistence.json'),JSON.stringify({scope:onlyTest??'All five Safari journeys',...persistence},null,2));
   if(!navigationVerified)throw new Error('Safari never requested the exact disposable fixture origin; cached content cannot satisfy this run');
   if(exitCode!==0)throw new Error(`xcodebuild exited ${exitCode}; inspect test results, not an assumed application defect`);
   await eventually(async()=>{const rows=await fixturePull(fixture.base,admin.token);return (!onlyTest||onlyTest==='test01LoginEditingRotation'?String(rows.find(r=>r.id==='apple-block')?.data?.text??'').includes(pageMarker):true)&&(!onlyTest||onlyTest==='test03SearchNavigation'?String(rows.find(r=>r.id==='apple-task')?.data?.description??'').includes(taskMarker):true)&&(!onlyTest||onlyTest==='test04CanvasAlternatives'?Number(rows.find(r=>r.id==='apple-note')?.data?.x??0)===110:true)&&(!onlyTest||onlyTest==='test02AssistantProposal'?rows.filter(r=>r.collection==='pages'&&r.data?.title===proposalTitle).length===1:true);},{timeout:10000});
   status='PASS';
  }catch(e){error=e.message;}
  finally{if(bootedHere)try{run('xcrun',['simctl','shutdown',device.udid]);}catch{}}
  results.push({device:device.name,attempt,authenticationMode:device.name.startsWith('iPad')&&!interactiveIpad?'Explicit preauthenticated synthetic fixture session; interactive sign-in NOT RUN':'Interactive Safari sign-in',udid:device.udid,runtime:device.runtime,status,exitCode,error});
  writeFileSync(join(output,'results.json'),JSON.stringify({source,protocol:useTls?'HTTPS, trusted temporary CA in disposable simulator clones':'HTTP loopback',scope:onlyTest??'All five Safari journeys',provider:'SIMULATED',approvalMode:'Authenticated inline browser approval with native software keyboard open; exactly-one server execution required',permissionMode:'DISABLED (platform parity only)',results,limitations:['Physical devices NOT RUN','Manual VoiceOver/TalkBack/NVDA NOT RUN','Native 400% zoom NOT RUN','Previous major runtime unavailable unless separately installed','Camera/microphone/file-provider hardware NOT RUN','PWA installation and offline suspension require separate acceptance']},null,2));
  console.log(`${status}: ${device.name} (${device.udid})`);
 }
 if(fingerprint(root)!==source.fingerprint)throw new Error('Source changed during Apple Safari run');
}finally{if(fixture)for(const file of ['apple-entry.html','apple-entry.mjs'])try{unlinkSync(join(fixture.directory,'client',file));}catch{}await fixture?.stop();await new Promise(resolve=>probe.close(resolve));for(const id of ownedClones)try{run('xcrun',['simctl','delete',id]);}catch{}}
process.exitCode=results.some(r=>r.status!=='PASS')?1:0;
console.log(output);
