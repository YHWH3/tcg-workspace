import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAuditFixture, ctx as ectx, type AuditFixture } from './audit-fixture';
import { aggregate, type Filter } from '../shared/views';
import { withD1Budget, d1BudgetRemaining } from '../worker/d1budget';

const schemas = vi.hoisted(() => new Map<string,{safeParse:(value:unknown)=>{success:boolean}}>());
const tools = vi.hoisted(() => new Map<string, (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>>());
vi.mock('@modelcontextprotocol/server', () => ({ McpServer: class { registerTool(name: string, meta: {inputSchema:{safeParse:(value:unknown)=>{success:boolean}}}, fn: never) { tools.set(name, fn); schemas.set(name,meta.inputSchema); } registerPrompt() {} registerResource() {} }, ResourceTemplate: class {} }));
vi.mock('agents/mcp/server', () => ({ createMcpHandler: vi.fn() }));
vi.mock('../worker/events', async original => ({ ...(await original<typeof import('../worker/events')>()), scheduleOutbox: vi.fn() }));
vi.mock('../shared/recurrence', async original => ({ ...(await original<typeof import('../shared/recurrence')>()), todayUtc: () => '2026-10-24' }));
import { createWorkspaceServer } from '../worker/mcp';

let fx: AuditFixture | undefined;
afterEach(async () => { await fx?.dispose(); fx = undefined; });

async function setup(enabled: boolean) {
  fx = await openAuditFixture([{ id: 'alice', role: 'admin' }, { id: 'bob' }]);
  const rows = [
    { id: 'near', title: 'Near', p_deadline: '2026-10-30', createdAt:Date.parse('2026-10-24T00:00Z'), status: 'open' },
    { id: 'next', title: 'Boundary', p_deadline: '2026-11-23', createdAt:Date.parse('2026-10-25T23:59Z'), status: 'open' },
    { id: 'distant', title: 'Distant', p_deadline: '2099-01-01', createdAt:Date.parse('2026-10-23T23:59Z'), status: 'open' },
    { id: 'won', title: 'Won', p_deadline: '2026-10-30', createdAt:Date.parse('2026-10-24T12:00Z'), status: 'won' },
  ];
  const data = [
    { id: 'opportunities', collection: 'boards', data: { name: 'Opportunities', kind: 'records', columns: [{ id: 'open', name: 'Open' }, { id: 'won', name: 'Won' }], fields: [{ id: 'deadline', name: 'Deadline', type: 'date' }] } },
    { id: 'existing-view', collection: 'views', data: { databaseId: 'opportunities', name: 'Existing', type: 'table', config: {}, order: 'a0' } },
    ...rows.map(row => ({ id: row.id, collection: 'tasks', data: { ...row, boardId: 'opportunities' } })),
  ];
  await fx.db.batch(data.map((row, i) => fx!.db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES(?,?,?,'{}',?,'space-core')").bind(row.id, row.collection, JSON.stringify(row.data), i + 1)));
  await fx.db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(enabled ? 1 : 0).run();
  return rows;
}

async function call(name: string, args: Record<string, unknown>, userId = 'alice') {
  const env = withD1Budget(fx!.env, 45);
  createWorkspaceServer({ env, ectx, userId, userRole: userId === 'alice' ? 'admin' : 'member', origin: 'http://localhost', userByKey: new Map(), userNameById: new Map(), pageTitleById: new Map(), recordTitleById: new Map(), recordIdByTitle: new Map(), pageIdByTitle: new Map(), cachesReady: false, warnings: [], cs: null, toolName: '' } as never);
  const output = await tools.get(name)!(args);
  expect(45 - d1BudgetRemaining(env.DB), name + ' binding calls').toBeLessThanOrEqual(45);
  return { ...output, json: JSON.parse(output.content[0].text) };
}

describe.each([false,true])('Phase 7 MCP date filters, permissions enabled=%s',enabled=>{
 it('uses the same inclusive within ids as metrics, sorted and paged',async()=>{
  const rows=await setup(enabled),filters:Filter[]=[{key:'p_deadline',op:'within',value:{from:'today',to:'today+30'}},{key:'status',op:'is_not',value:'won'}];
  const expected=aggregate(rows,{agg:'count',filters},{today:'2026-10-24'}).ids;expect(expected).toEqual(['near','next']);
  for(const sorts of [undefined,[{field:'createdAt',dir:'asc'}]]){
   const named=filters.map(f=>({field:f.key==='p_deadline'?'Deadline':f.key,op:f.op,value:f.value}));
   const ids:string[]=[];let cursor:unknown;
   for(let page=0;page<4;page++){
    const r=await call('query_records',{databaseId:'opportunities',filters:named,sorts,limit:1,...(cursor?{cursor}:{})});
    expect(r.isError,JSON.stringify(r.json)).not.toBe(true);ids.push(...r.json.rows.map((row:{id:string})=>row.id));
    if(!r.json.hasMore)break;cursor=r.json.nextCursor;
   }
   expect(ids.sort()).toEqual([...expected].sort());
  }
 });
 it('compares createdAt milliseconds with dates through the actual MCP read path',async()=>{
  await setup(enabled);
  const filters=[{field:'createdAt',op:'within',value:{from:'2026-10-24',to:'2026-10-25'}},{field:'status',op:'is_not',value:'won'}];
  const r=await call('query_records',{databaseId:'opportunities',filters,sorts:[{field:'createdAt',dir:'asc'}]});
  expect(r.isError,JSON.stringify(r.json)).not.toBe(true);expect(r.json.rows.map((row:{id:string})=>row.id)).toEqual(['near','next']);
 });
 it('persists a valid view range and refuses malformed ranges without overwriting it',async()=>{
  await setup(enabled);
  const filters=[{field:'Deadline',op:'within',value:{from:'today',to:'today+30'}}];
  const updated=await call('update_view',{viewId:'existing-view',filters});expect(updated.isError,JSON.stringify(updated.json)).not.toBe(true);
  const before=await fx!.db.prepare("SELECT data FROM records WHERE id='existing-view'").first<string>('data');
  expect(JSON.parse(before!).config.filters[0]).toEqual({key:'p_deadline',op:'within',value:filters[0].value});
  for(const value of [null,[],{}, {from:'today'}, {from:'today',to:'Today+3'}, {from:'2026-10-25',to:'2026-10-24'}]){
   const invalid=[{field:'Deadline',op:'within',value}];
   for(const [name,args] of [['update_view',{viewId:'existing-view',filters:invalid}],['add_view',{databaseId:'opportunities',name:'Invalid',filters:invalid}],['query_records',{databaseId:'opportunities',filters:invalid}]] as const){
    const r=await call(name,args);expect(r.isError,name+JSON.stringify(value)).toBe(true);
   }
  }
  expect(await fx!.db.prepare("SELECT data FROM records WHERE id='existing-view'").first('data')).toBe(before);
  expect(schemas.get('query_records')!.safeParse({databaseId:'opportunities',filters:[{field:'Deadline',op:'within',value:filters[0].value}]}).success).toBe(true);
  expect(schemas.get('query_records')!.safeParse({databaseId:'opportunities',filters:[{field:'Deadline',op:'unsupported'}]}).success).toBe(false);
 });
});
