import {test,expect,open,health,request,readRecord,fixture} from './support.mjs';

test('Space mentions: keyboard picker, Unicode chip, recipient inbox and reload',async({page},info)=>{
 const suffix=info.project.name.replaceAll('-','')+Date.now(),root='mention-'+suffix,body='mentionbody-'+suffix;
 const {code}=await request('/api/invites');
 const response=await fetch(fixture.base+'/api/auth/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'mention'+Date.now(),name:'Synthetic mention recipient',password:'fixture-'+crypto.randomUUID(),inviteCode:code})});
 expect(response.status).toBe(200);const recipient=await response.json();
 const write=async changes=>expect((await request('/api/sync/push',{protocol:3,changes:changes.map(row=>({...row,ts:Date.now()}))})).rejectedItems).toEqual([]);
 await write([{id:root,collection:'pages',patch:{title:'Space mention browser review'}},{id:body,collection:'blocks',patch:{pageId:root,type:'p',text:'',order:'a0'}}]);
 try{
  await open(page,{id:'space-mention-page',path:'/pages/'+root,ready:{placeholder:'Untitled'}});
  const editor=page.locator(`[data-block-id="${body}"] [contenteditable=true]`);
  await editor.pressSequentially('Team update 👩🏽‍💻 ');await editor.pressSequentially('@Core');
  const picker=page.locator('[data-mention-menu]');await expect(picker.getByRole('button',{name:'Core Space',exact:true})).toBeVisible();
  await health(page,'Space mention picker',info);
  await editor.press('Enter');
  await expect(editor.locator('[data-mk=group]')).toHaveText('@Core');
  await editor.pressSequentially(' नमस्ते');await editor.press('Tab');
  await expect.poll(async()=>(await readRecord(body))?.data.text).toContain('@[group:space-core]');
  const received=async()=>{const r=await fetch(fixture.base+'/api/notifications',{headers:{Authorization:'Bearer '+recipient.token}});expect(r.status).toBe(200);return (await r.json()).notifications.filter(row=>row.targetId===root);};
  await expect.poll(async()=>(await received()).length).toBe(1);expect((await received())[0].body).toContain('Team update');
  await page.reload();await expect(editor.locator('[data-mk=group]')).toHaveText('@Core');await expect(editor).toContainText('नमस्ते');
  await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});await editor.scrollIntoViewIfNeeded();await health(page,'Space mention enlarged chip',info);
  await info.attach('Space-mention-chip',{body:await page.screenshot(),contentType:'image/png'});
  await editor.locator('[data-mk=group]').evaluate(chip=>{const range=document.createRange();range.setStartAfter(chip);range.collapse(true);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);chip.closest('[contenteditable]').focus();});
  await editor.press('Backspace');await editor.press('Tab');await expect(editor.locator('[data-mk=group]')).toHaveCount(0);
  await expect.poll(async()=>(await readRecord(body))?.data.text).not.toContain('@[group:space-core]');await expect(editor).toContainText('नमस्ते');

 }finally{await write([{id:body,collection:'blocks',patch:{deleted:true}},{id:root,collection:'pages',patch:{deleted:true}}]);await request('/api/users/'+recipient.user.id,undefined,'DELETE');}
});
