#!/usr/bin/env node
// Local packaging/configuration validation only. No network, credentials or D1 access.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import JSON5 from 'json5';
import {createCertificationReporter} from './certification-report.mjs';

export const releasePreflightNames=[
  'explicit production target','D1 binding','OAuth KV binding','LiveRoom binding and migration',
  'asset and OAuth routing','fifteen-minute Cron','local bindings have no remote access',
  'fixture bypasses absent','optional AI disabled','secret values absent from config',
  'permission activation defaults off','34 immutable migration hashes','lockfile and pinned Wrangler',
  'built package matches deployment contract',
];
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const json=path=>JSON.parse(readFileSync(path,'utf8'));
// Already lockfile-installed through Vite; accepts JSONC comments/trailing commas.
function config(path){return JSON5.parse(readFileSync(path,'utf8'));}
function invariant(condition,message){if(!condition)throw new Error(message);}
function hasRemote(value){return value&&typeof value==='object'&&(value.remote===true||Object.values(value).some(hasRemote));}
const oauthRoutes=['/api/*','/mcp','/mcp/*','/oauth/*','/token','/register','/.well-known/*'];
function contract(c){return {name:c.name,compatibility_date:c.compatibility_date,compatibility_flags:c.compatibility_flags,vars:c.vars??{},durable_objects:c.durable_objects,migrations:c.migrations,kv_namespaces:c.kv_namespaces,ai:c.ai,triggers:c.triggers,d1:(c.d1_databases??[]).map(({binding,database_name,database_id})=>({binding,database_name,database_id})),assets:{not_found_handling:c.assets?.not_found_handling,run_worker_first:c.assets?.run_worker_first}};}

