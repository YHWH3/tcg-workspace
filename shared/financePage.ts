import {fieldsOf} from './fields';
import {applyView} from './views';
import {recordHref} from './recordRoutes';
import {projectMoney,productEconomics,type FinanceRecord,type FinanceLink,type ProjectMoney,type ProductEconomics} from './finance';
import type {FinanceConfig} from './financeConfig';
export interface FinancePage {
 status:'ready'|'source_unavailable';mode:'project'|'product';asOf:number;currency:string;
 partial:boolean;partialSources:string[];
 items:{id:string;title:string;databaseId:string;url:string;money:ProjectMoney|null;economics:ProductEconomics|null}[];
 records:{id:string;title:string;databaseId:string;url:string}[];
 trust:{untrusted:true;instructions:false};
}
export interface FinanceSnapshot {roots:FinanceRecord[];records:FinanceRecord[];boards:FinanceRecord[];links:FinanceLink[];partialSources:string[]}
export function financePage(config:FinanceConfig,snapshot:FinanceSnapshot,ctx:{userId:string;today:string;timeZone:string;currency:string;now:number}):FinancePage {
 const active=(r:FinanceRecord)=>!r.deleted&&!r.archived,boards=new Map(snapshot.boards.filter(active).map(b=>[b.id,b])),records=new Map(snapshot.records.filter(active).map(r=>[r.id,r]));
 const partialSources=new Set(snapshot.partialSources),database=config.databaseId?boards.get(config.databaseId):undefined;
 const candidates=snapshot.roots.filter(active).filter(r=>config.recordId?r.id===config.recordId&&(!config.databaseId||r.boardId===config.databaseId):r.boardId===config.databaseId&&!r.parentId),board=database??boards.get(String(candidates[0]?.boardId??''));
 const filtered=applyView(candidates,{filters:config.filters},{meId:ctx.userId,today:ctx.today,timeZone:ctx.timeZone,fieldsById:new Map(fieldsOf({fields:board?.fields}).map(f=>[f.id,f])),relationTitles:(id,fid)=>snapshot.links.filter(l=>!l.deleted&&!l.archived&&l.kind==='relation'&&l.fromId===id&&l.fieldId===fid&&records.has(l.toId)).map(l=>String(records.get(l.toId)!.title??''))}).rows as FinanceRecord[];
 if(filtered.length>config.limit)partialSources.add('record_selection');
 const items=filtered.slice(0,config.limit).map(record=>{
  const currentBoard=boards.get(String(record.boardId)),fields=fieldsOf({fields:currentBoard?.fields}),relation=fields.find(f=>`rel_${f.id}`===config.relationKey),transactionBoard=relation?.relation?boards.get(relation.relation.target):undefined;
  const money=config.mode==='project'?projectMoney(record,snapshot.records,snapshot.links,{projectFields:fields,transactionFields:fieldsOf({fields:transactionBoard?.fields}),workspaceCurrency:ctx.currency,transactionDatabaseId:transactionBoard?.id??'',relationField:relation??{id:'',type:'text',name:''},budgetKey:config.budgetKey,amountKey:config.amountKey,typeKey:config.typeKey,partial:partialSources.size>0}):null;
  const economics=config.mode==='product'?productEconomics(record,{fields,workspaceCurrency:ctx.currency,priceKey:config.priceKey,costKey:config.costKey,partial:partialSources.size>0}):null;
  return {id:record.id,title:String(record.title??'Untitled record').slice(0,300),databaseId:String(record.boardId),url:recordHref(String(record.boardId),undefined,record.id),money,economics};
 });
 const refs=new Set(items.flatMap(i=>i.money?.transactionIds??[]));
 return {status:!!config.databaseId&&!database||!!config.recordId&&!items.length?'source_unavailable':'ready',mode:config.mode,asOf:ctx.now,currency:ctx.currency,partial:partialSources.size>0||items.some(i=>(i.money??i.economics)?.partial===true),partialSources:[...partialSources].sort(),items,records:[...records.values()].filter(r=>refs.has(r.id)).map(r=>({id:r.id,title:String(r.title??'Untitled transaction').slice(0,300),databaseId:String(r.boardId),url:recordHref(String(r.boardId),undefined,r.id)})),trust:{untrusted:true,instructions:false}};
}
