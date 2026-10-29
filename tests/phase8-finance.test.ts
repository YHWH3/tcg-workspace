import {expect,it} from 'vitest';
import {projectMoney,productEconomics,type FinanceFieldsContext,type FinanceLink} from '../shared/finance';
import type {FieldDef} from '../shared/fields';
const number=(id:string,currency?:string):FieldDef=>({id,name:id,type:'number',format:'currency',...(currency?{currency}:{})});
const relation:FieldDef={id:'transactions',name:'Transactions',type:'relation',relation:{target:'money',pairedFieldId:'project',primary:false}};
const ctx:FinanceFieldsContext={projectFields:[number('f_budget')],transactionFields:[number('f_amount'),{id:'f_type',name:'Type',type:'select',options:[{id:'e',name:'Expense',color:''},{id:'i',name:'Income',color:''},{id:'b',name:'Budget line',color:''}]}],workspaceCurrency:'INR',transactionDatabaseId:'money',relationField:relation};
const project={id:'project',p_f_budget:100};
const tx=(id:string,type:string,amount:unknown)=>({id,boardId:'money',p_f_type:type,p_f_amount:amount});
const link=(id:string):FinanceLink=>({id:'l'+id,kind:'relation',fieldId:'project',fromId:id,toId:'project'});
it('splits signed reversals, deduplicates relations, excludes budget lines and shows income separately',()=>{
 const rows=[tx('a','e',20),tx('b','e',-5),tx('c','i',60),tx('d','i',-10),tx('plan','b',500)];
 expect(projectMoney(project,rows,[...rows.map(r=>link(r.id)),{...link('a'),id:'duplicate'}],ctx)).toMatchObject({budget:100,spent:15,income:50,remaining:85,currency:'INR',transactionIds:['a','b','c','d'],excludedBudgetLineIds:['plan'],partial:false});
});
it('rounds currency minor units rather than accumulating binary fractions',()=>{expect(projectMoney(project,[tx('a','e',0.1),tx('b','e',0.2)],[link('a'),link('b')],ctx)).toMatchObject({spent:0.3,remaining:99.7});});
it('does not include another project, unrelated field, tombstone or archived link',()=>{
 const links=[{...link('a'),toId:'other'},{...link('a'),fieldId:'unrelated'},{...link('a'),deleted:true},{...link('a'),archived:true}];expect(projectMoney(project,[tx('a','e',40)],links,ctx)).toMatchObject({spent:0,income:0,remaining:100,partial:false});
});
it('supports primary relation direction and configurable renamed numeric fields',()=>{
 const forward={...relation,id:'money',relation:{target:'money',primary:true}};
 expect(projectMoney({...project,p_custom:30},[tx('a','e',10)],[{...link('a'),fieldId:'money',fromId:'project',toId:'a'}],{...ctx,projectFields:[number('custom')],budgetKey:'p_custom',relationField:forward})).toMatchObject({budget:30,spent:10,remaining:20});
});
it('does not invent zero for unavailable or wrong-database transactions',()=>{
 for(const rows of [[],[{...tx('a','e',10),boardId:'private'}]])expect(projectMoney(project,rows,[link('a')],ctx)).toMatchObject({spent:null,remaining:null,partial:true,issues:['transaction_unavailable']});
});
it('reports missing/invalid amounts and unknown types instead of complete totals',()=>{
 for(const amount of [null,undefined,'20',NaN,Infinity,1e30])expect(projectMoney(project,[tx('a','e',amount)],[link('a')],ctx)).toMatchObject({spent:null,remaining:null,partial:true,issues:['amount_missing_or_invalid']});
 expect(projectMoney(project,[tx('a','unknown',20)],[link('a')],ctx)).toMatchObject({spent:null,partial:true,issues:['transaction_type_unknown']});
 expect(projectMoney({id:'project'},[],[],ctx)).toMatchObject({budget:null,spent:0,remaining:null,partial:true});
});
it('refuses mixed currencies without performing conversion, including empty transaction sets',()=>{
 expect(projectMoney(project,[],[],{...ctx,transactionFields:[number('f_amount','USD'),ctx.transactionFields[1]]})).toMatchObject({error:'mixed_currency',currencies:['INR','USD'],spent:null,remaining:null});
});
it('reports schema drift and partial source flags explicitly',()=>{
 expect(projectMoney(project,[],[],{...ctx,projectFields:[]})).toMatchObject({partial:true,issues:['field_configuration']});
 expect(projectMoney(project,[],[],{...ctx,partial:true})).toMatchObject({spent:0,partial:true,issues:['partial_sources']});
 expect(projectMoney(project,[],[],{...ctx,transactionFields:[number('f_amount'),{id:'f_type',name:'Type',type:'select',options:[]}]})).toMatchObject({spent:null,partial:true,issues:['type_configuration']});
});
it('uses option labels rather than assuming canonical IDs',()=>{expect(projectMoney(project,[tx('a','custom-expense',12)],[link('a')],{...ctx,transactionFields:[number('f_amount'),{id:'f_type',name:'Type',type:'select',options:[{id:'custom-expense',name:'EXPENSE',color:''},{id:'custom-income',name:'income',color:''}]}]})).toMatchObject({spent:12,remaining:88});});
it('rejects unsafe total accumulation',()=>{const amount=Number.MAX_SAFE_INTEGER/100;expect(projectMoney(project,[tx('a','e',amount),tx('b','e',amount)],[link('a'),link('b')],ctx)).toMatchObject({spent:null,partial:true,issues:['amount_out_of_range']});});
const productCtx={fields:[number('f_price'),number('f_cost'),{id:'f_margin',name:'Margin',type:'text'} as FieldDef],workspaceCurrency:'INR'};
it('computes price minus cost and margin without changing the legacy text Margin',()=>{const p={id:'cup',p_f_price:100,p_f_cost:60,p_f_margin:'Our own notes'};expect(productEconomics(p,productCtx)).toEqual({price:100,cost:60,difference:40,marginPercent:40,currency:'INR',partial:false,issues:[]});expect(p.p_f_margin).toBe('Our own notes');});
it('keeps zero/missing price and missing cost explicit without infinite margins',()=>{
 expect(productEconomics({id:'cup',p_f_price:0,p_f_cost:20},productCtx)).toMatchObject({difference:-20,marginPercent:null,partial:true,issues:['margin_requires_positive_price']});
 expect(productEconomics({id:'cup',p_f_cost:20},productCtx)).toMatchObject({price:null,difference:null,marginPercent:null,partial:true});
 expect(productEconomics({id:'cup',p_f_price:20},productCtx)).toMatchObject({cost:null,difference:null,partial:true});
});
it('keeps loss, effective currencies, field drift and partial product evidence visible',()=>{
 expect(productEconomics({id:'cup',p_f_price:50,p_f_cost:60},productCtx)).toMatchObject({difference:-10,marginPercent:-20});
 expect(productEconomics({id:'cup'},{...productCtx,fields:[number('f_price','USD'),number('f_cost')]})).toMatchObject({error:'mixed_currency',currencies:['INR','USD']});
 expect(productEconomics({id:'cup'},{...productCtx,fields:[]})).toMatchObject({partial:true,issues:['field_configuration']});
 expect(productEconomics({id:'cup',p_f_price:50,p_f_cost:30},{...productCtx,partial:true})).toMatchObject({difference:20,partial:true});
});

it('excludes known deleted and archived transactions without retaining their identities',()=>{for(const flag of ['deleted','archived'])expect(projectMoney(project,[{...tx('a','e',20),[flag]:true}],[link('a')],ctx)).toMatchObject({spent:0,partial:false,transactionIds:[]});});
