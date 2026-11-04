import {parseDateOnly} from './dates';
import {WEBSITE_INBOX_ID} from './websiteInbox';
import type {MutationGuard} from './mutationGuard';

/** A cached row is only a restriction. mutate/applyChanges still decide authority. */
export function planWebsiteChange(row:Record<string,unknown>,patch:Record<string,unknown>){
 if(row.boardId!==WEBSITE_INBOX_ID||row.deleted||row.archived||row.parentId)throw new Error('This submission is no longer available. Refresh the response desk.');
 if(!Object.keys(patch).length||Object.keys(patch).some(k=>!['assigneeId','dueDate','status'].includes(k)))throw new Error('Unsupported response change.');
 if('status' in patch&&!['new','in_review','replied','done'].includes(String(patch.status)))throw new Error('Choose a response status.');
 if('dueDate' in patch&&patch.dueDate!==null&&!parseDateOnly(patch.dueDate))throw new Error('Choose a valid follow-up date.');
 if('assigneeId' in patch&&patch.assigneeId!==null&&(typeof patch.assigneeId!=='string'||!patch.assigneeId))throw new Error('Choose an active owner.');
 const before=Object.fromEntries(Object.keys(patch).map(k=>[k,row[k]??null]));
 const context={boardId:WEBSITE_INBOX_ID,deleted:row.deleted??null,archived:row.archived??null,parentId:row.parentId??null};
 return {patch,before,guard:{fields:{...context,...before}} as MutationGuard,undoGuard:{fields:{...context,...patch}} as MutationGuard};
}
