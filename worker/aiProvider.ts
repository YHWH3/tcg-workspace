/** Optional provider boundary. Units are conservative UTF-8 input bytes plus
 * reserved output tokens, not Cloudflare billing units or a free-tier promise. */
import type {Env} from './auth';
export interface EmbeddingProvider {id:string;modelId:string;dimensions:number;embed(texts:string[]):Promise<number[][]>}
export const EMBEDDING_MODEL='@cf/baai/bge-small-en-v1.5' as const;
export function embeddingProvider(env:Env):EmbeddingProvider|null {
 if(env.AI_PROVIDER!=='workers-ai'||!env.AI||!(Number(env.AI_DAILY_UNITS)>0))return null;
 return {id:'workers-ai',modelId:EMBEDDING_MODEL,dimensions:384,async embed(texts){
  if(!texts.length||texts.length>10||texts.some(t=>new TextEncoder().encode(t).length>1800))throw new Error('embedding_input_budget');
  const result=await env.AI.run(EMBEDDING_MODEL,{text:texts});
  if(!result||!('data' in result)||!Array.isArray(result.data)||result.data.length!==texts.length||result.data.some(v=>v.length!==384||v.some(n=>!Number.isFinite(n))))throw new Error('embedding_shape_invalid');
  return result.data;
 }};
}
export async function reserveAi(env:Pick<Env,'DB'|'AI_DAILY_UNITS'>,kind:string,units:number,background=false,userId?:string){
 const configured=Number(env.AI_DAILY_UNITS??0),limit=Math.floor(configured*(background?0.8:1));
 if(!Number.isSafeInteger(units)||units<1||!Number.isSafeInteger(limit)||limit<units)return false;
 const day=new Date().toISOString().slice(0,10);
 const r=await env.DB.prepare(`INSERT INTO ai_usage(day,kind,user_id,units) SELECT ?,?,?,? WHERE COALESCE((SELECT SUM(units) FROM ai_usage WHERE day=?),0)+?<=? AND (? IS NULL OR COALESCE((SELECT SUM(units) FROM ai_usage WHERE day=? AND user_id=?),0)+?<=?)
 ON CONFLICT(day,kind,user_id) DO UPDATE SET units=units+excluded.units`).bind(day,kind,userId??'workspace',units,day,units,limit,userId??null,day,userId??null,units,Math.floor(limit/2)).run();
 return r.meta.changes===1;
}
export const inputUnits=(texts:string[])=>texts.reduce((n,t)=>n+new TextEncoder().encode(t).length,0);
export function cosine(a:number[],b:number[]){if(a.length!==b.length)return -1;let dot=0,aa=0,bb=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}return aa&&bb?dot/Math.sqrt(aa*bb):-1;}
export function reciprocalRank(lists:string[][],k=60){const scores=new Map<string,number>();for(const ids of lists)ids.forEach((id,i)=>scores.set(id,(scores.get(id)??0)+1/(k+i+1)));return [...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([id])=>id);}
