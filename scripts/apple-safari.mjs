#!/usr/bin/env node
// Test-only XCUITest runner for the existing HTTPS application's Safari surface.
// Generates a temporary UI-test bundle; never creates a native production app.
// Apple Simulator Safari is additional evidence, not physical-device acceptance.
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,copyFileSync,writeFileSync,unlinkSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {startFixture,bootstrap,push,pull,eventually} from './phase4-fixture.mjs';
import {freePort,fingerprint} from './certification/core.mjs';
const root=resolve(import.meta.dirname,'..');
const output=resolve(process.env.APPLE_ARTIFACT_DIR??join(root,'.artifacts/pr13-apple',new Date().toISOString().replaceAll(':','-')));mkdirSync(output,{recursive:true});
const run=(file,args,opts={})=>execFileSync(file,args,{cwd:root,encoding:'utf8',timeout:30000,...opts});
const source={sha:run('git',['rev-parse','HEAD']).trim(),tree:run('git',['rev-parse','HEAD^{tree}']).trim(),fingerprint:fingerprint(root),clean:!run('git',['status','--porcelain']).trim()};
const xcode=run('xcodebuild',['-version']),selectedPath=run('xcode-select',['-p']);
const runtimeInfo=JSON.parse(run('xcrun',['simctl','list','-j','runtimes']));
const inventory=JSON.parse(run('xcrun',['simctl','list','-j','devices','available']));
const desired=['TCG compact SE3 acceptance','iPhone 17','iPhone 17 Pro Max','iPad (A16)','iPad Pro 13-inch (M5)'];
const explicit=process.argv.find(a=>a.startsWith('--devices='))?.slice(10).split(',');
const onlyTest=process.argv.find(a=>a.startsWith('--only-test='))?.slice(12);
if(onlyTest&&!['test01LoginEditingRotation','test02AssistantProposal','test03SearchNavigation','test04CanvasAlternatives'].includes(onlyTest))throw new Error('Unknown Safari test');
const all=Object.entries(inventory.devices).flatMap(([runtime,devices])=>devices.map(d=>({...d,runtime})));
const devices=explicit?explicit.map(id=>all.find(d=>d.udid===id)).filter(Boolean):desired.map(name=>all.find(d=>d.name===name)).filter(Boolean);
if(!devices.length||explicit&&devices.length!==explicit.length)throw new Error('Requested installed Apple simulator devices unavailable');
writeFileSync(join(output,'toolchain.json'),JSON.stringify({date:new Date().toISOString(),xcode,selectedPath,runtimeInfo,inventory,source},null,2));
const project=mkdtempSync(join(tmpdir(),'tcg-apple-safari-'));mkdirSync(join(project,'SafariTests.xcodeproj'));mkdirSync(join(project,'Tests'));
copyFileSync(join(root,'scripts/apple-safari/project.pbxproj'),join(project,'SafariTests.xcodeproj/project.pbxproj'));
copyFileSync(join(root,'scripts/apple-safari/SafariTests.swift'),join(project,'Tests/SafariTests.swift'));
let fixture;const results=[];
try{
 fixture=await startFixture({port:await freePort(),build:!process.argv.includes('--skip-build'),artifactDirectory:join(output,'fixture')});
 const {admin}=await bootstrap(fixture.base);
 await push(fixture.base,admin.token,[
  {id:'apple-page',collection:'pages',patch:{title:'Apple Safari acceptance',order:'a0'}},
  {id:'apple-block',collection:'blocks',patch:{pageId:'apple-page',type:'p',text:'Safari fixture text: café 中文 🚀. Edit this paragraph and verify persistence.',order:'a0'}},
  {id:'apple-task',collection:'tasks',patch:{title:'Safari task fixture',boardId:'board-default',status:'todo',order:'a0'}},
  {id:'apple-mood',collection:'moodboards',patch:{title:'Apple Safari canvas',order:'a0'}},
  {id:'apple-note',collection:'mooditems',patch:{boardId:'apple-mood',type:'note',text:'Apple canvas note',x:100,y:100,w:220,h:140,z:1}},
 ]);
 // Fixture-only session entry avoids Xcode's iPad secure-keyboard idle bug.
 // Tokens are in temporary local asset files, never URLs, logs or source.
 writeFileSync(join(fixture.directory,'client','apple-entry.mjs'),`localStorage.setItem('ws_token',${JSON.stringify(admin.token)});localStorage.setItem('ws_uid',${JSON.stringify(admin.user.id)});localStorage.setItem('ws_user',${JSON.stringify(JSON.stringify(admin.user))});location.replace('/pages/apple-page');`,{mode:0o600});
 writeFileSync(join(fixture.directory,'client','apple-entry.html'),'<!doctype html><title>Disposable Safari test entry</title><script type="module" src="/apple-entry.mjs"></script>',{mode:0o600});
 await new Promise(resolve=>setTimeout(resolve,2000));
 for(const device of devices){
  const dir=join(output,device.udid);mkdirSync(dir);const bootedHere=device.state!=='Booted';let status='FAIL',error=null,exitCode=null;
  try{
   const marker=`${device.udid.slice(0,8)}-${Date.now().toString(36)}`;
   const pageMarker=`Safari edit café ${marker}`,taskMarker=`Safari property edit café ${marker}`,proposalTitle=`Apple simulator proposed page ${marker}`;
   await push(fixture.base,admin.token,[{id:'apple-block',collection:'blocks',patch:{text:'Safari fixture text: café 中文 🚀. Edit this paragraph and verify persistence.'}},{id:'apple-task',collection:'tasks',patch:{description:''}},{id:'apple-note',collection:'mooditems',patch:{x:100,y:100}}]);
   const swift=readFileSync(join(root,'scripts/apple-safari/SafariTests.swift'),'utf8').replaceAll('Safari edit café',pageMarker).replaceAll('Safari property edit café',taskMarker).replaceAll('Apple simulator proposed page',proposalTitle);
   const before=await pull(fixture.base,admin.token);if(before.some(r=>r.collection==='pages'&&r.data?.title===proposalTitle))throw new Error('Proposal fixture title must not already exist');
   writeFileSync(join(project,'Tests/SafariTests.swift'),swift);
   if(bootedHere)run('xcrun',['simctl','boot',device.udid]);
   run('xcrun',['simctl','bootstatus',device.udid,'-b'],{timeout:120000});
   run('xcrun',['simctl','openurl',device.udid,fixture.base+(device.name.startsWith('iPad')?'/apple-entry.html':'/pages/apple-page')]);
   const child=spawnSync('xcodebuild',['test','-project',join(project,'SafariTests.xcodeproj'),'-scheme','SafariTests','-destination',`platform=iOS Simulator,id=${device.udid}`,'-derivedDataPath',join(project,'DerivedData'),'-resultBundlePath',join(dir,'Safari.xcresult'),'-parallel-testing-enabled','NO','CODE_SIGNING_ALLOWED=NO',...(onlyTest?[`-only-testing:SafariTests/SafariTests/${onlyTest}`]:[])],{cwd:root,encoding:'utf8',timeout:600000,maxBuffer:20*1024*1024});
   writeFileSync(join(dir,'xcodebuild.log'),(child.stdout??'')+(child.stderr??''));exitCode=child.status;
   if(child.error)throw child.error;
   try{run('xcrun',['xcresulttool','export','attachments','--path',join(dir,'Safari.xcresult'),'--output-path',join(dir,'screenshots')]);}catch{}
   try{for(const item of ['summary','tests'])writeFileSync(join(dir,`test-${item}.json`),run('xcrun',['xcresulttool','get','test-results',item,'--path',join(dir,'Safari.xcresult'),'--format','json']));}catch{}
   if(exitCode!==0)throw new Error(`xcodebuild exited ${exitCode}; inspect test results, not an assumed application defect`);
   await eventually(async()=>{const rows=await pull(fixture.base,admin.token);return (!onlyTest||onlyTest==='test01LoginEditingRotation'?String(rows.find(r=>r.id==='apple-block')?.data?.text??'').includes(pageMarker):true)&&(!onlyTest||onlyTest==='test03SearchNavigation'?String(rows.find(r=>r.id==='apple-task')?.data?.description??'').includes(taskMarker):true)&&(!onlyTest||onlyTest==='test04CanvasAlternatives'?Number(rows.find(r=>r.id==='apple-note')?.data?.x??0)>100:true)&&(!onlyTest||onlyTest==='test02AssistantProposal'?rows.filter(r=>r.collection==='pages'&&r.data?.title===proposalTitle).length===1:true);},{timeout:10000});
   writeFileSync(join(dir,'persistence.json'),JSON.stringify({check:'Unicode page edit, task description edit and non-drag canvas nudge confirmed in server records',status:'PASS'}));
   status='PASS';
  }catch(e){error=e.message;}
  finally{if(bootedHere)try{run('xcrun',['simctl','shutdown',device.udid]);}catch{}}
  results.push({device:device.name,authenticationMode:device.name.startsWith('iPad')?'Preauthenticated synthetic fixture session; interactive sign-in NOT RUN (XCTest secure-keyboard quiescence)':'Interactive Safari sign-in',udid:device.udid,runtime:device.runtime,status,exitCode,error});
  writeFileSync(join(output,'results.json'),JSON.stringify({source,scope:onlyTest??'All four Safari journeys',provider:'SIMULATED',permissionMode:'DISABLED (platform parity only)',results,limitations:['Physical devices NOT RUN','Manual VoiceOver/TalkBack/NVDA NOT RUN','Native 400% zoom NOT RUN','Previous major runtime unavailable unless separately installed','Camera/microphone/file-provider hardware NOT RUN','PWA installation and offline suspension require separate acceptance']},null,2));
  console.log(`${status}: ${device.name} (${device.udid})`);
 }
 if(fingerprint(root)!==source.fingerprint)throw new Error('Source changed during Apple Safari run');
}finally{if(fixture)for(const file of ['apple-entry.html','apple-entry.mjs'])try{unlinkSync(join(fixture.directory,'client',file));}catch{}await fixture?.stop();}
process.exitCode=results.some(r=>r.status!=='PASS')?1:0;
console.log(output);
