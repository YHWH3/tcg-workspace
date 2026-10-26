import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {migrationStatements,verifyMigrationManifest,releaseRehearsalCases,RELEASE_MIGRATION_COUNT} from '../release-rehearsal.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
function manifestFixture(){const parent=join(root,'.artifacts','release-rehearsal-selftests');mkdirSync(parent,{recursive:true});const folder=mkdtempSync(join(parent,'manifest-'));mkdirSync(join(folder,'migrations'));mkdirSync(join(folder,'scripts/certification'),{recursive:true});const sql='CREATE TABLE sentinel(id TEXT);\n';writeFileSync(join(folder,'migrations/0001_fixture.sql'),sql);const manifest=[{name:'0001_fixture.sql',sha256:createHash('sha256').update(sql).digest('hex')}];writeFileSync(join(folder,'scripts/certification/migrations.json'),JSON.stringify(manifest));return{folder,manifest};}

test('registered migration fixture verifies matching bytes',()=>{const f=manifestFixture();assert.deepEqual(verifyMigrationManifest(f.folder),f.manifest);});
test('unregistered migration is rejected before any database opens',()=>{const f=manifestFixture();writeFileSync(join(f.folder,'migrations/0002_unregistered.sql'),'SELECT 1;');assert.throws(()=>verifyMigrationManifest(f.folder),/Every migration/);});
test('missing mandatory migration is rejected',()=>{const f=manifestFixture();writeFileSync(join(f.folder,'scripts/certification/migrations.json'),JSON.stringify([...f.manifest,{name:'0002_missing.sql',sha256:'0'.repeat(64)}]));assert.throws(()=>verifyMigrationManifest(f.folder),/Every migration/);});
test('changed shipped SQL fails its registered hash',()=>{const f=manifestFixture();writeFileSync(join(f.folder,'migrations/0001_fixture.sql'),'CREATE TABLE attacker(id TEXT);');assert.throws(()=>verifyMigrationManifest(f.folder),/Migration hash changed/);});
test('trigger body remains a single transactional migration statement',()=>{const sql='-- fixture\nCREATE TABLE sentinel(id TEXT); CREATE TRIGGER sentinel_ai AFTER INSERT ON sentinel BEGIN INSERT INTO sentinel VALUES(1); UPDATE sentinel SET id=2; END; SELECT 1;';const statements=migrationStatements(sql);assert.equal(statements.length,3);assert.match(statements[1],/^CREATE TRIGGER/);assert.match(statements[1],/UPDATE sentinel SET id=2; END;$/);});
test('rehearsal declares every checkpoint exactly once',()=>{assert.equal(releaseRehearsalCases.length,12);assert.equal(new Set(releaseRehearsalCases).size,12);assert.ok(releaseRehearsalCases.some(name=>name.includes('failed migration')));assert.ok(releaseRehearsalCases.some(name=>name.includes('file bytes')));});

test('release migration count matches the current registered manifest',()=>{assert.equal(verifyMigrationManifest(root).length,RELEASE_MIGRATION_COUNT);});
