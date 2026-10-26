/** Workspace-wide calendar and display rules. Server-only persistence. */
export interface WorkspaceSettings {
 timeZone:string; currency:string; weekStart:number; version:number; updatedAt:number;
}
export const DEFAULT_WORKSPACE_SETTINGS:WorkspaceSettings={timeZone:'UTC',currency:'INR',weekStart:1,version:1,updatedAt:0};
export function validTimeZone(value:unknown):value is string {
 if(typeof value!=='string'||!value||value.length>100)return false;
 try {new Intl.DateTimeFormat('en',{timeZone:value}).format(0);return true;}catch{return false;}
}
export function validCurrency(value:unknown):value is string {
 if(typeof value!=='string'||!/^[A-Z]{3}$/.test(value))return false;
 // NumberFormat accepts arbitrary three-letter strings. Validate the actual
 // supported ISO codes as well; never turn an invalid code into another code.
 return Intl.supportedValuesOf('currency').includes(value);
}
