import {createStore} from './store';
/** Runtime activity is never a persisted uploading state that can get stuck. */
export const uploadActivity=createStore<{userId:string|null;ids:readonly string[]}>({userId:null,ids:[]});
export function setUploading(userId:string,id:string,active:boolean){
 uploadActivity.set(s=>{if(!active&&s.userId!==userId)return s;const ids=new Set(s.userId===userId?s.ids:[]);if(active)ids.add(id);else ids.delete(id);return {userId,ids:[...ids]};});
}
