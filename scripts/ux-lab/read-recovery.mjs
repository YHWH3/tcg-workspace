// A WebKit console diagnostic is not proof of recovery. Whitelist only bounded
// read routes, then require a new authenticated response in the actual browser.
export function diagnosticReadUrl(stack,origin){
 const match=stack?.match(/^Fetch API cannot load (https:\/\/[^ ]+\/api\/(?:access|notifications\/badge|approvals|sync\/pull|workspace\/settings)(?:\?[^ ]*)?) due to access control checks\./);
 if(!match)return null;
 try{return new URL(match[1]).origin===origin?match[1]:null;}catch{return null;}
}
/** Self-contained for Playwright evaluate; also exercised with refusal controls. */
export async function readRecoveryInBrowser(url){
 if(!navigator.onLine)return {online:false,status:0};
 try{
  const headers={Authorization:'Bearer '+localStorage.getItem('ws_token')};
  const path=new URL(url).pathname;
  if(!['/api/access','/api/notifications/badge','/api/approvals','/api/sync/pull','/api/workspace/settings'].includes(path))return {online:true,status:0};
  if(path==='/api/sync/pull'){
   const response=await fetch('/api/access',{headers});if(!response.ok)return {online:true,status:response.status};
   const manifest=await response.json();if(manifest.protocol!==3||!Array.isArray(manifest.spaces))return {online:true,status:0};
   const body={protocol:3,etag:manifest.etag,cursor:0,joining:manifest.spaces.map(s=>({space:s.id,after:0,base:0})),limit:8};
   return {online:true,status:(await fetch(url,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)})).status};
  }
  const response=await fetch(url,{headers});if(!response.ok)return {online:true,status:response.status};
  if(path==='/api/workspace/settings'){
   const {settings:s}=await response.json();
   if(!s||typeof s.timeZone!=='string'||!Intl.supportedValuesOf('currency').includes(s.currency)||!Number.isInteger(s.weekStart)||s.weekStart<0||s.weekStart>6||!Number.isSafeInteger(s.version)||s.version<1)return {online:true,status:0};
   new Intl.DateTimeFormat('en',{timeZone:s.timeZone}).format(0);
  }
  return {online:true,status:response.status};
 }catch{return {online:true,status:0};}
}
