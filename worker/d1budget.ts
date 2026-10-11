// Per-invocation binding-call budget, not a claim about upstream SQL-statement
// quota accounting. D1's batch is one binding request containing N statements;
// row billing, statement-size limits and execution time still apply to all N.
// Leave headroom below the documented D1 Free 50 read-subrequest allowance for
// other service calls. Incomplete durable work remains recoverable next tick.
const BUDGET=Symbol('invocation D1 binding budget');
type Budget={remaining:number;reserve:number;cleanup?:D1Database};
function budget(db:D1Database):Budget|undefined{return (db as D1Database&{[BUDGET]?:Budget})[BUDGET];}
export class D1BudgetExhausted extends Error {
  constructor(){super('D1 invocation budget reached; retry pending work');this.name='D1BudgetExhausted';}
}
export function d1BudgetRemaining(db:D1Database):number {const state=budget(db);return state?Math.max(0,state.remaining-state.reserve):Infinity;}
export function hasD1Budget(db:D1Database,minimum:number):boolean {return d1BudgetRemaining(db)>=minimum;}
export function d1CleanupDatabase(db:D1Database):D1Database{return budget(db)?.cleanup??db;}

export function withD1Budget<T extends {DB:D1Database}>(env:T,limit=45):T {
  if(budget(env.DB))return env;
  if(!Number.isInteger(limit)||limit<2)throw new Error('D1 binding budget must be at least two');
  const state:Budget={remaining:limit,reserve:Math.min(5,Math.max(1,Math.floor(limit/4)))},originals=new WeakMap<object,D1PreparedStatement>();
  const consume=(cleanup=false)=>{if(state.remaining<=(cleanup?0:state.reserve))throw new D1BudgetExhausted();state.remaining--;};
  const statement=(source:D1PreparedStatement,cleanup=false):D1PreparedStatement=>{
    const wrapped=new Proxy(source,{get(target,key){
      if(key==='bind')return (...values:Parameters<D1PreparedStatement['bind']>)=>statement(target.bind(...values),cleanup);
      const value=Reflect.get(target,key);
      if(['first','all','run','raw'].includes(String(key)))return (...args:unknown[])=>{consume(cleanup);return (value as (...args:unknown[])=>unknown).apply(target,args);};
      return typeof value==='function'?value.bind(target):value;
    }});originals.set(wrapped,source);return wrapped;
  };
  const session=(source:D1Database|D1DatabaseSession,cleanup=false)=>new Proxy(source,{get(target,key){
    if(key===BUDGET)return state;
    if(key==='prepare')return (sql:string)=>statement(target.prepare(sql),cleanup);
    if(key==='batch')return (statements:D1PreparedStatement[])=>{consume(cleanup);return target.batch(statements.map(s=>originals.get(s)??s));};
    const value=Reflect.get(target,key);
    if(key==='exec')return (...args:unknown[])=>{consume(cleanup);return (value as (...args:unknown[])=>unknown).apply(target,args);};
    if(key==='withSession')return (...args:unknown[])=>session((value as (...args:unknown[])=>D1DatabaseSession).apply(target,args),cleanup);
    return typeof value==='function'?value.bind(target):value;
  }});
  const db=session(env.DB) as D1Database;
  state.cleanup=session(env.DB,true) as D1Database;
  return {...env,DB:db};
}
