import type {FormOperationsFailure} from './formOperations';
export type RecoveryState='automatic'|'stopped'|'blocked';
export type HealthErrorClass='attempt_limit'|'processing_budget'|'unknown';
/** Only known server messages are classified. Arbitrary exception text never leaves the journal. */
export function healthErrorClass(value:string|null):HealthErrorClass{
 if(value==='execution attempt limit reached')return 'attempt_limit';
 if(value==='D1 invocation budget reached; retry pending work')return 'processing_budget';
 return 'unknown';
}
export function recoveryLabel(state:RecoveryState,attempts:number):string{
 return state==='automatic'?'Will retry automatically':state==='stopped'?(attempts>=8?'Gave up after 8 attempts':'Stopped; review required'):'Recovery data unavailable; review required';
}
export interface AutomationHealthReport{
 asOf:number;
 automations:{id:string;name:string;databaseId:string|null;failedCount:number;lastFailedAt:number;lastRunId:string;attempts:number;retryAt:number;recovery:RecoveryState;errorClass:HealthErrorClass}[];
 events:{id:string;createdAt:number;attempts:number;recovery:RecoveryState;errorClass:HealthErrorClass;sources:{id:string;title:string;url:string|null}[]}[];
 forms:{id:string;title:string;databaseId:string;databaseName:string;failed7Days:number;failed30Days:number;failures:FormOperationsFailure[]}[];
 approvals:{id:string;targetId:string;title:string;createdAt:number;url:string|null}[];
 partial:{automations:boolean;events:boolean;forms:boolean;failures:boolean;approvals:boolean};
 scheduler:{available:false;reason:'not_recorded'};
}
