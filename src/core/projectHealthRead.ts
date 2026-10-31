import {api,ApiError} from './api';
import type {ProjectHealthConfig} from '../../shared/projectHealthConfig';
import type {ProjectHealthPage} from '../../shared/projectHealth';

/** Recover one explicitly changed read snapshot, within the same account and
 * access generation. Network/auth/server failures and repeated races surface. */
export async function readServerProjectHealth(config:ProjectHealthConfig,current:()=>boolean){
 const read=()=>api<{pages:[ProjectHealthPage]}>('/api/project-health',{method:'POST',body:[config]}).then(r=>r.pages[0]);
 try{return await read();}
 catch(error){
  if(!(error instanceof ApiError)||error.status!==409||error.message!=='project_sources_changed'||!current())throw error;
  return read();
 }
}
