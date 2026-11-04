/** Account-local indexed sources only. A device snapshot is always partial. */
import type {LocalDB,LocalRow} from './db';
import {fieldsOf} from '../../shared/fields';
import {financePage} from '../../shared/financePage';
import type {FinanceConfig} from '../../shared/financeConfig';
import type {FinanceLink} from '../../shared/finance';
export async function readLocalFinance(store:Pick<LocalDB,'tasks'|'boards'|'links'>,config:FinanceConfig,context:{userId:string;today:string;timeZone:string;currency:string;now:number}){
 const active=(r:LocalRow|undefined):r is LocalRow=>!!r&&!r.deleted&&!r.archived,partial=new Set(['device_snapshot']);
 const roots=config.recordId?(await store.tasks.bulkGet([config.recordId])).filter(active):await store.tasks.where('boardId').equals(config.databaseId!).and(r=>active(r)&&!r.parentId).limit(201).toArray();
 if(roots.length>200)partial.add('record_selection');const rootIds=roots.slice(0,200).map(r=>r.id);
 const rawLinks=rootIds.length?await store.links.where('fromId').anyOf(rootIds).or('toId').anyOf(rootIds).and(r=>active(r)&&r.kind==='relation').limit(1001).toArray():[];
 if(rawLinks.length>1000)partial.add('relations');
 const links:FinanceLink[]=rawLinks.slice(0,1000).flatMap(r=>typeof r.fromId==='string'&&typeof r.toId==='string'&&typeof r.fieldId==='string'?[{id:r.id,kind:'relation',fromId:r.fromId,toId:r.toId,fieldId:r.fieldId}]:[]);
 if(links.length<Math.min(rawLinks.length,1000))partial.add('relation_configuration');
 const peers=[...new Set([...rootIds,...links.flatMap(l=>[l.fromId,l.toId])])];if(peers.length>1200)partial.add('records');
 const records=(await store.tasks.bulkGet(peers.slice(0,1200))).filter((r):r is LocalRow=>!!r);
 const boardIds=[...new Set([...(config.databaseId?[config.databaseId]:[]),...records.map(r=>String(r.boardId??''))])];
 const rootBoards=(await store.boards.bulkGet(boardIds)).filter(active),relatedBoards=rootBoards.flatMap(b=>fieldsOf({fields:b.fields}).flatMap(f=>f.relation?[f.relation.target]:[]));
 const allBoardIds=[...new Set([...boardIds,...relatedBoards])];if(allBoardIds.length>100)partial.add('boards');
 const boards=(await store.boards.bulkGet(allBoardIds.slice(0,100))).filter(active);
 return financePage(config,{roots:roots.slice(0,200),records,boards,links,partialSources:[...partial]},context);
}
