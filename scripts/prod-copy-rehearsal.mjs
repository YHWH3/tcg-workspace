// Owner-supplied SQL -> a fresh local D1 only. Never imports Wrangler config or credentials.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,cpSync,lstatSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {migrationStatements,verifyMigrationManifest} from './release-rehearsal.mjs';
import {fingerprint} from './certification/core.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
export function localDump(path){
  if(typeof path!=='string'||!path||path.startsWith('-')||/^[a-z][a-z0-9+.-]*:/i.test(path)||path.startsWith('//'))throw new Error('Supply a local SQL file path only');
  const absolute=resolve(path),stat=lstatSync(absolute);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0||stat.size>64*1024*1024)throw new Error('SQL dump must be a nonempty regular file, at most 64 MiB');
  return realpathSync(absolute);
}

// SQLite's parser handles semicolons, escaped quotes, comments and trigger bodies.
// Never strip comments from data or split a production dump using a SQL regex.
export function dumpStatements(sql){
  const code=`import sys,json,sqlite3\ns=sys.stdin.read(); buf=[]; out=[]\nfor c in s:\n buf.append(c)\n if c==';' and sqlite3.complete_statement(''.join(buf)):\n  out.append(''.join(buf)); buf=[]\nrest=''.join(buf).strip()\nif rest and not sqlite3.complete_statement(rest+'\\nSELECT 1;'): raise ValueError('incomplete SQL')\nif rest:\n import re\n if re.sub(r'/\\*[\\s\\S]*?\\*/|--[^\\n]*','',rest).strip(): raise ValueError('unterminated SQL')\nprint(json.dumps(out))`;
  return JSON.parse(execFileSync('python3',['-c',code],{input:sql,encoding:'utf8',timeout:30_000,maxBuffer:128*1024*1024}));
}
const statementKind=s=>s.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/,'').trim();
const transactions=/^(?:BEGIN(?:\s+TRANSACTION)?|COMMIT|END(?:\s+TRANSACTION)?)\s*;$/i;
const hash=data=>createHash('sha256').update(data).digest('hex');

