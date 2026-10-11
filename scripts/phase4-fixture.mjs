// Disposable built-Worker fixture. No remote AI/service bindings, no personal
// Wrangler state, and cleanup only targets processes created by this fixture.
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,existsSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const PROJECT=fileURLToPath(new URL('../',import.meta.url));
export const PASSWORD='password123';
export function assertLocal(base) {
  const url=new URL(base);
  if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Verification requires disposable loopback HTTP');
  return url.origin;
}
export async function command(args,{cwd=PROJECT,log}={}) {
  const process=spawn(args[0],args.slice(1),{cwd,stdio:log?['ignore',log,log]:'inherit'});
  const code=await new Promise((resolve,reject)=>{process.on('error',reject);process.on('exit',resolve);});
  if(code!==0) throw new Error(`${args[0]} exited ${code}`);
}
export async function startFixture({port=8799,build=true}={}) {
  if(build||!existsSync(join(PROJECT,'dist/workspace/index.js'))) await command(['npm','run','build']);
  const directory=mkdtempSync(join(tmpdir(),'tcg-phase4-disposable-'));
  cpSync(join(PROJECT,'dist/workspace'),join(directory,'workspace'),{recursive:true});
  cpSync(join(PROJECT,'dist/client'),join(directory,'client'),{recursive:true});
  // no_bundle ESM auxiliary modules are resolved relative to the temporary
  // config by Wrangler; copy only generated Worker chunks into this fixture.
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
  await command(['npx','wrangler','d1','migrations','apply','DB','--local','--config',config,'--persist-to',state]);
  const server=spawn('npx',['wrangler','dev','--local','--config',config,'--port',String(port),'--persist-to',state,'--test-scheduled'],{cwd:PROJECT,stdio:['ignore','pipe','pipe'],detached:true});
  let logs='';for(const stream of [server.stdout,server.stderr]) stream.on('data',chunk=>{logs+=chunk;});
  const base=`http://127.0.0.1:${port}`;
  const stop=()=>{try{process.kill(-server.pid,'SIGTERM');}catch{server.kill('SIGTERM');}writeFileSync(join(directory,'worker.log'),logs);};
  process.once('exit',stop);
  let ready=false;
  const deadline=Date.now()+30_000;
  while(Date.now()<deadline) {try{const response=await fetch(base+'/api/auth/status');if(response.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}
  if(!ready){stop();throw new Error(`Fixture startup failed: ${logs}`);}
  return {base,directory,state,config,stop,async sql(sql){
    const run=spawn('npx',['wrangler','d1','execute','DB','--local','--config',config,'--persist-to',state,'--command',sql,'--json'],{cwd:PROJECT,stdio:['ignore','pipe','pipe']});
    let output='',errors='';run.stdout.on('data',c=>output+=c);run.stderr.on('data',c=>errors+=c);
    const code=await new Promise(r=>run.on('exit',r));if(code!==0)throw new Error(errors||output);
    return JSON.parse(output);
  }};
}

export async function api(base,path,{token,method='GET',body,headers={}}={}) {
  const response=await fetch(assertLocal(base)+path,{method,headers:{...headers,...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
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
export async function pull(base,token) {let since=0,rows=[];while(true){const result=await api(base,`/api/sync/pull?since=${since}`,{token});if(result.status!==200)throw new Error('pull failed');rows.push(...result.data.records);if(!result.data.hasMore)return rows;since=result.data.cursor;}}
export async function eventually(check,{timeout=10_000}={}) {const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){try{last=await check();if(last)return last;}catch(error){last=error;}await new Promise(r=>setTimeout(r,100));}throw new Error(`Condition timed out: ${String(last)}`);}
