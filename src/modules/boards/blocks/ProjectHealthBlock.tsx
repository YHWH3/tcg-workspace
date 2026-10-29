import {useEffect,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {Link} from 'react-router';
import {HeartPulse} from 'lucide-react';
import {projectHealthConfigSchema,type ProjectHealthConfig} from '../../../../shared/projectHealthConfig';
import {defaultProjectHealthBlock} from '../../../../shared/projectHealth';
import {planProjectHealthEdit} from '../../../../shared/projectHealthActions';
import {fieldsOf} from '../../../../shared/fields';
import {db,type LocalRow} from '../../../core/db';
import {authStore} from '../../../core/auth';
import {getToken} from '../../../core/api';
import {accessClientStore,assertClientMutationReady} from '../../../core/accessClient';
import {useStore} from '../../../core/store';
import {useUsers} from '../../../core/users';
import {useProjectHealth} from '../../../core/useProjectHealth';
import {mutate} from '../../../core/sync/engine';
import {logActivity} from '../../../core/activity';
import {Button,Field,Input,Select} from '../../../core/ui';
import {availableFieldKeys} from '../../../core/records';
import {FilterRow} from '../../../core/views/DatabasePage';
import {registerBlockType,type MediaBlockProps} from '../../pages/blocks/registry';
import {DashBlock,HeadingField,DatabasePicker,RecordListSheet,pickableBoards,str,useBoardsQuery} from './shared';

const control='h-auto min-h-11 w-full min-w-0 max-w-full py-2';
const button='h-auto min-h-11 py-2';
const link='inline-flex min-h-11 items-center break-words py-2 underline underline-offset-4 focus-visible:outline-2';
const statusLabel={on_track:'On track',at_risk:'At risk',blocked:'Blocked',unknown:'Unknown'};

function ProjectHealthConfigure({block}:{block:LocalRow}){
 const boards=useBoardsQuery(),[error,setError]=useState('');
 const databaseId=str(block.databaseId)??'',board=boards?.find(b=>b.id===databaseId);
 const projects=useLiveQuery(async():Promise<LocalRow[]>=>databaseId?await db.tasks.where('boardId').equals(databaseId).filter(r=>!r.deleted&&!r.archived&&!r.parentId).limit(200).toArray():[],[databaseId]);
 const parsed=projectHealthConfigSchema.safeParse(block),config=parsed.success?parsed.data:undefined;
 const save=async(patch:Record<string,unknown>)=>{setError('');try{await mutate('blocks',block.id,patch);}catch{setError('Configuration could not be saved. Reopen it and retry.');}};
 const mode=block.projectId==='self'?'self':'database';
 const fields=fieldsOf(board),filters=config?.filters??[];
 return <>
  <HeadingField value={str(block.heading)} onChange={heading=>void save({heading:heading??null})}/>
  <Field label="Project source"><Select className={control} aria-label="Project source" value={mode} onChange={e=>void save({projectId:e.target.value==='self'?'self':null})}><option value="database">Database or project</option><option value="self">This record</option></Select></Field>
  {mode==='self'?<p className="text-neutral-600 dark:text-neutral-400">This record resolves when the block is inside a record body.</p>:<>
   <DatabasePicker value={databaseId} boards={pickableBoards(boards)} onChange={id=>void save({databaseId:id||null,projectId:null})}/>
   <Field label="Project"><Select className={control} aria-label="Health project" value={str(block.projectId)??''} onChange={e=>void save({projectId:e.target.value||null})}><option value="">All matching projects</option>{projects?.filter(p=>p.boardId===databaseId).map(p=><option key={p.id} value={p.id}>{String(p.title??'Untitled project')}</option>)}</Select></Field>
   {(projects?.length??0)>=200&&<p>Showing the first 200 available root records. Use a database filter to narrow the review.</p>}
  </>}
  {board&&<>
   <Field label="Owner field"><Select className={control} aria-label="Health owner field" value={config?.ownerKey??'p_f_owner'} onChange={e=>void save({ownerKey:e.target.value})}><option value="assigneeId">Assignee</option>{fields.filter(f=>f.type==='person').map(f=><option key={f.id} value={`p_${f.id}`}>{f.name}</option>)}</Select></Field>
   {(['startKey','endKey'] as const).map(key=><Field key={key} label={key==='startKey'?'Start date field':'End date field'}><Select className={control} aria-label={key==='startKey'?'Health start field':'Health end field'} value={config?.[key]??(key==='startKey'?'p_f_start':'p_f_end')} onChange={e=>void save({[key]:e.target.value})}><option value="dueDate">Due date</option>{fields.filter(f=>f.type==='date').map(f=><option key={f.id} value={`p_${f.id}`}>{f.name}</option>)}</Select></Field>)}
   {mode==='database'&&<fieldset><legend className="font-medium">Project filters</legend>{filters.map((filter,i)=><FilterRow key={i} board={board} keys={availableFieldKeys(board)} filter={filter} onChange={next=>void save({filters:next?filters.map((f,j)=>i===j?next:f):filters.filter((_,j)=>i!==j)})}/>)}<Button className={button} disabled={filters.length>=20} onClick={()=>void save({filters:[...filters,{key:'title',op:'contains',value:''}]})}>Add project filter</Button></fieldset>}
  </>}
  <Field label="Activity age"><Select className={control} aria-label="Health activity age" value={config?.staleDays??14} onChange={e=>void save({staleDays:Number(e.target.value)})}>{[7,14,30,60,90,...(config&&![7,14,30,60,90].includes(config.staleDays)?[config.staleDays]:[])].map(n=><option key={n} value={n}>{n} days</option>)}</Select></Field>
  <Field label="Maximum projects"><Select className={control} aria-label="Health project limit" value={config?.limit??10} onChange={e=>void save({limit:Number(e.target.value)})}>{Array.from({length:20},(_,i)=>i+1).map(n=><option key={n} value={n}>{n}</option>)}</Select></Field>
  {error&&<p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
 </>;
}

function ProjectEditor({record,config,onClose,onSaved}:{record:LocalRow;config:ProjectHealthConfig;onClose:()=>void;onSaved:()=>void}){
 const users=useUsers(),[owner,setOwner]=useState(String(record[config.ownerKey]??'')),[start,setStart]=useState(String(record[config.startKey]??'')),[end,setEnd]=useState(String(record[config.endKey]??''));
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const save=async()=>{
  setBusy(true);setError('');const uid=authStore.get().user?.id,token=getToken(),epoch=accessClientStore.get().epoch;
  try{
   assertClientMutationReady();const board=await db.boards.get(String(record.boardId));
   if(!uid||!token||authStore.get().user?.id!==uid||getToken()!==token||accessClientStore.get().epoch!==epoch)throw new Error('Account or access changed. Reopen the project.');
   if(!board)throw new Error('Open the project to load its database before editing.');
   if(owner!==String(record[config.ownerKey]??'')&&owner&&!users.some(u=>u.id===owner&&!u.disabled))throw new Error('Choose an active owner.');
   const plan=planProjectHealthEdit(record,board,config,{ownerId:owner||null,start:start||null,end:end||null});
   if(Object.keys(plan.patch).length){await mutate('tasks',record.id,plan.patch,plan.guard);logActivity('updated','task',record.id,String(record.title??'Project'),{source:'project_health',fields:Object.keys(plan.patch)});window.dispatchEvent(new Event('ws-records-changed'));}
   onSaved();onClose();
  }catch(e){setError(e instanceof Error&&e.message.startsWith('Pack source changed')?'Project changed. Close and reopen this editor before saving.':e instanceof Error?e.message:'The project could not be saved.');}finally{setBusy(false);}
 };
 return <fieldset disabled={busy} className="min-w-0 space-y-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700"><legend className="px-1 font-medium">Edit owner and dates</legend>
  <Field label="Owner"><Select className={control} aria-label="Project owner" value={owner} onChange={e=>setOwner(e.target.value)}><option value="">Unassigned</option>{owner&&!users.some(u=>u.id===owner&&!u.disabled)&&<option value={owner}>Current unavailable member</option>}{users.filter(u=>!u.disabled).map(u=><option key={u.id} value={u.id}>{u.name||u.username}</option>)}</Select></Field>
  <Field label="Start"><Input className={control} aria-label="Project start date" type="date" min="0001-01-01" max="9999-12-31" value={start} onChange={e=>setStart(e.target.value)}/></Field>
  <Field label="End"><Input className={control} aria-label="Project end date" type="date" min="0001-01-01" max="9999-12-31" value={end} onChange={e=>setEnd(e.target.value)}/></Field>
  <div className="flex flex-wrap gap-2"><Button className={button} onClick={()=>void save()}>{busy?'Saving…':'Save project changes'}</Button><Button className={button} onClick={onClose}>Cancel</Button></div>
  {error&&<p role="alert" className="break-words text-red-700 dark:text-red-300">{error}</p>}
 </fieldset>;
}

function ProjectHealthReader({config,offline,onEdit}:{config:ProjectHealthConfig;offline:boolean;onEdit:(id:string)=>void}){
 const state=useProjectHealth(config,offline),[drill,setDrill]=useState<string[]|null>(null);
 const page=state.value;
 return <section aria-label="Project health" className="min-w-0 space-y-3 text-sm text-neutral-900 dark:text-neutral-100">
  <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Project health</h3><Button className={button} disabled={state.loading} onClick={()=>void state.reload()}>{state.loading?'Refreshing…':'Refresh health'}</Button></div>
  <div role="status" className="space-y-1 break-words text-xs text-neutral-600 dark:text-neutral-400">
   {state.loading&&!page&&<p>Loading project sources…</p>}
   {page&&<p>As of {new Date(page.asOf).toLocaleString()}. Review date {page.today}.</p>}
   {offline&&<p>Offline device snapshot. Approvals and server changes are unavailable; health stays Unknown until you reconnect.</p>}
   {page?.partial&&<p>Some sources or projects are missing from this bounded review. Open the project and refresh before relying on it.</p>}
   {page&&<p>Approvals include only requests you made or can decide. Other team approvals are outside this review.</p>}
  </div>
  {state.error&&<p role="alert" className="break-words text-red-700 dark:text-red-300">Project sources could not be refreshed. Check your connection and access, then retry.</p>}
  {page?.status==='source_unavailable'&&<p>The source is missing, archived or unavailable to this account. Review Configure or choose another project.</p>}
  {page?.status==='ready'&&!page.projects.length&&<p>No available projects match this review. Adjust the source or filters in Configure.</p>}
  <ul className="space-y-3">{page?.projects.map(project=><li key={project.id} className="min-w-0 space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
   <div className="flex min-w-0 flex-wrap items-start justify-between gap-2"><Link className={`${link} min-w-0 flex-1 basis-40 font-medium`} to={project.url}>{project.title||'Untitled project'}</Link><span className="rounded-md bg-neutral-100 px-2 py-2 font-medium dark:bg-neutral-800">{statusLabel[project.health.status]}</span></div>
   {project.health.partialSources.length>0&&<p className="break-words text-xs text-neutral-600 dark:text-neutral-400">Incomplete evidence: {project.health.partialSources.map(s=>s.replaceAll('_',' ')).join(', ')}.</p>}
   {!project.health.signals.length&&<p>No health signals in the available sources.</p>}
   <ul className="space-y-2">{project.health.signals.map(signal=><li key={signal.rule} className="flex min-w-0 flex-wrap items-center justify-between gap-2"><span className="min-w-0 flex-1 basis-36 break-words">{signal.label}{signal.count>1?` (${signal.count})`:''}</span><div className="flex max-w-full flex-wrap gap-2"><Button className={button} onClick={()=>setDrill(signal.sourceIds)}>View sources</Button>{(signal.action==='assign_owner'||signal.action==='set_dates')&&<Button className={button} onClick={()=>onEdit(project.id)}>{signal.action==='assign_owner'?'Assign owner':'Set dates'}</Button>}{signal.action==='open_approvals'&&<Link className={link} to="/approvals">Open approvals</Link>}{signal.action==='open_activity'&&<Link className={link} to="/activity">Open activity</Link>}</div></li>)}</ul>
   <Button className={button} onClick={()=>onEdit(project.id)}>Edit owner and dates</Button>
  </li>)}</ul>
  {drill&&page&&<RecordListSheet ids={drill} sourceRefs={page.records} onClose={()=>setDrill(null)}/>}
 </section>;
}

/** Connection changes replace read evidence, while an unsaved edit stays in
 * this same-account generation. Account/access/config changes unmount it. */
function ProjectHealthSession({config,offline}:{config:ProjectHealthConfig;offline:boolean}){
 const [edit,setEdit]=useState<LocalRow|null>(null),[error,setError]=useState(''),[message,setMessage]=useState('');
 const editProject=async(id:string)=>{setError('');const epoch=accessClientStore.get().epoch,uid=authStore.get().user?.id,token=getToken();try{const record=await db.tasks.get(id);if(epoch!==accessClientStore.get().epoch||uid!==authStore.get().user?.id||token!==getToken())throw new Error('Access changed. Refresh the review.');if(!record||record.deleted||record.archived)throw new Error('Open the project to load its current details before editing.');setEdit(record);}catch(e){setError(e instanceof Error?e.message:'Project could not be opened.');}};
 return <div className="min-w-0 space-y-3"><ProjectHealthReader key={String(offline)} config={config} offline={offline} onEdit={id=>void editProject(id)}/>{edit&&<ProjectEditor key={edit.id} record={edit} config={config} onClose={()=>setEdit(null)} onSaved={()=>setMessage('Project changes saved on this device. Sync confirms server acceptance.')}/>}<div role="status" className="break-words text-sm text-neutral-600 dark:text-neutral-400">{message}</div>{error&&<p role="alert" className="break-words text-sm text-red-700 dark:text-red-300">{error}</p>}</div>;
}

export function ProjectHealthContent({block}:{block:LocalRow}){
 const identity=useStore(authStore),access=useStore(accessClientStore),[online,setOnline]=useState(navigator.onLine);
 useEffect(()=>{const wake=()=>setOnline(navigator.onLine);window.addEventListener('online',wake);window.addEventListener('offline',wake);return()=>{window.removeEventListener('online',wake);window.removeEventListener('offline',wake);};},[]);
 const parent=useLiveQuery(async()=>block.projectId==='self'&&block.pageId?await db.tasks.get(String(block.pageId)):null,[block.projectId,block.pageId]);
 const config=projectHealthConfigSchema.safeParse({...block,...(block.projectId==='self'&&parent?{projectId:parent.id,databaseId:parent.boardId??'board-default'}:{})});
 if(!identity.user||!getToken()||access.manifest?.userId!==identity.user.id||!['ready','offline'].includes(access.status))return <p className="py-3 text-sm text-neutral-600 dark:text-neutral-400">Checking account access before loading project sources…</p>;
 if(block.projectId==='self'&&parent?.id!==block.pageId)return <p className="py-3 text-sm text-neutral-600 dark:text-neutral-400">This record needs a record body. Choose a project in Configure when using a page template on its own.</p>;
 if(!config.success)return <p className="py-3 text-sm text-neutral-600 dark:text-neutral-400">Choose a project or database in Configure.</p>;
 const offline=!online||access.status==='offline';
 return <ProjectHealthSession key={JSON.stringify([identity.user.id,getToken(),access.epoch,config.data])} config={config.data} offline={offline}/>;
}
export function ProjectHealthBlock({block}:MediaBlockProps){return <DashBlock block={block} icon={HeartPulse} label="Project health" config={<ProjectHealthConfigure block={block}/>} >{()=> <ProjectHealthContent block={block}/>}</DashBlock>;}
registerBlockType('projecthealth','Project health',ProjectHealthBlock);

export function ProjectHealthRecordBody({taskId}:{taskId:string}){
 const source=useLiveQuery(async()=>{const record=await db.tasks.get(taskId);if(!record)return null;const [board,blocks]=await Promise.all([db.boards.get(String(record.boardId)),db.blocks.where('pageId').equals(taskId).toArray()]);return board?defaultProjectHealthBlock(record,board,blocks.map(b=>b.type)):null;},[taskId]);
 const [error,setError]=useState('');
 const reserve=async(hidden:boolean)=>{if(!source)return;setError('');const {id,...patch}=source;try{await mutate('blocks',id,{...patch,order:'a0',deleted:hidden},{absent:true});}catch{setError('The default panel could not be customized. Reopen the project and retry.');}};
 if(!source||source.pageId!==taskId)return null;
 const block={...source,_ts:{}};
 return <div className="min-w-0 space-y-2 rounded-xl border border-neutral-200 p-3 dark:border-neutral-700"><ProjectHealthContent block={block}/><p className="text-xs text-neutral-600 dark:text-neutral-400">Default Project review. Customize creates a saved body block; hiding preserves your choice.</p><div className="flex flex-wrap gap-2"><Button className={button} onClick={()=>void reserve(false)}>Customize project health</Button><Button className={button} onClick={()=>void reserve(true)}>Hide default health</Button></div>{error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}</div>;
}
