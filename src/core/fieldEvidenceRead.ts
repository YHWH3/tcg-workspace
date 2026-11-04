import {api,ApiError} from './api';
import type {FieldEvidenceConfig} from '../../shared/fieldEvidenceConfig';
import type {FieldEvidencePage} from '../../shared/fieldEvidence';
/** One retry only for an explicit source revision race in the current context. */
export async function readServerFieldEvidence(config:FieldEvidenceConfig,current:()=>boolean){
 const read=()=>api<{pages:[FieldEvidencePage]}>('/api/field-evidence',{method:'POST',body:[config]}).then(r=>r.pages[0]);
 try{return await read();}catch(error){if(!(error instanceof ApiError)||error.status!==409||error.message!=='field_evidence_sources_changed'||!current())throw error;return read();}
}
