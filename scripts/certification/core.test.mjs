import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { runCommand, validateReport, validateVitest, validateSmoke, decision, freePort, localOrigin, migrationsManifest } from './core.mjs';
const dir=mkdtempSync(join(tmpdir(),'tcg-cert-harness-'));
const child=(code,options={})=>runCommand([process.execPath,'-e',code],{timeoutMs:5000,logPath:join(dir,Math.random()+'.log'),...options});
const report=()=>({schemaVersion:1,runner:'fixture',sourceSha:'sha',mandatoryAssertionsExecuted:true,results:[{engine:'chromium',viewport:'compact',test:'assertion',status:'PASS',error:null}],summary:{pass:1,fail:0}});
test('local API read retries a transport reset but returns the actual authorization response',async()=>{
  const {fetchFixtureApi}=await import('./core.mjs');let calls=0;
  const response=await fetchFixtureApi('http://127.0.0.1:8788/api/me',{},async()=>{
    if(++calls===1)throw new TypeError('fetch failed',{cause:{code:'ECONNRESET'}});
    return new Response('denied',{status:401});
  });
  assert.equal(calls,2);assert.equal(response.status,401);
});
test('local fixture requests use a fresh connection after external D1 CLI updates',async()=>{
  const {fetchFixtureApi}=await import('./core.mjs');
  await fetchFixtureApi('http://localhost:8788/mcp',{method:'POST',headers:{Authorization:'Bearer fixture-only'}},async(_,init)=>{
    const headers=new Headers(init.headers);assert.equal(headers.get('connection'),'close');assert.equal(headers.get('authorization'),'Bearer fixture-only');
    return new Response('denied',{status:401});
  });
});
test('local API writes and HTTP failures are never retried',async()=>{
  const {fetchFixtureApi}=await import('./core.mjs');let calls=0;
  await assert.rejects(fetchFixtureApi('http://localhost:8788/token',{method:'POST'},async()=>{calls++;throw new Error('reset');}),/1 attempt/);
  assert.equal(calls,1);calls=0;
  const response=await fetchFixtureApi('http://localhost:8788/api/me',{},async()=>{calls++;return new Response('failure',{status:500});});
  assert.equal(calls,1);assert.equal(response.status,500);
});
test('repeated local API transport failure stays failed with safe cause diagnostics',async()=>{
  const {fetchFixtureApi}=await import('./core.mjs');let calls=0;
  await assert.rejects(fetchFixtureApi('http://localhost:8788/api/me?token=not-for-logs',{},async()=>{calls++;throw new TypeError('fetch failed',{cause:{code:'UND_ERR_SOCKET'}});}),error=>{
    assert.match(error.message,/GET \/api\/me.*2 attempts.*UND_ERR_SOCKET/);assert.doesNotMatch(error.message,/not-for-logs/);return true;
  });assert.equal(calls,2);
});
test('local API retry cannot request a remote or credentialed origin',async()=>{
  const {fetchFixtureApi}=await import('./core.mjs');let calls=0;
  for(const url of ['https://example.com/api/me','http://secret@localhost:8788/api/me'])await assert.rejects(fetchFixtureApi(url,{},async()=>{calls++;return new Response();}));
  assert.equal(calls,0);
});
test('certification prefers IPv4 in owned Node children without changing existing options or TLS',async()=>{
  const dns=await import('node:dns');const before=dns.getDefaultResultOrder();
  try {
    const {configureCertificationNetwork}=await import('./core.mjs');
    const env={NODE_OPTIONS:'--no-warnings --dns-result-order=ipv6first'};
    const evidence=configureCertificationNetwork(env);
    assert.equal(evidence.dnsResultOrder,'ipv4first');assert.equal(dns.getDefaultResultOrder(),'ipv4first');
    assert.ok(env.NODE_OPTIONS.startsWith('--no-warnings --dns-result-order=ipv6first'));
    const once=env.NODE_OPTIONS;configureCertificationNetwork(env);assert.equal(env.NODE_OPTIONS,once);
    assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED,undefined);
    const result=await child('console.log(require("node:dns").getDefaultResultOrder())',{env});
    assert.equal(result.exitCode,0);assert.match(result.output,/ipv4first/);
  } finally {dns.setDefaultResultOrder(before);}
});
test('successful process captures exit, timing, durable log',async()=>{const r=await child('console.log("success")');assert.equal(r.exitCode,0);assert.equal(r.error,null);assert.match(readFileSync(r.logPath,'utf8'),/success/);});
test('exit 1 never passes',async()=>{const r=await child('process.exit(1)');assert.equal(r.exitCode,1);assert.match(r.error,/exited 1/);});
test('throw before assertions never passes',async()=>{const r=await child('throw new Error("before assertions")');assert.equal(r.exitCode,1);assert.match(r.output,/before assertions/);assert.ok(r.error);});
test('timeout is actionable and nonzero',async()=>{const r=await child('setInterval(()=>{},100)',{timeoutMs:100});assert.ok(r.timedOut);assert.match(r.error,/Timeout after 100ms/);assert.notEqual(r.exitCode,0);});
test('signal crash cannot pass',async()=>{const r=await child('process.kill(process.pid,"SIGKILL")');assert.equal(r.signal,'SIGKILL');assert.ok(r.error);});
test('spawn failure cannot pass',async()=>{const r=await runCommand(['/definitely/missing/binary']);assert.ok(r.error);assert.notEqual(r.exitCode,0);});
test('interrupt kills run and does not pass',async()=>{const controller=new AbortController();setTimeout(()=>controller.abort(),100);const r=await child('setInterval(()=>{},100)',{signal:controller.signal});assert.ok(r.interrupted);assert.match(r.error,/Interrupted/);});
test('descendant left running is killed with owned group',async()=>{const pidFile=join(dir,'child.pid');const r=await child(`const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'inherit'});writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setTimeout(()=>process.exit(0),50)`,{timeoutMs:250});assert.ok(r.timedOut);const pid=Number(readFileSync(pidFile));await new Promise(r=>setTimeout(r,200));assert.throws(()=>process.kill(pid,0),/ESRCH/);});
test('success assertion report validated against identity and SHA',()=>assert.equal(validateReport(report(),{runner:'fixture',sourceSha:'sha'}).pass,1));
test('empty assertions rejected',()=>{const r=report();r.results=[];assert.throws(()=>validateReport(r),/empty/);});
test('malformed JSON and malformed assertion rejected',()=>{assert.throws(()=>JSON.parse('{'));const r=report();r.results[0].engine=null;assert.throws(()=>validateReport(r),/Malformed/);});
test('partial execution rejected even after passes',()=>{const r=report();r.mandatoryAssertionsExecuted=false;assert.throws(()=>validateReport(r),/mandatory/);});
test('wrong SHA rejected',()=>assert.throws(()=>validateReport(report(),{sourceSha:'new'}),/SHA/));
test('missing mandatory engine cannot become PASS',()=>{const r=report();r.mandatoryAssertionsExecuted=false;r.results.push({engine:'webkit',viewport:'compact',test:'engine launch',status:'FAIL',error:'missing browser'});assert.throws(()=>validateReport(r));});
test('mixed PASS FAIL NOT RUN aggregates failure',()=>{const r=report();r.results.push({engine:'webkit',viewport:'compact',test:'broken',status:'FAIL',error:'error'},{engine:'firefox',viewport:'compact',test:'missing',status:'NOT RUN',error:'not run'});r.summary={pass:1,fail:1};const counts=validateReport(r);assert.equal(counts.fail,1);assert.equal(counts.notRun,1);assert.equal(decision([{suiteId:'a',status:'FAIL'}],['a']),'FAIL');});
test('missing suite and mandatory NOT RUN do not certify',()=>{assert.equal(decision([],['mandatory']),'PARTIAL');assert.equal(decision([{suiteId:'a',status:'NOT RUN'}],['a']),'PARTIAL');});
test('missing D1 migration fails',()=>{const path=join(dir,'migrations-case');mkdirSync(join(path,'scripts/certification'),{recursive:true});writeFileSync(join(path,'scripts/certification/migrations.json'),'[{"name":"0001.sql","sha256":"none"}]');assert.throws(()=>migrationsManifest(path),/Missing D1 migration/);});
test('remote URLs and credentialed loopback URLs rejected',()=>{for(const base of ['https://example.com','http://127.0.0.1@production.example','http://user:pass@localhost','http://localhost/path'])assert.throws(()=>localOrigin(base));assert.equal(localOrigin('http://127.0.0.1:8799'),'http://127.0.0.1:8799');});
test('occupied port reported and owner remains alive',async()=>{const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));try{await assert.rejects(freePort(server.address().port),/unavailable/);assert.ok(server.listening);}finally{await new Promise(r=>server.close(r));}});
test('Vitest zero or truncated mandatory assertions rejected',()=>{assert.throws(()=>validateVitest({testResults:[],numTotalTests:0}),/Empty/);assert.throws(()=>validateVitest({testResults:[{assertionResults:[{status:'passed'}]}],numTotalTests:2}),/truncated/);});
test('smoke requires exact ordered assertion manifest and terminal counts',()=>{const source='check "one" "1" "1"\ncheck "two" "1" "1"';assert.equal(validateSmoke('  ✅ one\n  ✅ two\n== 2 passed, 0 failed',source).pass,2);for(const output of ['ALL PASS','  ✅ one\n== 1 passed, 0 failed','  ✅ one\n  ✅ two\n== 1 passed, 0 failed'])assert.throws(()=>validateSmoke(output,source));});
for(const injection of ['throw','launch','timeout','fixture','startup','child','empty','partial'])test(`C16 complete runner ${injection} records exact engine/viewport failure and exits nonzero`,async()=>{
  const resultPath=join(dir,`v6-${injection}.json`);const r=await runCommand([process.execPath,'scripts/verify-v6.mjs','--no-spawn'],{timeoutMs:30000,env:{CERT_RUNNER_INJECT:injection,CERT_RESULT_PATH:resultPath,CERT_SOURCE_SHA:'test-sha'}});
  assert.notEqual(r.exitCode,0);const evidence=JSON.parse(readFileSync(resultPath));assert.ok(evidence.results.some(x=>x.status==='FAIL'&&(x.engine==='chromium'&&x.viewport==='desktop'||['fixture','startup','child','empty'].includes(injection)&&x.engine==='system')&&x.error));assert.equal(evidence.status,'FAIL');
});

