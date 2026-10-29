import 'fake-indexeddb/auto';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {LocalDB} from '../src/core/db';
import {readLocalFinance} from '../src/core/financeLocal';
import {financeConfigSchema} from '../shared/financeConfig';
let db:LocalDB;
beforeEach(async()=>{db=new LocalDB('workspace-finance-'+crypto.randomUUID());await db.open();});
afterEach(async()=>{vi.restoreAllMocks();db.close();await db.delete();});
it('uses targeted device indexes and the same sums with explicit incomplete device evidence',async()=>{
 await db.boards.bulkPut([{id:'projects',_ts:{},fields:[{id:'f_budget',name:'Budget',type:'number'},{id:'f_transactions',name:'Transactions',type:'relation',relation:{target:'money',primary:false,pairedFieldId:'f_project'}}]},{id:'money',_ts:{},fields:[{id:'f_amount',name:'Amount',type:'number'},{id:'f_type',name:'Type',type:'select',options:[{id:'e',name:'Expense',color:''},{id:'i',name:'Income',color:''}]}]}]);
 await db.tasks.bulkPut([{id:'project',_ts:{},boardId:'projects',p_f_budget:100},{id:'expense',_ts:{},boardId:'money',p_f_type:'e',p_f_amount:20}]);
 await db.links.put({id:'link',_ts:{},kind:'relation',fromId:'expense',toId:'project',fieldId:'f_project'});
 const scan=vi.spyOn(db.tasks,'toArray'),bytes=vi.spyOn(db.blobs,'get');
 const result=await readLocalFinance(db,financeConfigSchema.parse({databaseId:'projects'}),{userId:'alice',today:'2026-10-29',timeZone:'Asia/Kolkata',currency:'INR',now:1});
 expect(result).toMatchObject({partial:true,partialSources:['device_snapshot'],items:[{money:{spent:20,remaining:80,partial:true}}]});expect(scan).not.toHaveBeenCalled();expect(bytes).not.toHaveBeenCalled();
});
it('distinguishes missing database from empty and validates configuration limits',async()=>{
 const config=financeConfigSchema.parse({databaseId:'products',mode:'product'}),ctx={userId:'alice',today:'2026-10-29',timeZone:'Asia/Kolkata',currency:'INR',now:1};
 expect(await readLocalFinance(db,config,ctx)).toMatchObject({status:'source_unavailable',items:[]});await db.boards.put({id:'products',_ts:{}});expect(await readLocalFinance(db,config,ctx)).toMatchObject({status:'ready',items:[]});
 expect(financeConfigSchema.safeParse({databaseId:'products',limit:21}).success).toBe(false);expect(financeConfigSchema.safeParse({}).success).toBe(false);
});
