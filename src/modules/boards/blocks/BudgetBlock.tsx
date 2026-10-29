import {useEffect,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {Link} from 'react-router';
import {Wallet} from 'lucide-react';
import {mutate} from '../../../core/sync/engine';
import {db,type LocalRow} from '../../../core/db';
import {authStore} from '../../../core/auth';
import {getToken} from '../../../core/api';
import {accessClientStore} from '../../../core/accessClient';
import {useStore} from '../../../core/store';
import {useFinance} from '../../../core/useFinance';
import {Button,Field,Select} from '../../../core/ui';
import {availableFieldKeys} from '../../../core/records';
import {fieldsOf,formatNumber} from '../../../../shared/fields';
import {financeConfigSchema,type FinanceConfig} from '../../../../shared/financeConfig';
import {registerBlockType,type MediaBlockProps} from '../../pages/blocks/registry';
import {FilterRow} from '../../../core/views/DatabasePage';
import {DashBlock,HeadingField,DatabasePicker,RecordListSheet,pickableBoards,str,useBoardsQuery} from './shared';
const control='h-auto min-h-11 w-full min-w-0 max-w-full py-2',button='h-auto min-h-11 min-w-0 max-w-full whitespace-normal py-2';
function BudgetConfigure({block}:{block:LocalRow}){
 const boards=useBoardsQuery(),board=boards?.find(b=>b.id===block.databaseId),parsed=financeConfigSchema.safeParse(block),config=parsed.success?parsed.data:undefined,filters=config?.filters??[],fields=fieldsOf(board);
 const related=fields.find(f=>`rel_${f.id}`===(config?.relationKey??'rel_f_transactions')),transactions=boards?.find(b=>b.id===related?.relation?.target),transactionFields=fieldsOf(transactions);
 const [error,setError]=useState('');
 const save=async(patch:Record<string,unknown>)=>{setError('');try{await mutate('blocks',block.id,patch);}catch{setError('Configuration could not be saved. Reopen it and retry.');}};
 return <><HeadingField value={str(block.heading)} onChange={heading=>save({heading:heading??null})}/>
  <Field label="Summary"><Select className={control} aria-label="Budget summary mode" value={config?.mode??'project'} onChange={e=>save({mode:e.target.value})}><option value="project">Project budget</option><option value="product">Product price and cost</option></Select></Field>
  <DatabasePicker value={str(block.databaseId)??''} boards={pickableBoards(boards)} onChange={id=>save({databaseId:id||null})}/>
  <Field label="Record source"><Select className={control} aria-label="Budget record source" value={block.recordId==='self'?'self':'database'} onChange={e=>save({recordId:e.target.value==='self'?'self':null})}><option value="database">Matching database records</option><option value="self">This record</option></Select></Field>
  {config?.mode==='product'?(['priceKey','costKey'] as const).map(key=><Field key={key} label={key==='priceKey'?'Price field':'Cost field'}><Select className={control} aria-label={key==='priceKey'?'Budget price field':'Budget cost field'} value={config[key]} onChange={e=>save({[key]:e.target.value})}>{fields.filter(f=>f.type==='number').map(f=><option key={f.id} value={`p_${f.id}`}>{f.name}</option>)}</Select></Field>):<>
   <Field label="Budget field"><Select className={control} aria-label="Project budget field" value={config?.budgetKey??'p_f_budget'} onChange={e=>save({budgetKey:e.target.value})}>{fields.filter(f=>f.type==='number').map(f=><option key={f.id} value={`p_${f.id}`}>{f.name}</option>)}</Select></Field>
   <Field label="Transactions relation"><Select className={control} aria-label="Budget transactions relation" value={config?.relationKey??'rel_f_transactions'} onChange={e=>save({relationKey:e.target.value})}>{fields.filter(f=>f.type==='relation').map(f=><option key={f.id} value={`rel_${f.id}`}>{f.name}</option>)}</Select></Field>
   {(['amountKey','typeKey'] as const).map(key=><Field key={key} label={key==='amountKey'?'Amount field':'Transaction type field'}><Select className={control} aria-label={key==='amountKey'?'Transaction amount field':'Transaction type field'} value={config?.[key]??(key==='amountKey'?'p_f_amount':'p_f_type')} onChange={e=>save({[key]:e.target.value})}>{transactionFields.filter(f=>f.type===(key==='amountKey'?'number':'select')).map(f=><option key={f.id} value={`p_${f.id}`}>{f.name}</option>)}</Select></Field>)}
  </>}
  {board&&block.recordId!=='self'&&<fieldset><legend className="font-medium">Record filters</legend>{filters.map((filter,i)=><FilterRow key={i} board={board} keys={availableFieldKeys(board)} filter={filter} onChange={next=>save({filters:next?filters.map((f,j)=>i===j?next:f):filters.filter((_,j)=>i!==j)})}/>)}<Button className={button} disabled={filters.length>=20} onClick={()=>save({filters:[...filters,{key:'title',op:'contains',value:''}]})}>Add budget filter</Button></fieldset>}
  <Field label="Maximum records"><Select className={control} aria-label="Budget record limit" value={config?.limit??10} onChange={e=>save({limit:Number(e.target.value)})}>{Array.from({length:20},(_,i)=>i+1).map(n=><option key={n} value={n}>{n}</option>)}</Select></Field>
  {error&&<p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
 </>;
}
function BudgetReader({config,offline}:{config:FinanceConfig;offline:boolean}){
 const state=useFinance(config,offline),page=state.value,[drill,setDrill]=useState<string[]|null>(null);
 const money=(value:number|null,currency:string|null)=>value===null?'Unavailable':formatNumber(value,{format:'currency',currency:currency??page?.currency},page?.currency??'INR');
 return <section aria-label="Budget summary" className="min-w-0 space-y-3 text-sm text-neutral-900 dark:text-neutral-100">
  <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{config.mode==='product'?'Product price and cost':'Project budget'}</h3><Button className={button} disabled={state.loading} onClick={()=>void state.reload()}>{state.loading?'Refreshing…':'Refresh budget'}</Button></div>
  <div role="status" className="break-words text-xs text-neutral-600 dark:text-neutral-400">{state.loading&&!page&&<p>Loading money sources…</p>}{page&&<p>As of {new Date(page.asOf).toLocaleString()}. Amounts in your accessible records.</p>}{offline&&<p>Partial device snapshot. Reconnect to check current server amounts.</p>}{page?.partial&&<p>Partial: some sources or values are unavailable. Review the source records before relying on these figures.</p>}</div>
  {state.error&&<p role="alert" className="break-words text-red-700 dark:text-red-300">Money sources could not be refreshed. Check connection and access, then retry.</p>}
  {page?.status==='source_unavailable'&&<p>The source is missing, archived or unavailable. Choose another source in Configure.</p>}
  {page?.status==='ready'&&!page.items.length&&<p>No available records match this summary. Adjust the source or filters.</p>}
  <ul className="space-y-3">{page?.items.map(item=>{
   const value=item.money??item.economics!,currency=value.currency;
   return <li key={item.id} className="min-w-0 space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700"><Link className="block min-h-11 break-words py-2 font-medium underline" to={item.url}>{item.title}</Link>
    {value.error==='mixed_currency'?<p role="status">Cannot combine currencies: {value.currencies?.join(', ')}. Align the field currencies to compare them; no conversion was applied.</p>:<>
     <dl className="space-y-2">{(item.money?[['Budget',item.money.budget],['Net expenses',item.money.spent],['Income, shown separately',item.money.income],['Remaining: budget minus net expenses',item.money.remaining]]:[['Price',item.economics!.price],['Cost',item.economics!.cost],['Price minus cost',item.economics!.difference]]).map(([label,amount])=><div key={String(label)} className="flex min-w-0 flex-wrap justify-between gap-2"><dt className="min-w-0 break-words">{label}</dt><dd className="min-w-0 break-words font-medium tabular-nums">{money(amount as number|null,currency)}</dd></div>)}</dl>
     {item.money&&item.money.budget!==null&&item.money.budget>0&&item.money.spent!==null&&<><label className="block" htmlFor={'budget-'+item.id}>Net expenses against budget</label><progress id={'budget-'+item.id} className="h-3 w-full" value={Math.max(0,Math.min(item.money.spent,item.money.budget))} max={item.money.budget}/></>}
     {item.economics&&<p>Margin: {item.economics.marginPercent===null?'Unavailable':new Intl.NumberFormat('en',{maximumFractionDigits:2}).format(item.economics.marginPercent)+'%'}. Computed from Price and Cost; your text Margin is unchanged.</p>}
    </>}
    {value.issues.length>0&&<p className="break-words text-xs text-neutral-600 dark:text-neutral-400">Review needed: {value.issues.map(i=>i.replaceAll('_',' ')).join(', ')}.</p>}
    {item.money&&<Button className={button} disabled={!item.money.transactionIds.length} onClick={()=>setDrill(item.money!.transactionIds)}><span className="min-w-0 break-words">View transactions</span></Button>}
   </li>;
  })}</ul>
  {drill&&page&&<RecordListSheet ids={drill} sourceRefs={page.records} onClose={()=>setDrill(null)}/>}
 </section>;
}
export function BudgetContent({block}:{block:LocalRow}){
 const identity=useStore(authStore),access=useStore(accessClientStore),[online,setOnline]=useState(navigator.onLine);
 useEffect(()=>{const wake=()=>setOnline(navigator.onLine);window.addEventListener('online',wake);window.addEventListener('offline',wake);return()=>{window.removeEventListener('online',wake);window.removeEventListener('offline',wake);};},[]);
 const parent=useLiveQuery(()=>block.recordId==='self'&&block.pageId?db.tasks.get(String(block.pageId)):undefined,[block.recordId,block.pageId]);
 const parsed=financeConfigSchema.safeParse({...block,...(block.recordId==='self'&&parent?{recordId:parent.id,databaseId:parent.boardId??'board-default'}:{})});
 let content;
 if(!identity.user||!getToken()||access.manifest?.userId!==identity.user.id||!['ready','offline'].includes(access.status))content=<p>Checking account access before loading money sources…</p>;
 else if(block.recordId==='self'&&!parent)content=<p>This record needs a record body. Choose a database in Configure when using a page on its own.</p>;
 else if(!parsed.success)content=<p>Choose a database or record in Configure.</p>;
 else{const offline=!online||access.status==='offline';content=<BudgetReader key={JSON.stringify([identity.user.id,getToken(),access.epoch,parsed.data,offline])} config={parsed.data} offline={offline}/>;}
 return content;
}
export function BudgetBlock({block}:MediaBlockProps){return <DashBlock block={block} icon={Wallet} label="Budget" config={<BudgetConfigure block={block}/>} >{()=> <BudgetContent block={block}/>}</DashBlock>;}
export function ProductEconomicsDatabase({databaseId}:{databaseId:string}){
 const board=useLiveQuery(()=>db.boards.get(databaseId),[databaseId]),[open,setOpen]=useState(false);
 if(!board||board.deleted||board.archived||board.templateDbKey!=='products')return null;
 return <details className="max-h-[50vh] shrink-0 overflow-auto border-b border-neutral-200 px-4 py-2 dark:border-neutral-800" onToggle={e=>setOpen(e.currentTarget.open)}><summary className="min-h-11 cursor-pointer py-2 font-medium">Common Cupboard price and cost</summary>{open&&<BudgetContent block={{id:'budget:'+databaseId,_ts:{},databaseId,mode:'product',limit:10}}/>}</details>;
}
registerBlockType('budget','Budget and product economics',BudgetBlock);