/** Exported for local harness tests; accepting a path never grants remote access. */
export function inspectRelease(root=project){
  const results=[];
  let c;
  try{c=config(join(root,'wrangler.jsonc'));}catch{return releasePreflightNames.map(test=>({test,status:'FAIL',error:'Local Wrangler configuration missing or malformed'}));}
  // Assertion diffs can contain operator configuration; retain only the fixed heading.
  const check=(test,fn)=>{try{fn();results.push({test,status:'PASS'});}catch(error){results.push({test,status:'FAIL',error:error.message.split('\n')[0]});}};
  check(releasePreflightNames[0],()=>invariant(c.name==='workspace'&&c.main==='worker/index.ts'&&!Object.keys(c.env??{}).length,'Expected explicit workspace target; review environment changes before release'));
  check(releasePreflightNames[1],()=>{assert.deepEqual(c.d1_databases?.map(({binding,database_name,database_id,migrations_dir})=>({binding,database_name,database_id,migrations_dir})),[{binding:'DB',database_name:'workspace-db',database_id:'59b10ca8-3018-4e26-aa42-c9eeeb2fccc6',migrations_dir:'migrations'}],'D1 target differs from reviewed release contract');});
  check(releasePreflightNames[2],()=>invariant(c.kv_namespaces?.length===1&&c.kv_namespaces[0].binding==='OAUTH_KV'&&c.kv_namespaces[0].id==='93e1cd3d50204666baeb2dbfb62189dc','OAuth namespace differs from reviewed release contract'));
  check(releasePreflightNames[3],()=>{assert.deepEqual(c.durable_objects,{bindings:[{name:'LIVE',class_name:'LiveRoom'}]});assert.deepEqual(c.migrations,[{tag:'v1',new_sqlite_classes:['LiveRoom']}]);});
  check(releasePreflightNames[4],()=>invariant(c.assets?.directory==='./dist/client'&&c.assets.not_found_handling==='single-page-application'&&oauthRoutes.every(route=>c.assets.run_worker_first?.includes(route)),'SPA/assets or authenticated OAuth/API routing incomplete'));
  check(releasePreflightNames[5],()=>assert.deepEqual(c.triggers?.crons,['*/15 * * * *'],'Reviewed fifteen-minute UTC schedule missing or changed'));
  check(releasePreflightNames[6],()=>invariant(!hasRemote(c),'A configured binding uses remote access; local rehearsal must remain isolated'));
  check(releasePreflightNames[7],()=>invariant(!('TURNSTILE_LOCAL_TEST' in (c.vars??{}))&&(c.vars??{}).WORKSPACE_ENV!=='local-test','Disposable-only challenge bypass present in deployment configuration'));
  check(releasePreflightNames[8],()=>invariant(c.ai?.binding==='AI'&&(!c.vars?.AI_PROVIDER||c.vars.AI_PROVIDER==='none')&&(!c.vars?.AI_DAILY_UNITS||c.vars.AI_DAILY_UNITS==='0')&&!c.vars?.AI_CLASSIFICATION&&!c.vars?.AI_CHAT_MODEL&&!c.vars?.AI_BYOK_PROVIDERS&&!c.vars?.AI_CREDENTIAL_KEY&&!c.vars?.OPENAI_CHATGPT_HOSTED_APPROVAL,'Optional AI is enabled or AI binding differs; this candidate certifies disabled-mode operation'));
  check(releasePreflightNames[9],()=>invariant(!Object.keys(c.vars??{}).some(key=>/(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)$/i.test(key)),'Secret-like value stored as plaintext deployment variable; configure secret names through approved operator flow'));
  check(releasePreflightNames[10],()=>invariant(/INSERT\s+INTO\s+access_state\(id,generation,enabled\)\s+VALUES\(1,1,0\)/i.test(readFileSync(join(root,'migrations/0012_phase5_access_foundation.sql'),'utf8')),'Access foundation no longer defaults to disabled'));
  check(releasePreflightNames[11],()=>{
    const manifest=json(join(root,'scripts/certification/migrations.json')),files=readdirSync(join(root,'migrations')).filter(name=>name.endsWith('.sql')).sort();
    invariant(manifest.length===34&&files.length===34,'Expected exactly 34 registered migrations; review additive migration changes');
    invariant(manifest.every((entry,index)=>entry.name===files[index]&&entry.name.startsWith(String(index+1).padStart(4,'0')+'_')&&entry.sha256===createHash('sha256').update(readFileSync(join(root,'migrations',entry.name))).digest('hex')),'Migration name/order/hash differs from immutable manifest');
  });
  check(releasePreflightNames[12],()=>{
    const pkg=json(join(root,'package.json')),lock=json(join(root,'package-lock.json')),installed=json(join(root,'node_modules/wrangler/package.json'));
    invariant(pkg.devDependencies.wrangler===installed.version&&lock.packages['node_modules/wrangler'].version===installed.version,'Installed Wrangler differs from pinned lockfile');
    for(const key of ['dependencies','devDependencies'])assert.deepEqual(pkg[key],lock.packages[''][key],'Root dependency manifest differs from lockfile');
    invariant(pkg.scripts.deploy==='npm run build && wrangler deploy','Deployment command changed; verify explicit target contract');
  });
  check(releasePreflightNames[13],()=>{
    const redirect=json(join(root,'.wrangler/deploy/config.json')),generatedPath=resolve(root,'.wrangler/deploy',redirect.configPath),built=config(generatedPath);
    assert.deepEqual(contract(built),contract(c),'Built configuration differs from current source; rebuild and verify target');
    invariant(existsSync(resolve(dirname(generatedPath),built.main))&&existsSync(resolve(dirname(generatedPath),built.assets.directory,'index.html')),'Built Worker or client index missing; run npm run build');
    invariant(resolve(dirname(generatedPath),built.assets.directory)===join(root,'dist/client'),'Generated package points outside intended local client assets');
  });
  return results;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  process.env.CERT_SOURCE_SHA??=execFileSync('git',['rev-parse','HEAD'],{cwd:project,encoding:'utf8'}).trim();
  const reporter=createCertificationReporter('release-preflight',releasePreflightNames);
  reporter.setMetadata('scope','Local static contract and built-package checks only; never authorizes deployment');
  reporter.setMetadata('productionReleaseCertified',false);
  reporter.setMetadata('productionTargetWarning','Default config targets existing production workspace/DB/KV. Do not deploy or migrate without separate approval.');
  reporter.setMetadata('operatorConfiguration',{secretNames:['TURNSTILE_SECRET'],publicVariableNames:['TURNSTILE_SITE_KEY','TURNSTILE_HOSTNAMES'],optionalDisabled:['AI_PROVIDER','AI_DAILY_UNITS','AI_CLASSIFICATION','AI_CHAT_MODEL','AI_BYOK_PROVIDERS','AI_CREDENTIAL_KEY','OPENAI_CHATGPT_HOSTED_APPROVAL','REMOTE_IMPORT_HOSTS'],valuesIncluded:false});
  reporter.setMetadata('externalReleaseGates',['Live remote variables/secrets and target settings','Approved production backup/restore','Real Turnstile and hostname','Physical devices and assistive technology','Real third-party MCP host','Real optional AI provider'].map(test=>({test,status:'NOT VERIFIED'})));
  if(process.argv.length>2)reporter.record('node','none','arguments','FAIL','This read-only local preflight accepts no command-line arguments');
  else for(const result of inspectRelease()){reporter.record('node','none',result.test,result.status,result.error);console.log(`${result.status}: ${result.test}`);}
  const report=reporter.finish();
  console.log(`${report.summary.pass} PASS / ${report.summary.fail} FAIL. Remote release gates remain NOT VERIFIED; no deployment approval is inferred.`);
}