export async function rehearseProductionCopy(input){
  const path=localDump(input),bytes=readFileSync(path),statements=dumpStatements(bytes.toString('utf8'));
  const manifest=verifyMigrationManifest(ROOT),sha=execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),initialFingerprint=fingerprint(ROOT);
  const folder=join(ROOT,'.artifacts','prod-copy-rehearsal',randomUUID());mkdirSync(folder,{recursive:true,mode:0o700});chmodSync(folder,0o700);
  writeFileSync(join(folder,'input.sql'),bytes,{mode:0o600});
  const report={status:'HOLD',sourceSha:sha,sourceFingerprint:initialFingerprint,inputSha256:hash(bytes),startedAt:new Date().toISOString(),disposable:true,remoteOperations:false,checks:[],migrations:[],oauth:{status:'OWNER_VERIFICATION_REQUIRED',expectedLegacyGrantsFromHistoricalInventory:2,reason:'OAuth grants are in OAUTH_KV. A D1 SQL dump cannot verify their current count or connection IDs. Reconnect both owner connectors after release.'}};
  const worker=await build({stdin:{contents:`import {enqueueSearchRebuild,processSearchDirty} from './worker/search.ts';
import {maintainDateIndex} from './worker/events.ts';
import {withD1Budget,d1BudgetRemaining} from './worker/d1budget.ts';
export default {async fetch(request,raw){const env=withD1Budget(raw,45),u=new URL(request.url);let result;
if(u.pathname==='/search-enqueue')result=await enqueueSearchRebuild(env,u.searchParams.get('after')||'',100);
else if(u.pathname==='/search-process')result=await processSearchDirty(env,50);
else {const after=u.searchParams.get('after')||'';const {results}=await env.DB.prepare("SELECT id FROM records WHERE collection='tasks' AND id>? ORDER BY id LIMIT 100").bind(after).all();await maintainDateIndex(env,results.map(r=>({id:r.id,collection:'tasks',created:true,fields:[],before:{},after:{}})),true);result={next:results.length===100?results.at(-1).id:null,count:results.length};}
return Response.json({result,calls:45-d1BudgetRemaining(env.DB)});}}`,resolveDir:ROOT,sourcefile:'prod-copy-local-worker.ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
  let mf,db;
  const open=async state=>{mf=new Miniflare(convertV4MiniflareOptions({resourcePersistencePath:join(folder,state),workers:[{name:'production-copy-local',modules:true,script:worker.outputFiles[0].text,compatibilityDate:'2026-09-25',d1Databases:{DB:'production-copy-local'}}]}));db=await mf.getD1Database('DB');};
  const check=async(name,fn)=>{const start=Date.now();await fn();report.checks.push({name,status:'PASS',durationMs:Date.now()-start});};
  const rows=async(sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
  const contents=async()=>hash(JSON.stringify(await rows('SELECT id,collection,data,field_ts,seq FROM records ORDER BY id')));
  const files=async()=>hash(JSON.stringify(await rows('SELECT file_id,idx,hex(data) AS data FROM file_chunks ORDER BY file_id,idx')));
  const call=async path=>{const response=await mf.dispatchFetch('http://localhost'+path);assert.equal(response.status,200);const out=await response.json();assert.ok(out.calls<=45);report.maxBindingCalls=Math.max(report.maxBindingCalls??0,out.calls);return out.result;};
  try{
    await open('imported');
    await check('SQL imports into a fresh disposable D1',async()=>{
      const list=statements.filter(s=>!transactions.test(statementKind(s)));
      for(let i=0;i<list.length;i+=25)await db.batch(list.slice(i,i+25).map(s=>db.prepare(s)));
      assert.equal(await db.prepare('SELECT COUNT(*) n FROM records WHERE json_valid(data)=0').first('n'),0);
    });
    let applied;
    await check('dump migration ledger is an exact registered prefix',async()=>{
      applied=(await rows('SELECT name FROM d1_migrations ORDER BY name')).map(r=>r.name);
      assert.ok(applied.length>=3&&applied.length<=manifest.length);
      assert.deepEqual(applied,manifest.slice(0,applied.length).map(m=>m.name));
    });
    const before={records:await db.prepare('SELECT COUNT(*) n FROM records').first('n'),contents:await contents(),files:await files()};
    report.originalRecordCount=before.records;report.originalMigrationCount=applied.length;
    await mf.dispose();mf=null;cpSync(join(folder,'imported'),join(folder,'pre-upgrade-backup'),{recursive:true,errorOnExist:true,force:false});
    cpSync(join(folder,'pre-upgrade-backup'),join(folder,'upgraded-copy'),{recursive:true,errorOnExist:true,force:false});await open('upgraded-copy');
    await check('apply only pending registered migrations',async()=>{
      for(const m of manifest.slice(applied.length)){
        await db.batch([...migrationStatements(readFileSync(join(ROOT,'migrations',m.name),'utf8')).map(s=>db.prepare(s)),db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(m.name)]);
        report.migrations.push({name:m.name,sha256:m.sha256});
      }
    });
    await check('record counts, JSON and original values survive',async()=>{
      assert.equal(await db.prepare('SELECT COUNT(*) n FROM records').first('n'),before.records);
      assert.equal(await contents(),before.contents);assert.equal(await files(),before.files);
      assert.equal(await db.prepare('SELECT COUNT(*) n FROM records WHERE json_valid(data)=0').first('n'),0);
    });
    await check('permissions remain disabled and integrity holds',async()=>{
      assert.equal(await db.prepare('SELECT enabled FROM access_state WHERE id=1').first('enabled'),0);
      assert.deepEqual(await rows('PRAGMA foreign_key_check'),[]);assert.equal(await db.prepare('PRAGMA quick_check').first('quick_check'),'ok');
    });
    await check('real bounded search and date backfills complete',async()=>{
      let after='';do{const result=await call('/search-enqueue?after='+encodeURIComponent(after));after=result.next;}while(after);
      const limit=Number(await db.prepare('SELECT COUNT(*) n FROM search_dirty').first('n'))+1;
      for(let i=0;i<limit;i++){if(!await call('/search-process'))break;}
      assert.equal(await db.prepare('SELECT COUNT(*) n FROM search_dirty').first('n'),0);
      after='';do{const result=await call('/dates?after='+encodeURIComponent(after));after=result.next;}while(after);
    });
    await check('closed pre-upgrade backup restores original content and bytes',async()=>{
      await mf.dispose();mf=null;cpSync(join(folder,'pre-upgrade-backup'),join(folder,'restored-copy'),{recursive:true,errorOnExist:true,force:false});await open('restored-copy');
      assert.equal(await contents(),before.contents);assert.equal(await files(),before.files);
      assert.deepEqual((await rows('SELECT name FROM d1_migrations ORDER BY name')).map(r=>r.name),applied);
    });
    assert.equal(fingerprint(ROOT),initialFingerprint);report.status='PASS';
  }catch(error){report.status='HOLD';report.failure={check:report.checks.length+1,kind:error.name};}
  finally{await mf?.dispose();report.endedAt=new Date().toISOString();writeFileSync(join(folder,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
  return {folder,report};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{if(process.argv.length!==3)throw new Error('Usage: node scripts/prod-copy-rehearsal.mjs /absolute/path/to/owner-export.sql');const result=await rehearseProductionCopy(process.argv[2]);console.log(JSON.stringify({status:result.report.status,report:join(result.folder,'report.json')}));if(result.report.status!=='PASS')process.exitCode=1;}
  catch{console.error('Rehearsal refused or failed. Supply one nonempty local SQL export with its migration ledger. No remote operation was attempted.');process.exitCode=2;}
}
