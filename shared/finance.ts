/** Focused operating summaries, not a ledger or exchange-rate engine. */
import {fieldsOf,optionByName,type FieldDef} from './fields';
import {validCurrency} from './workspaceSettings';
export type FinanceRecord={id:string}&Record<string,unknown>;
export interface FinanceLink {id:string;kind:string;fieldId?:string;fromId:string;toId:string;deleted?:boolean;archived?:boolean}
export interface FinanceFieldsContext {
 projectFields:FieldDef[];transactionFields:FieldDef[];workspaceCurrency:string;
 transactionDatabaseId:string;relationField:FieldDef;
 budgetKey?:string;amountKey?:string;typeKey?:string;partial?:boolean;
}
export interface ProjectMoney {
 budget:number|null;spent:number|null;income:number|null;remaining:number|null;
 currency:string|null;transactionIds:string[];excludedBudgetLineIds:string[];
 partial:boolean;issues:string[];error?:'mixed_currency';currencies?:string[];
}
const active=(r:FinanceRecord)=>!r.deleted&&!r.archived;
/** Validate untyped record values at the calculation boundary. Missing is not0. */
function minorAmount(raw:unknown,factor:number):number|null {
 if(typeof raw!=='number'||!Number.isFinite(raw))return null;
 const minor=Math.round(raw*factor);
 return Number.isSafeInteger(minor)?minor:null;
}
export function projectMoney(project:FinanceRecord,transactions:FinanceRecord[],links:FinanceLink[],ctx:FinanceFieldsContext):ProjectMoney {
 const issues=new Set<string>(ctx.partial?['partial_sources']:[]),transactionIds:string[]=[],excludedBudgetLineIds:string[]=[];
 const budgetKey=ctx.budgetKey??'p_f_budget',amountKey=ctx.amountKey??'p_f_amount',typeKey=ctx.typeKey??'p_f_type';
 const budgetField=ctx.projectFields.find(f=>`p_${f.id}`===budgetKey),amountField=ctx.transactionFields.find(f=>`p_${f.id}`===amountKey),typeField=ctx.transactionFields.find(f=>`p_${f.id}`===typeKey);
 const currencies=[...new Set([budgetField?.currency??ctx.workspaceCurrency,amountField?.currency??ctx.workspaceCurrency])].sort();
 const result=(values:Partial<ProjectMoney>={}):ProjectMoney=>({budget:null,spent:null,income:null,remaining:null,currency:currencies.length===1?currencies[0]:null,transactionIds,excludedBudgetLineIds,partial:issues.size>0,issues:[...issues].sort(),...values});
 if(!active(project)){issues.add('project_unavailable');return result();}
 if(budgetField?.type!=='number'||amountField?.type!=='number'||typeField?.type!=='select'||ctx.relationField.type!=='relation'||ctx.relationField.relation?.target!==ctx.transactionDatabaseId){issues.add('field_configuration');return result();}
 if(currencies.some(c=>!validCurrency(c))){issues.add('currency_configuration');return result();}
 if(currencies.length>1)return result({error:'mixed_currency',currencies});
 const currency=currencies[0]!,digits=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits!,factor=10**digits;
 const budget=minorAmount(project[budgetKey],factor);if(budget===null)issues.add('budget_missing_or_invalid');
 const expense=optionByName(typeField,'expense'),income=optionByName(typeField,'income'),budgetLine=optionByName(typeField,'budget line');
 if(!expense||!income){issues.add('type_configuration');return result({budget:budget===null?null:budget/factor});}
 const relation=ctx.relationField.relation,reverse=relation.primary!==true&&!!relation.pairedFieldId,fieldId=reverse?relation.pairedFieldId!:ctx.relationField.id;
 const ids=new Set(links.filter(l=>!l.deleted&&!l.archived&&l.kind==='relation'&&l.fieldId===fieldId&&(reverse?l.toId===project.id:l.fromId===project.id)).map(l=>reverse?l.fromId:l.toId));
 const removed=new Set(transactions.filter(r=>!active(r)).map(r=>r.id));
 const byId=new Map(transactions.filter(active).map(r=>[r.id,r]));let spent=0,received=0,complete=true;
 for(const id of [...ids].sort()){
  if(removed.has(id))continue;
  const row=byId.get(id);if(!row||row.boardId!==ctx.transactionDatabaseId){issues.add('transaction_unavailable');complete=false;continue;}
  if(budgetLine&&row[typeKey]===budgetLine.id){excludedBudgetLineIds.push(id);continue;}
  transactionIds.push(id);
  const amount=minorAmount(row[amountKey],factor),kind=row[typeKey];
  if(amount===null){issues.add('amount_missing_or_invalid');complete=false;continue;}
  if(kind===expense.id)spent+=amount;else if(kind===income.id)received+=amount;else{issues.add('transaction_type_unknown');complete=false;}
  if(!Number.isSafeInteger(spent)||!Number.isSafeInteger(received)){issues.add('amount_out_of_range');complete=false;}
 }
 const remaining=budget===null?null:budget-spent;
 if(remaining!==null&&!Number.isSafeInteger(remaining)){issues.add('amount_out_of_range');complete=false;}
 return result({budget:budget===null?null:budget/factor,spent:complete?spent/factor:null,income:complete?received/factor:null,remaining:complete&&remaining!==null?remaining/factor:null});
}
export interface ProductEconomics {price:number|null;cost:number|null;difference:number|null;marginPercent:number|null;currency:string|null;partial:boolean;issues:string[];error?:'mixed_currency';currencies?:string[]}
export function productEconomics(product:FinanceRecord,ctx:{fields:FieldDef[];workspaceCurrency:string;priceKey?:string;costKey?:string;partial?:boolean}):ProductEconomics {
 const priceKey=ctx.priceKey??'p_f_price',costKey=ctx.costKey??'p_f_cost',fields=fieldsOf({fields:ctx.fields}),priceField=fields.find(f=>`p_${f.id}`===priceKey),costField=fields.find(f=>`p_${f.id}`===costKey);
 const issues=new Set<string>(ctx.partial?['partial_sources']:[]),currencies=[...new Set([priceField?.currency??ctx.workspaceCurrency,costField?.currency??ctx.workspaceCurrency])].sort();
 const result=(values:Partial<ProductEconomics>={}):ProductEconomics=>({price:null,cost:null,difference:null,marginPercent:null,currency:currencies.length===1?currencies[0]:null,partial:issues.size>0,issues:[...issues].sort(),...values});
 if(!active(product)){issues.add('product_unavailable');return result();}
 if(priceField?.type!=='number'||costField?.type!=='number'||priceKey===costKey){issues.add('field_configuration');return result();}
 if(currencies.some(c=>!validCurrency(c))){issues.add('currency_configuration');return result();}
 if(currencies.length>1)return result({error:'mixed_currency',currencies});
 const currency=currencies[0]!,factor=10**new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits!;
 const price=minorAmount(product[priceKey],factor),cost=minorAmount(product[costKey],factor);
 if(price===null)issues.add('price_missing_or_invalid');if(cost===null)issues.add('cost_missing_or_invalid');
 const difference=price!==null&&cost!==null?price-cost:null;
 if(difference!==null&&!Number.isSafeInteger(difference)){issues.add('amount_out_of_range');return result();}
 if(price!==null&&price<=0)issues.add('margin_requires_positive_price');
 return result({price:price===null?null:price/factor,cost:cost===null?null:cost/factor,difference:difference===null?null:difference/factor,marginPercent:difference!==null&&price!==null&&price>0?difference/price*100:null});
}
