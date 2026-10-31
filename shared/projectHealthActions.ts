import {projectHealthFieldsAvailable,type ProjectHealthConfig} from './projectHealthConfig';
import {parseDateOnly} from './dates';
import type {MutationGuard} from './mutationGuard';

/** Restriction-only edit plan. Normal mutate/applyChanges retains authority. */
export function planProjectHealthEdit(record:Record<string,unknown>,board:Record<string,unknown>,config:ProjectHealthConfig,values:{ownerId:string|null;start:string|null;end:string|null}){
 if(record.deleted||record.archived||board.deleted||board.archived||record.boardId!==board.id||config.databaseId&&record.boardId!==config.databaseId||config.projectId&&config.projectId!=='self'&&record.id!==config.projectId)throw new Error('Project changed. Reopen it before editing.');
 if(!projectHealthFieldsAvailable(board,config))throw new Error('Project fields changed. Review the health configuration.');
 const proposed={[config.ownerKey]:values.ownerId,[config.startKey]:values.start,[config.endKey]:values.end};
 const patch=Object.fromEntries(Object.entries(proposed).filter(([key,value])=>(record[key]??null)!==value));
 for(const key of [config.startKey,config.endKey])if(key in patch&&patch[key]!==null&&!parseDateOnly(patch[key]))throw new Error('Choose valid start and end dates.');
 if((config.startKey in patch||config.endKey in patch)&&values.start&&values.end&&values.start>values.end)throw new Error('End date must be on or after the start date.');
 const before=Object.fromEntries(Object.keys(patch).map(k=>[k,record[k]??null]));
 const scope={boardId:record.boardId,deleted:record.deleted??null,archived:record.archived??null,parentId:record.parentId??null};
 return {patch,before,guard:{fields:{...scope,...before}} as MutationGuard,undoGuard:{fields:{...scope,...patch}} as MutationGuard};
}
