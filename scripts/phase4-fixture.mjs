// Disposable built-Worker fixture. No remote AI/service bindings, no personal
// Wrangler state, and cleanup only targets processes created by this fixture.
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,existsSync,cpSync,mkdirSync,readdirSync,readFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const PROJECT=fileURLToPath(new URL('../',import.meta.url));
export const PASSWORD='password123';
export function assertLocal(base) {
  const url=new URL(base);
  if(url.protocol!=='http:'||url.username||url.password||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Verification requires disposable loopback HTTP');
  return url.origin;
}
// Child processes never inherit cloud credentials. Wrangler is resolved from the
// installed lockfile, cannot fetch an unpinned executable, and is always local.
export function fixtureEnvironment() {
  const env={...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'};
  for(const key of Object.keys(env)) if(/^(CLOUDFLARE_|CF_|TURNSTILE_|OPENAI_|AWS_|GOOGLE_|GITHUB_TOKEN$|GH_TOKEN$)/i.test(key)) delete env[key];
  return env;
}
export function redactFixtureLog(value) {
  return String(value).replace(/(Bearer\s+)[^\s"']+/gi,'$1[REDACTED]')
    .replace(/("?(?:access_token|refresh_token|client_secret|password|token)"?\s*[:=]\s*)"?[^\s",}]+"?/gi,'$1[REDACTED]');
}
export async function assertPortAvailable(port) {
  if(!Number.isInteger(port)||port<1024||port>65535) throw new Error(`Invalid disposable fixture port: ${port}`);
  await new Promise((resolve,reject)=>{
    const probe=createServer();probe.once('error',error=>reject(new Error(`Disposable fixture port ${port} unavailable: ${error.code}; existing processes are preserved`)));
    probe.listen({host:'127.0.0.1',port,exclusive:true},()=>probe.close(resolve));
  });
}
export function assertOwnedPort(port,ownedGroup) {
  const lsof=spawnSync(process.platform==='darwin'?'/usr/sbin/lsof':'lsof',['-t','-nP',`-iTCP:${port}`,'-sTCP:LISTEN'],{encoding:'utf8',timeout:5000,env:fixtureEnvironment()});
  if(lsof.error||lsof.status!==0)throw new Error(`Cannot prove fixture listener provenance on port ${port}: ${lsof.error?.message??'no listener'}`);
  const pids=[...new Set(lsof.stdout.trim().split(/\s+/).map(Number))];
  if(!pids.length||pids.some(pid=>!Number.isInteger(pid)||pid<=0))throw new Error('Malformed fixture listener ownership report');
  for(const pid of pids){
    const ps=spawnSync('/bin/ps',['-o','pgid=','-p',String(pid)],{encoding:'utf8',timeout:5000,env:fixtureEnvironment()});
    if(ps.error||ps.status!==0||Number(ps.stdout.trim())!==ownedGroup)throw new Error(`Port ${port} listener ${pid} belongs to another process group; existing processes are preserved`);
  }
  return pids;
}
function signalOwned(child,signal) {
  if(!child.pid)return;
  try {process.kill(-child.pid,signal);}catch {try{child.kill(signal);}catch{}}
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function command(args,{cwd=PROJECT,log,timeout=180_000}={}) {
  const started=Date.now();let output='',timedOut=false;
  const child=spawn(args[0],args.slice(1),{cwd,env:fixtureEnvironment(),stdio:['ignore','pipe','pipe'],detached:true});
  const onData=chunk=>{const clean=redactFixtureLog(chunk);output+=clean;if(log)typeof log==='number'?writeFileSync(log,clean):log.write(clean);else process.stdout.write(clean);};
  child.stdout.on('data',onData);child.stderr.on('data',onData);
  const timer=setTimeout(()=>{timedOut=true;signalOwned(child,'SIGTERM');},timeout);
  const killer=setTimeout(()=>signalOwned(child,'SIGKILL'),timeout+2000);
  const onExit=()=>signalOwned(child,'SIGTERM');process.once('exit',onExit);
  let code,signal;
  try {[code,signal]=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(c,s)=>resolve([c,s]));});}
  finally {clearTimeout(timer);clearTimeout(killer);process.removeListener('exit',onExit);signalOwned(child,'SIGTERM');}
  if(timedOut)throw new Error(`${args[0]} timed out after ${timeout}ms; owned process group terminated`);
  if(code!==0)throw new Error(`${args[0]} exited ${code}, signal ${signal??'none'}; ${output.slice(-1500)}`);
  return {code,signal,output,durationMs:Date.now()-started};
}
export async function startFixture({port=8799,build=true,artifactDirectory,startupTimeout=60_000,commandTimeout=180_000}={}) {
  await assertPortAvailable(port);
  if(build) await command(['npm','run','build'],{timeout:commandTimeout});
  if(!existsSync(join(PROJECT,'dist/workspace/index.js')))throw new Error('Built Worker missing; run certification build stage first');
  const directory=mkdtempSync(join(tmpdir(),'tcg-phase4-disposable-'));
  const fixtureId=directory.split('/').at(-1);
  const evidence=artifactDirectory?resolve(artifactDirectory):directory;mkdirSync(evidence,{recursive:true});
  const wrangler=join(PROJECT,'node_modules/.bin/wrangler');
  if(!existsSync(wrangler))throw new Error('Pinned Wrangler executable missing; install lockfile dependencies');
  cpSync(join(PROJECT,'dist/workspace'),join(directory,'workspace'),{recursive:true});
  cpSync(join(PROJECT,'dist/client'),join(directory,'client'),{recursive:true});
  cpSync(join(PROJECT,'dist/workspace/assets'),join(directory,'assets'),{recursive:true});
  const config=join(directory,'wrangler.json');
  const settings={name:'tcg-phase4-local',main:join(directory,'workspace/index.js'),no_bundle:true,
    compatibility_date:'2026-09-25',compatibility_flags:['nodejs_compat'],rules:[{type:'ESModule',globs:['**/*.js','**/*.mjs']}],
    assets:{directory:join(directory,'client'),not_found_handling:'single-page-application',run_worker_first:['/api/*','/mcp','/mcp/*','/oauth/*','/token','/register','/.well-known/*']},
    d1_databases:[{binding:'DB',database_name:'workspace-db',database_id:'00000000-0000-0000-0000-000000000004',migrations_dir:resolve(PROJECT,'migrations')}],
    kv_namespaces:[{binding:'OAUTH_KV',id:'00000000000000000000000000000004'}],
    durable_objects:{bindings:[{name:'LIVE',class_name:'LiveRoom'}]},migrations:[{tag:'v1',new_sqlite_classes:['LiveRoom']}],
    vars:{WORKSPACE_ENV:'local-test',TURNSTILE_LOCAL_TEST:'1'},triggers:{crons:['*/15 * * * *']}};
  writeFileSync(config,JSON.stringify(settings));
  const state=join(directory,'state');
  const migrationFiles=readdirSync(join(PROJECT,'migrations')).filter(file=>file.endsWith('.sql')).sort();
  if(!migrationFiles.length)throw new Error('No D1 migrations found');
  const migration=await command([wrangler,'d1','migrations','apply','DB','--local','--config',config,'--persist-to',state],{timeout:commandTimeout,log:{write:chunk=>writeFileSync(join(evidence,'migrations.log'),chunk,{flag:'a'})}});
  writeFileSync(join(evidence,'migration-evidence.json'),JSON.stringify({fixtureId,state,config,local:true,exitCode:migration.code,durationMs:migration.durationMs,files:migrationFiles.map(file=>({file,sha256:createHash('sha256').update(readFileSync(join(PROJECT,'migrations',file))).digest('hex')}))},null,2));
  // Check again after migration setup; never adopt the process that won a race.
  await assertPortAvailable(port);
  const server=spawn(wrangler,['dev','--local','--ip','127.0.0.1','--config',config,'--port',String(port),'--persist-to',state,'--test-scheduled'],{cwd:PROJECT,env:fixtureEnvironment(),stdio:['ignore','pipe','pipe'],detached:true});
  let logs='',closed=false,launchError;server.once('error',error=>{launchError=error;});server.once('exit',()=>{closed=true;});
  for(const stream of [server.stdout,server.stderr]) stream.on('data',chunk=>{const clean=redactFixtureLog(chunk);logs=(logs+clean).slice(-100_000);writeFileSync(join(evidence,'worker.log'),clean,{flag:'a'});});
  const base=`http://127.0.0.1:${port}`;
  let stopping;
  const exitCleanup=()=>signalOwned(server,'SIGTERM');
  const stop=()=>stopping??=(async()=>{
    process.removeListener('exit',exitCleanup);process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
    signalOwned(server,'SIGTERM');await pause(300);signalOwned(server,'SIGKILL');
  })();
  const interrupt=()=>{exitCleanup();process.exitCode=130;void stop();};
  process.once('exit',exitCleanup);process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  writeFileSync(join(evidence,'fixture.json'),JSON.stringify({fixtureId,base,directory,state,config,pid:server.pid,local:true,disposable:true},null,2));
  let ready=false,readinessError;
  const deadline=Date.now()+startupTimeout;
  while(Date.now()<deadline) {
    if(launchError||closed)break;
    try{const response=await fetch(base+'/api/auth/status',{signal:AbortSignal.timeout(2000)});if(response.ok&&!closed){assertOwnedPort(port,server.pid);ready=true;break;}}catch(error){readinessError=error;}
    await pause(200);
  }
  if(!ready){await stop();throw new Error(`Fixture ${fixtureId} startup ${launchError?'launch error: '+launchError.message:closed?'process terminated unexpectedly':`timeout after ${startupTimeout}ms`}; ${readinessError?.message??''}; see ${join(evidence,'worker.log')}: ${logs.slice(-1500)}`);}
  return {base,directory,state,config,fixtureId,evidence,stop,async sql(sql){
    if(closed||stopping)throw new Error('Disposable fixture Worker is no longer running');
    const result=await command([wrangler,'d1','execute','DB','--local','--config',config,'--persist-to',state,'--command',sql,'--json'],{timeout:commandTimeout,log:{write:()=>{}}});
    try{return JSON.parse(result.output);}catch{throw new Error('Wrangler D1 returned malformed JSON');}
  }};
}

export async function api(base,path,{token,method='GET',body,headers={}}={}) {
  const response=await fetch(assertLocal(base)+path,{method,headers:{...headers,...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30_000)});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data={text};}
  return {status:response.status,data};
}
export async function bootstrap(base) {
  let admin=await api(base,'/api/auth/signup',{method:'POST',body:{username:'admin',name:'Admin',password:PASSWORD}});
  if(!admin.data.token) admin=await api(base,'/api/auth/login',{method:'POST',body:{username:'admin',password:PASSWORD}});
  if(!admin.data.token)throw new Error('Admin fixture authentication failed');
  const invite=await api(base,'/api/invites',{token:admin.data.token,method:'POST'});
  let bob=await api(base,'/api/auth/signup',{method:'POST',body:{username:'bob',name:'Bob',password:PASSWORD,inviteCode:invite.data.code}});
  if(!bob.data.token)bob=await api(base,'/api/auth/login',{method:'POST',body:{username:'bob',password:PASSWORD}});
  if(!bob.data.token)throw new Error('Bob fixture authentication failed');
  return {admin:admin.data,bob:bob.data};
}
export async function push(base,token,changes) {const result=await api(base,'/api/sync/push',{token,method:'POST',body:{changes:changes.map(change=>({ts:Date.now(),...change}))}});if(result.status!==200||result.data.rejected)throw new Error(`Fixture push failed ${JSON.stringify(result)}`);return result;}
export async function pull(base,token) {let since=0,rows=[];for(let page=0;page<1000;page++){const result=await api(base,`/api/sync/pull?since=${since}`,{token});if(result.status!==200)throw new Error('pull failed');rows.push(...result.data.records);if(!result.data.hasMore)return rows;if(!Number.isFinite(result.data.cursor)||result.data.cursor<=since)throw new Error('Fixture pull cursor did not advance');since=result.data.cursor;}throw new Error('Fixture pull exceeded 1000 pages');}
export async function eventually(check,{timeout=10_000}={}) {const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){try{last=await check();if(last)return last;}catch(error){last=error;}await new Promise(r=>setTimeout(r,100));}throw new Error(`Condition timed out: ${String(last)}`);}
