/** Indexed metadata from this account only. Never claims server completeness. */
import type {LocalDB,LocalRow} from './db';
import {fieldEvidencePage,type FieldEvidenceLink,type FieldEvidenceFile} from '../../shared/fieldEvidence';
import type {FieldEvidenceConfig} from '../../shared/fieldEvidenceConfig';
export async function readLocalFieldEvidence(store:Pick<LocalDB,'tasks'|'boards'|'links'|'files'>,config:FieldEvidenceConfig,now:number){
 const active=(r:LocalRow|undefined):r is LocalRow=>!!r&&!r.deleted&&!r.archived,partial=new Set(['device_snapshot']);
 const candidates=await store.tasks.where('boardId').equals(config.databaseId).and(r=>active(r)&&!r.parentId).limit(201).toArray();
 if(candidates.length>200)partial.add('records');const logs=candidates.slice(0,200),ids=logs.map(r=>r.id);
 const rawLinks=ids.length?await store.links.where('fromId').anyOf(ids).or('toId').anyOf(ids).and(r=>active(r)&&r.kind==='relation').limit(1001).toArray():[];
 if(rawLinks.length>1000)partial.add('relations');
 const links:FieldEvidenceLink[]=rawLinks.slice(0,1000).flatMap(r=>typeof r.fromId==='string'&&typeof r.toId==='string'&&typeof r.fieldId==='string'?[{id:r.id,kind:'relation',fieldId:r.fieldId,fromId:r.fromId,toId:r.toId}]:[]);
 if(links.length<Math.min(rawLinks.length,1000))partial.add('relation_configuration');
 const peers=[...new Set(links.flatMap(l=>[l.fromId,l.toId]))];if(peers.length>1000)partial.add('targets');
 const targets=(await store.tasks.bulkGet(peers.slice(0,1000))).filter(active),boards=(await store.boards.bulkGet([config.databaseId])).filter(active);
 const rawFiles=ids.length?await store.files.where('parentId').anyOf(ids).and(r=>active(r)&&r.parentType==='task').limit(401).toArray():[];
 if(rawFiles.length>400)partial.add('files');
 const files:FieldEvidenceFile[]=rawFiles.slice(0,400).flatMap(r=>typeof r.parentId==='string'&&typeof r.kind==='string'?[{id:r.id,parentId:r.parentId,kind:r.kind}]:[]);
 if(files.length<Math.min(rawFiles.length,400))partial.add('file_configuration');
 return fieldEvidencePage(config,{logs,targets,boards,links,files,partialSources:[...partial]},now);
}
