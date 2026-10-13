import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export const json = (path, value) => { mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, JSON.stringify(value,null,2)+'\n'); };
export function localOrigin(base) {
  const u=new URL(base);
  if(u.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||u.pathname!=='/') throw new Error('Certification accepts only a loopback HTTP origin');
  return u.origin;
}
export async function freePort(port=0) {
  return await new Promise((resolve,reject)=>{
    const s=createServer();s.once('error',e=>reject(new Error(`Port ${port} unavailable: ${e.code}; no existing process will be reused or killed`)));
    s.listen({port,host:'127.0.0.1',exclusive:true},()=>{const n=s.address().port;s.close(e=>e?reject(e):resolve(n));});
  });
}
export function fingerprint(cwd) {
  const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd}).toString().split('\0').filter(Boolean).sort();
  const h=createHash('sha256');
  for(const f of [...new Set(files)]) {h.update(f+'\0');h.update(existsSync(`${cwd}/${f}`)?readFileSync(`${cwd}/${f}`):'<deleted>');}
  return h.digest('hex');
}
export function redact(text) {
  return text.replace(/("(?:access_token|refresh_token|token|password|client_secret|inviteCode|handle)"\s*:\s*")[^"]*/gi,'$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi,'Bearer [REDACTED]').replace(/([?&](?:code|token|access_token|refresh_token|client_secret)=)[^&\s"']+/gi,'$1[REDACTED]');
}
export function terminateGroup(child,signal='SIGTERM') {
  if(!child?.pid)return;
  try {process.kill(-child.pid,signal);}catch(e){if(e.code!=='ESRCH')try{child.kill(signal);}catch{}}
}
export async function runCommand(command,{cwd=process.cwd(),env={},logPath,timeoutMs=600000,signal}={}) {
  const startedAt=new Date().toISOString(),start=performance.now();
  let output='',pendingLog='',spawnError=null,timedOut=false,interrupted=false;
  if(logPath){mkdirSync(dirname(logPath),{recursive:true});writeFileSync(logPath,'');}
  const child=spawn(command[0],command.slice(1),{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe'],detached:true});
  let escalation;
  const stop=()=>{terminateGroup(child);escalation??=setTimeout(()=>terminateGroup(child,'SIGKILL'),500);};
  const abort=()=>{interrupted=true;stop();};
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
  for(const stream of [child.stdout,child.stderr])stream?.on('data',c=>{output+=c;pendingLog+=c;const end=pendingLog.lastIndexOf('\n');if(logPath&&end>=0){appendFileSync(logPath,redact(pendingLog.slice(0,end+1)));pendingLog=pendingLog.slice(end+1);}});
  const result=await new Promise(resolve=>{
    child.once('error',e=>{spawnError=String(e);});
    child.once('close',(exitCode,exitSignal)=>resolve({exitCode,signal:exitSignal}));
  });
  clearTimeout(timer);if(escalation)clearTimeout(escalation);signal?.removeEventListener('abort',abort);
  // Even a successful parent can leave descendants alive. They belong to this
  // dedicated process group, never the caller's shell or another desktop app.
  terminateGroup(child);await new Promise(r=>setTimeout(r,100));terminateGroup(child,'SIGKILL');
  output=redact(output);if(logPath){mkdirSync(dirname(logPath),{recursive:true});writeFileSync(logPath,output);}
  const error=spawnError??(timedOut?`Timeout after ${timeoutMs}ms; inspect ${logPath??'captured log'}`:interrupted?'Interrupted run':result.signal?`Unexpected termination: ${result.signal}`:result.exitCode!==0?`Command exited ${result.exitCode}`:null);
  return {command,startedAt,endedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-start),...result,timedOut,interrupted,error,output,logPath};
}
export function validateReport(report,{runner,sourceSha}={}) {
  if(!report||report.schemaVersion!==1||!Array.isArray(report.results)||!report.results.length)throw new Error('Missing, malformed or empty assertion report');
  if(runner&&report.runner!==runner)throw new Error(`Wrong runner ${report.runner}`);
  if(sourceSha&&report.sourceSha!==sourceSha)throw new Error('Report source SHA does not match tested source');
  if((report.mandatoryAssertionsExecuted??report.allMandatoryAssertionsExecuted)!==true)throw new Error('Not all mandatory assertions executed');
  if(Array.isArray(report.plannedTests)&&(!report.plannedTests.length||report.plannedTests.some(t=>report.completedTests?!report.completedTests.includes(t):!report.results.some(r=>`${r.engine}/${r.viewport}/${r.test}`===t))))throw new Error('Incomplete explicit assertion manifest');
  for(const r of report.results){if(!r.test||!r.engine||!r.viewport||!['PASS','FAIL','NOT RUN'].includes(r.status))throw new Error('Malformed assertion entry');if(r.status==='FAIL'&&!r.error)throw new Error(`FAIL lacks error details: ${r.test}`);}
  const pass=report.results.filter(r=>r.status==='PASS').length,fail=report.results.filter(r=>r.status==='FAIL').length,notRun=report.results.filter(r=>r.status==='NOT RUN'&&!r.external).length;
  if(report.summary&&(report.summary.pass!==pass||report.summary.fail!==fail))throw new Error('Report counts disagree with assertions');
  return {pass,fail,notRun,allMandatoryAssertionsExecuted:true,results:report.results,browserVersions:report.browserVersions??{}};
}
export function validateVitest(report,expectedFiles=[]) {
  if(!report||!Array.isArray(report.testResults)||!report.testResults.length)throw new Error('Empty or malformed Vitest report');
  const assertions=report.testResults.flatMap(r=>r.assertionResults??[]);
  if(!assertions.length||assertions.length!==report.numTotalTests)throw new Error('Missing or truncated Vitest assertions');
  for(const f of expectedFiles)if(!report.testResults.some(r=>r.name.endsWith('/'+f)))throw new Error(`Mandatory test file missing: ${f}`);
  const pass=assertions.filter(r=>r.status==='passed').length,fail=assertions.filter(r=>r.status==='failed').length,notRun=assertions.length-pass-fail;
  return {pass,fail,notRun,allMandatoryAssertionsExecuted:notRun===0,results:assertions.map(r=>({engine:'node',viewport:'none',test:r.fullName,status:r.status==='passed'?'PASS':r.status==='failed'?'FAIL':'NOT RUN',error:r.failureMessages?.join('\n')||null}))};
}
export function validateSmoke(output,source) {
  const planned=[...source.matchAll(/^check "([^"]+)"/gm)].map(r=>r[1]);
  const results=[...output.matchAll(/^  ([✅❌]) (.+)$/gm)].map(r=>({engine:'worker',viewport:'none',test:r[2].replace(/ \(want '[\s\S]*$/,''),status:r[1]==='✅'?'PASS':'FAIL',error:r[1]==='❌'?r[2]:null}));
  const summary=output.match(/^== (\d+) passed, (\d+) failed\s*$/m);
  if(!planned.length||!summary||results.length!==planned.length||planned.some((name,i)=>results[i]?.test!==name))throw new Error('Incomplete smoke execution: mandatory assertion manifest or terminal counts missing');
  const pass=results.filter(r=>r.status==='PASS').length,fail=results.length-pass;
  if(pass!==Number(summary[1])||fail!==Number(summary[2]))throw new Error('Malformed smoke terminal counts');
  return {pass,fail,notRun:0,allMandatoryAssertionsExecuted:true,results};
}
export function decision(rows,expectedIds) {
  const missing=expectedIds.filter(id=>!rows.some(r=>r.suiteId===id));
  return rows.some(r=>r.status==='FAIL')?'FAIL':missing.length||rows.some(r=>r.status==='NOT RUN')?'PARTIAL':'PASS';
}
export function migrationsManifest(cwd) {
  const lock=JSON.parse(readFileSync(`${cwd}/scripts/certification/migrations.json`));
  for(const row of lock){const path=`${cwd}/migrations/${row.name}`;if(!existsSync(path))throw new Error(`Missing D1 migration ${row.name}`);const hash=createHash('sha256').update(readFileSync(path)).digest('hex');if(hash!==row.sha256)throw new Error(`Migration changed ${row.name}; existing migrations must not be rewritten`);}
  return lock;
}
