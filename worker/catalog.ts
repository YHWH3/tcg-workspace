import {Hono} from 'hono';
import {requireAuth,type AuthUser,type Env} from './auth';
import {createReadGate} from './readAccess';
import {levelSql} from './capability';
/** Bounded root/archive browsing. The cursor advances over examined candidates,
 * while only the current read gate may publish their content. */
export const catalogApi=new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();catalogApi.use('*',requireAuth);
catalogApi.get('/',async c=>{const uid=c.get('user').id,space=c.req.query('space')??'',after=c.req.query('after')??'',archived=c.req.query('archived')==='1';if(space.length>64||after.length>64)return c.json({error:'invalid_request'},400);
 const {results}=await c.env.DB.prepare(`SELECT r.id,r.collection,r.data,r.seq FROM records r WHERE r.id>? AND (?='' OR r.space_id=?) AND r.collection IN ('pages','boards','moodboards'${archived?",'tasks'":''}) AND COALESCE(json_extract(r.data,'$.deleted'),0)!=1 AND COALESCE(json_extract(r.data,'$.archived'),0)=? ${archived?'':"AND (r.collection!='pages' OR json_extract(r.data,'$.parentId') IS NULL)"} AND ((SELECT enabled FROM access_state WHERE id=1)=0 OR ${levelSql('?','r.space_id')}>=1) ORDER BY r.id LIMIT 101`).bind(after,space,space,archived?1:0,uid).all<{id:string;collection:string;data:string;seq:number}>();
 const rows=results.slice(0,100).map(r=>({...r,rev:r.seq})),visible=await createReadGate(c.env.DB,uid).filter(rows);
 return c.json({items:visible.map(r=>{const d=JSON.parse(r.data);return{id:r.id,type:r.collection,title:String(d.title??d.name??'Untitled'),revision:r.rev,url:r.collection==='tasks'?`/tasks/${r.id}`:`/${r.collection}/${r.id}`};}),next:results.length>100?rows[rows.length-1].id:null});});
