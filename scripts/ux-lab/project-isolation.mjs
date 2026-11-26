import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fingerprint} from '../certification/core.mjs';
import {coverage} from './coverage.mjs';
import {surfaces,notCovered} from './catalog.mjs';

export const DEFAULT_UX_CONCURRENCY=2;
export const MAX_UX_CONCURRENCY=4;

/** Parse bounded local browser concurrency (default 2, serial fallback 1, capped at 4). */
export function resolveConcurrency(args=[],env=process.env){
 let raw=env?.UX_CONCURRENCY;
 for(let i=0;i<args.length;i++){
  if(args[i].startsWith('--concurrency='))raw=args[i].slice(14);
  else if(args[i]==='--concurrency'){
   if(i+1>=args.length)throw new Error('--concurrency requires an integer value (1..4)');
   raw=args[++i];
  }else if(args[i]==='--serial'){
   raw='1';
  }
 }
 if(raw===undefined||raw==='')return DEFAULT_UX_CONCURRENCY;
 const parsed=Number(raw);
 if(!Number.isInteger(parsed)||parsed<1||parsed>MAX_UX_CONCURRENCY){
  throw new Error(`Invalid UX concurrency "${raw}": must be an integer between 1 and ${MAX_UX_CONCURRENCY}`);
 }
 return parsed;
}

