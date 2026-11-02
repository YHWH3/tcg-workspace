import {isDone} from './boardModel';
import {parseDateOnly} from './dates';
import type {MutationGuard} from './mutationGuard';
/** Current record/board, not a retained dashboard, owns mutation preconditions. */
export function planCommitmentEdit(record:Record<string,unknown>,board:{id:string;columns?:unknown;deleted?:unknown;archived?:unknown},value:{ownerId:string|null;date:string|null}){
 if(record.boardId!==board.id||record.deleted||record.archived||board.deleted||board.archived||isDone(record,board))throw new Error('This action changed. Reopen it before editing.');
 if(value.date!==null&&!parseDateOnly(value.date))throw new Error('Choose a valid due date.');
 const fields=Object.fromEntries(['boardId','status','deleted','archived','assigneeId','dueDate'].map(key=>[key,record[key]??null])),patch:Record<string,unknown>={};
 if((record.assigneeId??null)!==value.ownerId)patch.assigneeId=value.ownerId;
 if((record.dueDate??null)!==value.date)patch.dueDate=value.date;
 return {patch,guard:{fields} as MutationGuard};
}
