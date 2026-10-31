/** Local certification evidence only. Never reads a remote target or mutates the
 * source certificate. Eligibility is deliberately independent from orchestration. */
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,lstatSync,existsSync,realpathSync,cpSync,mkdirSync} from 'node:fs';
import {resolve,relative,join,dirname,isAbsolute,sep} from 'node:path';

export const NEVER_REUSE=new Set(['prerequisites','dependencies','lockfile','security','source-integrity','performance-evidence','browsers']);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function gateEligibility({gate,previous,current,now=Date.now(),artifactsVerified=false}) {
 const refuse=reason=>({reuse:false,reason});
 if(!gate||NEVER_REUSE.has(gate.suiteId))return refuse('always rerun');
 if(gate.status!=='PASS'||gate.exitCode!==0||gate.allMandatoryAssertionsExecuted!==true)return refuse('not a complete passing gate');
 if(gate.reused)return refuse('chained reused evidence');
 if(gate.sourceFingerprint!==current.fingerprint||gate.startingCommitSha!==current.sha||gate.finalTestedSourceSha!==current.sha)return refuse('gate source mismatch');
 const sealed=previous.gateArtifacts?.[gate.suiteId];
 if(!sealed||sealed.sealed!==true||!same(sealed.hashes,gate.artifactHashes))return refuse('gate artifact manifest mismatch');
 if(previous.schemaVersion!==2||previous.startingTreeDirty!==false||current.clean!==true)return refuse('clean source required');
 if(previous.startingSha!==current.sha||previous.finalTestedSha!==current.sha||previous.sourceFingerprint!==current.fingerprint)return refuse('source mismatch');
 if(!same(previous.configuration,current.configuration))return refuse('mode or permission contract changed');
 if(!same(previous.versions,current.versions)||!current.versions?.node||!current.versions?.playwright||!Object.keys(current.versions?.browsers??{}).length)return refuse('runtime versions changed or missing');
 const start=Date.parse(previous.startedAt),end=Date.parse(gate.endedAt);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||now<end||now-start>86400000)return refuse('expired or invalid chronology');
 const pauses=(previous.hostPauses??[]).map(p=>Date.parse(p.at));
 if(pauses.some(p=>!Number.isFinite(p))||pauses.length&&end>=Math.min(...pauses))return refuse('gate did not end before first pause');
 if(gate.artifactsSealed!==true||!Object.keys(gate.artifactHashes??{}).length||!artifactsVerified)return refuse('artifact evidence unavailable or changed');
 return {reuse:true,reason:'verified same-source fresh passing gate'};
}

export function createPauseMonitor({now=()=>performance.now(),wall=()=>new Date().toISOString(),thresholdMs=90000,onPause=()=>{}}={}) {
 if(!Number.isFinite(thresholdMs)||thresholdMs<=0)throw new Error('Invalid pause threshold');
 let prior=now(),stopped=false;
 return {check(value=now()) {if(stopped)return null;const gapMs=value-prior;prior=value;if(!Number.isFinite(gapMs)||gapMs<0)throw new Error('Invalid monotonic clock');if(gapMs>thresholdMs){stopped=true;const pause={at:wall(),gapMs};onPause(pause);return pause;}return null;},stop(){stopped=true;}};
}
export const certificateHeading=(resumed,phase)=>resumed?`Resumed certificate (${resumed.reusedGates.length} gates reused from ${resumed.from})`:`TCG Phase 0–${phase} local certification`;

function safeFile(root,path){
 if(typeof path!=='string'||!path||isAbsolute(path)||path.split(/[\\/]/).some(p=>p==='..'||p==='.'||!p))throw new Error('Invalid artifact path');
 const base=resolve(root),target=resolve(base,path);if(lstatSync(base).isSymbolicLink())throw new Error('Certificate directory is a symlink');if(!target.startsWith(base+sep))throw new Error('Artifact path escaped certificate');
 let next=base;
 for(const part of path.split('/')){next=join(next,part);if(!existsSync(next)||lstatSync(next).isSymbolicLink())throw new Error('Missing or symlink artifact');}
 if(!lstatSync(target).isFile()||!realpathSync(target).startsWith(realpathSync(base)+sep))throw new Error('Artifact is not a confined regular file');
 return target;
}
const hashFile=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
export function hashArtifactPaths(root,paths){
 const hashes={};const visit=path=>{const full=resolve(root,path);if(!existsSync(full))return;const stat=lstatSync(full);if(stat.isSymbolicLink())throw new Error('Symlink evidence refused');if(stat.isDirectory())for(const name of readdirSync(full).sort())visit(join(path,name));else{const key=relative(root,full).split(sep).join('/');hashes[key]=hashFile(safeFile(root,key));}};
 for(const path of paths)visit(path);return Object.fromEntries(Object.entries(hashes).sort(([a],[b])=>a.localeCompare(b)));
}
export function verifyArtifactHashes(root,hashes){
 try{return !!hashes&&Object.keys(hashes).length>0&&Object.entries(hashes).every(([path,hash])=>/^[a-f0-9]{64}$/.test(hash)&&hashFile(safeFile(root,path))===hash);}catch{return false;}
}
export function copyVerifiedArtifacts(from,to,hashes){
 if(!verifyArtifactHashes(from,hashes))throw new Error('Source artifacts changed');
 for(const path of Object.keys(hashes)){const target=resolve(to,path);if(!target.startsWith(resolve(to)+sep))throw new Error('Invalid artifact destination');mkdirSync(dirname(target),{recursive:true});cpSync(safeFile(from,path),target,{errorOnExist:true,force:false});}
 if(!verifyArtifactHashes(to,hashes))throw new Error('Copied artifact verification failed');
}
export function gateArtifactPaths(id){
 return [id+'.log',id+'.log.processes.jsonl',id,id+'-artifacts',...(id==='unit'?['vitest.json']:id==='d1'?['d1-results.json']:id.startsWith('d1-stress-')?[id+'.json']:id==='migrations'?['migrations.json']:[])];
}
