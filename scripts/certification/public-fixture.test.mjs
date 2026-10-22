import test from 'node:test';
import assert from 'node:assert/strict';
import {publicFixturePolicy} from './public-fixture.mjs';
const secret='a'.repeat(64),entry='/qa-entry-'+secret;
test('test ingress denies APIs, root and unknown files without exact cookie',()=>{
  for(const path of ['/','/api/auth/signup','/api/files/private','/mcp','/oauth/authorize','/apple-probe.mjs'])assert.equal(publicFixturePolicy(path,'',secret,entry),'deny');
  assert.equal(publicFixturePolicy('/api/users','tcg_qa='+secret.slice(1),secret,entry),'deny');
  assert.equal(publicFixturePolicy('/api/users','tcg_qa='+secret+'x',secret,entry),'deny');
  assert.equal(publicFixturePolicy('/api/users','tcg_qa='+'é'.repeat(64),secret,entry),'deny');
});
test('test ingress exposes only static manifest assets needed by WebAPK packaging',()=>{
  for(const path of ['/manifest.webmanifest','/icons/icon-192.png','/assets/index-Abc_12.js'])assert.equal(publicFixturePolicy(path,'',secret,entry),'static');
  for(const path of ['/assets/../api/users','/icons/../../api/users','/icons/private.svg','/manifest.webmanifest/extra'])assert.equal(publicFixturePolicy(path,'',secret,entry),'deny');
});
test('test ingress accepts exact entry and cookie without substring credentials',()=>{
  assert.equal(publicFixturePolicy(entry,'',secret,entry),'entry');
  assert.equal(publicFixturePolicy(entry+'x','',secret,entry),'deny');
  assert.equal(publicFixturePolicy('/api/users','other=1; tcg_qa='+secret+'; x=2',secret,entry),'authenticated');
  assert.equal(publicFixturePolicy('/api/users','prefix_tcg_qa='+secret,secret,entry),'deny');
});
