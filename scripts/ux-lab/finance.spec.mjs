import {test,expect,open,health,request,readRecord,setOfflineForTest} from './support.mjs';
import {readAccountStore} from '../certification/browser-db.mjs';
import {linkId} from '../../shared/linkid.ts';
async function seed(info){
 const key=info.project.name.replaceAll('-','')+'-'+Date.now(),projects='fip-'+key,money='fim-'+key,products='fic-'+key,pageId='fpg-'+key,project='fpr-'+key,expense='fex-'+key,income='fin-'+key,product='fcp-'+key,budget='fbu-'+key,productBudget='fcb-'+key;
 const fields=[{id:'f_amount',name:'Amount',type:'number',format:'currency'},{id:'f_type',name:'Type',type:'select',options:[{id:'expense',name:'Expense',color:'#ef4444'},{id:'income',name:'Income',color:'#22c55e'}]},{id:'f_project',name:'Project',type:'relation',relation:{target:projects,primary:true,pairedFieldId:'f_transactions'}}];
 const rows=[
  {id:projects,collection:'boards',patch:{name:'Finance projects '+key,kind:'records',fields:[{id:'f_budget',name:'Budget',type:'number',format:'currency'},{id:'f_transactions',name:'Transactions',type:'relation',relation:{target:money,primary:false,pairedFieldId:'f_project'}}]}},
  {id:money,collection:'boards',patch:{name:'Finance transactions '+key,kind:'records',fields}},
  {id:products,collection:'boards',patch:{name:'Common Cupboard '+key,kind:'records',templateDbKey:'products',fields:[{id:'f_price',name:'Price',type:'number',format:'currency'},{id:'f_cost',name:'Cost',type:'number',format:'currency'},{id:'f_margin',name:'Margin',type:'text'}]}},
  {id:project,collection:'tasks',patch:{boardId:projects,title:'Project café 日本語 العربية 👩🏽‍💻 '+key,p_f_budget:100}},
  {id:expense,collection:'tasks',patch:{boardId:money,title:'Synthetic materials '+key,p_f_amount:20,p_f_type:'expense'}},
  {id:income,collection:'tasks',patch:{boardId:money,title:'Synthetic funding '+key,p_f_amount:60,p_f_type:'income'}},
  {id:product,collection:'tasks',patch:{boardId:products,title:'Cup café 日本語 '+key,p_f_price:100,p_f_cost:60,p_f_margin:'Original team margin notes'}},
  ...[expense,income].map(id=>({id:linkId('relation','f_project',id,project),collection:'links',patch:{kind:'relation',fieldId:'f_project',fromType:'record',toType:'record',fromId:id,toId:project}})),
  {id:pageId,collection:'pages',patch:{title:'Finance review '+key,order:'a0'}},
  {id:budget,collection:'blocks',patch:{pageId,type:'budget',heading:'Project money',databaseId:projects,mode:'project',order:'a0'}},
  {id:productBudget,collection:'blocks',patch:{pageId,type:'budget',heading:'Product economics',databaseId:products,mode:'product',order:'a1'}},
 ];
 expect((await request('/api/sync/push',{protocol:3,changes:rows.map(r=>({...r,ts:Date.now()}))})).rejectedItems).toEqual([]);
 return {key,projects,money,products,pageId,project,expense,income,product,budget,productBudget,fields,async cleanup(){await request('/api/sync/push',{protocol:3,changes:rows.map(r=>({id:r.id,collection:r.collection,patch:{deleted:true},ts:Date.now()}))});}};
}
async function review(page,f){await open(page,{id:'finance-review',path:'/pages/'+f.pageId,ready:{role:'heading',name:'Project money'}});const region=page.getByRole('region',{name:'Budget summary',exact:true}).first();await expect(region.getByText('Remaining: budget minus net expenses',{exact:true})).toBeVisible();return region;}
const amount=(region,label)=>region.getByText(label,{exact:true}).locator('..').locator('dd');
test('Finance desk: exact totals, transaction drill-down and offline recovery',async({page,context},info)=>{
 const f=await seed(info);
 try{
  const region=await review(page,f);await expect(amount(region,'Budget')).toContainText('100.00');await expect(amount(region,'Net expenses')).toContainText('20.00');await expect(amount(region,'Income, shown separately')).toContainText('60.00');await expect(amount(region,'Remaining: budget minus net expenses')).toContainText('80.00');
  await region.getByRole('button',{name:'View transactions',exact:true}).press('Enter');const sheet=page.getByRole('dialog',{name:'Records',exact:true});await expect(sheet).toContainText('Synthetic materials');await expect(sheet).toContainText('Synthetic funding');await sheet.getByRole('button',{name:/Synthetic materials/}).click();await expect(page).toHaveURL(new RegExp('/boards/'+f.money+'/tasks/'+f.expense+'$'));
  const back=await review(page,f);await setOfflineForTest(page,context,true);await expect(back).toContainText('Partial device snapshot');await expect(amount(back,'Net expenses')).toContainText('20.00');await health(page,'Finance offline',info);
  await setOfflineForTest(page,context,false);await back.getByRole('button',{name:'Refresh budget',exact:true}).click();await expect(back).not.toContainText('Partial device snapshot');await health(page,'Finance recovered',info);
 }finally{if(!page.isClosed())await setOfflineForTest(page,context,false);await f.cleanup();}
});
test('Finance desk: configured filters, mixed currency, failure recovery and enlarged text',async({page},info)=>{
 const f=await seed(info);
 try{
  const region=await review(page,f);await page.getByRole('button',{name:'Configure Budget',exact:true}).first().press('Enter');await page.getByRole('button',{name:'Add budget filter',exact:true}).click();await page.getByLabel('Filter value',{exact:true}).fill('no matching money');await page.keyboard.press('Escape');await expect(region).toContainText('No available records match');await expect.poll(async()=>(await readRecord(f.budget)).data.filters?.[0]?.value).toBe('no matching money');
  await page.getByRole('button',{name:'Configure Budget',exact:true}).first().click();await page.getByRole('button',{name:'Remove filter',exact:true}).click();await page.keyboard.press('Escape');await expect(amount(region,'Budget')).toContainText('100.00');
  await request('/api/sync/push',{protocol:3,changes:[{id:f.money,collection:'boards',patch:{fields:f.fields.map(field=>field.id==='f_amount'?{...field,currency:'USD'}:field)},ts:Date.now()}]});await region.getByRole('button',{name:'Refresh budget',exact:true}).click();await expect(region).toContainText('Cannot combine currencies: INR, USD');await health(page,'Finance mixed currencies',info);
  await request('/api/sync/push',{protocol:3,changes:[{id:f.money,collection:'boards',patch:{fields:f.fields},ts:Date.now()}]});await page.route('**/api/finance',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"disposable_outage"}'}));await region.getByRole('button',{name:'Refresh budget',exact:true}).click();await expect(region).toContainText('Money sources could not be refreshed');await page.unroute('**/api/finance');await region.getByRole('button',{name:'Refresh budget',exact:true}).click();await expect(amount(region,'Budget')).toContainText('100.00');
  await page.addStyleTag({content:'html{font-size:200%!important}'});const title=region.getByRole('link').first();const bounds=await title.evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth}));expect(bounds.scroll,'Budget title wraps inside its own card').toBeLessThanOrEqual(bounds.width+1);const drill=region.getByRole('button',{name:'View transactions',exact:true});await drill.scrollIntoViewIfNeeded();await expect(drill).toBeInViewport({ratio:1});const buttonBounds=await drill.evaluate(el=>{const own=el.getBoundingClientRect(),card=el.closest('li').getBoundingClientRect();return {right:own.right,cardRight:card.right,scroll:el.scrollWidth,width:el.clientWidth};});expect(buttonBounds.right,'Budget action stays inside its card').toBeLessThanOrEqual(buttonBounds.cardRight+1);expect(buttonBounds.scroll,'Full action caption fits').toBeLessThanOrEqual(buttonBounds.width+1);await health(page,'Finance enlarged',info);await info.attach('finance-enlarged',{body:await page.screenshot(),contentType:'image/png'});
 }finally{await f.cleanup();}
});
test('Finance desk: Products database economics and missing-value states preserve text Margin',async({page},info)=>{
 const f=await seed(info);
 try{
  await open(page,{id:'finance-products',path:'/boards/'+f.products,ready:{role:'heading',name:'🗃️ Common Cupboard '+f.key}});await page.getByText('Common Cupboard price and cost',{exact:true}).click();const region=page.getByRole('region',{name:'Budget summary',exact:true});await expect(amount(region,'Price minus cost')).toContainText('40.00');await expect(region).toContainText('Margin: 40%');expect((await readRecord(f.product)).data.p_f_margin).toBe('Original team margin notes');await health(page,'Finance products database',info);
  await request('/api/sync/push',{protocol:3,changes:[{id:f.product,collection:'tasks',patch:{p_f_price:0},ts:Date.now()}]});await region.getByRole('button',{name:'Refresh budget',exact:true}).click();await expect(region).toContainText('Margin: Unavailable');await expect(region).toContainText('margin requires positive price');await health(page,'Finance zero price',info);
  await request('/api/sync/push',{protocol:3,changes:[{id:f.product,collection:'tasks',patch:{p_f_cost:null},ts:Date.now()}]});await region.getByRole('button',{name:'Refresh budget',exact:true}).click();await expect(amount(region,'Cost')).toHaveText('Unavailable');expect((await readRecord(f.product)).data.p_f_margin).toBe('Original team margin notes');
 }finally{await f.cleanup();}
});
