#!/usr/bin/env node
// One-command, fail-closed local certification. Never deploys or uses personal state.
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, release, cpus, totalmem } from 'node:os';
import { createHash } from 'node:crypto';
let chromium, firefox, webkit;
import { startFixture, bootstrap } from './phase4-fixture.mjs';
import { assessSecurityAudit } from './certification/security.mjs';
import { json, fingerprint, preventIdleSleep, localOrigin, freePort, runCommand, validateReport, validateVitest, validateSmoke, migrationsManifest, decision, validatePerformanceEvidence } from './certification/core.mjs';

const cwd=fileURLToPath(new URL('../',import.meta.url));
const mode=process.argv.includes('--quick')?'quick':process.argv.includes('--extended')?'extended':'complete';
const sha=()=>execFileSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'}).trim();
const startingSha=sha(),startedAt=new Date().toISOString();
const directory=resolve(cwd,'.artifacts/certification',`${startingSha}-${startedAt.replace(/[:.]/g,'-')}-${mode}`);
mkdirSync(directory,{recursive:true});
const results=[],controller=new AbortController();let interrupted=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{interrupted=true;controller.abort();});
const expectedIds=['prerequisites','dependencies','lockfile','whitespace','migrations','harness','typecheck','unit','build','d1','security','performance-evidence','source-integrity'];
if(mode!=='quick')expectedIds.push('browsers','smoke','mcp-base','mcp-multiuser','mcp-phase1','mcp-phase2','mcp-phase3','mcp-phase4','v4','v6','v7','v8','v9');
if(mode==='extended')expectedIds.push('d1-stress-1','d1-stress-2');
const sleepGuard=preventIdleSleep();
process.once('exit',sleepGuard.stop);
const environment={sleepPrevention:sleepGuard.evidence,os:platform(),osRelease:release(),node:process.version,cpu:cpus()[0]?.model,memoryBytes:totalmem(),startingSha,branch:execFileSync('git',['branch','--show-current'],{cwd,encoding:'utf8'}).trim(),mode,startedAt,playwright:null};
json(join(directory,'environment.json'),environment);
let sourceFingerprint=fingerprint(cwd),buildOkay=false;
const timeout=Number(process.env.CERT_TIMEOUT_MS??1200000);
const timeoutError=!Number.isFinite(timeout)||timeout<1000?'CERT_TIMEOUT_MS must be at least 1000':null;
const safeEnv={WRANGLER_SEND_METRICS:'false',CLOUDFLARE_API_TOKEN:'',CLOUDFLARE_API_KEY:'',CLOUDFLARE_EMAIL:'',CF_API_TOKEN:'',CERT_SOURCE_SHA:startingSha,CERT_MANAGED_FIXTURE:'1',MCP_PASS:'password123',MCP_USER:'admin',MCP_USER_A:'admin',MCP_USER_B:'bob'};
function persist() {
  const verdict=decision(results,expectedIds),endedAt=new Date().toISOString();
  json(join(directory,'commands.json'),results.map(({command,startedAt,endedAt,durationMs,exitCode,signal,logPath,suiteId})=>({suiteId,command,startedAt,endedAt,durationMs,exitCode,signal,logPath})));
  json(join(directory,'test-results.json'),results);
  json(join(directory,'summary.json'),{schemaVersion:1,decision:verdict,mode,startingSha,finalTestedSha:sha(),sourceFingerprint,startedAt,endedAt,mandatorySuites:expectedIds,pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length,notRun:results.filter(r=>r.status==='NOT RUN').length,completeLocalCertification:mode!=='quick'&&verdict==='PASS',externalGates:[{name:'Physical iPhone/iPad Safari',status:'NOT RUN'},{name:'Physical Android',status:'NOT RUN'},{name:'Manual assistive technology',status:'NOT RUN'},{name:'Native 400% browser zoom',status:'NOT RUN',reason:'320px reflow equivalent is automated; not native zoom'}],securityExceptions:results.find(r=>r.suiteId==='security')?.securityAssessment?.exceptions??[],securityIndependentReviewRequired:results.find(r=>r.suiteId==='security')?.securityAssessment?.needsIndependentReview??true,productionReleaseCertified:false});
  const table=results.map(r=>`| ${r.suiteId} | ${r.status} | ${r.pass}/${r.fail}/${r.notRun} | ${(r.durationMs/1000).toFixed(1)} | ${r.fixtureId??'none'} | ${r.errorSummary?.replaceAll('|','/').replaceAll('\n',' ').slice(0,250)??''} |`).join('\n');
  const rows=results.flatMap(r=>(r.assertions??[]).map(t=>`| ${r.suiteId} | ${t.engine} | ${t.viewport} | ${String(t.test).replaceAll('|','/').replaceAll('\n',' ')} | ${t.status} |`)).join('\n');
  writeFileSync(join(directory,'report.md'),`# TCG Phase 0–4 local certification\n\nDecision: **${verdict}**. Mode: ${mode}. Starting and tested commit: \`${startingSha}\`. Source fingerprint: \`${sourceFingerprint}\`.\n\nRun: ${startedAt} to ${endedAt}. ${environment.os} ${environment.osRelease}; Node ${environment.node}; Playwright ${environment.playwright}.\n\n| Suite | Result | PASS/FAIL/NOT RUN | Seconds | Fixture | Error |\n|---|---|---|---:|---|---|\n${table}\n\nExact commands, exit codes, timestamps and log paths: [commands.json](commands.json). Complete per-assertion evidence and browser versions: [test-results.json](test-results.json). Security machine output: [security-audit.json](security-audit.json). Migration hashes and actual SQLite schema: [migrations.json](migrations.json). Local resource metrics: [performance.json](performance.json).\n\nPhysical iPhone/iPad Safari, physical Android, manual assistive technology and native browser 400% zoom remain NOT RUN production release gates. Automated 320px reflow is not native zoom evidence. The npm audit raw nonzero status is retained. The coordinated Agents/MCP upgrade removes the former OAuth-client advisory exception. All high/critical findings fail the security gate. Independent release review remains required. No merge/deployment performed. Quick mode cannot establish complete local certification.\n\n| Suite | Engine | Viewport | Assertion | Result |\n|---|---|---|---|---|\n${rows}\n`);
}
function record(id,commandResult,evidence={},extra={}) {
  const {output,...command}=commandResult;const warnings=(output??'').split('\n').filter(line=>/warning|exceed|will not move module/i.test(line)).slice(0,30);
  const failed=command.error||evidence.validationError||evidence.fail||evidence.notRun||evidence.allMandatoryAssertionsExecuted===false;
  const row={suiteId:id,...command,warnings,startingCommitSha:startingSha,finalTestedSourceSha:startingSha,sourceFingerprint,os:environment.os,node:environment.node,browserVersions:evidence.browserVersions??{},pass:evidence.pass??(failed?0:1),fail:evidence.fail??(failed?1:0),notRun:evidence.notRun??0,allMandatoryAssertionsExecuted:evidence.allMandatoryAssertionsExecuted??!failed,assertions:evidence.results??[],securityAssessment:evidence.securityAssessment??null,status:failed?'FAIL':'PASS',errorSummary:command.error??evidence.validationError??(failed?'Required assertion failed or did not execute':null),...extra};
  row.fixtureId ??= /^(unit|d1(?:-stress-\d+)?)$/.test(id)?`isolated-miniflare:${startingSha}:${id}`:'not-applicable';
  row.artifactPath = directory;
  results.push(row);console.log(`[${row.status}] ${id}: ${row.pass} PASS / ${row.fail} FAIL / ${row.notRun} NOT RUN (${(row.durationMs/1000).toFixed(1)}s)`);persist();return row;
}
async function stage(id,command,{adapter,env={},fixtureId,timeoutMs=timeout}={}) {
  if(interrupted)return record(id,{command,startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),durationMs:0,exitCode:null,error:'Interrupted before stage'},{pass:0,fail:0,notRun:1,allMandatoryAssertionsExecuted:false},{status:'NOT RUN',fixtureId});
  console.log(`Running ${id}…`);
  const result=await runCommand(command,{cwd,env:{...safeEnv,CERT_ARTIFACT_DIR:join(directory,id+'-artifacts'),...env},logPath:join(directory,id+'.log'),timeoutMs,signal:controller.signal});
  let evidence={};if(adapter)try{evidence=await adapter(result.output,result);if(evidence.acceptedExitCode===result.exitCode&&!result.timedOut&&!result.signal&&!result.interrupted){result.rawError=result.error;result.error=null;};}catch(e){result.error=[result.error,String(e)].filter(Boolean).join('; ');evidence={pass:0,fail:1,notRun:0,allMandatoryAssertionsExecuted:false};}
  return record(id,result,evidence,{fixtureId});
}
async function internal(id,fn) {
  const start=performance.now(),startedAt=new Date().toISOString();let evidence={},error;
  try{evidence=await fn()??{};}catch(e){error=String(e?.stack??e);}
  return record(id,{command:['internal',id],startedAt,endedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-start),exitCode:error?1:0,error},evidence);
}
function readJson(path){return JSON.parse(readFileSync(path,'utf8'));}
function runnerEvidence(path,runner) {
  const report=readJson(path);
  try{return validateReport(report,{runner,sourceSha:startingSha});}
  catch(error){
    // Keep valid observed assertion evidence on an incomplete run while marking
    // completeness false. These counts never turn a partial run into PASS.
    if(!Array.isArray(report.results)||report.results.some(r=>!r.test||!r.engine||!r.viewport||!['PASS','FAIL','NOT RUN'].includes(r.status)))throw error;
    return {pass:report.results.filter(r=>r.status==='PASS').length,fail:report.results.filter(r=>r.status==='FAIL').length||1,notRun:report.results.filter(r=>r.status==='NOT RUN'&&!r.external).length,allMandatoryAssertionsExecuted:false,results:report.results,browserVersions:report.browserVersions??{},validationError:String(error)};
  }
}
async function integration(id,script,{smoke=false,selfFixture=false,args=[]}={}) {
  if(!buildOkay||interrupted){record(id,{command:['node',script],startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),durationMs:0,exitCode:null,error:interrupted?'Certification interrupted':'Production build prerequisite failed'},{pass:0,fail:0,notRun:1,allMandatoryAssertionsExecuted:false},{status:'NOT RUN'});return;}
  let fixture;const out=join(directory,id);mkdirSync(out,{recursive:true});
  try {
    const port=await freePort();
    if(!selfFixture)fixture=await startFixture({port,build:false,artifactDirectory:out});
    const env={CERT_ARTIFACT_DIR:out,CERT_RESULT_PATH:join(out,'results.json'),CERT_FIXTURE_ID:fixture?.directory??id,CERT_FIXTURE_PORT:String(port),CERT_FILE_FIXTURES:join(out,'files')};
    if(id==='v4'){mkdirSync(env.CERT_FILE_FIXTURES,{recursive:true});const {default:sharp}=await import('sharp');const colors=['#db3746','#37a86a','#336ddd','#e7b638','#8248aa'];await sharp({create:{width:500,height:100,channels:3,background:colors[0]}}).composite(colors.slice(1).map((color,i)=>({input:Buffer.from(`<svg width="100" height="100"><rect width="100" height="100" fill="${color}"/></svg>`),left:(i+1)*100,top:0}))).png().toFile(join(env.CERT_FILE_FIXTURES,'photo.png'));writeFileSync(join(env.CERT_FILE_FIXTURES,'doc.pdf'),'%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF');}
    if(fixture){Object.assign(env,{PHASE4_FIXTURE_CONFIG:fixture.config,PHASE4_FIXTURE_STATE:fixture.state,PHASE4_BASE:fixture.base,PHASE3_BASE:fixture.base,V6_BASE:fixture.base,V7_BASE:fixture.base,V8_BASE:fixture.base});if(!smoke)await bootstrap(fixture.base);}
    const command=smoke?['bash',script,fixture.base]:['node',script,...(fixture?[fixture.base,'--no-spawn']:['--skip-build']),...args];
    const row=await stage(id,command,{env,fixtureId:fixture?.directory??`self:${port}`,adapter:output=>smoke?validateSmoke(output,readFileSync(join(cwd,script),'utf8')):runnerEvidence(env.CERT_RESULT_PATH,script.split('/').at(-1).replace('.mjs',''))});
    if(fixture){json(join(out,'fixture.json'),{id:fixture.directory,config:readJson(fixture.config),state:fixture.state,base:fixture.base,sourceSha:startingSha,disposable:true});const schema=await fixture.sql("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index','trigger') ORDER BY name;");json(join(out,'schema.json'),schema);}
    return row;
  }catch(e){record(id,{command:['node',script],startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),durationMs:0,exitCode:1,error:`Fixture/setup failed: ${e.stack??e}`},{pass:0,fail:1,notRun:0,allMandatoryAssertionsExecuted:false},{fixtureId:fixture?.directory});}
  finally {if(fixture)await fixture.stop();}
}

