import {fieldsOf} from './fields';
/** Inputs have already passed the account's current read boundary. No title inference. */
export interface HandoffRecord {id:string;boardId?:unknown;title?:unknown;deleted?:unknown;archived?:unknown}
export interface HandoffBoard {id:string;templateDbKey?:unknown;fields?:unknown;deleted?:unknown;archived?:unknown}
export interface HandoffLink {id:string;kind?:unknown;fieldId?:unknown;fromId?:unknown;toId?:unknown;deleted?:unknown}
export interface IdeaHandoff {direction:'to_project'|'from_idea';id:string;databaseId:string;title:string}
export function ideaHandoffs(record:HandoffRecord,boards:readonly HandoffBoard[],records:readonly HandoffRecord[],links:readonly HandoffLink[]):IdeaHandoff[]{
 if(record.deleted||record.archived)return [];
 const activeBoards=new Map(boards.filter(b=>!b.deleted&&!b.archived).map(b=>[b.id,b]));
 const activeRecords=new Map(records.filter(r=>!r.deleted&&!r.archived).map(r=>[r.id,r]));
 const result=new Map<string,IdeaHandoff>();
 for(const link of links){
  if(link.deleted||link.kind!=='relation'||link.fieldId!=='f_converted_project'||(link.fromId!==record.id&&link.toId!==record.id))continue;
  const idea=activeRecords.get(String(link.fromId)),project=activeRecords.get(String(link.toId));
  if(!idea||!project)continue;
  const source=activeBoards.get(String(idea.boardId)),target=activeBoards.get(String(project.boardId));
  const field=fieldsOf(source).find(f=>f.id==='f_converted_project');
  if(source?.templateDbKey!=='ideas'||target?.templateDbKey!=='projects'||field?.type!=='relation'||field.relation?.primary!==true||field.relation.target!==target.id)continue;
  const peer=idea.id===record.id?project:idea;
  result.set(peer.id,{direction:idea.id===record.id?'to_project':'from_idea',id:peer.id,databaseId:String(peer.boardId),title:String(peer.title??'Untitled')});
 }
 return [...result.values()].sort((a,b)=>a.id.localeCompare(b.id));
}
