// Observe every actual D1 binding/statement and returned local row metadata.
export function reviewMeter(db:D1Database){
 const metrics={bindings:0,statements:0,rowsRead:0,rowsWritten:0};
 const originals=new WeakMap<object,D1PreparedStatement>();
 const observe=(r:D1Result)=>{metrics.rowsRead+=r.meta.rows_read??0;metrics.rowsWritten+=r.meta.rows_written??0;};
 const wrap=(s:D1PreparedStatement):D1PreparedStatement=>{const proxy=new Proxy(s,{get(t,k){
  if(k==='bind')return(...v:Parameters<D1PreparedStatement['bind']>)=>wrap(t.bind(...v));
  if(k==='all'||k==='run')return async()=>{metrics.bindings++;metrics.statements++;const r=await t[k]();observe(r);return r;};
  if(k==='first')return async(column?:string)=>{metrics.bindings++;metrics.statements++;const r=await t.all();observe(r);return column?r.results[0]?.[column]??null:r.results[0]??null;};
  const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;
 }});originals.set(proxy,s);return proxy;};
 return{metrics,db:new Proxy(db,{get(t,k){
  if(k==='prepare')return(sql:string)=>wrap(t.prepare(sql));
  if(k==='batch')return async(stmts:D1PreparedStatement[])=>{metrics.bindings++;metrics.statements+=stmts.length;const r=await t.batch(stmts.map(s=>originals.get(s)??s));r.forEach(observe);return r;};
  const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;
 }})};
}
