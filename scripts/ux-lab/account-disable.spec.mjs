import {test,expect,open,health,request,fixture} from './support.mjs';
import {surfaces} from './catalog.mjs';
import {reloadReady} from '../navigation-ready.mjs';

test('account access: disable, session cutoff, history and restoration',async({page,browser},info)=>{
 const username='member-'+info.project.name,password=crypto.randomUUID();
 const {code}=await request('/api/invites');
 const response=await fetch(fixture.base+'/api/auth/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,name:'Synthetic member',password,inviteCode:code})});
 expect(response.status).toBe(200);const member=await response.json();
 const other=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});
 await other.route('**/*',r=>new URL(r.request().url()).origin===new URL(fixture.base).origin?r.continue():r.abort());
 await other.addInitScript(a=>{localStorage.setItem('ws_token',a.token);localStorage.setItem('ws_uid',a.user.id);localStorage.setItem('ws_user',JSON.stringify(a.user));},member);
 const memberPage=await other.newPage();
 try{
  await memberPage.goto(fixture.base+'/settings');await expect(memberPage.getByRole('heading',{name:'Settings',exact:true})).toBeVisible();
  await request('/api/sync/push',{protocol:3,changes:[{id:'disabled-history-'+info.project.name,collection:'tasks',ts:Date.now(),patch:{boardId:'ux-tasks',title:'Retained member work',assigneeId:member.user.id,order:'z1'}}]});
  await open(page,surfaces.find(s=>s.id==='settings'));
  const row=page.getByTestId('member-'+member.user.id),disable=row.getByRole('button',{name:'Disable access for Synthetic member',exact:true});
  await disable.scrollIntoViewIfNeeded();await disable.focus();await disable.press('Enter');
  let dialog=page.getByRole('dialog',{name:'Disable access for Synthetic member',exact:true});await expect(dialog).toContainText('Existing work, assignments and history stay');
  await health(page,'account disable confirmation',info);await info.attach('account-disable-dialog',{body:await page.screenshot(),contentType:'image/png'});
  await dialog.getByRole('button',{name:'Disable access',exact:true}).click();await expect(dialog).toBeHidden();await expect(row).toContainText('(Disabled)');
  await reloadReady(memberPage);await expect(memberPage.getByRole('form',{name:'Sign in form'}).getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
  const auth=await memberPage.evaluate(async token=>(await fetch('/api/auth/me',{headers:{Authorization:'Bearer '+token}})).status,member.token);expect(auth).toBe(401);
  // Disabled people remain visible on historical assignments, and cannot be chosen anew.
  await open(page,{path:'/boards/ux-tasks/tasks/disabled-history-'+info.project.name,ready:{role:'textbox',name:'Task title'}});
  const assignee=page.getByRole('combobox',{name:'Assignee',exact:true});await expect(assignee).toHaveValue(member.user.id);await expect(assignee.locator(`option[value="${member.user.id}"]`)).toBeDisabled();await expect(assignee).toContainText('Synthetic member (disabled)');
  await open(page,surfaces.find(s=>s.id==='settings'));
  await row.getByRole('button',{name:'Restore access for Synthetic member',exact:true}).click();
  dialog=page.getByRole('dialog',{name:'Restore access for Synthetic member',exact:true});await expect(dialog).toContainText('free place');await health(page,'account restore confirmation',info);
  const failureRoute='**/api/users/'+member.user.id+'/enable';
  await page.route(failureRoute,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'connector_cleanup_pending',message:'Account remains disabled. Retry when connector revocation is available.'})}));
  await dialog.getByRole('button',{name:'Restore access',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('Account remains disabled');await expect(row).toContainText('(Disabled)');await page.unroute(failureRoute);
  await dialog.getByRole('button',{name:'Restore access',exact:true}).click();await expect(dialog).toBeHidden();await expect(row).not.toContainText('(Disabled)');
  const old=await fetch(fixture.base+'/api/auth/me',{headers:{Authorization:'Bearer '+member.token}});expect(old.status).toBe(401);
  const fresh=await fetch(fixture.base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});expect(fresh.status).toBe(200);
 }finally{
  await other.close();await request('/api/users/'+member.user.id,undefined,'DELETE');
  await request('/api/sync/push',{protocol:3,changes:[{id:'disabled-history-'+info.project.name,collection:'tasks',ts:Date.now(),patch:{deleted:true}}]});
 }
});
