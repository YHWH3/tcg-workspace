import {useEffect,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {Link} from 'react-router';
import {UsersRound} from 'lucide-react';
import {mutate} from '../../../core/sync/engine';
import {db,type LocalRow} from '../../../core/db';
import {authStore} from '../../../core/auth';
import {getToken} from '../../../core/api';
import {accessClientStore} from '../../../core/accessClient';
import {useStore} from '../../../core/store';
import {useEventOps} from '../../../core/useEventOps';
import {workspaceTimeZone} from '../../../core/workspaceLocale';
import {Button,Field,Select} from '../../../core/ui';
import {fieldsOf} from '../../../../shared/fields';
import {eventOpsConfigSchema,type EventOpsConfig} from '../../../../shared/eventOpsConfig';
import {EVENT_ROLES} from '../../../../shared/eventOps';
import {registerBlockType,type MediaBlockProps} from '../../pages/blocks/registry';
import {DashBlock,HeadingField,DatabasePicker,pickableBoards,str,useBoardsQuery} from './shared';

const control='h-auto min-h-11 w-full min-w-0 max-w-full py-2';
const action='inline-flex min-h-11 min-w-0 max-w-full items-center rounded-lg border border-neutral-300 px-3 py-2 underline [overflow-wrap:anywhere] dark:border-neutral-600';
const labels={startKey:'Start date',capacityKey:'Capacity',facilitatorsKey:'Facilitators',volunteersKey:'Volunteers',participantsKey:'Participants'} as const;
function EventOpsConfigure({block}:{block:LocalRow}){
 const boards=useBoardsQuery(),board=boards?.find(row=>row.id===block.databaseId),fields=fieldsOf(board),parsed=eventOpsConfigSchema.safeParse(block),config=parsed.success?parsed.data:undefined,[error,setError]=useState('');
 const events=useLiveQuery<LocalRow[]>(()=>typeof block.databaseId==='string'?db.tasks.where('boardId').equals(block.databaseId).and(row=>!row.deleted&&!row.archived&&!row.parentId).limit(201).toArray():Promise.resolve([]),[block.databaseId]);
 const options=events?.slice(0,200)??[],selected=str(block.eventId)??'';
 const save=async(patch:Record<string,unknown>)=>{setError('');try{await mutate('blocks',block.id,patch);}catch{setError('Configuration could not be saved. Reopen it and retry.');}};
 return <><HeadingField value={str(block.heading)} onChange={heading=>save({heading:heading??null})}/><DatabasePicker value={str(block.databaseId)??''} boards={pickableBoards(boards)} onChange={id=>save({databaseId:id||null,eventId:null})}/>
  {(Object.keys(labels) as (keyof typeof labels)[]).map(key=>{const relation=key.endsWith('sKey'),type=relation?'relation':key==='startKey'?'date':'number';return <Field key={key} label={labels[key]+' field'}><Select className={control} aria-label={'Event roles '+labels[key]+' field'} value={str(block[key])??config?.[key]??''} onChange={event=>save({[key]:event.target.value})}><option value="" disabled>Choose a field</option>{fields.filter(field=>field.type===type).map(field=><option key={field.id} value={`${relation?'rel':'p'}_${field.id}`}>{field.name}</option>)}</Select></Field>;})}
  <Field label="Event"><Select className={control} aria-label="Event roles Event" value={selected} onChange={event=>save({eventId:event.target.value||null,...(event.target.value?{upcomingOnly:false}:{})})}><option value="">All available Events</option>{selected&&!options.some(event=>event.id===selected)&&<option value={selected}>Selected Event unavailable on this device</option>}{options.map(event=><option key={event.id} value={event.id}>{String(event.title??'Untitled event')}</option>)}</Select></Field>
  {(events?.length??0)>200&&<p>Showing the first 200 Events on this device. Open another Event from its database.</p>}
  <Field label="Maximum Events"><Select className={control} aria-label="Event roles limit" value={config?.limit??10} onChange={event=>save({limit:Number(event.target.value)})}>{[5,10,20].map(limit=><option key={limit} value={limit}>{limit}</option>)}</Select></Field>
  <label className="flex min-h-11 items-center gap-2"><input type="checkbox" disabled={!!selected} checked={!selected&&(config?.upcomingOnly??true)} onChange={event=>save({upcomingOnly:event.target.checked})}/>Upcoming Events only</label>
  <p>A selected Event is shown regardless of its date or stage. Capacity is displayed without restricting registration.</p>
  {error&&<p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
 </>;
}
function EventOpsReader({config,offline}:{config:EventOpsConfig;offline:boolean}){
 const state=useEventOps(config,offline),page=state.value;
 return <section aria-label="Event roles and participants" className="min-w-0 space-y-3 text-sm text-neutral-900 dark:text-neutral-100 [overflow-wrap:anywhere]">
  <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="min-w-0 font-semibold">Event roles and participants</h3><Button className="h-auto min-h-11 max-w-full whitespace-normal py-2" disabled={state.loading} onClick={()=>void state.reload()}>{state.loading?'Refreshing…':'Refresh Events'}</Button></div>
  <div role="status" className="text-xs text-neutral-600 dark:text-neutral-400">{state.loading&&!page&&<p>Loading Event relationships…</p>}{page&&<p>As of {new Date(page.asOf).toLocaleString(undefined,{timeZone:workspaceTimeZone()})}. Counts include only people you can access.</p>}{offline&&<p>Partial device snapshot. Reconnect to check current relationships.</p>}{page?.partial&&<p>Some sources are incomplete or need review. Counts may be lower than the full Event. {page.partialSources.map(source=>source.replaceAll('_',' ')).join(', ')}.</p>}</div>
  {state.error&&<p role="alert" className="text-red-700 dark:text-red-300">Event relationships could not be refreshed. Check connection and access, then retry.</p>}
  {page?.status==='source_unavailable'&&<p>The Events database is missing, archived or unavailable. Choose a source in Configure.</p>}
  {page?.status==='event_unavailable'&&<p>The selected Event is missing, archived or unavailable. Choose another Event in Configure.</p>}
  {page?.status==='configuration_required'&&<p>The configured fields changed or are unavailable. Review Configure before using these counts.</p>}
  {page?.status==='ready'&&<>
   {!page.events.length&&<p>No available Events match this selection.</p>}
   <ul className="space-y-4">{page.events.map(event=><li key={event.id} className="min-w-0 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
    <Link to={event.url} className="block min-h-11 py-2 font-semibold underline">{event.title}</Link><p>Start: {event.start??'Date unavailable'}</p>
    <dl className="my-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">{EVENT_ROLES.map(role=><div key={role} className="min-w-0 rounded-lg bg-neutral-100 p-2 dark:bg-neutral-800"><dt className="capitalize">{role}</dt><dd className="text-lg font-semibold tabular-nums">{event.coverage[role]}</dd></div>)}</dl>
    <p>Capacity: {event.coverage.capacity??'Not available'}. Participants: {event.coverage.participants}.{event.coverage.remaining!==null&&(event.coverage.remaining<0?` ${-event.coverage.remaining} above capacity.`:` ${event.coverage.remaining} ${event.coverage.remaining===1?'place':'places'} remaining.`)} Display only; registration is not restricted.</p>
    {event.issues.length>0&&<p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">Review needed: {event.issues.map(issue=>issue.replaceAll('_',' ')).join(', ')}.</p>}
    <div className="mt-3 flex flex-wrap gap-2">{EVENT_ROLES.map(role=><Link key={role} className={action} to={event.url+'?focusField='+encodeURIComponent(config[`${role}Key`])}><span className="min-w-0">Review {role}</span></Link>)}<Link className={action} to={event.url+'?focusField='+encodeURIComponent(config.capacityKey)}><span className="min-w-0">Review capacity</span></Link></div>
    <h4 className="mt-4 font-semibold">Recently linked participants</h4>
    {!event.recentParticipants.length&&<p>No current participants are available to your account.</p>}
    {event.recentParticipantsTruncated&&<p>Showing {event.recentParticipants.length} of {event.recentParticipantsTotal} accessible participants. Open the Event for the full relationship field.</p>}
    <ul>{event.recentParticipants.map(person=><li key={person.id} className="min-w-0 border-b border-neutral-200 py-2 dark:border-neutral-700"><Link className="block min-h-11 py-2 underline" to={person.url}>{person.title}</Link><p className="text-xs text-neutral-600 dark:text-neutral-400">{person.linkedAt===null?'Link date unavailable':'Linked '+new Date(person.linkedAt).toLocaleString(undefined,{timeZone:workspaceTimeZone()})}</p></li>)}</ul>
    {event.formsUrl&&<Link className="mt-3 block min-h-11 py-2 underline" to={event.formsUrl}>Set up registration forms for this People database</Link>}
   </li>)}</ul>
   {page.undatedEvents.length>0&&<div className="min-w-0 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700"><h4 className="font-semibold">Events needing a start date</h4><p>{page.undatedCount} {page.undatedCount===1?'Event needs':'Events need'} a usable date to appear in the upcoming list.</p><ul>{page.undatedEvents.map(event=><li key={event.id}><Link className="block min-h-11 py-2 underline" to={event.url}>{event.title}: review start date</Link></li>)}</ul>{page.undatedCount>page.undatedEvents.length&&<p>More Events need dates. Review the Events database.</p>}</div>}
  </>}
  <p className="text-xs text-neutral-600 dark:text-neutral-400">{page?.registrationNote??'Recently linked participants are current relationships, not submission receipts or attendance proof. Links may be entered by the team or a configured registration form.'}</p>
 </section>;
}
export function EventOpsContent({block}:{block:LocalRow}){
 const identity=useStore(authStore),access=useStore(accessClientStore),[online,setOnline]=useState(navigator.onLine);
 useEffect(()=>{const wake=()=>setOnline(navigator.onLine);window.addEventListener('online',wake);window.addEventListener('offline',wake);return()=>{window.removeEventListener('online',wake);window.removeEventListener('offline',wake);};},[]);
 const parsed=eventOpsConfigSchema.safeParse(block);
 if(!identity.user||!getToken()||access.manifest?.userId!==identity.user.id||!['ready','offline'].includes(access.status))return <p>Checking account access before loading Event relationships…</p>;
 if(!parsed.success)return <p>Choose an Events database and distinct role fields in Configure.</p>;
 const offline=!online||access.status==='offline';
 return <EventOpsReader key={JSON.stringify([identity.user.id,getToken(),access.epoch,parsed.data,offline])} config={parsed.data} offline={offline}/>;
}
export function EventOpsBlock({block}:MediaBlockProps){return <DashBlock block={block} icon={UsersRound} label="Event roles" config={<EventOpsConfigure block={block}/>}>{()=> <EventOpsContent block={block}/>}</DashBlock>;}
registerBlockType('eventops','Event roles',EventOpsBlock);
