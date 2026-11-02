import {useEffect,useState} from 'react';
import {Link,useParams} from 'react-router';
import {accessClientStore} from '../../core/accessClient';
import {authStore} from '../../core/auth';
import {getToken} from '../../core/api';
import {useStore} from '../../core/store';
import {useAiReviewRead} from '../../core/useAiReviewRead';
import {Button,Select} from '../../core/ui';
import {useWorkspaceLocale} from '../../core/workspaceLocale';
import {FORM_PROCESSING_STATES,type FormOperationsReport} from '../../../shared/formOperations';

const labels={pending:'Pending',processing:'Processing',retryable_failure:'Retryable failure',rejected:'Rejected',accepted:'Accepted'};
const link='inline-flex min-h-11 min-w-11 items-center rounded-lg px-3 py-2 underline [overflow-wrap:anywhere]';

/** In-memory operational metadata. This surface never loads publish tokens or answers. */
export function FormOperations(){
 const {boardId,formId}=useParams(),access=useStore(accessClientStore),auth=useStore(authStore);
 const [online,setOnline]=useState(()=>navigator.onLine);
 useEffect(()=>{const update=()=>setOnline(navigator.onLine);window.addEventListener('online',update);window.addEventListener('offline',update);return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);};},[]);
 return <div className="h-full min-w-0 overflow-y-auto p-4 sm:p-6"><div className="mx-auto max-w-4xl space-y-5">
 <h1 className="text-2xl font-semibold">Forms operations</h1>
 <nav aria-label="Forms views" className="flex flex-wrap gap-2 border-b border-neutral-200 pb-2 dark:border-neutral-700">
 {formId?<Link className={link} to={`/forms/${boardId}/${formId}`}>Builder</Link>:boardId?<Link className={link} to={`/forms/${boardId}`}>Forms</Link>:null}
 <span aria-current="page" className="inline-flex min-h-11 items-center rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-800">Operations</span>
 {boardId&&<Link className={link} to="/forms">All form operations</Link>}
 <Link className={link} to={boardId?`/boards/${boardId}`:'/boards'}>{boardId?'Open database':'Open databases'}</Link>
 </nav>
 {online&&access.status==='ready'?<OperationsContent key={`${auth.user?.id}:${getToken()}:${access.epoch}:${boardId}:${formId}`} databaseId={boardId} formId={formId}/>:<p role="status">Reconnect to verify current access before viewing form operations. Operational responses are not stored on this device.</p>}
 </div></div>;
}
function OperationsContent({databaseId,formId}:{databaseId?:string;formId?:string}){
 const [days,setDays]=useState(3),locale=useWorkspaceLocale(),zone=locale.settings?.timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone;
 const query=new URLSearchParams({followupDays:String(days),...(databaseId?{databaseId}:{})});
 const read=useAiReviewRead<FormOperationsReport>(`/api/forms/${formId?encodeURIComponent(formId)+'/':''}operations?${query}`);
 const date=(value:number)=>new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short',timeZone:zone}).format(value);
 const report=read.value;
 return <>
 <p>Public form processing only. Counts cover rolling 7- and 30-day windows. Accepted means the record was created, not that someone replied.</p>
 <div className="flex flex-wrap items-end gap-3"><label className="flex min-w-0 flex-col gap-1 text-sm">Unresolved follow-up age<Select className="min-h-11" aria-label="Unresolved follow-up age" value={days} onChange={event=>setDays(Number(event.target.value))}>{[1,3,7,14,30,90].map(n=><option key={n} value={n}>{n} day{n===1?'':'s'}</option>)}</Select></label><Button className="h-auto min-h-11 py-2" disabled={read.loading} onClick={()=>void read.reload()}>Refresh operations</Button></div>
 {read.loading&&<p role="status">Loading current form operations…</p>}
 {read.error&&<p role="alert">Form operations could not be verified. The form may be unavailable or access may have changed. Reconnect and use Refresh operations to retry.</p>}
 {report&&<>
 <p className="text-sm">As of <time dateTime={new Date(report.asOf).toISOString()}>{date(report.asOf)}</time>. Times use {zone}.</p>
 {(report.partial.forms||report.partial.failures||report.partial.followups)&&<p role="status" className="rounded-lg border border-amber-600 p-3">Partial operational window. {report.partial.forms?'Up to 40 forms are shown; open a specific form or database for a narrower read. ':''}{report.partial.failures?'Recent failures are limited to 10 per form. ':''}{report.partial.followups?'Follow-up candidates are limited; completed, deleted or unavailable records can consume this window. Open the destination database to review older records.':''}</p>}
 {!report.forms.length&&<p>No editable public forms are available in this scope.</p>}
 {report.forms.map(form=><section key={form.id} aria-label={'Operations for '+form.title} className="min-w-0 space-y-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-700">
 <h2 className="text-xl font-semibold [overflow-wrap:anywhere]">{form.title}</h2><p className="[overflow-wrap:anywhere]">{form.databaseName} · {form.enabled?'Enabled':'Disabled'}</p>
 <div className="flex flex-wrap gap-2"><Link className={link} to={`/forms/${form.databaseId}/${form.id}/operations`}>Open this form’s operations</Link><Link className={link} to={`/forms/${form.databaseId}/${form.id}`}>Open form builder</Link><Link className={link} to={`/boards/${form.databaseId}`}>Open destination database</Link></div>
 <table className="w-full table-fixed text-left text-sm"><caption className="py-2 text-left font-medium">Processing counts</caption><thead><tr><th className="w-1/2 py-2 pr-2" scope="col">State</th><th className="px-1 py-2" scope="col">7 days</th><th className="px-1 py-2" scope="col">30 days</th></tr></thead><tbody>{FORM_PROCESSING_STATES.map(state=><tr key={state} className="border-t border-neutral-200 dark:border-neutral-700"><th scope="row" className="py-2 pr-2 font-normal [overflow-wrap:anywhere]">{labels[state]}</th><td className="px-1 py-2 tabular-nums">{form.counts.last7Days[state]}</td><td className="px-1 py-2 tabular-nums">{form.counts.last30Days[state]}</td></tr>)}</tbody></table>
 <h3 className="font-medium">Recent processing failures</h3>
 {!form.failures.length&&<p className="text-sm">No failures in the returned 30-day window.</p>}
 <ul className="space-y-3">{form.failures.map(failure=><li key={failure.submissionId} className="min-w-0 rounded-lg bg-neutral-50 p-3 text-sm dark:bg-neutral-900"><p>{labels[failure.state]} · {failure.errorClass} · {failure.attempts} attempt{failure.attempts===1?'':'s'}</p><p className="[overflow-wrap:anywhere]">Submission reference: {failure.submissionId}</p><p>Received {date(failure.createdAt)}{failure.retryAt?'; retry scheduled '+date(failure.retryAt):''}</p></li>)}</ul>
 <h3 className="font-medium">Unresolved follow-ups</h3><p className="text-sm">Accepted at least {report.followupDays} day{report.followupDays===1?'':'s'} ago and still in the destination’s first stage. This is a review aid, not a reply SLA.</p>
 {!form.followups.length&&<p className="text-sm">No unresolved follow-ups in the returned candidate window.</p>}
 <ul>{form.followups.map(item=><li key={item.submissionId} className="min-w-0 border-t border-neutral-200 py-2 dark:border-neutral-700"><Link className={link} to={item.url}>{item.title}</Link><p className="text-sm">Received {date(item.createdAt)}</p></li>)}</ul>
 </section>)}
 <section aria-label="Website intake" className="min-w-0 space-y-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-700"><h2 className="text-xl font-semibold">Website</h2><p>Signed website relay intake arrives separately from public forms. These are Inbox records added to Workspace in the last 30 days, not public-form processing receipts or proof of relay delivery.</p><Link className={link} to="/website">Open Website response desk</Link>
 {!report.website.available?<p>Website intake is unavailable in your current access scope.</p>:<>{report.website.partial&&<p role="status">Partial Website window: up to 150 recent records. Open the Website desk for further review.</p>}{!report.website.records.length&&<p>No Website records in the returned 30-day window.</p>}<ul>{report.website.records.map(item=><li key={item.id} className="min-w-0 border-t border-neutral-200 py-2 dark:border-neutral-700"><Link className={link} to={item.url}>{item.title}</Link><p className="text-sm">Added {date(item.createdAt)}</p></li>)}</ul></>}
 </section>
 </>}
 </>;
}
