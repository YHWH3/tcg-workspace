import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticReadUrl,readRecoveryInBrowser} from '../ux-lab/read-recovery.mjs';
const origin='https://127.0.0.1:9999',url=origin+'/api/workspace/settings';
test('diagnostic selection refuses arbitrary routes, JS errors and foreign origins',()=>{
 const line=u=>'Fetch API cannot load '+u+' due to access control checks.\n at app';
 assert.equal(diagnosticReadUrl(line(url),origin),url);
 for(const value of [line('https://other.example/api/workspace/settings'),line(origin+'/api/users/1/disable'),'Uncaught Error: settings unavailable'])assert.equal(diagnosticReadUrl(value,origin),null);
});
test('settings recovery requires an online authenticated valid response; refusals cannot pass',async t=>{
 const saved=new Map(['navigator','localStorage','fetch'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 t.after(()=>{for(const [key,descriptor]of saved)descriptor?Object.defineProperty(globalThis,key,descriptor):Reflect.deleteProperty(globalThis,key);});
 Object.defineProperty(globalThis,'navigator',{value:{onLine:true},configurable:true});globalThis.localStorage={getItem:()=> 'disposable'};
 const settings={timeZone:'Asia/Kolkata',currency:'INR',weekStart:1,version:2};
 let response=new Response(JSON.stringify({settings}));globalThis.fetch=async(_url,options)=>{assert.equal(options.headers.Authorization,'Bearer disposable');return response;};
 assert.deepEqual(await readRecoveryInBrowser(url),{online:true,status:200});
 for(const invalid of [{...settings,timeZone:'No/Such'},{...settings,currency:'XYZ'},{...settings,version:0},{...settings,weekStart:7},null]){response=new Response(JSON.stringify({settings:invalid}));assert.deepEqual(await readRecoveryInBrowser(url),{online:true,status:0});}
 for(const status of [401,403,500]){response=new Response('{}',{status});assert.deepEqual(await readRecoveryInBrowser(url),{online:true,status});}
 Object.defineProperty(globalThis,'navigator',{value:{onLine:false},configurable:true});assert.deepEqual(await readRecoveryInBrowser(url),{online:false,status:0});
});