try {
  if(!existsSync(join(cwd,'node_modules/.bin/wrangler')))await stage('dependency-install',['npm','ci','--no-audit','--no-fund']);
  ({chromium,firefox,webkit}=await import('playwright'));environment.playwright=JSON.parse(readFileSync(join(cwd,'node_modules/playwright/package.json'))).version;json(join(directory,'environment.json'),environment);
  await internal('prerequisites',async()=>{
    if(timeoutError)throw new Error(timeoutError);
    for(const key of ['V6_BASE','V7_BASE','V8_BASE','PHASE3_BASE','PHASE4_BASE'])if(process.env[key])localOrigin(process.env[key]);
    for(const file of ['package-lock.json','node_modules/.package-lock.json','node_modules/.bin/wrangler','scripts/smoke.sh'])if(!existsSync(join(cwd,file)))throw new Error(`Missing prerequisite ${file}; run npm ci (or certification bootstrap)`);
    execFileSync('python3',['--version']);execFileSync('curl',['--version']);return {pass:6,fail:0,notRun:0,allMandatoryAssertionsExecuted:true};
  });
  await stage('dependencies',['npm','ls','--all','--json']);
  await stage('lockfile',['npm','ci','--dry-run','--ignore-scripts','--no-audit','--no-fund'],{adapter:()=>{
    const manifest=readJson(join(cwd,'package.json')),locked=readJson(join(cwd,'package-lock.json')).packages[''];
    for(const kind of ['dependencies','devDependencies'])if(Object.keys({...manifest[kind],...locked[kind]}).some(key=>manifest[kind]?.[key]!==locked[kind]?.[key]))throw new Error(`Lockfile ${kind} mismatch`);
    return {pass:2,fail:0,notRun:0,allMandatoryAssertionsExecuted:true};
  }});
  await stage('whitespace',['git','diff','--check','HEAD']);
  await internal('migrations',()=>{const manifest=migrationsManifest(cwd);const files=readdirSync(join(cwd,'migrations')).filter(f=>f.endsWith('.sql')).sort();if(files.length!==manifest.length)throw new Error('Register new migrations in certification/migrations.json');json(join(directory,'migrations.json'),{manifest,validation:'Hashes + actual-D1 migration tests + per-fixture SQLite schema'});return {pass:manifest.length,fail:0,notRun:0,allMandatoryAssertionsExecuted:true};});
  await stage('harness',['node','--test','--test-reporter=tap',...readdirSync(join(cwd,'scripts/certification')).filter(f=>f.endsWith('.test.mjs')).map(f=>'scripts/certification/'+f)],{adapter:output=>{const number=key=>Number(output.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]??NaN);const total=number('tests'),pass=number('pass'),fail=number('fail'),notRun=number('cancelled')+number('skipped');if(!total||!Number.isFinite(pass)||total!==pass+fail+notRun)throw new Error('Incomplete harness TAP report');return {pass,fail,notRun,allMandatoryAssertionsExecuted:notRun===0};}});
  await stage('typecheck',['npm','run','typecheck']);
  const unitPath=join(directory,'vitest.json'),testFiles=readdirSync(join(cwd,'tests')).filter(f=>f.endsWith('.test.ts')).map(f=>'tests/'+f);
  await stage('unit',['npm','test','--','--reporter=default','--reporter=json',`--outputFile=${unitPath}`],{adapter:()=>validateVitest(readJson(unitPath),testFiles)});
  buildOkay=(await stage('build',['npm','run','build'])).status==='PASS';
  const d1Files=testFiles.filter(f=>/(?:phase4|audit)-.*-d1\.test\.ts$/.test(f)),d1Path=join(directory,'d1-results.json');
  await stage('d1',['npm','test','--',...d1Files,'--reporter=default','--reporter=json',`--outputFile=${d1Path}`],{adapter:()=>validateVitest(readJson(d1Path),d1Files)});
  await stage('security',['npm','audit','--json'],{adapter:(output,result)=>{const report=JSON.parse(output);json(join(directory,'security-audit.json'),report);const assessment=assessSecurityAudit(report,{auditExitCode:result.exitCode,project:cwd});json(join(directory,'security-decisions.json'),assessment);return {pass:assessment.verdict==='PASS'?1:0,fail:assessment.verdict==='FAIL'?1:0,notRun:0,allMandatoryAssertionsExecuted:true,...(assessment.verdict==='PASS'?{acceptedExitCode:result.exitCode}:{}),securityAssessment:assessment};}});
  if(mode!=='quick') {
    await internal('browsers',async()=>{
      const versions={};for(const [name,type]of Object.entries({chromium,firefox,webkit})) {
        if(!existsSync(type.executablePath())){const install=await runCommand(['node','node_modules/playwright/cli.js','install',name],{cwd,env:safeEnv,logPath:join(directory,`browser-install-${name}.log`),timeoutMs:timeout,signal:controller.signal});if(install.error)throw new Error(`${name} install: ${install.error}`);}
        const browser=await type.launch({headless:true,timeout:60000});versions[name]=browser.version();await browser.close();
      }json(join(directory,'browser-versions.json'),versions);return {pass:3,fail:0,notRun:0,allMandatoryAssertionsExecuted:true,browserVersions:versions};
    });
    await integration('smoke','scripts/smoke.sh',{smoke:true});
    for(const [id,script]of [['mcp-base','verify-mcp'],['mcp-multiuser','verify-mcp-multiuser'],...['1','2','3','4'].map(n=>['mcp-phase'+n,'verify-mcp-phase'+n]),...['4','6','7','8','9'].map(n=>['v'+n,'verify-v'+n])])await integration(id,'scripts/'+script+'.mjs',{});
  }
  if(mode==='extended')for(let i=1;i<=2;i++){const path=join(directory,`d1-stress-${i}.json`);await stage(`d1-stress-${i}`,['npm','test','--',...d1Files,'--reporter=default','--reporter=json',`--outputFile=${path}`],{adapter:()=>validateVitest(readJson(path),d1Files)});}
  await internal('performance-evidence',()=>{
    const measurements=[];
    for(const id of ['unit','d1',...(mode==='extended'?['d1-stress-1','d1-stress-2']:[])]){
      const metricPath=join(directory,id+'-artifacts/performance/d1-performance.json');
      const report=validatePerformanceEvidence(readJson(metricPath));
      cpSync(metricPath,join(directory,id+'-performance.json'));
      measurements.push({suite:id,...report});
    }
    const browserMeasurements=mode==='quick'?[]:['v8','v9'].flatMap(id=>{
      const report=readJson(join(directory,id,'results.json'));
      if(!Array.isArray(report.performance)||!report.performance.length)throw new Error(`Missing browser performance evidence: ${id}`);
      return report.performance.map(metric=>({suite:id,...metric}));
    });
    json(join(directory,'performance.json'),{measurements,browserMeasurements,limitations:['Local Miniflare and Playwright measurements only; no Cloudflare regional latency or billing measured','Binding calls and SQL statements are separate counts; all() retains row metadata for first() observation']});
    return {pass:measurements.reduce((count,r)=>count+r.metrics.length,0)+browserMeasurements.length,fail:0,notRun:0,allMandatoryAssertionsExecuted:true};
  });
  await internal('source-integrity',()=>{
    if(sha()!==startingSha||fingerprint(cwd)!==sourceFingerprint)throw new Error('Source changed during certification; rerun the complete matrix on final source');
    return {pass:1,fail:0,notRun:0,allMandatoryAssertionsExecuted:true};
  });
}catch(e){record('orchestrator',{command:['node','scripts/certify-phase4.mjs'],startedAt,endedAt:new Date().toISOString(),durationMs:0,exitCode:1,error:String(e.stack??e)},{pass:0,fail:1,notRun:0,allMandatoryAssertionsExecuted:false});}
finally {
  for(const id of expectedIds)if(!results.some(r=>r.suiteId===id))record(id,{command:[],startedAt,endedAt:new Date().toISOString(),durationMs:0,exitCode:null,error:interrupted?'Run interrupted':'Mandatory suite did not execute'},{pass:0,fail:0,notRun:1,allMandatoryAssertionsExecuted:false},{status:'NOT RUN'});
  persist();const verdict=decision(results,expectedIds);console.log(`\n${verdict} — ${directory}/report.md`);process.exitCode=verdict==='PASS'?0:1;
}
