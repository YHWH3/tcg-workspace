import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessSecurityAudit} from './security.mjs';
const ghsa='https://github.com/advisories/GHSA-6qxp-vccf-f47h';
const known={name:'@modelcontextprotocol/sdk',severity:'high',via:[{url:ghsa,severity:'high'}]};
const versions={'@modelcontextprotocol/sdk':'1.30.0','@modelcontextprotocol/client':'2.0.0',agents:'0.24.0'};
const sources=[{file:'worker/mcp.ts',text:'import {McpServer} from "@modelcontextprotocol/server"; createMcpHandler(server);'}];
const options={auditExitCode:1,versions,sources};
function audit(entries=[]){return {metadata:{vulnerabilities:{total:entries.length,high:entries.filter(e=>e.severity==='high').length,critical:entries.filter(e=>e.severity==='critical').length}},vulnerabilities:Object.fromEntries(entries.map(entry=>[entry.name,entry]))};}
test('a clean complete audit passes without an exception',()=>{const r=assessSecurityAudit(audit(),{auditExitCode:0});assert.equal(r.verdict,'PASS');assert.equal(r.unresolvedException,false);});
test('the exact reviewed advisory passes locally and preserves its release gate',()=>{const r=assessSecurityAudit(audit([known]),options);assert.equal(r.verdict,'PASS');assert.equal(r.rawAuditExitCode,1);assert.equal(r.unresolvedException,true);assert.equal(r.needsIndependentReview,true);assert.equal(r.productionReleaseBlocked,true);});
test('novel high and critical advisories fail',()=>{for(const severity of ['high','critical'])assert.equal(assessSecurityAudit(audit([{name:'new-package',severity,via:[{url:'new'}]}]),options).verdict,'FAIL');});
test('another advisory on the same package cannot inherit the exception',()=>{assert.equal(assessSecurityAudit(audit([{...known,via:[{url:'other',severity:'high'}]}]),options).verdict,'FAIL');});
test('an affected outbound client invalidates source reachability',()=>{for(const text of ['new MCPClient()','transport({authProvider:provider})','fetchToken(server)','withOAuth(client)','auth(server)','import {Client} from "@modelcontextprotocol/sdk/client/index.js"'])assert.equal(assessSecurityAudit(audit([known]),{...options,sources:[...sources,{file:'worker/outbound.ts',text}]}).verdict,'FAIL');});
test('changed or missing peer versions require a new review',()=>{assert.equal(assessSecurityAudit(audit([known]),{...options,versions:{...versions,agents:'0.28.1'}}).verdict,'FAIL');});
test('empty source and missing server integration cannot claim non-reachability',()=>{for(const inspected of [[],[{file:'worker/mcp.ts',text:'export default {}'}]])assert.equal(assessSecurityAudit(audit([known]),{...options,sources:inspected}).verdict,'FAIL');});
test('malformed, unavailable, empty and signal-terminated reports fail closed',()=>{for(const report of [null,{}, {error:{code:'ENOENT'}}])assert.equal(assessSecurityAudit(report,options).verdict,'FAIL');assert.equal(assessSecurityAudit(audit([known]),{...options,auditExitCode:null}).verdict,'FAIL');});
test('audit exit status and metadata consistency are mandatory',()=>{assert.equal(assessSecurityAudit(audit([known]),{...options,auditExitCode:0}).verdict,'FAIL');const report=audit([known]);report.metadata.vulnerabilities.total=0;assert.equal(assessSecurityAudit(report,options).verdict,'FAIL');assert.equal(assessSecurityAudit(audit(),options).verdict,'FAIL');});
test('the actual installed dependency and source assessment passes with reviewed exception',()=>{assert.equal(assessSecurityAudit(audit([known]),{auditExitCode:1}).verdict,'PASS');});

test('truncated advisory dependency chains and malformed entries fail',()=>{assert.equal(assessSecurityAudit(audit([{name:'agents',severity:'high',via:['@modelcontextprotocol/sdk']}]),options).verdict,'FAIL');const report=audit();report.vulnerabilities.bad=null;assert.equal(assessSecurityAudit(report,options).verdict,'FAIL');});
