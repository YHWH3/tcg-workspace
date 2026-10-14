import test from 'node:test';
import assert from 'node:assert/strict';
import {preventIdleSleep} from './core.mjs';

test('idle-sleep prevention owns only its spawned assertion and ties it to the runner',()=>{
 const calls=[];const child={pid:12345,killed:false,on(){},unref(){calls.push('unref');},kill(signal){calls.push(['kill',signal]);this.killed=true;}};
 const guard=preventIdleSleep({os:'darwin',available:true,ownerPid:9876,spawnProcess:(...args)=>{calls.push(args);return child;}});
 assert.deepEqual(calls[0],['/usr/bin/caffeinate',['-i','-w','9876'],{stdio:'ignore'}]);assert.equal(guard.evidence.active,true);
 guard.stop();guard.stop();assert.equal(calls.filter(x=>Array.isArray(x)&&x[0]==='kill').length,1);
});
test('non-macOS and unavailable utilities never start or stop another process',()=>{
 for(const config of [{os:'linux',available:true},{os:'darwin',available:false}]){
 const guard=preventIdleSleep({...config,spawnProcess:()=>{throw new Error('must not spawn');}});assert.equal(guard.evidence.active,false);guard.stop();
 }
});
test('sleep assertion launch failure is reported without claiming active protection',()=>{
 const guard=preventIdleSleep({os:'darwin',available:true,spawnProcess:()=>{throw new Error('launch failure');}});
 assert.equal(guard.evidence.active,false);assert.equal(guard.evidence.error,'launch failure');guard.stop();
});
