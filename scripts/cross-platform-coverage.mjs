#!/usr/bin/env node
// Evidence inventory, not a test runner. Never infers PASS from test source.
import {readFileSync,readdirSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..'),cert=resolve(process.argv[2]??''),out=resolve(process.argv[3]??'.artifacts/cross-platform/coverage.json');
assert.ok(existsSync(join(cert,'summary.json')),'Exact completed certification directory required');
const summary=JSON.parse(readFileSync(join(cert,'summary.json')));assert.equal(summary.completeLocalCertification,true);
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]);
const routes=walk(join(root,'src')).filter(p=>/\.(tsx?|jsx?)$/.test(p)).flatMap(file=>[...readFileSync(file,'utf8').matchAll(/path:\s*['"]([^'"]*)['"]/g)].map(m=>({path:m[1],source:relative(root,file)})));
const apis=walk(join(root,'worker')).filter(p=>p.endsWith('.ts')).flatMap(file=>[...readFileSync(file,'utf8').matchAll(/\b\w+\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g)].map(m=>({method:m[1].toUpperCase(),path:m[2],source:relative(root,file)})));
const reports=walk(cert).filter(p=>p.endsWith('.json')&&!p.includes('node_modules'));
const evidence=reports.flatMap(file=>{try{const d=JSON.parse(readFileSync(file));if(d.sourceSha!==summary.finalTestedSha||!Array.isArray(d.results))return [];return d.results.filter(r=>r.test&&r.status).map(r=>({test:r.test,status:r.status,engine:r.engine??r.suiteId,viewport:r.viewport,runner:d.runner,permissionMode:d.permissionMode??'See runner fixture and dedicated security assertions',expected:'Assertion-specific behavior in named test; no claim beyond its scope',artifact:relative(root,file)}));}catch{return [];}});
const features=[
 ['identity','Identity, bootstrap, invitations, account/session recovery','/settings','auth.ts|admin.ts|sessions.ts','users/sessions/invites; account-owned IndexedDB','bootstrap|signup|login|session|account replacement|account switch|seat cap|invite'],
 ['spaces','Spaces, membership, guest isolation and regrant','/spaces/:spaceId','accessApi.ts|spaces.ts|readAccess.ts','spaces/space_members/guest_invites; canonical access kernel','guest|space creation|membership|regrant|current scope|revocation'],
 ['pages','Page CRUD, nested content, deletion and restoration','/pages/:pageId','sync.ts|recordAccess.ts','pages/blocks; mutate/applyChanges','page|markdown|subtree|closure|restore_item|cascade'],
 ['editor','Rich text, mentions, selection rewrite and local save','/pages/:pageId','sync.ts','blocks; per-field LWW/outbox and editor drafts','edit|mention|body block|rewrite|Unicode|draft'],
 ['databases','Databases, records, properties and pagination','/boards/:boardId','mcp.ts|sync.ts','boards/tasks/views/links; current read/write kernel','database|record|property|custom field|pagination|table view'],
 ['views','Board/list/gallery/calendar/timeline filters and sorts','/boards/:boardId','mcp.ts','views plus tasks; shared view evaluator','view|calendar|timeline|filter|sort|group'],
 ['tasks','Tasks, assignments, dates, dependencies and gates','/tasks','sync.ts|approvals.ts','tasks/links/approvals; current authorizer','task|dependency|gate|date-range|status'],
 ['dashboards','Dashboards, aggregation and metrics','/pages/:pageId','mcpReadTools.ts','dashboard blocks; shared evaluator and gated reads','dashboard|metric|rollup|snapshot'],
 ['templates','Template install, repeat install and dry-run','/settings','templateSnapshot.ts|mcp.ts','pages/blocks/boards/tasks/views/links; gated closure','template|instantiat'],
 ['collaboration','Live presence, comments and concurrent edits','/pages/:pageId','live.ts|sync.ts','LiveRoom sessions; comments/activity','presence|live|comment|concurrent|merge|isolation'],
 ['notifications','Notification privacy, badges, grouping and reminders','/inbox','notifications.ts|aiDigest.ts','notifications/reminder_sent/ai_digest_runs; current recipient rights','notification|badge|Inbox|digest|reminder'],
 ['automations','Automation, approval, cancellation/retry/recovery','/automations/:boardId','automations.ts|approvals.ts','automation_runs/approvals/event_outbox; owner capability','automation|approval|cancel|retry|recovery'],
 ['sharing','Public shares and forms/submission provenance','/s/:token; /f/:token','public.ts|publicForms.ts|shareAccess.ts','shares/form_tokens/form_submissions; pinned token scope','public|share|form|submission|receipt'],
 ['files','Attachments, upload recovery, serving and byte ownership','/capture','files.ts|remotefile.ts','files metadata + file_chunks/Dexie blobs; serving policy','file|upload|attachment|SVG|svg|byte|chunk|media'],
 ['canvas','Moodboards, gestures and accessible alternatives','/moodboards/:boardId','public.ts|sync.ts','moodboards/mooditems; world geometry and gated mutations','canvas|mood|touch drag|zoom|nudge|diagram'],
 ['search','Indexed search, filters, snippets and revocation','Global search','search.ts|readAccess.ts','search_documents/fts/dirty; account/access-version binding','search|FTS|index|cursor'],
 ['history','Activity, field history, revision-safe restore and undo','/activity; record history','history.ts|changesets.ts|historyAccess.ts','record_history/changesets/undo journals; current permissions','history|changeset|undo|revision|summary'],
 ['sync','Protocol 3, offline, quarantine, interruptions and account isolation','All authenticated routes','sync.ts|spaceFeed.ts','per-space feed events/cursors/staging/outbox; authority fence','offline|protocol 3|backfill|quarantine|held-work|account|resumes|lost'],
 ['ai','Assistant, provider contracts, workflows and human execution','/ai; /ai/chat; /ai/review/:previewId','assistant/*|aiPreviews.ts|connectorAccess.ts','assistant conversations + previews/checkpoints; scoped grants','assistant|provider|workflow|proposal|execute|connector|source|prompt|stream'],
 ['operations','Migration, backup/restore, deployment preflight and budgets','Operator only','index.ts','D1/KV/DO; local rehearsal only','migration|restore|backup|binding|preflight|production|recovery|budget'],
 ['accessibility','Keyboard, touch, axe and responsive reflow','All UI','N/A','Shared semantics; no human AT inference','focus|keyboard|axe|accessibility|reflow|release UI|compact|touch'],
];
const coverage=features.map(([id,feature,route,backend,storage,pattern])=>{const found=evidence.filter(e=>new RegExp(pattern,'i').test(e.test));return {id,feature,frontend:route,backend,storageAndAuthority:storage,implementation:'IMPLEMENTED; scope established from existing modules and route inventory',verification:found.length?'EXECUTED_EVIDENCE_FOUND':'GAP',pass:found.filter(e=>e.status==='PASS').length,fail:found.filter(e=>e.status==='FAIL').length,notRun:found.filter(e=>e.status==='NOT RUN').length,evidence:found};});
mkdirSync(resolve(out,'..'),{recursive:true});writeFileSync(out,JSON.stringify({schemaVersion:1,testedSha:summary.finalTestedSha,fingerprint:summary.sourceFingerprint,certification:relative(root,cert),limitations:'Evidence can overlap features. Matching a test is not proof of every subfeature or external platform. Native, Android, HTTPS/PWA and manual gates have separate platform reports.',frontendRoutes:routes,backendRoutes:apis,features:coverage},null,2));
console.log(JSON.stringify({out,features:coverage.length,frontendRoutes:routes.length,backendRoutes:apis.length,recordedAssertions:evidence.length,gaps:coverage.filter(f=>f.verification==='GAP').map(f=>f.id)}));
