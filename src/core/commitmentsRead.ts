import {api,ApiError} from './api';
import type {CommitmentsConfig} from '../../shared/commitmentsConfig';
import type {CommitmentsPage} from '../../shared/commitments';
/** Only an explicit source-revision conflict gets one current-context retry. */
export async function readServerCommitments(config:CommitmentsConfig,current:()=>boolean){
 const read=()=>api<{pages:[CommitmentsPage]}>('/api/commitments',{method:'POST',body:[config]}).then(reply=>reply.pages[0]);
 try{return await read();}catch(error){if(!(error instanceof ApiError)||error.status!==409||error.message!=='commitment_sources_changed'||!current())throw error;return read();}
}
