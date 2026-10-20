/** Disposable local D1 upgrade/recovery proof. Never reads Wrangler configuration,
 * credentials, remote D1, or an existing database directory. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {cpSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createCertificationReporter} from './certification-report.mjs';
import {fingerprint} from './certification/core.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const LEGACY_SHA='fb6e203081359b1846694cb1e0c3e5ac9a4a1104';
export const releaseRehearsalCases=[
 'registered migration hashes and shipped mainline migrations match',
 'mainline fixture contains records relations files and execution journals',
 'injected upgrade failure rolls back its transaction',
 'closed pre-upgrade backup restores after failed migration',
 'all original mainline values survive the complete upgrade',
 'permissions remain off and existing Core access is preserved',
 'shares remain pinned and obsolete snapshots are retired',
 'search backlog drains through the real bounded Worker indexer',
 'lost FTS entries rebuild from canonical records',
 'Phase 6 durable tables and digest outcomes exist',
 'final database foreign keys and integrity pass',
 'closed final backup restores complete logical state and file bytes',
];

export function verifyMigrationManifest(root=ROOT) {
 const manifest=JSON.parse(readFileSync(join(root,'scripts/certification/migrations.json'),'utf8'));
 const files=readdirSync(join(root,'migrations')).filter(n=>n.endsWith('.sql')).sort();
 assert.deepEqual(files,manifest.map(m=>m.name),'Every migration must occur once in the registered manifest');
 for(const m of manifest){assert.match(m.name,/^\d{4}_[a-z0-9_]+\.sql$/);assert.equal(createHash('sha256').update(readFileSync(join(root,'migrations',m.name))).digest('hex'),m.sha256,`Migration hash changed: ${m.name}`);}
 return manifest;
}

// Same trigger-aware parser used by the established actual-D1 fixtures. Statements
// are submitted as one D1 batch per migration, preserving D1 transaction semantics.
export const migrationStatements=sql=>(sql.replace(/--[^\n]*/g,'').match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi)??[]).map(s=>s.trim()).filter(Boolean);
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const writeJson=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
const fixtureName='release-rehearsal-'+randomUUID();

