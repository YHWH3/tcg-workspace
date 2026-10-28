#!/usr/bin/env node
// One command, owned loopback HTTPS, fresh D1, synthetic data, no model/cloud calls.
import {spawn} from 'node:child_process';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHmac} from 'node:crypto';
import {startFixture,fixtureEnvironment} from './phase4-fixture.mjs';
import {freePort,fingerprint} from './certification/core.mjs';
import {surfaces,notCovered} from './ux-lab/catalog.mjs';
import {coverage} from './ux-lab/coverage.mjs';
import {ensureLabTls} from './ux-lab/tls.mjs';
const root=resolve(import.meta.dirname,'..'),output=resolve(process.env.UX_OUTPUT??join(root,'.artifacts/ux-lab',new Date().toISOString().replaceAll(':','-')));
mkdirSync(output,{recursive:true});
const args=process.argv.slice(2),record=args.includes('--record'),skipBuild=args.includes('--skip-build');
if(args.some(a=>/^--(?:update-snapshots|ui|headed|debug|reporter|config|output)/.test(a)))throw new Error('Use --record for explicit local baseline capture; interactive/alternate config flags are not supported by this fixture owner');
if(Boolean(process.env.UX_TLS_CERT)!==Boolean(process.env.UX_TLS_KEY))throw new Error('Set both UX_TLS_CERT and UX_TLS_KEY, or neither');
const tls={cert:resolve(process.env.UX_TLS_CERT??join(root,'.artifacts/ux-lab/tls/cert.pem')),key:resolve(process.env.UX_TLS_KEY??join(root,'.artifacts/ux-lab/tls/key.pem'))};
const tlsRenewed=ensureLabTls(tls,{provided:!!process.env.UX_TLS_CERT});
// Node reads additional CA roots at process startup. Trust only in this owned
// child process, never in the operating system or the user's browser profile.
if(process.env.NODE_EXTRA_CA_CERTS!==tls.cert||tlsRenewed){
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),...args],{cwd:root,env:{...process.env,UX_OUTPUT:output,NODE_EXTRA_CA_CERTS:tls.cert},stdio:'inherit'});
  process.exit(child.status??1);
}
const source={sha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),fingerprint:fingerprint(root)};
let owned,child,exitCode=1;
const cleanup=()=>{child?.kill('SIGTERM');void owned?.stop();};process.once('SIGINT',cleanup);process.once('SIGTERM',cleanup);
try{
  owned=await startFixture({port:await freePort(),build:!skipBuild,tls,artifactDirectory:join(output,'fixture'),vars:{WEBSITE_INGEST_ENABLED:'true',WEBSITE_INGEST_SECRET:'ux-lab-disposable'}});
  const req=async(path,body,token)=>{
    const r=await fetch(owned.base+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(`Fixture setup ${path}: ${r.status}`);return j;
  };
  const admin=await req('/api/auth/signup',{username:'admin',name:'Synthetic UX Admin',password:'password123'});
  const records=[
    {id:'ux-page',collection:'pages',patch:{title:'UX journal',order:'a0'}},
    {id:'ux-block',collection:'blocks',patch:{pageId:'ux-page',type:'paragraph',text:'Synthetic multilingual observations: café é 日本語 العربية 👩🏽‍💻',order:'a0'}},
    {id:'ux-records',collection:'boards',patch:{name:'UX records',kind:'records',recordNoun:'Record',columns:[{id:'todo',name:'To do',color:'gray'},{id:'done',name:'Done',color:'green'}],fields:[{id:'date',name:'Date',type:'date'},{id:'email',name:'Email',type:'email'}],defaultViewId:'ux-table',order:'a0'}},
    {id:'ux-tasks',collection:'boards',patch:{name:'UX tasks',kind:'tasks',columns:[{id:'todo',name:'To do',color:'gray'},{id:'done',name:'Done',color:'green'}],fields:[],order:'a1'}},
    {id:'ux-task',collection:'tasks',patch:{boardId:'ux-tasks',title:'UX task for input geometry',status:'todo',order:'a0'}},
    // Protocol 3 deliberately does not create legacy client seeds. Configure
    // the existing first-reply rule explicitly in this disposable fixture.
    {id:'auto-wi-first-reply',collection:'automations',patch:{databaseId:'board-website-inbox',name:'Website inbox: record the first reply date',enabled:true,trigger:{kind:'stage_changed',to:'replied'},conditions:[{key:'p_wi_replied',op:'empty'}],actions:[{type:'set_field',fieldKey:'p_wi_replied',value:'{{today}}'}],createdBy:admin.user.id,createdAt:Date.now()}},
    ...['table','list','gallery','board','calendar','timeline'].map((type,i)=>({id:'ux-'+type,collection:'views',patch:{databaseId:'ux-records',name:type[0].toUpperCase()+type.slice(1),type,config:{visible:['title','status','p_date','p_email'],dateKey:'p_date',groupBy:'status'},order:'a'+i}})),
    ...['Unicode café 👩🏽‍💻 日本語 العربية é','Very long synthetic record title '+('length '.repeat(14))].map((title,i)=>({id:'ux-record-'+i,collection:'tasks',patch:{boardId:'ux-records',title,status:'todo',p_date:new Date().toISOString().slice(0,10),p_email:'synthetic-long-address@example.org',order:'a'+i}})),
  ];
  const pushed=await req('/api/sync/push',{changes:records.map(r=>({...r,ts:Date.now()}))},admin.token);if(pushed.rejected||pushed.rejectedItems?.length)throw new Error('UX fixture seeding rejected');
  const grant=await fetch(owned.base+'/api/admin/website-ingest',{method:'PUT',headers:{Authorization:'Bearer '+admin.token,'Content-Type':'application/json'},body:JSON.stringify({spaceId:'space-core'})});if(grant.status!==200)throw new Error('UX service grant setup failed');
  const body={v:2,id:'ux-visual-event',event:'form.submitted',occurred_at:'2026-10-23T06:00:00.000Z',form_id:'consulting',subject:'UX application',page:'/consulting/',reply_to:'example-applicant@example.org',answers:[{name:'Name',label:'Your name',value:'Example Applicant'},{name:'Why',label:'What are you building?',value:'Synthetic testing data. No real applicant.'}]};
  const raw=JSON.stringify(body),timestamp=String(Math.floor(Date.now()/1000));
  const ingested=await fetch(owned.base+'/api/ingest/website',{method:'POST',headers:{'Content-Type':'application/json','X-TCG-Timestamp':timestamp,'X-TCG-Signature':'sha256='+createHmac('sha256','ux-lab-disposable').update(`${timestamp}.${raw}`).digest('hex')},body:raw});if(ingested.status!==200)throw new Error('UX event setup failed');
  await owned.sql('UPDATE access_state SET enabled=1 WHERE id=1');
  const authFile=join(output,'fixture-session.json');writeFileSync(authFile,JSON.stringify({base:owned.base,admin,disposable:true,owner:{config:owned.config,state:owned.state,directory:owned.directory,fixtureId:owned.fixtureId}}),{mode:0o600});
  // These ignored local reports can contain disposable session credentials in
  // traces. Never attach raw reports/traces to a public PR.
  const env={...fixtureEnvironment(),UX_OUTPUT:output,UX_FIXTURE:authFile,NODE_EXTRA_CA_CERTS:tls.cert,PLAYWRIGHT_HTML_OPEN:'never'};
  child=spawn(join(root,'node_modules/.bin/playwright'),['test','--config=scripts/ux-lab/playwright.config.mjs',...args.filter(a=>!['--record','--skip-build'].includes(a)),...(record?['--update-snapshots=all']:[])],{cwd:root,env,stdio:'inherit'});
  exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});child=undefined;
  if(fingerprint(root)!==source.fingerprint)throw new Error('Tracked source changed during UX lab verification');
  const reportPath=join(output,'playwright.json'),report=existsSync(reportPath)?JSON.parse(readFileSync(reportPath,'utf8')):null;
  const rows=[];
  function collect(suites){for(const suite of suites??[]){for(const spec of suite.specs??[])for(const t of spec.tests??[])rows.push({surface:spec.title,project:t.projectName,status:t.status,results:t.results?.map(r=>({status:r.status,error:r.error?.message??null,attachments:r.attachments?.map(a=>({name:a.name,path:a.path}))}))});collect(suite.suites);}}
  collect(report?.suites);
  const attachments=[];
  function readMetadata(suites){for(const s of suites??[]){for(const spec of s.specs??[])for(const t of spec.tests??[])for(const r of t.results??[])for(const a of r.attachments??[])if(a.body&&['runtime.json','exploration-replay.json'].includes(a.name))attachments.push({project:t.projectName,name:a.name,data:JSON.parse(Buffer.from(a.body,'base64').toString())});readMetadata(s.suites);}}
  readMetadata(report?.suites);
  const summary={source,recordMode:record,selection:args,exitCode,stats:report?.stats??null,rows,runtimes:[...new Map(attachments.filter(a=>a.name==='runtime.json').map(a=>[a.project,a.data])).entries()].map(([project,data])=>({project,...data})),explorations:attachments.filter(a=>a.name==='exploration-replay.json'),surfaces:surfaces.map(s=>s.id),baselineReview:'GENERATED_REFERENCE_NOT_HUMAN_ACCEPTANCE',notCovered,scope:'Matrix: 3 engines × 3 viewport sizes × 2 themes. Only executed named states and bounded generated interactions count. No claim of all features/devices.',report:join(output,'html/index.html')};
  if(!rows.length)summary.exitCode=exitCode=1;
  coverage(summary,output);
  if(!record&&!args.some(a=>/^--(?:project|grep)/.test(a))&&!summary.coverage.complete)summary.exitCode=exitCode=1;
  writeFileSync(join(output,'summary.json'),JSON.stringify(summary,null,2));
  if(record){const dir=join(root,'.artifacts/ux-lab/baselines');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'provenance.json'),JSON.stringify({source,recordedAt:new Date().toISOString(),review:'UNREVIEWED',output},null,2));}
  writeFileSync(join(output,'README.md'),`# UX lab results\n\nSource ${source.sha}; fingerprint ${source.fingerprint}.\n\nExit: ${exitCode}. Baselines: generated references, no human acceptance implied.\n\nOpen html/index.html for screenshots, accessibility failures and replay traces. Reports are local only: synthetic sessions may appear in traces.\n\nUncovered:\n${notCovered.map(s=>'- '+s).join('\n')}\n`);
  console.log(`UX lab exit ${exitCode}; local report ${summary.report}`);
}finally{await owned?.stop();process.removeListener('SIGINT',cleanup);process.removeListener('SIGTERM',cleanup);}
process.exitCode=exitCode;