test('detached descendant is supervised and removed after parent crash',async()=>{
  const pidFile=join(dir,'detached.pid');
  const r=await child(`const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore',detached:true});writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setTimeout(()=>process.kill(process.pid,'SIGKILL'),350)`);
  assert.equal(r.signal,'SIGKILL');assert.ok(r.error);const pid=Number(readFileSync(pidFile));assert.throws(()=>process.kill(pid,0),/ESRCH/);
});

test('immediate successful parent exit cannot orphan a detached Node child',async()=>{
  const pidFile=join(dir,'immediate-detached.pid');
  const r=await child(`const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore',detached:true});writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();process.exit(0)`);
  assert.equal(r.exitCode,0);assert.equal(r.error,null);const pid=Number(readFileSync(pidFile));assert.throws(()=>process.kill(pid,0),/ESRCH/);
});

test('performance evidence rejects missing, empty and invalid measurements',async()=>{
  const {validatePerformanceEvidence}=await import('./core.mjs');
  for(const report of [null,{records:1000,metrics:[]},{records:1000,metrics:[{name:'seed 1000 records'}],plans:{}}])assert.throws(()=>validatePerformanceEvidence(report));
});

test('performance evidence requires every resource metric and the binding budget',async()=>{
  const {validatePerformanceEvidence}=await import('./core.mjs');
  const names=['seed 1000 records','record/event commit 100 rows','Inbox indexed query','bounded reminder Cron tick','C14 budgeted reminder lookbehind','C15 budgeted cross-database date-offset','form accepted acknowledgement','automation one record and journal'];
  const complete={records:1000,plans:{inbox:[{}],dateSweep:[{}],outbox:[{}]},metrics:names.map(name=>({name,ms:1,subrequests:1,statements:1,rowsRead:1,rowsWritten:1,sqlKinds:{other:1}}))};
  assert.equal(validatePerformanceEvidence(complete),complete);
  assert.throws(()=>validatePerformanceEvidence({...complete,records:undefined}));
  const truncated=structuredClone(complete);truncated.metrics.pop();assert.throws(()=>validatePerformanceEvidence(truncated),/Missing performance/);
  const over=structuredClone(complete);over.metrics[4].subrequests=46;assert.throws(()=>validatePerformanceEvidence(over),/budget exceeded/);
  const invalid=structuredClone(complete);invalid.metrics[0].rowsRead=NaN;assert.throws(()=>validatePerformanceEvidence(invalid),/Malformed/);
  const unclassified=structuredClone(complete);unclassified.metrics[0].sqlKinds={};assert.throws(()=>validatePerformanceEvidence(unclassified),/classification/);
  const noPlan=structuredClone(complete);noPlan.plans.inbox=[];assert.throws(()=>validatePerformanceEvidence(noPlan),/query plan/);
});
