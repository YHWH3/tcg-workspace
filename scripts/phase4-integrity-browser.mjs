import assert from 'node:assert/strict';
import {join} from 'node:path';

// Real persisted browser profiles; no source-module imports or direct IDB
// mutations. Offline actions use the delivered UI and reconnect uses sync.
export async function verifyIntegrityBrowser({browserType,engine,base,admin,fixture,output,check,update,rows,eventually}) {
 const prefix=`integrity_${engine}_${Date.now()}`,board=prefix+'_people',work=prefix+'_work',personId=prefix+'_person',task=prefix+'_task',file=prefix+'_photo',thumb=prefix+'_thumb',pageId=prefix+'_page';
 const url='https://docs.google.com/document/d/integrity/edit';
 await update([{id:board,collection:'boards',patch:{kind:'records',name:prefix+' People',columns:[{id:'open',name:'Open'}],fields:[{id:'email',name:'Email',type:'text'}]}},
 {id:work,collection:'boards',patch:{name:prefix+' Work',columns:[{id:'open',name:'Open'}],fields:[]}},
 {id:task,collection:'tasks',patch:{boardId:work,title:prefix+' Task',status:'open'}},
 {id:personId,collection:'tasks',patch:{boardId:board,title:prefix+' Person',status:'open',p_email:'fixture@example.invalid'}},
 {id:file,collection:'files',patch:{parentType:'task',parentId:task,kind:'image',mime:'image/png',size:1,thumbId:thumb}},
 {id:thumb,collection:'files',patch:{parentType:'task',parentId:task,kind:'thumbnail',mime:'image/png',size:1}},
 {id:pageId,collection:'pages',patch:{title:prefix+' Embeds'}},
 {id:prefix+'_embed',collection:'blocks',patch:{pageId,type:'embed',url,provider:'gdrive',order:'a0'}}]);
 for(const id of [file,thumb])for(const [path,method,body] of [[`/api/files/${id}/chunks/0`,'PUT',new Uint8Array([1])],[`/api/files/${id}/complete`,'POST',JSON.stringify({mime:'image/png',size:1,chunks:1})]]){
  const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${admin.token}`,...(method==='POST'?{'Content-Type':'application/json'}:{})},body});assert.equal(response.status,200,await response.text());
 }
 const profile=join(output,engine+'-integrity-profile');let context;
 const run=(name,fn)=>check(engine,name,async()=>{try{await fn();}catch(error){const p=context?.pages().at(-1);if(p){await p.screenshot({path:join(output,engine+'-'+name.slice(0,6)+'-failure.png'),fullPage:true}).catch(()=>{});console.error((await p.locator('body').innerText()).slice(0,3000));}await context?.tracing.stop({path:join(output,engine+'-'+name.slice(0,6)+'-failure.zip')}).catch(()=>{});await context?.setOffline(false);throw error;}});
 const start=async()=>{
  context=await browserType.launchPersistentContext(profile,{headless:true,viewport:{width:390,height:844}});
  await context.tracing.start({screenshots:true,snapshots:true});
  await context.addInitScript(([token,user])=>{localStorage.setItem('ws_token',token);localStorage.setItem('ws_user',JSON.stringify(user));localStorage.setItem('ws_uid',user.id);},[admin.token,admin.user]);
  // External Drive content is not part of this local test; the app link and
  // sandboxed renderer must have the correct URL without contacting Google.
  await context.route('https://docs.google.com/**',route=>route.fulfill({status:200,body:'Disposable external embed placeholder'}));
  const page=context.pages()[0]??await context.newPage();
  page.on('response',async response=>{if(response.url().endsWith('/api/sync/push')&&response.status()>=400)console.error('Integrity sync failure',response.status(),await response.text());});
  return page;
 };
 try {
  await run('INT-01 offline attachment deletion survives browser restart and reclaims D1 quota',async()=>{
   let page=await start();await page.goto(`${base}/boards/${work}/tasks/${task}`);await page.getByRole('button',{name:'Delete image',exact:true}).waitFor();
   assert.equal(await page.getByText('Deleted attachments cannot be restored. Keep another copy before deleting.',{exact:true}).isVisible(),true);
   await context.setOffline(true);await page.getByRole('button',{name:'Delete image',exact:true}).click();
   await page.getByRole('button',{name:'Delete image',exact:true}).waitFor({state:'hidden'});
   await context.close();context=null;
   // The original browser process and page no longer exist. The profile's
   // Dexie outbox is the only client intent that survives this transition.
   page=await start();await page.goto(`${base}/boards/${work}/tasks/${task}`);
   await eventually(async()=>{const r=await rows();return r.find(r=>r.id===file)?.data.deleted===true;},{timeout:30000});
   const stored=(await fixture.sql(`SELECT (SELECT COUNT(*) FROM files WHERE id IN ('${file}','${thumb}')) files,(SELECT COUNT(*) FROM file_chunks WHERE file_id IN ('${file}','${thumb}')) chunks`)).flatMap(r=>r.results??[])[0];
   assert.equal(stored.files,0);assert.equal(stored.chunks,0);
   const replay=await fetch(`${base}/api/files/${file}/chunks/0`,{method:'PUT',headers:{Authorization:`Bearer ${admin.token}`},body:new Uint8Array([1])});assert.equal(replay.status,410);
   await page.screenshot({path:join(output,engine+'-INT-01.png')});
  });
  await run('INT-02 offline generic database archive and restore preserve records',async()=>{
   if(!context)await start();const page=await context.newPage();await page.goto(`${base}/boards/${board}`);
   await page.getByLabel('Database menu',{exact:true}).click();await context.setOffline(true);
   await page.getByRole('button',{name:'Archive database',exact:true}).click();
   await page.getByRole('button',{name:'Unarchive',exact:true}).waitFor();
   await context.setOffline(false);
   // Discover and reopen via the normal Archived sidebar section, rather than a saved route.
   await page.setViewportSize({width:1440,height:1000});await page.goto(`${base}/boards`);
   await page.getByText('Archived',{exact:true}).first().waitFor();
   await page.getByRole('button',{name:prefix+' People',exact:false}).first().click();
   await page.getByRole('button',{name:'Unarchive',exact:true}).click();
   await eventually(async()=>{const r=await rows();return r.find(r=>r.id===board)?.data.archived===false;},{timeout:30000});
   const person=(await rows()).find(r=>r.id===personId);assert.equal(person.data.boardId,board);assert.equal(person.data.p_email,'fixture@example.invalid');
   await page.screenshot({path:join(output,engine+'-INT-02.png')});await page.close();
  });
  await run('INT-06 stored embed renders usable Drive link after reload',async()=>{
   if(!context)await start();const page=await context.newPage();await page.goto(`${base}/pages/${pageId}`);
   const link=page.getByRole('link',{name:'Open in Drive',exact:true});await link.waitFor();assert.equal(await link.getAttribute('href'),url);
   await page.reload();await link.waitFor();assert.equal(await link.getAttribute('href'),url);
   await page.screenshot({path:join(output,engine+'-INT-06.png')});await page.close();
  });
 }finally{await context?.close();}
}