export async function runReleaseRehearsal() {
 const require=createRequire(join(ROOT,'package.json'));
 const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
 const {build}=require('esbuild');
 const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim();
 const tree=execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:ROOT,encoding:'utf8'}).trim();
 const initialFingerprint=fingerprint(ROOT),startedAt=new Date().toISOString();
 // The directory is always newly created under ignored artifacts. No caller can
 // point this runner at an existing personal/production database or output path.
 const folder=join(ROOT,'.artifacts','release-rehearsal',`${sha.slice(0,12)}-${Date.now()}-${randomUUID().slice(0,8)}`);
 mkdirSync(folder,{recursive:true});
 process.env.CERT_RESULT_PATH??=join(folder,'test-results.json');
 const reporter=createCertificationReporter('release-rehearsal',releaseRehearsalCases);
 reporter.setMetadata('fixtureId',fixtureName);
 reporter.setMetadata('sourceSha',sha);
 reporter.setMetadata('artifactDirectory',folder);
 reporter.setMetadata('permissionMode','DISABLED');
 const measurements=[],commands=[];
 reporter.setMetadata('command',[process.execPath,...process.argv.slice(1)]);
 let mf=null,db,backup=null,baseline,allTables;
 const check=async(name,fn)=>{const start=performance.now();try{await fn();reporter.record('D1','local',name,'PASS');commands.push({check:name,exitCode:0,durationMs:performance.now()-start});console.log('PASS',name);}catch(error){reporter.record('D1','local',name,'FAIL',error);commands.push({check:name,exitCode:1,durationMs:performance.now()-start,error:error.message});throw error;}};
 const worker=await build({stdin:{contents:`import {processSearchDirty,enqueueSearchRebuild} from './worker/search.ts';
 import {reviewMeter} from './tests/reviewMetrics.ts';
 export default {async fetch(request,env){const measured=reviewMeter(env.DB);const u=new URL(request.url);
 const result=u.pathname==='/rebuild'?await enqueueSearchRebuild({DB:measured.db},'',400):await processSearchDirty({DB:measured.db},50);
 return Response.json({result,metrics:measured.metrics});}};`,resolveDir:ROOT,sourcefile:'release-rehearsal-worker.ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
 const options=state=>convertV4MiniflareOptions({resourcePersistencePath:state,workers:[{name:fixtureName,modules:true,script:worker.outputFiles[0].text,compatibilityDate:'2026-09-25',d1Databases:{DB:fixtureName}}]});
 const open=async state=>{assert.ok(state.startsWith(folder+'/'));mf=new Miniflare(options(state));db=await mf.getD1Database('DB');};
 const close=async()=>{if(mf){await mf.dispose();mf=null;}};
 const rows=async(sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
 const snapshot=async()=>{const tables=(await rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")).map(r=>r.name);const out={};for(const table of tables){const cols=(await rows('PRAGMA table_info('+quote(table)+')')).map(r=>r.name);const data=await rows('SELECT '+cols.map(quote).join(',')+' FROM '+quote(table));out[table]={cols,rows:data.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))};}return out;};
 const assertPreserved=async saved=>{for(const [t,s] of Object.entries(saved)){const current=await rows('SELECT '+s.cols.map(quote).join(',')+' FROM '+quote(t));assert.deepEqual(current.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),s.rows,t);}};
 const apply=async names=>{for(const name of names){const stmts=migrationStatements(readFileSync(join(ROOT,'migrations',name),'utf8')),start=performance.now();const result=await db.batch(stmts.map(s=>db.prepare(s)));measurements.push({operation:'migration',file:name,statements:stmts.length,bindingCalls:1,durationMs:performance.now()-start,rowsRead:result.reduce((n,r)=>n+(r.meta?.rows_read??0),0),rowsWritten:result.reduce((n,r)=>n+(r.meta?.rows_written??0),0)});}};
 const callIndexer=async pathname=>{const start=performance.now();const response=await mf.dispatchFetch('http://localhost'+pathname);assert.equal(response.status,200);const result=await response.json();measurements.push({operation:pathname,durationMs:performance.now()-start,...result.metrics});assert.ok(result.metrics.bindings<=45);return result.result;};
 try {
  let manifest;
  await check(releaseRehearsalCases[0],async()=>{manifest=verifyMigrationManifest();assert.equal(manifest.length,32);for(const m of manifest.filter(m=>m.name<'0012')){const old=execFileSync('git',['show',`${LEGACY_SHA}:migrations/${m.name}`],{cwd:ROOT});assert.equal(createHash('sha256').update(old).digest('hex'),m.sha256,`Previously shipped migration changed: ${m.name}`);}});
  await open(join(folder,'initial-state'));
  await apply(manifest.filter(m=>m.name<'0012').map(m=>m.name));
  await check(releaseRehearsalCases[1],async()=>{
   await db.batch([
    db.prepare("INSERT INTO users(id,username,name,role,created_at) VALUES('owner','owner','Fixture Owner','admin',1),('member','member','Fixture Member','member',2)"),
    db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES('fixture-session-hash','owner',9999999999999,1)"),
    db.prepare(`INSERT INTO records(id,collection,data,field_ts,seq,updated_by,updated_at) VALUES
     ('page','pages','{"title":"Upgrade Sentinel"}','{"title":1}',1,'owner',1),
     ('board','boards','{"name":"Tasks","kind":"tasks"}','{}',2,'owner',1),
     ('task','tasks','{"boardId":"board","title":"Pending Sentinel","assigneeId":"member"}','{}',3,'owner',1),
     ('body','blocks','{"pageId":"task","type":"text","text":"Body sentinel"}','{}',4,'owner',1),
     ('comment','comments','{"targetId":"task","targetType":"task","text":"Comment sentinel","authorId":"member"}','{}',5,'member',1),
     ('file','files','{"parentType":"task","parentId":"task","name":"fixture.txt"}','{}',6,'owner',1),
     ('relation','links','{"kind":"related","fromId":"task","toId":"page"}','{}',7,'owner',1)`),
    db.prepare("INSERT INTO files(id,mime,size,chunks,uploaded_by,created_at,complete) VALUES('file','text/plain',4,1,'owner',1,1)"),
    db.prepare("INSERT INTO file_chunks(file_id,idx,data) VALUES('file',0,?)").bind(new Uint8Array([1,2,3,4])),
    db.prepare("INSERT INTO shares(token,page_id,created_by,created_at) VALUES('fixture-share','page','owner',1)"),
    db.prepare("INSERT INTO changesets(id,user_id,source,tool,summary,item_count,created_at) VALUES('cs','owner','mcp','create_page','Fixture journal',1,1)"),
    db.prepare("INSERT INTO changeset_items(changeset_id,idx,collection,record_id,created,before,after,field_ts) VALUES('cs',0,'pages','page',1,'{}','{\"title\":\"Upgrade Sentinel\"}','{}')"),
    db.prepare("INSERT INTO mcp_requests(user_id,request_id,tool,args_hash,status,result,created_at) VALUES('owner','fixture-request','create_page','fixture-hash','done','{\"changesetId\":\"cs\"}',1)"),
    db.prepare("INSERT INTO notifications(id,user_id,kind,target_type,target_id,title,created_at) VALUES('notice','member','assigned','record','task','Retained notice',1)"),
    db.prepare("INSERT INTO approvals(id,target_type,target_id,requested_by,approver_id,status,created_at) VALUES('approval','record','task','owner','member','pending',1)"),
    db.prepare("INSERT INTO form_submissions(submission_id,form_id,state,receipt,record_id,created_at) VALUES('submission','fixture-form','accepted','fixture-receipt','task',1)"),
    db.prepare("INSERT INTO event_outbox(id,payload,created_at) VALUES('event','{\"source\":\"client\",\"applied\":[]}',1)"),
    db.prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,created_at) VALUES('run','fixture-auto','fixture-event','pending',1)")
   ]);
   baseline=await snapshot();allTables=Object.keys(baseline);assert.equal((await rows('SELECT id FROM records')).length,7);assert.deepEqual(await db.prepare("SELECT data FROM file_chunks WHERE file_id='file'").first('data'),[1,2,3,4]);
   await close();backup=join(folder,'pre-upgrade-backup');cpSync(join(folder,'initial-state'),backup,{recursive:true,errorOnExist:true,force:false});await open(join(folder,'initial-state'));
  });
  await check(releaseRehearsalCases[2],async()=>{
   // Successful migrations may precede a failure in real operations. The backup
   // recovery below therefore restores the whole pre-upgrade schema, not only
   // the transaction that is deliberately broken here.
   await apply(manifest.filter(m=>m.name>='0012'&&m.name<'0018').map(m=>m.name));
   let failure;
   try{await db.batch([db.prepare('CREATE TABLE release_fault_probe(id TEXT)'),db.prepare("INSERT INTO release_fault_probe VALUES('must roll back')"),db.prepare('INSERT INTO deliberately_missing_release_table VALUES(1)')]);}catch(error){failure=error;}
   assert.ok(failure,'Injected migration must fail');assert.match(failure.message,/no such table|D1_ERROR/i);
   reporter.setMetadata('faultInjection',{afterMigration:'0017_phase5_space_feeds.sql',statements:['CREATE TABLE release_fault_probe(id TEXT)',"INSERT INTO release_fault_probe VALUES('must roll back')",'INSERT INTO deliberately_missing_release_table VALUES(1)'],observedError:failure.message,expected:true});
   assert.equal(await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='release_fault_probe'").first('n'),0);
   await assertPreserved(baseline);
  });
  await check(releaseRehearsalCases[3],async()=>{await close();cpSync(backup,join(folder,'failed-upgrade-recovered'),{recursive:true,errorOnExist:true,force:false});await open(join(folder,'failed-upgrade-recovered'));await assertPreserved(baseline);assert.equal(await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='access_state'").first('n'),0);});
  await apply(manifest.filter(m=>m.name>='0012').map(m=>m.name));
  await check(releaseRehearsalCases[4],()=>assertPreserved(baseline));
  await check(releaseRehearsalCases[5],async()=>{assert.equal(await db.prepare('SELECT enabled FROM access_state WHERE id=1').first('enabled'),0);assert.equal(await db.prepare("SELECT workspace_role FROM users WHERE id='owner'").first('workspace_role'),'owner');assert.equal(await db.prepare("SELECT role FROM space_members WHERE space_id='space-core' AND user_id='owner'").first('role'),'owner');assert.equal(await db.prepare("SELECT space_id FROM records WHERE id='task'").first('space_id'),'space-core');});
  await check(releaseRehearsalCases[6],async()=>{assert.equal(await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('sync_snapshots','sync_snapshot_items')").first('n'),0);assert.equal(await db.prepare("SELECT space_id FROM shares WHERE token='fixture-share'").first('space_id'),'space-core');});
  await check(releaseRehearsalCases[7],async()=>{let pending=await db.prepare('SELECT COUNT(*) n FROM search_dirty').first('n');assert.ok(pending>=5);for(let i=0;i<20&&pending;i++){const processed=await callIndexer('/process');assert.ok(processed>0&&processed<=50);pending=await db.prepare('SELECT COUNT(*) n FROM search_dirty').first('n');}assert.equal(pending,0);assert.ok(await db.prepare("SELECT COUNT(*) n FROM search_fts WHERE search_fts MATCH 'sentinel*'").first('n')>=2);assert.equal(await db.prepare('SELECT COUNT(*) n FROM search_documents d LEFT JOIN search_fts f ON f.rowid=d.rowid WHERE f.rowid IS NULL').first('n'),0);});
  await check(releaseRehearsalCases[8],async()=>{const expected=await rows('SELECT doc_id,title,body,source_rev FROM search_documents ORDER BY doc_id');await db.prepare('DELETE FROM search_fts').run();assert.equal(await db.prepare('SELECT COUNT(*) n FROM search_fts').first('n'),0);const queued=await callIndexer('/rebuild');assert.ok(queued.queued>0);for(let i=0;i<20&&await db.prepare('SELECT COUNT(*) n FROM search_dirty').first('n');i++)await callIndexer('/process');assert.equal(await db.prepare('SELECT COUNT(*) n FROM search_dirty').first('n'),0);assert.deepEqual(await rows('SELECT doc_id,title,body,source_rev FROM search_documents ORDER BY doc_id'),expected);assert.equal(await db.prepare('SELECT COUNT(*) n FROM search_fts').first('n'),expected.length);});
  await check(releaseRehearsalCases[9],async()=>{for(const table of ['ai_connections','ai_scope_consents','ai_previews','ai_preview_done','ai_workflow_changesets','ai_usage','ai_embedding_dirty','ai_embeddings','ai_suggestions','ai_digest_runs'])assert.ok(await db.prepare('SELECT name FROM sqlite_master WHERE name=?').bind(table).first('name'));assert.ok((await rows('PRAGMA table_info(ai_digest_runs)')).some(r=>r.name==='outcome'));});
  await check(releaseRehearsalCases[10],async()=>{assert.deepEqual(await rows('PRAGMA foreign_key_check'),[]);assert.equal(await db.prepare('PRAGMA quick_check').first('quick_check'),'ok');});
  await check(releaseRehearsalCases[11],async()=>{const final=await snapshot();await close();cpSync(join(folder,'failed-upgrade-recovered'),join(folder,'final-backup'),{recursive:true,errorOnExist:true,force:false});cpSync(join(folder,'final-backup'),join(folder,'final-restored-state'),{recursive:true,errorOnExist:true,force:false});await open(join(folder,'final-restored-state'));assert.deepEqual(await snapshot(),final);assert.deepEqual(await db.prepare("SELECT data FROM file_chunks WHERE file_id='file'").first('data'),[1,2,3,4]);assert.equal(await db.prepare('SELECT SUM(size) n FROM files WHERE complete=1').first('n'),4);});
 } catch(error) {reporter.setMetadata('error',error.message);console.error(error.stack);process.exitCode=1;}
 finally {
  try{await close();}catch(error){reporter.record('D1','local','owned local fixture cleanup','FAIL',error);process.exitCode=1;}
  const finalFingerprint=fingerprint(ROOT);
  reporter.setMetadata('initialFingerprint',initialFingerprint);reporter.setMetadata('finalFingerprint',finalFingerprint);
  // The encompassing certification gate enforces a clean unchanged committed
  // source. Standalone runs also disclose drift without confusing concurrent
  // local development with a database failure.
  reporter.setMetadata('sourceUnchanged',initialFingerprint===finalFingerprint);
  writeJson(join(folder,'metrics.json'),measurements);writeJson(join(folder,'commands.json'),commands);
  const limitations=['Local Miniflare D1 measurements are not production billing or regional latency.','Closed disposable local state copies are not Cloudflare Time Travel, SQL export, or a production backup/restore proof.','No credentials, production resources, remote migrations, permissions activation, or real AI provider were used.'];
  const report=reporter.finish();
  writeJson(join(folder,'summary.json'),{status:report.status,sourceSha:sha,tree,initialFingerprint,finalFingerprint,sourceUnchanged:initialFingerprint===finalFingerprint,startedAt,endedAt:new Date().toISOString(),fixtureId:fixtureName,permissionMode:'DISABLED',legacySha:LEGACY_SHA,legacyMigrationCount:11,finalMigrationCount:(()=>{try{return verifyMigrationManifest().length;}catch{return 0;}})(),legacyTableCount:allTables?.length??0,summary:report.summary,allMandatoryAssertionsExecuted:report.allMandatoryAssertionsExecuted,limitations});
  writeFileSync(join(folder,'report.md'),`# Local release migration/recovery rehearsal\n\nResult: ${report.status}; ${report.summary.pass} PASS, ${report.summary.fail} FAIL.\n\nSource: ${sha}; tree: ${tree}.\n\n${commands.map(c=>`- ${c.exitCode===0?'PASS':'FAIL'} — ${c.check} (${Math.round(c.durationMs)} ms)`).join('\n')}\n\n${limitations.join('\n\n')}\n`);
  console.log('Release rehearsal evidence:',folder);
  return {folder,report};
 }
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 // Existing suite orchestration appends --skip-build. This runner never builds
 // the application; accept that one compatibility flag, never remote/config URLs.
 if(process.argv.slice(2).some(arg=>arg!=='--skip-build')||process.argv.slice(2).length>1){console.error('Usage: node scripts/release-rehearsal.mjs [--skip-build] (local disposable state only)');process.exitCode=2;}
 else await runReleaseRehearsal();
}
