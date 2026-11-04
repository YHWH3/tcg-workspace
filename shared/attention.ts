/** Derived attention, never a synced queue or a source of write authority. */
import {addDays,daysBetween,parseDateOnly} from './dates';
import {fieldsOf} from './fields';
import {isArchived} from './archive';
import {isDone,columnsOf} from './boardModel';

export const ATTENTION_KINDS=['approval_pending','ai_preview_pending','suggestion_pending','record_overdue','record_due_today','record_due_soon','record_unassigned','website_aging','mention_unread','automation_failed'] as const;
export type AttentionKind=typeof ATTENTION_KINDS[number];
export type AttentionPersonKey='assigneeId'|`p_${string}`;
export type AttentionDateKey='dueDate'|`p_${string}`;
export interface AttentionConfig {enabled:boolean;personKey:AttentionPersonKey;dateKey?:AttentionDateKey;soonDays?:number;triage?:boolean;triagers?:'admins'|string[]}
export interface AttentionItem {
 key:string;kind:AttentionKind;targetType:'record'|'page'|'approval'|'preview'|'suggestion'|'automation';targetId:string;
 title:string;url:string|null;databaseId?:string;databaseName?:string;ownerId?:string|null;personKey?:AttentionPersonKey;date?:string|null;ageDays?:number;
 reason?:'Refund needed'|'First reply overdue';
 severity:0|1|2|3;actions:('open'|'assign_me'|'decide'|'review'|'mark_done'|'snooze')[];restricted?:true;
}
export interface AttentionPage {items:AttentionItem[];nextCursor:string|null;partial:boolean;partialSources:string[];asOf:number;today:string;urgentCount:number;quietDigest:boolean}
export const isAttentionKind=(value:unknown):value is AttentionKind=>typeof value==='string'&&(ATTENTION_KINDS as readonly string[]).includes(value);
const customKey=(value:unknown):value is `p_${string}`=>typeof value==='string'&&/^p_[A-Za-z0-9_-]{1,64}$/.test(value);
export function validateAttentionConfig(raw:unknown,board:Record<string,unknown>):AttentionConfig {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('invalid_attention_config');
 const r=raw as Record<string,unknown>;
 if(Object.keys(r).some(k=>!['enabled','personKey','dateKey','soonDays','triage','triagers'].includes(k))||typeof r.enabled!=='boolean')throw new Error('invalid_attention_config');
 const fields=fieldsOf(board),person=r.personKey??'assigneeId',date=r.dateKey;
 if(person!=='assigneeId'&&(!customKey(person)||!fields.some(f=>`p_${f.id}`===person&&f.type==='person')))throw new Error('invalid_attention_person_field');
 if(date!==undefined&&date!=='dueDate'&&(!customKey(date)||!fields.some(f=>`p_${f.id}`===date&&f.type==='date')))throw new Error('invalid_attention_date_field');
 if(r.soonDays!==undefined&&(!Number.isInteger(r.soonDays)||Number(r.soonDays)<0||Number(r.soonDays)>30))throw new Error('invalid_attention_soon_days');
 if(r.triage!==undefined&&typeof r.triage!=='boolean')throw new Error('invalid_attention_triage');
 if(r.triagers!==undefined&&r.triagers!=='admins'&&(!Array.isArray(r.triagers)||r.triagers.length>7||r.triagers.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(id))||new Set(r.triagers).size!==r.triagers.length))throw new Error('invalid_attention_triagers');
 return {enabled:r.enabled,personKey:person as AttentionPersonKey,...(date===undefined?{}:{dateKey:date as AttentionDateKey}),soonDays:r.soonDays===undefined?3:Number(r.soonDays),triage:r.triage===true,triagers:r.triagers===undefined?'admins':r.triagers as 'admins'|string[]};
}
/** Missing settings retain task behavior; malformed stored settings fail closed. */
export function attentionConfig(board:Record<string,unknown>):AttentionConfig|null {
 if(board.attention==null)return {enabled:board.kind!=='records',personKey:'assigneeId',dateKey:'dueDate',soonDays:3,triage:false,triagers:'admins'};
 try{return validateAttentionConfig(board.attention,board);}catch{return null;}
}
export function openAttentionRecord(record:Record<string,unknown>,board:Record<string,unknown>|undefined):boolean {
 return !!board&&record.deleted!==true&&!isArchived(record)&&board.deleted!==true&&!isArchived(board)&&!isDone(record,board);
}
/** A record database without stages has no completion transition. */
export function attentionDoneStage(board:Record<string,unknown>):string|null {
 if(board.kind==='records'&&(!Array.isArray(board.columns)||!board.columns.length))return null;
 const columns=columnsOf(board);const id=columns[columns.length-1]?.id;
 return typeof id==='string'&&id? id:null;
}
export function isAttentionTriager(config:AttentionConfig,userId:string,admin:boolean):boolean {
 return config.triage===true&&(Array.isArray(config.triagers)?config.triagers.includes(userId):admin);
}
export function datedAttentionKind(date:unknown,today:string,soonDays=3):'record_overdue'|'record_due_today'|'record_due_soon'|null {
 if(!parseDateOnly(date)||!parseDateOnly(today)||!Number.isInteger(soonDays)||soonDays<0||soonDays>30)return null;
 if(String(date)<today)return 'record_overdue';if(date===today)return 'record_due_today';
 return String(date)<=addDays(today,soonDays)!?'record_due_soon':null;
}
export const attentionAge=(date:string,today:string)=>Math.max(0,daysBetween(date,today)??0);
const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
export function compareAttention(a:AttentionItem,b:AttentionItem):number {
 return b.severity-a.severity||cmp(a.date??'9999-99-99',b.date??'9999-99-99')||(b.ageDays??0)-(a.ageDays??0)||cmp(a.key,b.key);
}
export function rankAttention(items:readonly AttentionItem[],today:string):AttentionItem[] {
 if(!parseDateOnly(today))throw new Error('invalid_attention_today');return [...items].sort(compareAttention);
}
/** Cursor uses the complete rank tuple, including age, for stable tie paging. */
export const attentionRankKey=(item:AttentionItem)=>({severity:item.severity,date:item.date??'9999-99-99',ageDays:item.ageDays??0,key:item.key});
