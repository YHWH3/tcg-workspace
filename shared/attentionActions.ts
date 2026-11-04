import {attentionConfig,attentionDoneStage,datedAttentionKind,openAttentionRecord,type AttentionItem} from './attention';
import {taskBoardId} from './boardModel';
import {gateMatches,parseGate} from './approvals';
import type {MutationGuard} from './mutationGuard';
/** Recheck the current local source. A cached item supplies no arbitrary field or patch. */
export function planAttentionAction(item:AttentionItem,action:'assign_me'|'mark_done',record:Record<string,unknown>,board:Record<string,unknown>,userId:string,today:string){
 const config=attentionConfig(board);
 if(!item.actions.includes(action)||item.restricted||item.targetType!=='record'||item.targetId!==record.id||item.databaseId!==board.id||taskBoardId(record)!==board.id||!config?.enabled||!openAttentionRecord(record,board))throw new Error('This item changed. Refresh attention and try again.');
 const fields:Record<string,unknown>={boardId:record.boardId??null,status:record.status??null,deleted:record.deleted??null,archived:record.archived??null,[config.personKey]:record[config.personKey]??null};
 let patch:Record<string,unknown>;
 if(action==='assign_me'){
  if(item.kind!=='record_unassigned'||!config.triage||item.personKey!==config.personKey||record[config.personKey]!=null&&record[config.personKey]!=='')throw new Error('This item has already been assigned or reconfigured.');
  patch={[config.personKey]:userId};
 }else{
  const stage=attentionDoneStage(board);
  if(!stage||record[config.personKey]!==userId||!config.dateKey||datedAttentionKind(record[config.dateKey],today,config.soonDays)!==item.kind)throw new Error('This item changed. Open it to review its current state.');
  fields[config.dateKey]=record[config.dateKey]??null;patch={status:stage};
 }
 const gate=parseGate(board);
 return {patch,guard:{fields} as MutationGuard,gateStage:gateMatches(gate,patch.status)?gate.stageId:null};
}
