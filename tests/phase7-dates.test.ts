import {describe,expect,it} from 'vitest';
import {evalFilter,sortRecords,type Filter} from '../shared/views';

describe('Phase 7 date filtering',()=>{
 it('compares created milliseconds with a calendar date while keeping numeric sorting',()=>{
  const early={id:'early',createdAt:Date.parse('2026-10-23T20:00:00Z')};
  const late={id:'late',createdAt:Date.parse('2026-10-25T20:00:00Z')};
  expect(evalFilter(late,{key:'createdAt',op:'after',value:'2026-10-24'})).toBe(true);
  expect(evalFilter(early,{key:'createdAt',op:'after',value:'2026-10-24'})).toBe(false);
  expect(sortRecords([late,early],[{key:'createdAt',dir:'asc'}]).map(r=>r.id)).toEqual(['early','late']);
 });
 it('bounds an inclusive within window instead of accepting every row',()=>{
  const filter={key:'dueDate',op:'within',value:{from:'today',to:'today+30'}} as Filter;
  const days=['2026-10-23','2026-10-24','2026-11-23','2026-11-24','2099-01-01'];
  expect(days.map(dueDate=>evalFilter({dueDate},filter,{today:'2026-10-24'}))).toEqual([false,true,true,false,false]);
 });
});

import {isDateBound,parseDateOnly,toDateOnlyInZone} from '../shared/dates';
import {aggregate,changeFilterOperator,dateFilterError,isDateFilterKey} from '../shared/views';
import {conditionsMatch,validateAutomation,type AutomationConfig} from '../shared/automations';
import pack from '../templates/tcg-pack.json';
const dateFields=[{id:'deadline',name:'Deadline',type:'date' as const}];

