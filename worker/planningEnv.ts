import type {Env} from './auth';
import type {PreviewOp} from './aiPreviews';
/** The existing canonical planner may read D1, but cannot persist during review planning. */
export function planningEnv(env:Env,ops:PreviewOp[],expected:Map<string,number>):Env {
  const originals=new WeakMap<object,D1PreparedStatement>();
  const statements=new WeakMap<object,string>();
  const readOnly=(sql:string)=>{if(!/^\s*(SELECT|WITH\b)/i.test(sql)||/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql))throw new Error('This operation requires its dedicated Workspace review flow');};
  const wrap=(source:D1PreparedStatement,sql:string):D1PreparedStatement=>{
    const wrapped=new Proxy(source,{get(target,key){
      if(key==='bind')return(...values:Parameters<D1PreparedStatement['bind']>)=>wrap(target.bind(...values),sql);
      const value=Reflect.get(target,key);
      if(['run','all','first','raw'].includes(String(key)))return(...args:unknown[])=>{readOnly(sql);return (value as (...a:unknown[])=>unknown).apply(target,args);};
      return typeof value==='function'?value.bind(target):value;
    }});originals.set(wrapped,source);statements.set(wrapped,sql);return wrapped;
  };
  const db=new Proxy(env.DB,{get(target,key){
    if(key==='prepare')return(sql:string)=>{const stmt=wrap(target.prepare(sql),sql);statements.set(stmt,sql);return stmt;};
    if(key==='batch')return(stmts:D1PreparedStatement[])=>{for(const stmt of stmts){const sql=statements.get(stmt);if(sql===undefined)throw new Error('unsupported planning batch');readOnly(sql);}return target.batch(stmts.map(s=>originals.get(s)??s));};
    if(key==='exec'||key==='withSession')return()=>{throw new Error('unsupported planning operation');};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const planned={...env,DB:db,MCP_PLAN:{ops,expected}};return {...planned,SERVICE_ENV:{...planned,READ_GATE:undefined}};
}
