// Child-side registration closes the spawn → immediate parent exit race.
// Preloaded only for certification-owned Node subprocesses.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
const registry=process.env.CERT_OWNERSHIP_REGISTRY;
if(registry) {
  const original=childProcess.spawn;
  childProcess.spawn=function(...args) {
    const child=original.apply(this,args);
    if(child.pid) {
      try {
        const data=childProcess.execFileSync('ps',['-p',String(child.pid),'-o','pid=,ppid=,pgid=,lstart='],{encoding:'utf8'}).trim().split(/\s+/);
        if(Number(data[0])===child.pid&&Number(data[1])===process.pid)appendFileSync(registry,JSON.stringify({pid:child.pid,ppid:process.pid,pgid:Number(data[2]),birth:data.slice(3).join(' ')})+'\n');
      }catch { /* A child already gone cannot leave its own process running. */ }
    }
    return child;
  };
  syncBuiltinESMExports();
}
