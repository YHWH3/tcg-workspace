export type FieldGap='date'|'place'|'experiment_or_project'|'unit'|'observation'|'photo';
export interface FieldLogEntry {
 id:string;title:string;databaseId:string;url:string;date:string|null;measurement:number|null;unit:string;
 places:string[];experiments:string[];projects:string[];missing:FieldGap[];
 photoIntent:'planned'|'not_planned'|'unknown';
 photoEvidence:'available'|'unavailable'|'not_planned'|'unknown';issues:string[];
}
export interface FieldSession {key:string;date:string|null;places:string[];experiments:string[];recordIds:string[];missingCount:number;unknownPhotoCount:number}
/** Group only authorized normalized entries, by the exact visit tuple. */
export function groupSessions(fieldLogs:readonly FieldLogEntry[]):FieldSession[]{
 const sessions=new Map<string,FieldSession>();
 for(const log of fieldLogs){
  const places=[...log.places].sort(),experiments=[...log.experiments].sort(),key=JSON.stringify([log.date,places,experiments]);
  let session=sessions.get(key);
  if(!session){session={key,date:log.date,places,experiments,recordIds:[],missingCount:0,unknownPhotoCount:0};sessions.set(key,session);}
  session.recordIds.push(log.id);if(log.missing.length)session.missingCount++;if(log.photoEvidence==='unknown')session.unknownPhotoCount++;
 }
 return [...sessions.values()].map(s=>({...s,recordIds:s.recordIds.sort()})).sort((a,b)=>a.date!==b.date?(a.date===null?1:b.date===null?-1:a.date>b.date?-1:1):a.key<b.key?-1:a.key>b.key?1:0);
}
