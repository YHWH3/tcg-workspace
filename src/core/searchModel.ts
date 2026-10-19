import {scopeResolver,type ScopeRecord} from '../../shared/recordScope';
/** Shared online/offline prefix contract. No persistent result cache. */
export interface PaletteHit {id:string;type:string;title:string;url:string;snippet?:string|null;source:'local'|'server'}
export function prefixMatch(query:string,text:string):boolean {
 const words=(s:string)=>s.normalize('NFKD').replace(/\p{M}+/gu,'').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
 return words(query).every(t=>words(text).some(w=>t.length<2?w===t:w.startsWith(t)));
}
export function mergeSearch(local:PaletteHit[],server:PaletteHit[]):PaletteHit[]{const hits=new Map(local.map(h=>[h.id,h]));for(const h of server)hits.set(h.id,h);return [...hits.values()];}
/** Each query/account/access epoch owns its responses; invalidation is synchronous. */
export class SearchEpoch {private version=0;begin(){return ++this.version;}current(v:number){return v===this.version;}invalidate(){this.version++;}}

/** A bounded cache sample may lack an ancestor. Hide that result rather than
 * guess. Scope semantics stay shared with the server; archives are excluded
 * from this search graph so their descendants are not searchable either. */
export function localSearchVisibility(rows:readonly ScopeRecord[]){
 const graph=new Map(rows.filter(r=>!r.data.archived).map(r=>[r.id,r]));
 const resolve=scopeResolver(graph);
 return (id:string)=>{try{const row=graph.get(id),scope=resolve(id);return !!row&&!row.data.deleted&&!scope.ancestorDeleted&&!scope.serviceOnly;}catch{return false;}};
}
