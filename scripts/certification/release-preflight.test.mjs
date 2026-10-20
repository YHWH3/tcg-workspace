import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectRelease,releasePreflightNames} from '../release-preflight.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'tcg-release-preflight-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const dir of ['scripts/certification','.wrangler/deploy','dist/workspace','dist/client','node_modules/wrangler'])mkdirSync(join(root,dir),{recursive:true});
  for(const file of ['wrangler.jsonc','package.json','package-lock.json','scripts/certification/migrations.json','node_modules/wrangler/package.json'])copyFileSync(join(project,file),join(root,file));
  cpSync(join(project,'migrations'),join(root,'migrations'),{recursive:true});
  const source=JSON.parse(readFileSync(join(root,'wrangler.jsonc'),'utf8'));
  const built={...structuredClone(source),main:'index.js',assets:{...source.assets,directory:'../client'}};
  writeFileSync(join(root,'dist/workspace/wrangler.json'),JSON.stringify(built));
  writeFileSync(join(root,'.wrangler/deploy/config.json'),JSON.stringify({configPath:'../../dist/workspace/wrangler.json'}));
  writeFileSync(join(root,'dist/workspace/index.js'),'// Packaging existence fixture; actual build is a separate gate.');
  writeFileSync(join(root,'dist/client/index.html'),'<!doctype html><title>Disposable packaging fixture</title>');
  return {root,source,built};
}
const failed=(root,name)=>inspectRelease(root).find(row=>row.test===name)?.status==='FAIL';

test('local release contract passes without production secrets or credentials',t=>{
  const {root}=fixture(t),results=inspectRelease(root);
  assert.equal(results.length,releasePreflightNames.length);
  assert.ok(results.every(row=>row.status==='PASS'),JSON.stringify(results));
});

test('unsafe fixture/prod configuration fails even when the same values enter the built package',t=>{
  const {root,source,built}=fixture(t);
  const unsafe={TURNSTILE_LOCAL_TEST:'1',TURNSTILE_SECRET:'NONSECRET-CANARY-NEVER-RETURN',AI_PROVIDER:'workers-ai',AI_DAILY_UNITS:'100'};
  source.vars=unsafe;built.vars=unsafe;source.d1_databases[0].remote=true;built.d1_databases[0].remote=true;
  writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify(source));writeFileSync(join(root,'dist/workspace/wrangler.json'),JSON.stringify(built));
  for(const name of ['local bindings have no remote access','fixture bypasses absent','optional AI disabled','secret values absent from config'])assert.ok(failed(root,name),name);
  assert.ok(!JSON.stringify(inspectRelease(root)).includes(unsafe.TURNSTILE_SECRET),'Report must not echo operator values');
});

test('missing or modified migration cannot satisfy the immutable ledger',t=>{
  const {root}=fixture(t);
  writeFileSync(join(root,'migrations/0001_init.sql'),'-- tampered fixture');
  assert.ok(failed(root,'31 immutable migration hashes'));
  rmSync(join(root,'migrations/0031_phase6_digest_outcome.sql'));
  assert.ok(failed(root,'31 immutable migration hashes'));
});

test('stale generated target or missing client package fails release packaging',t=>{
  const {root,built}=fixture(t);
  built.d1_databases[0].database_id='another-target';
  writeFileSync(join(root,'dist/workspace/wrangler.json'),JSON.stringify(built));
  assert.ok(failed(root,'built package matches deployment contract'));
  rmSync(join(root,'dist/client/index.html'));
  assert.ok(failed(root,'built package matches deployment contract'));
});

test('malformed configuration fails every planned local check',t=>{
  const {root}=fixture(t);writeFileSync(join(root,'wrangler.jsonc'),'{ malformed');
  const results=inspectRelease(root);assert.equal(results.length,releasePreflightNames.length);
  assert.ok(results.every(row=>row.status==='FAIL'));
});