describe('Phase 7 calendar and range boundaries',()=>{
 it.each([
  ['UTC','2026-10-24'],['Asia/Kolkata','2026-10-25'],['America/New_York','2026-10-24'],
 ])('converts an instant in %s without shifting stored date strings',(timeZone,expected)=>{
  const ms=Date.parse('2026-10-24T20:00:00Z');
  expect(toDateOnlyInZone(ms,timeZone)).toBe(expected);
  expect(evalFilter({createdAt:ms},{key:'createdAt',op:'is',value:expected},{timeZone})).toBe(true);
  expect(evalFilter({createdAt:ms},{key:'createdAt',op:'is_not',value:expected},{timeZone})).toBe(false);
  expect(evalFilter({dueDate:'2026-10-24'},{key:'dueDate',op:'is',value:'2026-10-24'},{timeZone})).toBe(true);
 });
 it('uses the correct date on both sides of a DST transition',()=>{
  expect(toDateOnlyInZone(Date.parse('2026-03-08T04:30Z'),'America/New_York')).toBe('2026-03-07');
  expect(toDateOnlyInZone(Date.parse('2026-03-08T07:30Z'),'America/New_York')).toBe('2026-03-08');
  expect(toDateOnlyInZone(Date.parse('2026-11-01T05:30Z'),'America/New_York')).toBe('2026-11-01');
  expect(toDateOnlyInZone(Date.parse('2026-11-01T06:30Z'),'America/New_York')).toBe('2026-11-01');
 });
 it('fails closed for invalid instants, zones and unresolvable relative ranges',()=>{
  for(const ms of [NaN,Infinity,9e15])expect(toDateOnlyInZone(ms,'UTC')).toBeNull();
  for(const op of ['is','is_not','before','after','on_or_before','on_or_after'] as const)
   expect(evalFilter({createdAt:Date.now()},{key:'createdAt',op,value:'2026-10-24'},{timeZone:'invalid/zone'})).toBe(false);
  const filter:Filter={key:'dueDate',op:'within',value:{from:'today',to:'today+7'}};
  for(const today of [undefined,'bad','2026-02-30'])expect(evalFilter({dueDate:'2026-10-24'},filter,{today})).toBe(false);
 });
 it('handles leap day, year rollover and reversed dynamic endpoints inclusively',()=>{
  const inRange=(date:string,from:string,to:string,today?:string)=>evalFilter({dueDate:date},{key:'dueDate',op:'within',value:{from,to}},{today});
  expect(inRange('2024-02-29','today','today+1','2024-02-28')).toBe(true);
  expect(inRange('2027-01-01','today','today+1','2026-12-31')).toBe(true);
  expect(inRange('2026-10-24','today+1','today-1','2026-10-24')).toBe(false);
  for(const date of ['','bad','2026-02-30'])expect(inRange(date,'2026-01-01','2026-12-31')).toBe(false);
 });
 it('retains numeric createdAt comparisons and supports createdAt windows',()=>{
  expect(evalFilter({createdAt:200},{key:'createdAt',op:'after',value:100})).toBe(true);
  expect(evalFilter({createdAt:Date.parse('2026-10-24T20:00Z')},{key:'createdAt',op:'within',value:{from:'2026-10-25',to:'2026-10-25'}},{timeZone:'Asia/Kolkata'})).toBe(true);
 });
 it('validates date bounds and absolute ordering without rejecting literal text filters',()=>{
  expect(isDateFilterKey('createdAt')).toBe(true);expect(isDateFilterKey('p_deadline',dateFields)).toBe(true);
  for(const value of ['today+3651','today + 3','Today+3','2026-02-30','2026-10-24\n','bad']){
   expect(isDateBound(value)).toBe(false);
   expect(dateFilterError({key:'p_deadline',op:'before',value},dateFields)).toBeTypeOf('string');
  }
  expect(parseDateOnly('2026-10-24\n')).toBeNull();
  for(const value of [null,{},[],{from:'today'},{from:'today',to:'today+3651'},{from:'2026-10-25',to:'2026-10-24'}])
   expect(dateFilterError({key:'dueDate',op:'within',value})).toBeTypeOf('string');
  expect(dateFilterError({key:'dueDate',op:'within',value:{from:'today+7',to:'today'}})).toBeNull();
  expect(dateFilterError({key:'title',op:'is',value:'Today+3'})).toBeNull();
  expect(dateFilterError({key:'title',op:'within',value:{from:'today',to:'today'}})).toBeTypeOf('string');
 });
 it('changes operators without serializing range objects into scalar fields',()=>{
  const range=changeFilterOperator({key:'dueDate',op:'before',value:'today-7'},'within');
  expect(range.value).toEqual({from:'today',to:'today+30'});
  expect(changeFilterOperator(range,'after').value).toBe('today');
  expect(changeFilterOperator({...range,value:null},'before').value).toBe('today');
 });
 it('expresses each of the three pack deadline metrics with a single within condition',()=>{
  const found:{filters:Filter[]}[]=[];
  const visit=(value:unknown)=>{if(!value||typeof value!=='object')return;const x=value as Record<string,unknown>;
   if(x.type==='metric'&&x.label==='Deadlines in the next 30 days')found.push(x as unknown as {filters:Filter[]});Object.values(x).forEach(visit);};visit(pack);
  expect(found).toHaveLength(3);
  const records=[{id:'near',p_f_deadline:'2026-10-30',status:'open'},{id:'far',p_f_deadline:'2099-01-01',status:'open'},{id:'won',p_f_deadline:'2026-10-30',status:'won'}];
  for(const metric of found){const filters=metric.filters.filter(f=>f.key!=='p_f_deadline');filters.push({key:'p_f_deadline',op:'within',value:{from:'today',to:'today+30'}});
   expect(aggregate(records,{agg:'count',filters},{today:'2026-10-24'}).ids).toEqual(['near']);}
 });
 it('shares within evaluation and validation with automation conditions',()=>{
  const conditions:Filter[]=[{key:'p_deadline',op:'within',value:{from:'today',to:'today+7'}}];
  expect(conditionsMatch(conditions,{p_deadline:'2026-10-30'},{today:'2026-10-24'})).toBe(true);
  expect(conditionsMatch(conditions,{p_deadline:'2099-01-01'},{today:'2026-10-24'})).toBe(false);
  const auto={name:'Date workflow',databaseId:'db',enabled:true,trigger:{kind:'record.created'},conditions,actions:[{type:'set_field',fieldKey:'title',value:'Matched'}]} as AutomationConfig;
  expect(validateAutomation(auto,{boardsById:new Map([['db',{fields:dateFields}]])})).toEqual([]);
  expect(validateAutomation({...auto,conditions:[{...conditions[0],value:{from:'today',to:'today+9999'}}]},{boardsById:new Map([['db',{fields:dateFields}]])}).join(' ')).toContain('valid from and to');
 });
});
