import {api,ApiError} from './api';
import type {EventOpsConfig} from '../../shared/eventOpsConfig';
import type {EventOpsPage} from '../../shared/eventOps';
/** Only an explicit source-revision conflict gets one current-context retry. */
export async function readServerEventOps(config:EventOpsConfig,current:()=>boolean){
 const read=()=>api<{pages:[EventOpsPage]}>('/api/event-ops',{method:'POST',body:[config]}).then(reply=>reply.pages[0]);
 try{return await read();}catch(error){if(!(error instanceof ApiError)||error.status!==409||error.message!=='event_sources_changed'||!current())throw error;return read();}
}
