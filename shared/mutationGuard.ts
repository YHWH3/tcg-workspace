/** Restriction-only precondition for additive client upgrades. No authority is
 * conveyed: normal session, permission and LWW checks still apply. */
export type MutationGuard={absent:true}|{fields:Record<string,unknown>};
function canonical(value:unknown):string{
 if(value===undefined||value===null)return 'null';
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value);
}
export function validMutationGuard(value:unknown):value is MutationGuard{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>;
 return Object.keys(v).length===1&&(v.absent===true||!!v.fields&&typeof v.fields==='object'&&!Array.isArray(v.fields)&&Object.keys(v.fields).length>0&&Object.keys(v.fields).length<=20)&&JSON.stringify(value).length<=65536;
}
export function mutationGuardMatches(guard:MutationGuard,current:Record<string,unknown>|null):boolean{
 if('absent' in guard)return current===null;
 return current!==null&&Object.entries(guard.fields).every(([key,value])=>canonical(current[key])===canonical(value));
}
export function exactGuardedReplay(patch:Record<string,unknown>,ts:number,current:Record<string,unknown>|null,fieldTs:Record<string,number>):boolean{
 return current!==null&&Object.keys(patch).length>0&&Object.entries(patch).every(([key,value])=>fieldTs[key]===ts&&canonical(current[key])===canonical(value));
}
