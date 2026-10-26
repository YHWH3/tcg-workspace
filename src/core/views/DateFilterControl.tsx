import {useWorkspaceLocale} from '../workspaceLocale';
import {useEffect,useId,useRef,useState} from 'react';
import {parseDateOnly,resolveDateBound} from '../../../shared/dates';
import type {FieldDef} from '../../../shared/fields';
import {dateFilterError,type Filter} from '../../../shared/views';
import {Input,Select} from '../ui';
import {todayISO} from '../utils';

const PRESETS = [
  {id:'next7',label:'Next 7 days',from:'today',to:'today+7'},
  {id:'next30',label:'Next 30 days',from:'today',to:'today+30'},
  {id:'last7',label:'Last 7 days',from:'today-7',to:'today'},
  {id:'last30',label:'Last 30 days',from:'today-30',to:'today'},
] as const;
type Kind = 'today'|'tomorrow'|'future'|'past';
function initial(value: unknown) {
  const text=typeof value==='string'?value:'';
  const match=/^today([+-])(\d+)$/.exec(text);
  return {
    mode:text==='today'||match?'relative':'date',
    kind:(text==='today'?'today':text==='today+1'?'tomorrow':match?.[1]==='-'?'past':'future') as Kind,
    days:match?.[2]??'1',date:parseDateOnly(text)?text:'',
  };
}

function DateBoundControl({value,onChange,label,today}:{value:unknown;onChange:(value:string)=>void;label:string;today:string}) {
  const [draft,setDraft]=useState(()=>initial(value));
  const lastEmitted=useRef(value),help=useId();
  useEffect(()=>{if(value!==lastEmitted.current){setDraft(initial(value));lastEmitted.current=value;}},[value]);
  const emit=(next:string)=>{lastEmitted.current=next;onChange(next);};
  const validDays=/^\d+$/.test(draft.days)&&Number(draft.days)<=3650;
  const error=draft.mode==='date'&&!parseDateOnly(draft.date)?'Choose a valid date.'
    :draft.mode==='relative'&&['future','past'].includes(draft.kind)&&!validDays?'Enter a whole number from 0 to 3650.':null;
  const relative=(kind:Kind,days=draft.days)=>kind==='today'?'today':kind==='tomorrow'?'today+1':`today${kind==='past'?'-':'+'}${Number(days)}`;
  const commitDays=()=>{if(validDays)emit(relative(draft.kind));};
  return <div className="min-w-0 space-y-1">
    <Select density="compact" aria-label={`${label} date mode`} value={draft.mode} className="w-full"
      onChange={e=>{
        const mode=e.target.value;
        if(mode==='relative'){setDraft({...draft,mode,kind:'today'});emit('today');}
        else {const date=resolveDateBound(value,today)??'';setDraft({...draft,mode,date});if(date)emit(date);}
      }}>
      <option value="date">Exact date</option><option value="relative">Relative date</option>
    </Select>
    {draft.mode==='date'?<Input density="compact" type="date" min="0001-01-01" max="9999-12-31"
      className="w-full min-w-0" aria-label={`${label} date`} aria-describedby={help} aria-invalid={!!error}
      value={draft.date} onChange={e=>{const date=e.target.value;setDraft({...draft,date});if(parseDateOnly(date))emit(date);}}/>
      :<>
        <Select density="compact" className="w-full" aria-label={`${label} relative day`} value={draft.kind}
          onChange={e=>{const kind=e.target.value as Kind;const days=validDays?draft.days:'1';setDraft({...draft,kind,days});emit(relative(kind,days));}}>
          <option value="today">Today</option><option value="tomorrow">Tomorrow</option>
          <option value="future">In N days</option><option value="past">N days ago</option>
        </Select>
        {['future','past'].includes(draft.kind)&&<Input density="compact" type="number" min={0} max={3650} step={1} inputMode="numeric"
          className="w-full min-w-0" aria-label={`${label} days`} aria-describedby={help} aria-invalid={!!error} value={draft.days}
          onChange={e=>setDraft({...draft,days:e.target.value})} onBlur={commitDays}
          onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commitDays();}}}/>}
      </>}
    <p id={help} role={error?'alert':undefined} className={`text-xs ${error?'text-red-700 dark:text-red-300':'text-neutral-600 dark:text-neutral-400'}`}>
      {error??(draft.mode==='relative'?'Relative days: 0 to 3650. Press Tab or Enter to apply days.':'This date stays fixed as days pass.')}
    </p>
  </div>;
}

/** Shared by database filters and automation conditions; values use one contract. */
export function DateFilterControl({filter,onChange,label,fields}:{filter:Filter;onChange:(filter:Filter)=>void;label:string;fields:readonly FieldDef[]}) {
  useWorkspaceLocale();
  const today=todayISO();
  if(filter.op!=='within')return <DateBoundControl value={filter.value} onChange={value=>onChange({...filter,value})} label={label} today={today}/>;
  const range=filter.value&&typeof filter.value==='object'?filter.value as {from?:unknown;to?:unknown}:{};
  const preset=PRESETS.find(p=>p.from===range.from&&p.to===range.to)?.id;
  const error=dateFilterError(filter,fields);
  return <div className="min-w-0 space-y-2">
    <div role="group" aria-label={`${label} date presets`} className="grid grid-cols-2 gap-1">
      {PRESETS.map(p=><button key={p.id} type="button" aria-pressed={preset===p.id}
        className="min-h-10 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100 aria-pressed:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800 dark:aria-pressed:bg-neutral-800"
        onClick={()=>onChange({...filter,value:{from:p.from,to:p.to}})}>{p.label}</button>)}
      <button type="button" className="col-span-2 min-h-10 rounded-md border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-700"
        onClick={()=>onChange({...filter,op:'before',value:'today'})}>Overdue</button>
    </div>
    <div><p className="mb-1 text-xs font-medium">From (inclusive)</p><DateBoundControl label={`${label} from`} today={today} value={range.from}
      onChange={from=>onChange({...filter,value:{...range,from}})}/></div>
    <div><p className="mb-1 text-xs font-medium">To (inclusive)</p><DateBoundControl label={`${label} to`} today={today} value={range.to}
      onChange={to=>onChange({...filter,value:{...range,to}})}/></div>
    {error&&<p role="alert" className="text-xs text-red-700 dark:text-red-300">{error}</p>}
  </div>;
}

export const DATE_VALUE_OPERATORS = ['is','is_not','before','after','on_or_before','on_or_after','within'];
