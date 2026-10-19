import type {Env} from './auth';
import {embeddingProvider,reserveAi,inputUnits,cosine,reciprocalRank,type EmbeddingProvider} from './aiProvider';
import {argsHash} from '../shared/stablejson';
import {searchRecords,loadDocs,type SearchQuery} from './search';
import {withReadGate} from './readAccess';
import {levelSql} from './capability';
import {hasD1Budget} from './d1budget';
const small=(s:string)=>{const e=new TextEncoder();let out=s.slice(0,1500);while(e.encode(out).length>1700)out=out.slice(0,-1);return out;};
/** Same committed FTS document pipeline; no separate ingestion scan. Tests inject
 * a fake provider explicitly; the application never accepts a provider from HTTP. */
export async function processEmbeddings(env:Env,provider=embeddingProvider(env)){
 if(!provider)return {status:'disabled',processed:0};
 const lease=crypto.randomUUID(),now=Date.now();
 await env.DB.prepare(`UPDATE ai_embedding_dirty SET lease_id=?,lease_until=? WHERE doc_id IN(SELECT q.doc_id FROM ai_embedding_dirty q JOIN search_documents d ON d.doc_id=q.doc_id WHERE q.attempts<5 AND q.retry_at<=? AND COALESCE(q.lease_until,0)<? AND NOT EXISTS(SELECT 1 FROM search_dirty s WHERE s.doc_id=q.doc_id) ORDER BY q.retry_at,q.doc_id LIMIT 5)`).bind(lease,now+120000,now,now).run();
 const rows=(await env.DB.prepare(`SELECT q.doc_id,q.token,d.title,d.body,d.space_id FROM ai_embedding_dirty q JOIN search_documents d ON d.doc_id=q.doc_id WHERE q.lease_id=? AND d.source_rev=q.token ORDER BY q.doc_id`).bind(lease).all<{doc_id:string;token:number;title:string;body:string;space_id:string|null}>()).results;
 if(!rows.length)return {status:'idle',processed:0};
 let texts=rows.map(r=>small(r.title+'\n'+r.body));
 const hashes=await Promise.all(texts.map(text=>argsHash({text}))),existing=(await env.DB.prepare('SELECT doc_id,text_hash FROM ai_embeddings WHERE model_id=? AND dim=? AND doc_id IN(SELECT value FROM json_each(?))').bind(provider.modelId,provider.dimensions,JSON.stringify(rows.map(r=>r.doc_id))).all<{doc_id:string;text_hash:string}>()).results;
 const unchanged=rows.filter((r,i)=>existing.some(e=>e.doc_id===r.doc_id&&e.text_hash===hashes[i]));
 if(unchanged.length)await env.DB.batch(unchanged.flatMap(r=>[env.DB.prepare(`UPDATE ai_embeddings SET source_rev=?,space_id=?,updated_at=? WHERE doc_id=? AND EXISTS(SELECT 1 FROM ai_embedding_dirty WHERE doc_id=? AND token=? AND lease_id=?) AND NOT EXISTS(SELECT 1 FROM search_dirty WHERE doc_id=?)`).bind(r.token,r.space_id,now,r.doc_id,r.doc_id,r.token,lease,r.doc_id),env.DB.prepare('DELETE FROM ai_embedding_dirty WHERE doc_id=? AND token=? AND lease_id=? AND NOT EXISTS(SELECT 1 FROM search_dirty WHERE doc_id=?)').bind(r.doc_id,r.token,lease,r.doc_id)]));
 const pending=rows.filter(r=>!unchanged.includes(r));rows.splice(0,rows.length,...pending);texts=rows.map(r=>small(r.title+'\n'+r.body));
 if(!rows.length)return {status:'unchanged',processed:unchanged.length};
 if(!await reserveAi(env,'embeddings',inputUnits(texts),true)){await env.DB.prepare('UPDATE ai_embedding_dirty SET lease_id=NULL,lease_until=NULL WHERE lease_id=?').bind(lease).run();return {status:'budget_exhausted',processed:unchanged.length};}
 try{
  const vectors=await provider.embed(texts);
  if(vectors.length!==rows.length||vectors.some(v=>v.length!==provider.dimensions||v.some(x=>!Number.isFinite(x))))throw new Error('invalid_embedding');
  const statements:D1PreparedStatement[]=[];
  for(let i=0;i<rows.length;i++){
   const r=rows[i],hash=await argsHash({text:texts[i]});
   statements.push(env.DB.prepare(`INSERT INTO ai_embeddings(doc_id,space_id,model_id,text_hash,source_rev,dim,vec,updated_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ai_embedding_dirty q JOIN search_documents d ON d.doc_id=q.doc_id WHERE q.doc_id=? AND q.token=? AND q.lease_id=? AND d.source_rev=q.token) AND NOT EXISTS(SELECT 1 FROM search_dirty WHERE doc_id=?)
    ON CONFLICT(doc_id) DO UPDATE SET space_id=excluded.space_id,model_id=excluded.model_id,text_hash=excluded.text_hash,source_rev=excluded.source_rev,dim=excluded.dim,vec=excluded.vec,updated_at=excluded.updated_at`)
    .bind(r.doc_id,r.space_id,provider.modelId,hash,r.token,provider.dimensions,JSON.stringify(vectors[i]),Date.now(),r.doc_id,r.token,lease,r.doc_id),env.DB.prepare('DELETE FROM ai_embedding_dirty WHERE doc_id=? AND token=? AND lease_id=?').bind(r.doc_id,r.token,lease));
  }
  await env.DB.batch(statements);return {status:'processed',processed:rows.length};
 }catch{
  await env.DB.batch(rows.map(r=>env.DB.prepare('UPDATE ai_embedding_dirty SET attempts=attempts+1,retry_at=?,lease_id=NULL,lease_until=NULL WHERE doc_id=? AND token=? AND lease_id=?').bind(Date.now()+60000,r.doc_id,r.token,lease)));
  return {status:'provider_unavailable',processed:0};
 }
}
export async function hybridSearch(env:Env,userId:string,q:SearchQuery,mode:'keyword'|'semantic'|'hybrid'='keyword',provider:EmbeddingProvider|null=embeddingProvider(env)){
 const scopedEnv=withReadGate(env,userId);env=scopedEnv;
 const keyword=await searchRecords(env,userId,q);
 const fallback=async(semantic:string)=>await scopedEnv.READ_GATE!.validateObserved()?{...keyword,semantic,fallback:'keyword'}:{...keyword,results:[],semantic:'access_changed',fallback:'retry'};
 if(mode==='keyword')return {...keyword,semantic:'not_requested'};
 if(!provider)return fallback('disabled');
 if(q.cursor)return fallback('keyword_pagination');
 if(!hasD1Budget(env.DB,8))return fallback('budget_exhausted');
 if(!await reserveAi(env,'semantic_query',inputUnits([small(q.q)]),false,userId))return fallback('budget_exhausted');
 try{
  const vector=(await provider.embed([small(q.q)]))[0];if(!vector||vector.length!==provider.dimensions||vector.some(x=>!Number.isFinite(x)))throw new Error('invalid_embedding');
  const scoped=withReadGate(env,userId),enabled=await scoped.READ_GATE!.enabled();
  const filter=enabled?` AND ${levelSql('?', 'e.space_id')}>=1`:'';
  const connection=env.CONNECTOR?` AND e.space_id IN(SELECT value FROM ai_connections g,json_each(g.spaces_json) WHERE g.id=? AND g.user_id=? AND g.revoked_at IS NULL AND g.expires_at>?)`:'';
  const rows=(await env.DB.prepare(`SELECT e.doc_id,e.vec,d.title,d.collection,d.database_id,d.source_rev FROM ai_embeddings e JOIN search_documents d ON d.doc_id=e.doc_id AND d.source_rev=e.source_rev WHERE e.model_id=? AND e.dim=? AND NOT EXISTS(SELECT 1 FROM search_dirty s WHERE s.doc_id=e.doc_id)${filter}${connection}${q.databaseId?' AND d.database_id=?':''}${q.spaceId?' AND e.space_id=?':''} ORDER BY e.doc_id LIMIT 501`)
   .bind(provider.modelId,provider.dimensions,...(enabled?[userId]:[]),...(env.CONNECTOR?[env.CONNECTOR.id,userId,Date.now()]:[]),...(q.databaseId?[q.databaseId]:[]),...(q.spaceId?[q.spaceId]:[])).all<{doc_id:string;vec:string;title:string;collection:string;database_id:string|null;source_rev:number}>()).results;
  const live=await loadDocs(env.DB,rows.slice(0,500).map(r=>r.doc_id));
  const allowed=await scoped.READ_GATE!.filter(rows.slice(0,500).filter(r=>live.get(r.doc_id)?.rev===r.source_rev).map(r=>({id:r.doc_id,...r})));
  const types:Record<string,string>={pages:'page',tasks:'task',boards:'board',moodboards:'moodboard',comments:'comment',files:'file',mooditems:'mooditem'};
  const matches=allowed.filter(r=>!q.type||types[r.collection]===q.type).map(r=>({...r,similarity:cosine(vector,JSON.parse(r.vec))})).sort((a,b)=>b.similarity-a.similarity||a.doc_id.localeCompare(b.doc_id));
  const ids=mode==='hybrid'?reciprocalRank([keyword.results.map(r=>r.docId),matches.map(r=>r.doc_id)]):matches.map(r=>r.doc_id);
  const hits=new Map(keyword.results.map(r=>[r.docId,r]));
  for(const r of matches)if(!hits.has(r.doc_id))hits.set(r.doc_id,{docId:r.doc_id,title:live.get(r.doc_id)!.title,url:live.get(r.doc_id)!.url,type:types[r.collection] as typeof keyword.results[number]['type'],databaseId:r.database_id,rev:r.source_rev,snippet:null});
  const chosen=ids.slice(0,q.limit??20).map(id=>hits.get(id)!);
  if(!await scoped.READ_GATE!.validateObserved())return {...keyword,results:[],semantic:'access_changed',fallback:'retry'};
  return {...keyword,results:chosen,semantic:'available',boundedCandidateScan:true,semanticPagination:'first_page_only'};
 }catch{if(!await withReadGate(env,userId).READ_GATE!.validateObserved())return {...keyword,results:[],semantic:'access_changed',fallback:'retry'};return {...keyword,semantic:'unavailable',fallback:'keyword'};}
}
