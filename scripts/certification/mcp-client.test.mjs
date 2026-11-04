import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connectFixtureMcp} from './mcp-client.mjs';
test('HTTPS raw review fixtures reject non-loopback, credentials, paths and ambient human approval before network',async()=>{
 for(const base of ['https://example.com','https://127.0.0.1/private','https://user:secret@localhost','https://localhost/?key=x','https://localhost/#x','http://localhost'])await assert.rejects(connectFixtureMcp(base,{allowHttps:true,fixtureHuman:false}),/exact loopback origin/);
 await assert.rejects(connectFixtureMcp('https://localhost',{allowHttps:true}),/raw review mode/);
});
test('existing fixture defaults preserve HTTP-only local boundary',async()=>{
 await assert.rejects(connectFixtureMcp('https://localhost'),/loopback HTTP origin/);
 await assert.rejects(connectFixtureMcp('http://example.com'),/loopback HTTP origin/);
});
