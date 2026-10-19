/** Shared online/offline prefix contract. No persistent result cache. */
export interface PaletteHit {id:string;type:string;title:string;url:string;snippet?:string|null;source:'local'|'server'}
export function prefixMatch(query:string,text:string):boolean {
 const words=(s:string)=>s.normalize('NFKD').replace(/\p{M}+/gu,'').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
 return words(query).every(t=>words(text).some(w=>t.length<2?w===t:w.startsWith(t)));
}
export function mergeSearch(local:PaletteHit[],server:PaletteHit[]):PaletteHit[]{const hits=new Map(local.map(h=>[h.id,h]));for(const h of server)hits.set(h.id,h);return [...hits.values()];}
/** Each query/account/access epoch owns its responses; invalidation is synchronous. */
export class SearchEpoch {private version=0;begin(){return ++this.version;}current(v:number){return v===this.version;}invalidate(){this.version++;}}
