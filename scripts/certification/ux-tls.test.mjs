import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {ensureLabTls} from '../ux-lab/tls.mjs';
function fixture(fn){const dir=mkdtempSync(join(tmpdir(),'tcg-ux-tls-test-'));try{fn({cert:join(dir,'cert.pem'),key:join(dir,'key.pem')});}finally{rmSync(dir,{recursive:true,force:true});}}
test('creates protected local TLS and reuses a healthy certificate',()=>fixture(tls=>{
 assert.equal(ensureLabTls(tls),true);const first=readFileSync(tls.cert,'utf8');
 assert.equal(statSync(tls.key).mode&0o777,0o600);assert.equal(ensureLabTls(tls),false);assert.equal(readFileSync(tls.cert,'utf8'),first);
}));
test('renews a generated certificate before its remaining day expires',()=>fixture(tls=>{
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-keyout',tls.key,'-out',tls.cert],{stdio:'ignore'});
 const old=readFileSync(tls.cert,'utf8');assert.equal(ensureLabTls(tls),true);assert.notEqual(readFileSync(tls.cert,'utf8'),old);
 execFileSync('openssl',['x509','-checkend','86400','-noout','-in',tls.cert],{stdio:'ignore'});
}));
test('never overwrites a supplied certificate, including missing-file failure',()=>fixture(tls=>{
 assert.throws(()=>ensureLabTls(tls,{provided:true}),/missing/);ensureLabTls(tls);const first=readFileSync(tls.cert,'utf8');
 assert.equal(ensureLabTls(tls,{provided:true}),false);assert.equal(readFileSync(tls.cert,'utf8'),first);
}));
