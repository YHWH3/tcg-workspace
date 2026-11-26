import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 DEFAULT_UX_CONCURRENCY,
 partitionProjects,
 aggregateProjects,
 resolveConcurrency,
 runBoundedPool,
} from '../ux-lab/project-isolation.mjs';

const available=['chromium-compact-light','chromium-compact-dark','firefox-compact-light'];
const source={sha:'a',fingerprint:'f'};
const child=(project,patch={})=>({project,exitCode:0,summary:{source,rows:[{project,surface:'case',status:'expected'}],runtimes:[{project}],stats:{expected:1,skipped:0,unexpected:0,flaky:0,duration:10},...patch}});

test('partitions all default projects and retains non-project CLI options while stripping concurrency flags',()=>{
 assert.deepEqual(partitionProjects(['--grep','source.*'],available),{projects:available,childArgs:['--grep','source.*']});
 assert.deepEqual(partitionProjects(['--project=chromium-*','--project',available[2],'--concurrency=2','--grep=case'],available),{projects:available,childArgs:['--grep=case']});
 assert.deepEqual(partitionProjects(['--serial','--concurrency','1','--crm-p4'],available),{projects:available,childArgs:['--crm-p4']});
});

test('deduplicates selected projects and rejects unknown or missing flags',()=>{
 assert.deepEqual(partitionProjects(['--project',available[0],available[1],'--project='+available[0]],available).projects,available.slice(0,2));
 assert.throws(()=>partitionProjects(['--project'],available));assert.throws(()=>partitionProjects(['--project=unknown'],available));
});

test('resolves bounded concurrency with conservative default, serial fallback, and strict bounds',()=>{
 assert.equal(resolveConcurrency([],{}),DEFAULT_UX_CONCURRENCY);
 assert.equal(resolveConcurrency([],{UX_CONCURRENCY:'1'}),1);
 assert.equal(resolveConcurrency(['--serial'],{UX_CONCURRENCY:'3'}),1);
 assert.equal(resolveConcurrency(['--concurrency=3'],{}),3);
 assert.equal(resolveConcurrency(['--concurrency','4'],{}),4);
 assert.throws(()=>resolveConcurrency(['--concurrency=0'],{}));
 assert.throws(()=>resolveConcurrency(['--concurrency=5'],{}));
 assert.throws(()=>resolveConcurrency([],{UX_CONCURRENCY:'abc'}));
});

test('runBoundedPool enforces concurrency ceiling, deterministic ordering, and fail-fast cancellation',async()=>{
 let active=0,maxActive=0;
 const items=['p1','p2','p3','p4','p5'];
 const out=await runBoundedPool(items,2,async(item,idx)=>{
  active+=1;
  if(active>maxActive)maxActive=active;
  await new Promise(r=>setTimeout(r,(items.length-idx)*5));
  active-=1;
  return {item,idx};
 });
 assert.equal(maxActive,2);
 assert.deepEqual(out.map(x=>x.item),items);

 // Serial fallback never runs more than 1 at a time
 let serialMax=0,serialActive=0;
 const serialOut=await runBoundedPool(['a','b','c'],1,async(item)=>{
  serialActive+=1;
  if(serialActive>serialMax)serialMax=serialActive;
  await new Promise(r=>setTimeout(r,5));
  serialActive-=1;
  return {item};
 });
 assert.equal(serialMax,1);
 assert.deepEqual(serialOut.map(x=>x.item),['a','b','c']);

 // Fail-fast stops scheduling remaining items after a failure
 const visited=[];
 await runBoundedPool(['a','b','c','d'],1,async(item)=>{
  visited.push(item);
  return {item,stopPool:item==='b'};
 });
 assert.deepEqual(visited,['a','b']);
});

test('aggregates only real child rows and retains their project runtimes',()=>{
 const report=aggregateProjects(source,[child('a'),child('b')],true);assert.equal(report.exitCode,0);assert.equal(report.rows.length,2);assert.equal(report.stats.expected,2);assert.equal(report.runtimes.length,2);
});

test('missing child results, failed or interrupted cases and source drift cannot pass',()=>{
 for(const children of [[],[{exitCode:0,summary:null}],[{...child('a'),exitCode:1}],[child('a',{rows:[{status:'unexpected'}]})],[child('a',{source:{...source,fingerprint:'changed'}})]])assert.equal(aggregateProjects(source,children,true).exitCode,1);
 assert.equal(aggregateProjects(source,[child('a')],false).exitCode,1);assert.equal(aggregateProjects(source,[child('a')],true,true).exitCode,130);
});

test('incomplete, duplicate or misattributed project reports fail closed',()=>{
 assert.equal(aggregateProjects(source,[child('a')],true,false,['a','b']).exitCode,1);
 assert.equal(aggregateProjects(source,[child('a'),child('a')],true,false,['a','b']).exitCode,1);
 assert.equal(aggregateProjects(source,[child('a',{rows:[{project:'b',status:'expected'}]})],true).exitCode,1);
});
