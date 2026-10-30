import {useEffect,useId,useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {Link,useNavigate} from 'react-router';
import {ClipboardList,LineChart} from 'lucide-react';
import {mutate} from '../../../core/sync/engine';
import {db,type LocalRow} from '../../../core/db';
import {authStore} from '../../../core/auth';
import {getToken} from '../../../core/api';
import {accessClientStore} from '../../../core/accessClient';
import {useStore} from '../../../core/store';
import {useFieldEvidence} from '../../../core/useFieldEvidence';
import {Button,Field,Input,Select} from '../../../core/ui';
import {fieldsOf} from '../../../../shared/fields';
import {fieldEvidenceConfigSchema,type FieldEvidenceConfig} from '../../../../shared/fieldEvidenceConfig';
import type {FieldEvidencePage} from '../../../../shared/fieldEvidence';
import type {FieldGap} from '../../../../shared/fieldSessions';
import {measurementLayout} from '../../../../shared/measurementLayout';
import {registerBlockType,type MediaBlockProps} from '../../pages/blocks/registry';
import {DashBlock,HeadingField,DatabasePicker,pickableBoards,str,useBoardsQuery} from './shared';
const control='h-auto min-h-11 w-full min-w-0 max-w-full py-2',button='h-auto min-h-11 min-w-0 max-w-full whitespace-normal break-words py-2';
const fieldLabels={dateKey:'Date',measurementKey:'Measurement',unitKey:'Unit',observationKey:'Observation',photoKey:'Photo link',placeKey:'Place',experimentKey:'Experiment',projectKey:'Project'} as const;
function FieldEvidenceConfigure({block,chart}:{block:LocalRow;chart:boolean}){
 const boards=useBoardsQuery(),board=boards?.find(b=>b.id===block.databaseId),fields=fieldsOf(board),parsed=fieldEvidenceConfigSchema.safeParse(block),config=parsed.success?parsed.data:undefined,[error,setError]=useState('');
 const targetIds=[...new Set(['experimentKey','placeKey'].flatMap(key=>{const field=fields.find(f=>`rel_${f.id}`===config?.[key as 'experimentKey'|'placeKey']);return field?.relation?[field.relation.target]:[];}))];
 const contexts=useLiveQuery<LocalRow[]>(()=>targetIds.length?db.tasks.where('boardId').anyOf(targetIds).and(r=>!r.deleted&&!r.archived).limit(201).toArray():Promise.resolve([]),[JSON.stringify(targetIds)]);
 const save=async(patch:Record<string,unknown>)=>{setError('');try{await mutate('blocks',block.id,patch);}catch{setError('Configuration could not be saved. Reopen it and retry.');}};
 return <><HeadingField value={str(block.heading)} onChange={heading=>save({heading:heading??null})}/><DatabasePicker value={str(block.databaseId)??''} boards={pickableBoards(boards)} onChange={id=>save({databaseId:id||null})}/>
  {(Object.keys(fieldLabels) as (keyof typeof fieldLabels)[]).map(key=>{
   const relation=['placeKey','experimentKey','projectKey'].includes(key),type=relation?'relation':key==='dateKey'?'date':key==='measurementKey'?'number':key==='photoKey'?'url':'text';
   return <Field key={key} label={fieldLabels[key]+' field'}><Select className={control} aria-label={'Field evidence '+fieldLabels[key]+' field'} value={config?.[key]??''} onChange={e=>save({[key]:e.target.value})}><option value="" disabled>Choose a field</option>{fields.filter(f=>f.type===type).map(f=><option key={f.id} value={`${relation?'rel':'p'}_${f.id}`}>{f.name}</option>)}</Select></Field>;
  })}
  {(['experiment','place'] as const).map(kind=>{
   const field=fields.find(f=>`rel_${f.id}`===config?.[`${kind}Key`]),target=field?.relation?.target,selected=config?.[`${kind}Id`]??'',options=(contexts??[]).slice(0,200).filter(r=>r.boardId===target);
   return <Field key={kind} label={kind==='experiment'?'Experiment context':'Place context'}><Select className={control} aria-label={kind==='experiment'?'Evidence Experiment context':'Evidence Place context'} value={selected} onChange={e=>save({[`${kind}Id`]:e.target.value||null})}><option value="">All available contexts</option>{selected&&!options.some(r=>r.id===selected)&&<option value={selected}>Selected context unavailable on this device</option>}{options.map(r=><option key={r.id} value={r.id}>{String(r.title??'Untitled context')}</option>)}</Select></Field>;
  })}
  {(contexts?.length??0)>200&&<p className="text-xs text-neutral-600 dark:text-neutral-400">Showing the first 200 context records on this device.</p>}
  {chart?<Field label="Unit to display"><Input aria-label="Unit to display" className={control} value={str(block.unit)??''} maxLength={100} onChange={e=>save({unit:e.target.value})} placeholder="Leave blank for a single-unit source"/><p className="text-xs text-neutral-600 dark:text-neutral-400">Choosing a unit filters the source. No conversion is applied.</p></Field>:<><Field label="Maximum visits"><Select className={control} aria-label="Field session limit" value={config?.limit??10} onChange={e=>save({limit:Number(e.target.value)})}>{[5,10,20,50].map(n=><option key={n} value={n}>{n}</option>)}</Select></Field><label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={config?.missingOnly??false} onChange={e=>save({missingOnly:e.target.checked})}/>Visits with missing context only</label></>}
  {error&&<p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
 </>;
}
const gapLabels:Record<FieldGap,string>={date:'Add Date',place:'Review Place',experiment_or_project:'Add Experiment or Project',unit:'Add Unit',observation:'Add Observation',photo:'Review photo evidence'};
function FieldSessions({page,config}:{page:FieldEvidencePage;config:FieldEvidenceConfig}){
 const contexts=new Map(page.context.map(r=>[r.id,r.title])),records=new Map(page.records.map(r=>[r.id,r])),keys:Record<FieldGap,string>={date:config.dateKey,place:config.placeKey,experiment_or_project:config.experimentKey,unit:config.unitKey,observation:config.observationKey,photo:config.photoKey};
 return <><p>Missing context can also be unavailable to your account. Review the source before changing it.</p>{!page.sessions.length&&<p>No available visits match this summary.</p>}<ul className="space-y-3">{page.sessions.map(session=><li key={session.key} className="min-w-0 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700"><details><summary className="min-h-11 cursor-pointer break-words py-2 font-medium">{session.date??'Date unavailable'} · {session.places.map(id=>contexts.get(id)).filter(Boolean).join(', ')||'No available Place'} · {session.recordIds.length} observations · {session.missingCount} need context</summary><p className="break-words text-xs text-neutral-600 dark:text-neutral-400">Experiment: {session.experiments.map(id=>contexts.get(id)).filter(Boolean).join(', ')||'No available Experiment'}.</p><ul className="space-y-3">{session.recordIds.map(id=>{
  const record=records.get(id)!;return <li key={id} className="min-w-0 border-t border-neutral-200 pt-2 dark:border-neutral-700"><Link className="block min-h-11 break-words py-2 font-medium underline" to={record.url}>{record.title}</Link><div className="flex flex-wrap gap-2">{record.missing.map(gap=><Link key={gap} className="inline-flex min-h-11 min-w-0 max-w-full items-center rounded-lg border border-neutral-300 px-2 py-2 underline dark:border-neutral-600" to={record.url+'?focusField='+encodeURIComponent(keys[gap])}><span className="min-w-0 break-words">{gapLabels[gap]}</span></Link>)}</div>{record.photoEvidence==='unknown'&&<p className="text-xs text-neutral-600 dark:text-neutral-400">{record.photoIntent==='planned'?'Photos were planned; the available metadata is incomplete.':'Photo intent is unknown. This record has no usable capture intent.'}</p>}{record.issues.length>0&&<p className="break-words text-xs text-neutral-600 dark:text-neutral-400">Review needed: {record.issues.map(i=>i.replaceAll('_',' ')).join(', ')}.</p>}</li>;
 })}</ul></details></li>)}</ul></>;
}
function MeasurementChart({page}:{page:FieldEvidencePage}){
 const {series}=page,geometry=measurementLayout(series.points),prefix=useId(),navigate=useNavigate(),refs=useRef<(HTMLAnchorElement|null)[]>([]),[active,setActive]=useState(0),[table,setTable]=useState(false),records=new Map(page.records.map(r=>[r.id,r]));
 useEffect(()=>setActive(index=>Math.min(index,Math.max(0,series.points.length-1))),[series.points.length]);
 const number=(v:number)=>new Intl.NumberFormat('en',{maximumSignificantDigits:8}).format(v);
 if(series.error==='mixed_units')return <p role="status" className="break-words">Cannot combine units: {series.units.join(', ')}. Choose one unit in Configure. No conversion was applied.</p>;
 if(!series.points.length)return <><p>No dated measurements with a usable Unit match this chart.</p>{series.omitted.length>0&&<p>{series.omitted.length} measurements need a Date or Unit. Review the field-session list.</p>}</>;
 return <figure className="min-w-0 space-y-3"><figcaption className="break-words font-medium">Measurements in {series.unit}. {series.points[0].date} to {series.points.at(-1)!.date}.</figcaption>
  <p id={prefix+'-instructions'} className="text-xs text-neutral-600 dark:text-neutral-400">Use Left and Right arrows on chart points, then Enter to open the observation and its original notes or attachments. The data table offers the same links.</p>
  <svg className="block w-full overflow-visible" viewBox={`0 0 ${geometry.width} ${geometry.height}`} role="group" aria-labelledby={prefix+'-title'} aria-describedby={prefix+'-instructions'}><title id={prefix+'-title'}>Measurement series in {series.unit}</title><path d={geometry.path} fill="none" className="stroke-blue-600 dark:stroke-blue-400" strokeWidth={2} vectorEffect="non-scaling-stroke"/>{geometry.points.map((point,index)=>{
   const record=records.get(point.recordId)!,label=`${point.date}: ${number(point.value)} ${series.unit}. ${record.title}`;
   return <a key={point.recordId} href={record.url} ref={el=>{refs.current[index]=el;}} tabIndex={active===index?0:-1} aria-label={label} className="group outline-none" onFocus={()=>setActive(index)} onClick={e=>{if(e.button===0&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey){e.preventDefault();navigate(record.url);}}} onKeyDown={e=>{
    const next=e.key==='Home'?0:e.key==='End'?geometry.points.length-1:e.key==='ArrowRight'?Math.min(index+1,geometry.points.length-1):e.key==='ArrowLeft'?Math.max(index-1,0):null;if(next===null)return;e.preventDefault();setActive(next);refs.current[next]?.focus();
   }}><circle cx={point.x} cy={point.y} r={8} className="fill-blue-600 stroke-white group-focus-visible:stroke-blue-800 dark:fill-blue-400 dark:stroke-neutral-950 dark:group-focus-visible:stroke-white" strokeWidth={2} vectorEffect="non-scaling-stroke"/><circle cx={point.x} cy={point.y} r={14} fill="none" className="stroke-transparent group-focus-visible:stroke-blue-800 dark:group-focus-visible:stroke-white" strokeWidth={3} vectorEffect="non-scaling-stroke"/></a>;
  })}</svg>
  <p className="break-words text-xs text-neutral-600 dark:text-neutral-400">Range: {number(geometry.min!)} to {number(geometry.max!)} {series.unit}. {series.omitted.length>0&&`${series.omitted.length} measurements omitted for missing Date or Unit. `}{series.excludedByUnit>0&&`${series.excludedByUnit} measurements use another unit and are excluded.`}</p>
  <Button className={button} aria-expanded={table} aria-controls={prefix+'-table'} onClick={()=>setTable(value=>!value)}>{table?'Hide data table':'Show data table'}</Button>
  {table&&<div id={prefix+'-table'} className="max-w-full overflow-auto" role="region" aria-label="Measurement data table" tabIndex={0}><table className="w-full border-collapse text-left"><caption className="sr-only">Source measurements in {series.unit}</caption><thead><tr>{['Date','Value','Observation'].map(label=><th key={label} scope="col" className="border-b border-neutral-300 p-2 dark:border-neutral-600">{label}</th>)}</tr></thead><tbody>{series.points.map(point=><tr key={point.recordId}><td className="whitespace-nowrap border-b border-neutral-200 p-2 dark:border-neutral-700">{point.date}</td><td className="border-b border-neutral-200 p-2 tabular-nums dark:border-neutral-700">{number(point.value)} {series.unit}</td><td className="min-w-0 border-b border-neutral-200 p-2 dark:border-neutral-700"><Link className="inline-block min-h-11 break-words py-2 underline" to={records.get(point.recordId)!.url}>{records.get(point.recordId)!.title}</Link></td></tr>)}</tbody></table></div>}
 </figure>;
}
function FieldEvidenceReader({config,offline,chart}:{config:FieldEvidenceConfig;offline:boolean;chart:boolean}){
 const state=useFieldEvidence(config,offline),page=state.value;
 return <section aria-label={chart?'Measurement evidence':'Field sessions'} className="min-w-0 space-y-3 text-sm text-neutral-900 dark:text-neutral-100"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="min-w-0 break-words font-semibold">{chart?'Measurements over time':'Recent field visits'}</h3><Button className={button} disabled={state.loading} onClick={()=>void state.reload()}>{state.loading?'Refreshing…':'Refresh evidence'}</Button></div>
  <div role="status" className="break-words text-xs text-neutral-600 dark:text-neutral-400">{state.loading&&!page&&<p>Loading field evidence…</p>}{page&&<p>As of {new Date(page.asOf).toLocaleString()}. Sources describe records you can access.</p>}{offline&&<p>Partial device snapshot. Reconnect to check current sources.</p>}{page?.partial&&<p>Some sources or measurements are incomplete. Review the source records.</p>}</div>
  {state.error&&<p role="alert" className="break-words text-red-700 dark:text-red-300">Field evidence could not be refreshed. Check connection and access, then retry.</p>}
  {page?.status==='source_unavailable'&&<p>The Field Log source is missing, archived or unavailable. Choose a source in Configure.</p>}{page?.status==='configuration_required'&&<p>The configured fields changed or are unavailable. Review Configure before relying on this summary.</p>}
  {page?.status==='ready'&&(chart?<MeasurementChart page={page}/>:<FieldSessions page={page} config={config}/>)}
  <Link to="/settings#reliability" className="block min-h-11 break-words py-2 underline">Review capture and uploads on this device</Link>
  <p className="break-words text-xs text-neutral-600 dark:text-neutral-400">Observations remain source data. No AI interpretation is written into them.</p>
 </section>;
}
export function FieldEvidenceContent({block,chart}:{block:LocalRow;chart:boolean}){
 const identity=useStore(authStore),access=useStore(accessClientStore),[online,setOnline]=useState(navigator.onLine);useEffect(()=>{const wake=()=>setOnline(navigator.onLine);window.addEventListener('online',wake);window.addEventListener('offline',wake);return()=>{window.removeEventListener('online',wake);window.removeEventListener('offline',wake);};},[]);
 const parsed=fieldEvidenceConfigSchema.safeParse(block);
 if(!identity.user||!getToken()||access.manifest?.userId!==identity.user.id||!['ready','offline'].includes(access.status))return <p>Checking account access before loading field evidence…</p>;
 if(!parsed.success)return <p>Choose a Field Log database and fields in Configure.</p>;
 const offline=!online||access.status==='offline';return <FieldEvidenceReader key={JSON.stringify([identity.user.id,getToken(),access.epoch,parsed.data,offline])} config={parsed.data} offline={offline} chart={chart}/>;
}
export function FieldSessionsBlock({block}:MediaBlockProps){return <DashBlock block={block} icon={ClipboardList} label="Field sessions" config={<FieldEvidenceConfigure block={block} chart={false}/>}>{()=> <FieldEvidenceContent block={block} chart={false}/>}</DashBlock>;}
export function MeasurementChartBlock({block}:MediaBlockProps){return <DashBlock block={block} icon={LineChart} label="Measurement chart" config={<FieldEvidenceConfigure block={block} chart/>}>{()=> <FieldEvidenceContent block={block} chart/>}</DashBlock>;}
registerBlockType('fieldsessions','Field sessions',FieldSessionsBlock);
registerBlockType('measurechart','Measurement chart',MeasurementChartBlock);
