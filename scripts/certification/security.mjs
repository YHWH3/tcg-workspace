// No advisory exceptions: high/critical findings fail certification.
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const PROJECT=fileURLToPath(new URL('../../',import.meta.url));
export function assessSecurityAudit(audit,{auditExitCode,project=PROJECT}={}) {
  const errors=[],exceptions=[],findings=[];
  if(!audit||typeof audit!=='object'||!audit.metadata?.vulnerabilities||!audit.vulnerabilities||typeof audit.vulnerabilities!=='object'||Array.isArray(audit.vulnerabilities)||audit.error)errors.push('Missing, malformed or unavailable npm vulnerability report');
  const vulnerabilities=audit?.vulnerabilities&&typeof audit.vulnerabilities==='object'?audit.vulnerabilities:{};
  const entries=Object.entries(vulnerabilities);
  for(const [name,entry] of entries)if(!entry||typeof entry!=='object'||entry.name!==name||typeof entry.severity!=='string'||!Array.isArray(entry.via))errors.push(`Malformed audit package entry: ${name}`);
  const all=entries.map(([,entry])=>entry).filter(entry=>entry&&typeof entry==='object');

  if(!Number.isInteger(auditExitCode)||auditExitCode<0||auditExitCode>1)errors.push(`npm audit terminated unexpectedly or failed to retrieve advisories (exit ${auditExitCode})`);
  const count=audit?.metadata?.vulnerabilities;
  if(count&&(!Number.isInteger(count.total)||count.total!==all.length||!Number.isInteger(count.high)||!Number.isInteger(count.critical)||count.high!==all.filter(entry=>entry.severity==='high').length||count.critical!==all.filter(entry=>entry.severity==='critical').length))errors.push('Audit metadata and package entries are inconsistent');
  if(count&&count.total>0&&auditExitCode!==1)errors.push('Audit reported vulnerabilities without its expected nonzero status');
  if(count&&count.total===0&&auditExitCode!==0)errors.push('An empty audit must finish successfully');
  for(const entry of all) {
    if(entry.severity==='high'||entry.severity==='critical')errors.push(`Unaccepted ${entry.severity} advisory: ${entry.name}`);
    findings.push({package:entry.name,severity:entry.severity,via:entry.via,classification:'requires review',decision:'unreviewed',fix:entry.fixAvailable});
  }
  return {verdict:errors.length?'FAIL':'PASS',rawAuditExitCode:auditExitCode,counts:count??null,findings,exceptions,errors,unresolvedException:exceptions.length>0,needsIndependentReview:exceptions.length>0,productionReleaseBlocked:errors.length>0||exceptions.length>0,reviewDocument:resolve(project,'docs/reviews/phase-4-dependency-security.md')};
}
