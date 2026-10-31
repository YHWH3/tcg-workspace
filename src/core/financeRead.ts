import {api,ApiError} from './api';
import type {FinanceConfig} from '../../shared/financeConfig';
import type {FinancePage} from '../../shared/financePage';
/** Only an explicit changed-read conflict gets one retry in the current context. */
export async function readServerFinance(config:FinanceConfig,current:()=>boolean){
 const read=()=>api<{pages:[FinancePage]}>('/api/finance',{method:'POST',body:[config]}).then(r=>r.pages[0]);
 try{return await read();}catch(error){if(!(error instanceof ApiError)||error.status!==409||error.message!=='finance_sources_changed'||!current())throw error;return read();}
}
