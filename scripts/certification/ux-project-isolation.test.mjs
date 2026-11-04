import {test} from 'node:test';
import assert from 'node:assert/strict';
import {partitionProjects,aggregateProjects} from '../ux-lab/project-isolation.mjs';
const available=['chromium-compact-light','chromium-compact-dark','firefox-compact-light'];
const source={sha:'a',fingerprint:'f'};
const child=(project,patch={})=>({project,exitCode:0,summary:{source,rows:[{project,surface:'case',status:'expected'}],runtimes:[{project}],stats:{expected:1,skipped:0,unexpected:0,flaky:0,duration:10},...patch}});
test('partitions all default projects and retains non-project CLI options',()=>{
 assert.deepEqual(partitionProjects(['--grep','source.*'],available),{projects:available,childArgs:['--grep','source.*']});
 assert.deepEqual(partitionProjects(['--project=chromium-*','--project',available[2],'--grep=case'],available),{projects:available,childArgs:['--grep=case']});
});
test('deduplicates selected projects and rejects unknown or missing flags',()=>{
 assert.deepEqual(partitionProjects(['--project',available[0],available[1],'--project='+available[0]],available).projects,available.slice(0,2));
 assert.throws(()=>partitionProjects(['--project'],available));assert.throws(()=>partitionProjects(['--project=unknown'],available));
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