/** Resolve the existing project flags; every selected project gets its own D1. */
export function partitionProjects(args,available){
 const patterns=[],childArgs=[];
 for(let i=0;i<args.length;i++){
  if(args[i].startsWith('--project='))patterns.push(args[i].slice(10));
  else if(args[i]==='--project'){
   const start=patterns.length;
   while(i+1<args.length&&!args[i+1].startsWith('-'))patterns.push(args[++i]);
   if(start===patterns.length)throw new Error('--project needs a project name');
  }else if(args[i].startsWith('--concurrency=')){
   continue;
  }else if(args[i]==='--concurrency'){
   i+=1;
   continue;
  }else if(args[i]==='--serial'){
   continue;
  }else childArgs.push(args[i]);
 }
 const projects=patterns.length?[...new Set(patterns.flatMap(pattern=>{
  const regex=new RegExp('^'+pattern.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$');
  const matches=available.filter(project=>regex.test(project));if(!matches.length)throw new Error('Unknown UX project: '+pattern);return matches;
 }))]:available;
 return {projects,childArgs};
}

/**
 * Bounded async worker pool with deterministic output ordering and fail-fast cancellation.
 */
export async function runBoundedPool(items,concurrency,worker,shouldStop=()=>false){
 const limit=Math.max(1,Math.min(concurrency,items.length||1));
 const results=new Array(items.length);
 let nextIndex=0;
 let failed=false;
 async function runWorker(){
  while(!failed&&!shouldStop()){
   const idx=nextIndex++;
   if(idx>=items.length)return;
   const res=await worker(items[idx],idx);
   results[idx]=res;
   if(res&&res.stopPool)failed=true;
  }
 }
 await Promise.all(Array.from({length:limit},()=>runWorker()));
 return results.filter(Boolean);
}

export function aggregateProjects(source,children,unchanged,interrupted=false,requestedProjects=children.map(child=>child.project)){
 const reports=children.filter(child=>child.summary).map(child=>child.summary),rows=reports.flatMap(report=>report.rows),runtimes=reports.flatMap(report=>report.runtimes);
 const sourceUnchanged=unchanged&&reports.every(report=>report.source.sha===source.sha&&report.source.fingerprint===source.fingerprint);
 const stats={startTime:reports[0]?.stats?.startTime??new Date().toISOString(),duration:reports.reduce((n,r)=>n+(r.stats?.duration??0),0),expected:0,skipped:0,unexpected:0,flaky:0};
 for(const report of reports)for(const key of ['expected','skipped','unexpected','flaky'])stats[key]+=report.stats?.[key]??0;
 const projectsComplete=children.length===requestedProjects.length&&new Set(children.map(child=>child.project)).size===children.length&&requestedProjects.every(project=>children.some(child=>child.project===project&&child.summary?.rows.every(row=>row.project===project)));
 const exitCode=interrupted?130:!projectsComplete||!sourceUnchanged||!children.length||children.some(child=>child.exitCode!==0||!child.summary||!child.summary.rows.length)||rows.some(row=>row.status!=='expected')?1:0;
 return {source,exitCode,stats,rows,runtimes,sourceUnchanged,projectsComplete};
}

const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');

/** Separate fixture lifetimes preserve real per-user quotas and test isolation. */
export async function runIsolatedProjects({root,output,source,plan,record,skipBuild,crmMode=false,crmP4Mode=false,originalArgs}){
 const concurrency=resolveConcurrency(originalArgs,process.env);
 const activeChildren=new Set();
 let interrupted=false;
 const stop=()=>{
  interrupted=true;
  for(const proc of activeChildren)proc.kill('SIGINT');
 };
 process.once('SIGINT',stop);process.once('SIGTERM',stop);

 // Build once up front before spawning parallel children so workers never race on dist/.
 if(!skipBuild&&concurrency>1){
  const npmCmd=process.platform==='win32'?'npm.cmd':'npm';
  const built=spawnSync(npmCmd,['run','build'],{cwd:root,stdio:'inherit'});
  if((built.status??1)!==0){
   process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
   throw new Error(`Upfront build failed before isolated UX matrix (exit ${built.status??1})`);
  }
 }

 const completedRecords=[];
 let children=[];
 try{
  const poolResults=await runBoundedPool(
   plan.projects,
   concurrency,
   async(project,index)=>{
    const directory=join(output,'projects',project);mkdirSync(directory,{recursive:true});
    const childSkipBuild=skipBuild||concurrency>1||index>0;
    const args=[resolve(root,'scripts/qa-ux.mjs'),...plan.childArgs,'--project='+project,...(childSkipBuild?['--skip-build']:[])];
    const result=await new Promise((resolveDone,reject)=>{
     const proc=spawn(process.execPath,args,{cwd:root,env:{...process.env,UX_OUTPUT:directory},stdio:'inherit'});
     activeChildren.add(proc);
     proc.once('error',err=>{activeChildren.delete(proc);reject(err);});
     proc.once('exit',(code,signal)=>{activeChildren.delete(proc);resolveDone({exitCode:code??1,signal});});
    });
    const summaryPath=join(directory,'summary.json'),reportPath=join(directory,'playwright.json');
    const summary=existsSync(summaryPath)?JSON.parse(readFileSync(summaryPath,'utf8')):null;
    const entry={project,...result,summary,summaryPath,reportPath};
    completedRecords.push({project:entry.project,exitCode:entry.exitCode,summary:entry.summaryPath,...(entry.summary?{sha256:hash(entry.summaryPath)}:{})});
    writeFileSync(join(output,'project-progress.json'),JSON.stringify({source,concurrency,requestedProjects:plan.projects,completed:completedRecords,interrupted},null,2));
    const failed=result.exitCode!==0||!summary||summary.source.fingerprint!==source.fingerprint;
    return {...entry,stopPool:failed};
   },
   ()=>interrupted,
  );
  children=poolResults.map(({stopPool:_stopPool,...rest})=>rest);
 }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}

 const combined=aggregateProjects(source,children,fingerprint(root)===source.fingerprint,interrupted,plan.projects);
 const baselineDirName=crmP4Mode?'crm-p4-baselines':crmMode?'crm-baselines':'baselines';
 const summary={...combined,recordMode:record,crmMode,crmP4Mode,selection:originalArgs,explorations:children.flatMap(c=>c.summary?.explorations??[]),surfaces:surfaces.map(s=>s.id),baselineReview:'GENERATED_REFERENCE_NOT_HUMAN_ACCEPTANCE',notCovered,scope:'Fresh disposable loopback HTTPS/D1 per engine/layout/theme project; only executed named states count. No physical-device or genuine human-approval claim.',report:join(output,'html/index.html'),projectIsolation:{strategy:'fresh_disposable_fixture_per_project',concurrency,requested:plan.projects,children:children.map(c=>({project:c.project,exitCode:c.exitCode,signal:c.signal,summary:c.summaryPath,...(c.summary?{sha256:hash(c.summaryPath)}:{})}))}};
 coverage(summary,output);
 if(!record&&!crmMode&&!crmP4Mode&&!originalArgs.some(a=>/^--(?:project|grep)/.test(a))&&!summary.coverage.complete)summary.exitCode=1;
 writeFileSync(join(output,'summary.json'),JSON.stringify(summary,null,2));
 const raw=children.filter(c=>existsSync(c.reportPath)).map(c=>JSON.parse(readFileSync(c.reportPath,'utf8')));
 writeFileSync(join(output,'playwright.json'),JSON.stringify({projectIsolation:true,concurrency,source,stats:summary.stats,errors:raw.flatMap(r=>r.errors??[]),suites:raw.flatMap(r=>r.suites??[])},null,2));
 mkdirSync(join(output,'html'),{recursive:true});
 writeFileSync(join(output,'html/index.html'),`<!doctype html><meta charset="utf-8"><title>Isolated UX project reports</title><h1>Isolated UX project reports</h1><p>Exit ${summary.exitCode} (concurrency ${concurrency}). Each project used fresh disposable data. Generated references are not human acceptance.</p><p><a href="../coverage.html">Coverage matrix</a></p><ul>${children.map(c=>`<li><a href="../projects/${c.project}/html/index.html">${c.project}</a>: exit ${c.exitCode}</li>`).join('')}</ul>`);
 if(record){const directory=join(root,'.artifacts/ux-lab',baselineDirName);mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'provenance.json'),JSON.stringify({source,recordedAt:new Date().toISOString(),review:'UNREVIEWED',output,projectIsolation:summary.projectIsolation},null,2));}
 console.log('Isolated UX matrix exit '+summary.exitCode+' (concurrency '+concurrency+'); local report '+summary.report);
 return summary.exitCode;
}
