// A narrow, source-checked exception for the server-only use of the MCP SDK.
// Raw npm audit exit status and advisory details remain part of the evidence.
import {readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const PROJECT=fileURLToPath(new URL('../../',import.meta.url));
const GHSA='https://github.com/advisories/GHSA-6qxp-vccf-f47h';
const EXPECTED={'@modelcontextprotocol/sdk':'1.30.0','@modelcontextprotocol/client':'2.0.0',agents:'0.24.0'};
const OUTBOUND=/\bauthProvider\b|\bwithOAuth\s*\(|\bfetchToken\s*\(|\bauth\s*\(|\bMCPClient\b|\b(?:ClientCredentialsProvider|PrivateKeyJwtProvider|StaticPrivateKeyJwtProvider|CrossAppAccessProvider|OAuthClientProvider)\b|(?:from\s*|import\s*\()["'][^"']*modelcontextprotocol\/(?:sdk\/client|client)/;
function sourceFiles(directory) {
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?sourceFiles(join(directory,entry.name)):/\.[cm]?[jt]sx?$/.test(entry.name)?[{file:join(directory,entry.name),text:readFileSync(join(directory,entry.name),'utf8')}]:[]);
}
export function assessSecurityAudit(audit,{auditExitCode,project=PROJECT,versions,sources}={}) {
  const errors=[],exceptions=[],findings=[];
  if(!audit||typeof audit!=='object'||!audit.metadata?.vulnerabilities||!audit.vulnerabilities||typeof audit.vulnerabilities!=='object'||Array.isArray(audit.vulnerabilities)||audit.error)errors.push('Missing, malformed or unavailable npm vulnerability report');
  const vulnerabilities=audit?.vulnerabilities&&typeof audit.vulnerabilities==='object'?audit.vulnerabilities:{};
  const entries=Object.entries(vulnerabilities);
  for(const [name,entry] of entries)if(!entry||typeof entry!=='object'||entry.name!==name||typeof entry.severity!=='string'||!Array.isArray(entry.via))errors.push(`Malformed audit package entry: ${name}`);
  const all=entries.map(([,entry])=>entry).filter(entry=>entry&&typeof entry==='object');
  const blocking=all.filter(value=>value.severity==='high'||value.severity==='critical');
  if(!Number.isInteger(auditExitCode)||auditExitCode<0||auditExitCode>1)errors.push(`npm audit terminated unexpectedly or failed to retrieve advisories (exit ${auditExitCode})`);
  const count=audit?.metadata?.vulnerabilities;
  if(count&&(!Number.isInteger(count.total)||count.total!==all.length||!Number.isInteger(count.high)||!Number.isInteger(count.critical)||count.high!==all.filter(entry=>entry.severity==='high').length||count.critical!==all.filter(entry=>entry.severity==='critical').length))errors.push('Audit metadata and package entries are inconsistent');
  if(count&&count.total>0&&auditExitCode!==1)errors.push('Audit reported vulnerabilities without its expected nonzero status');
  if(count&&count.total===0&&auditExitCode!==0)errors.push('An empty audit must finish successfully');
  if(blocking.length) {
    try {
      const installed=versions??Object.fromEntries(Object.keys(EXPECTED).map(name=>[name,JSON.parse(readFileSync(join(project,'node_modules',name,'package.json'),'utf8')).version]));
      for(const [name,version] of Object.entries(EXPECTED))if(installed[name]!==version)errors.push(`Exception requires reviewed ${name}@${version}; found ${installed[name]??'missing'}`);
      const inspected=sources??['worker','src'].flatMap(directory=>sourceFiles(join(project,directory)));
      if(!inspected.length)errors.push('No production source inspected for OAuth-client reachability');
      for(const source of inspected)if(OUTBOUND.test(source.text))errors.push(`OAuth-client reachability exception invalidated by ${source.file}`);
      // The review is specific to the current inbound MCP server integration.
      if(!inspected.some(source=>/createMcpHandler/.test(source.text)&&/McpServer/.test(source.text)))errors.push('Reviewed inbound MCP server integration is missing');
    } catch(error){errors.push(`Security reachability inspection failed: ${error.message}`);}
  }
  for(const entry of all) {
    const known=Object.hasOwn(EXPECTED,entry.name)&&entry.severity==='high'&&Array.isArray(entry.via)&&entry.via.length>0&&entry.via.every(cause=>typeof cause==='string'?Object.hasOwn(EXPECTED,cause)&&Object.hasOwn(vulnerabilities,cause):cause&&typeof cause==='object'&&cause.url===GHSA&&cause.severity==='high');
    const isBlocking=entry.severity==='high'||entry.severity==='critical';
    if(isBlocking&&!known)errors.push(`Unreviewed ${entry.severity} advisory: ${entry.name}`);
    const finding={package:entry.name,severity:entry.severity,via:entry.via,classification:known?'not reachable under current server-only use':'requires review',decision:known?'reviewed exception, independent review required':'unreviewed',fix:entry.fixAvailable};
    findings.push(finding);if(known)exceptions.push({...finding,advisory:GHSA,patchedVersions:{sdk:'1.31.0',client:'2.2.0'},migration:'Coordinated Agents + MCP peer upgrade; no forced peer override'});
  }
  return {verdict:errors.length?'FAIL':'PASS',rawAuditExitCode:auditExitCode,counts:count??null,findings,exceptions,errors,unresolvedException:exceptions.length>0,needsIndependentReview:exceptions.length>0,productionReleaseBlocked:errors.length>0||exceptions.length>0,reviewDocument:resolve(project,'docs/reviews/phase-4-dependency-security.md')};
}
