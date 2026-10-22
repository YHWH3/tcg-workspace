import {onlineStore} from './sync/engine';
import {useEffect,useMemo,useRef,useState} from 'react';
import {useNavigate} from 'react-router';
import {useLiveQuery} from 'dexie-react-hooks';
import {Search,Sparkles} from 'lucide-react';
import {openAssistant} from './assistant/store';
import {db} from './db';
import {createStore,useStore} from './store';
import {accessClientStore} from './accessClient';
import {authStore} from './auth';
import {api,ApiError,getToken} from './api';
import {Sheet,Button} from './ui';
import {useIsMobile} from './mobile';
import {prefixMatch,mergeSearch,SearchEpoch,localSearchVisibility,type PaletteHit} from './searchModel';
export const paletteStore=createStore(false);
interface Reply {results:Omit<PaletteHit,'source'>[];nextCursor:string|null;hasMore:boolean;indexPending:boolean}
export function CommandPalette(){const open=useStore(paletteStore);return open?<SearchDialog/>:null;}
function SearchDialog(){
 const navigate=useNavigate(),access=useStore(accessClientStore),auth=useStore(authStore),online=useStore(onlineStore);
 const [query,setQuery]=useState(''),[type,setType]=useState(''),[space,setSpace]=useState(''),[database,setDatabase]=useState('');
 const compact=useIsMobile();
 const [showFilters,setShowFilters]=useState(false);
 const [revision,retry]=useState(0),[selected,setSelected]=useState(0);
 const [remote,setRemote]=useState<{key:string;reply:Reply|null;state:string;error?:string}>({key:'',reply:null,state:'Loading'});
 const sequence=useRef(new SearchEpoch()),input=useRef<HTMLInputElement>(null);
 const uid=auth.user?.id,token=getToken();
 const ready=!!uid&&db.name===`workspace-${uid}`&&access.manifest?.userId===uid&&['ready','offline'].includes(access.status);
 const key=JSON.stringify([uid,token,access.epoch,access.status,online,query,type,space,database,revision]);
 const rows=useLiveQuery(async()=>{
  if(!ready)return {key,results:[] as PaletteHit[]};
  const collections=['pages','tasks','boards','moodboards','comments','files','mooditems'] as const;
  const sampled=[...collections,'blocks'] as const;
  const tables=await db.transaction('r',sampled.map(c=>db.collection(c)),()=>Promise.all(sampled.map(c=>db.collection(c).limit(2000).toArray())));
  const visible=localSearchVisibility(tables.flatMap((rows,i)=>rows.map(r=>({id:r.id,collection:sampled[i],data:r,rootSpaceId:String(r._spaceId??r.spaceId??'space-core')}))));
  const result:PaletteHit[]=[];const blocks=tables[sampled.indexOf('blocks')];const bodies=new Map<string,string[]>();for(const b of blocks){if(!visible(b.id))continue;const id=String(b.pageId);const text=bodies.get(id)??[];text.push(String(b.text??''));bodies.set(id,text);}
  for(const [index,c] of collections.entries()){const table=tables[index];
   for(const r of table){if(!visible(r.id)||(space&&(r._spaceId??r.spaceId)!==space)||(database&&r.boardId!==database&&r.id!==database))continue;const kind=({pages:'page',tasks:'task',boards:'board',moodboards:'moodboard',comments:'comment',files:'file',mooditems:'mooditem'})[c];if(type&&type!==kind)continue;
    const title=String(r.title??r.name??r.body??r.text??'Untitled');
    const content=[title,r.description,...Object.entries(r).filter(([k,v])=>k.startsWith('p_')&&typeof v==='string').map(([,v])=>v),...(bodies.get(r.id)??[])].join(' ');if(!query.trim()||!prefixMatch(query,content))continue;
    let url=c==='pages'?`/pages/${r.id}`:c==='tasks'?`/boards/${r.boardId??'board-default'}/tasks/${r.id}`:c==='boards'?`/boards/${r.id}`:c==='moodboards'?`/moodboards/${r.id}`:'';
    if(!url&&c==='comments'){url=r.targetType==='page'?`/pages/${r.targetId}`:r.targetType==='task'?`/tasks/${r.targetId}`:r.targetType==='moodboard'?`/moodboards/${r.targetId}`:'';}
    if(!url&&c==='mooditems')url=`/moodboards/${r.boardId}`;
    if(!url&&c==='files'){if(r.parentType==='task')url=`/tasks/${r.parentId}`;else if(r.parentType==='block'){const b=await db.blocks.get(String(r.parentId));if(b)url=(await db.tasks.get(String(b.pageId)))?`/tasks/${b.pageId}`:`/pages/${b.pageId}`;}else if(r.parentType==='mooditem'){const m=await db.mooditems.get(String(r.parentId));if(m)url=`/moodboards/${m.boardId}`;}}
    if(url)result.push({id:r.id,type:kind,title:title.slice(0,300),url,source:'local'});if(result.length>=50)return {key,results:result};
   }}return {key,results:result};
 },[key,ready]);
 const valid=()=>authStore.get().user?.id===uid&&getToken()===token&&accessClientStore.get().epoch===access.epoch&&accessClientStore.get().status==='ready';
 async function fetchPage(cursor?:string){const request=sequence.current.begin();
  setRemote(s=>({key,reply:cursor&&s.key===key?s.reply:null,state:'Loading'}));
  try{const p=new URLSearchParams({q:query,limit:'20'});if(type)p.set('type',type);if(space)p.set('space',space);if(database)p.set('database',database);if(cursor)p.set('cursor',cursor);
   const reply=await api<Reply>(`/api/search?${p}`);if(!sequence.current.current(request)||!valid())return;
   setRemote(s=>({key,state:'Server results',reply:{...reply,results:cursor&&s.key===key?[...(s.reply?.results??[]),...reply.results]:reply.results}}));
  }catch(e){if(!sequence.current.current(request)||!valid())return;setRemote({key,reply:null,state:e instanceof ApiError&&e.status===401?'Session expired':e instanceof ApiError&&e.status===409?'Permission changed':'Request failed',error:'Server search unavailable. Local results may be incomplete.'});}
 }
 useEffect(()=>{sequence.current.invalidate();setSelected(0);if(!ready||access.status==='offline'||!online||!query.trim())return;const timer=setTimeout(()=>void fetchPage(),220);return()=>{clearTimeout(timer);sequence.current.invalidate();};},[key]);
 useEffect(()=>{input.current?.focus();},[]);
 const current=remote.key===key?remote:null;
 const hits=useMemo(()=>ready?mergeSearch(rows?.key===key?rows.results:[],(current?.reply?.results??[]).map(h=>({...h,source:'server' as const}))):[],[rows,current,key,ready]);
 useEffect(()=>{document.getElementById(`workspace-search-${selected}`)?.scrollIntoView({block:'nearest'});},[selected]);
 const go=(h:PaletteHit)=>{if(!ready)return;paletteStore.set(false);navigate(h.url);};
 const spaces=access.manifest?.protocol===3?access.manifest.spaces:[];
 const status=!ready?'Checking permissions — results hidden':(access.status==='offline'||!online)?'Offline — cached local results':current?.state??(query.trim()?'Loading':'Type to search');
 return <Sheet label="Search workspace" onClose={()=>paletteStore.set(false)} side="bottom"><div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col p-4">
  <div className="flex items-center gap-2"><Search size={18}/><label className="flex-1">Search workspace<input ref={input} role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="workspace-search-results" aria-activedescendant={hits[selected]?`workspace-search-${selected}`:undefined} aria-label="Search workspace" placeholder="Search pages, records, comments and files…" value={query} onChange={e=>setQuery(e.target.value)} className="mt-1 w-full rounded border p-2 text-base dark:bg-neutral-900" onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();setSelected(i=>Math.min(i+1,Math.max(0,hits.length-1)));}if(e.key==='ArrowUp'){e.preventDefault();setSelected(i=>Math.max(i-1,0));}if(e.key==='Enter'&&hits[selected]){e.preventDefault();go(hits[selected]);}}}/></label><Button onClick={()=>paletteStore.set(false)}>Close</Button></div>
  {compact&&<Button className="my-2 min-h-11 self-start" aria-expanded={showFilters} aria-controls="workspace-search-filters" onClick={()=>setShowFilters(v=>!v)}>Filters{(type||space||database)?" · Active":""}</Button>}
  <div id="workspace-search-filters" hidden={compact&&!showFilters} className={compact&&!showFilters?"hidden":"my-3 flex flex-wrap gap-2"}><label>Type<select aria-label="Search type" value={type} onChange={e=>setType(e.target.value)} className="block rounded border p-2 dark:bg-neutral-900"><option value="">All types</option>{['page','task','board','moodboard','comment','file','mooditem'].map(t=><option key={t}>{t}</option>)}</select></label>
  <label>Space<select aria-label="Search space" value={space} onChange={e=>setSpace(e.target.value)} className="block rounded border p-2 dark:bg-neutral-900"><option value="">All accessible spaces</option>{spaces.map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label>
  <label>Database<input aria-label="Search database ID" value={database} onChange={e=>setDatabase(e.target.value)} placeholder="Optional database ID" className="block max-w-full rounded border p-2 text-base dark:bg-neutral-900"/></label></div>
  <button type="button" data-testid="palette-ask-ai" aria-keyshortcuts="Control+J Meta+J" className="mb-2 flex min-h-11 w-full items-center gap-2 rounded border border-dashed border-neutral-300 p-3 text-left text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900" onClick={()=>{const q=query.trim();paletteStore.set(false);if(q)openAssistant({context:[],actionId:'search_answer',prompt:q,autoSend:false});else openAssistant();}}><Sparkles size={15} className="shrink-0 text-violet-500" aria-hidden="true"/><span className="min-w-0 flex-1 break-words">{query.trim()?`Ask AI: “${query.trim()}”`:'Ask AI…'}</span><kbd className="text-[10px] text-neutral-500">⌘J</kbd></button>
  <p role="status" className="text-sm">{status}{current?.reply?.indexPending?' · Index update pending':''}</p>
  {current?.error&&<div role="alert"><p>{current.error}</p><Button onClick={()=>retry(i=>i+1)}>Retry search</Button></div>}
  <div id="workspace-search-results" role="listbox" aria-label="Search results" className="min-h-0 flex-1 overflow-y-auto py-2">{hits.map((h,i)=><button role="option" id={`workspace-search-${i}`} aria-selected={selected===i} key={h.id} onClick={()=>go(h)} onFocus={()=>setSelected(i)} className={`my-1 block min-h-11 w-full rounded border p-3 text-left ${selected===i?'border-blue-500':'border-transparent'}`}><span className="block break-words">{h.title}</span><span className="block text-xs text-neutral-500">{h.type} · {h.source==='local'?'Cached local result':'Server result'}</span>{h.snippet&&<span className="block break-words text-sm">{h.snippet}</span>}</button>)}
  {ready&&query.trim()&&hits.length===0&&current?.state==='Server results'&&!current.reply?.indexPending&&<p>No matching records</p>}
  {current?.reply?.hasMore&&<Button disabled={current.state==='Loading'} onClick={()=>void fetchPage(current.reply!.nextCursor!)}>Load more results</Button>}</div>
 </div></Sheet>;
}
