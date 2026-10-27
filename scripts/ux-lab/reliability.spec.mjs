import {test,expect,open,health,request,readRecord,fixture,setOfflineForTest} from './support.mjs';
import {readAccountStore} from '../certification/browser-db.mjs';
import {readFileSync} from 'node:fs';
async function seed(info){
 const suffix=info.project.name.replaceAll('-','')+'-'+Date.now(),id='rel-page-'+suffix,body='rel-body-'+suffix,file='rel-file-'+suffix;
 const rows=[{id,collection:'pages',patch:{title:'Device reliability '+suffix,order:'a0'}},{id:body,collection:'blocks',patch:{pageId:id,type:'p',text:'Original device note',order:'a0'}},{id:file,collection:'blocks',patch:{pageId:id,type:'file',order:'a1'}}];
 expect((await request('/api/sync/push',{protocol:3,changes:rows.map(r=>({...r,ts:Date.now()}))})).rejectedItems).toEqual([]);return {id,body,file,rows,suffix};
}
async function cleanup(f){await request('/api/sync/push',{protocol:3,changes:f.rows.map(r=>({id:r.id,collection:r.collection,patch:{deleted:true},ts:Date.now()}))});}
async function panel(page){const link=page.getByRole('link',{name:'Settings',exact:true}).first();await link.click();const p=page.getByRole('region',{name:'Reliability on this device',exact:true});await expect(p).toBeAttached();await p.scrollIntoViewIfNeeded();return p;}
const value=(panel,label)=>panel.getByText(label,{exact:true}).locator('..').locator('dd');
async function openPage(page,f){await open(page,{id:'reliability-page',path:'/pages/'+f.id,ready:{placeholder:'Untitled'}});await expect(page.getByRole('textbox',{name:"Block content",exact:true})).toHaveText('Original device note');}

test('reliability: local offline edit, explicit pending state and server acknowledgement',async({page,context},info)=>{
 const f=await seed(info);
 try{
  await openPage(page,f);await setOfflineForTest(page,context,true);
  const editor=page.locator(`[data-block-id="${f.body}"] [contenteditable="true"]`),text='Saved on this device '+f.suffix;await editor.fill(text);await editor.press('Tab');
  await expect.poll(async()=>(await readAccountStore(page,'outbox')).some(e=>e.id===f.body)).toBe(true);
  const p=await panel(page);await expect(value(p,'Pending record changes')).not.toHaveText('0');await expect(value(p,'Network interface')).toHaveText('Offline');
  expect((await readRecord(f.body))?.data.text).toBe('Original device note');
  await health(page,'reliability offline',info);await info.attach('reliability-offline',{body:await page.screenshot(),contentType:'image/png'});
  await setOfflineForTest(page,context,false);await expect.poll(async()=>(await readRecord(f.body))?.data.text).toBe(text);
  await expect(value(p,'Pending record changes')).toHaveText('0');await expect(value(p,'Last acknowledged record push')).toContainText('Synced at');await expect(value(p,'Last successful pull')).not.toContainText('Not observed');
  await p.getByRole('button',{name:'Sync now',exact:true}).focus();await p.getByRole('button',{name:'Sync now',exact:true}).press('Enter');await expect(p.getByRole('status')).toContainText('Sync attempted');
  await health(page,'reliability acknowledged',info);await info.attach('reliability-acknowledged',{body:await page.screenshot(),contentType:'image/png'});
 }finally{await setOfflineForTest(page,context,false);await cleanup(f);}
});

test('reliability: failed upload retains bytes and explicit retry completes it',async({page,context},info)=>{
 const f=await seed(info);let fileId;
 try{
  await openPage(page,f);
  await context.route('**/api/files/*/chunks/*',route=>route.fulfill({status:507,contentType:'application/json',body:'{"error":"synthetic_storage_limit"}'}));
  await page.locator('input[type="file"]').first().setInputFiles({name:'Synthetic recovery note.txt',mimeType:'text/plain',buffer:Buffer.from('Retained original upload bytes')});
  await expect.poll(async()=>{const r=await readAccountStore(page,'blocks',{id:f.file});fileId=r?.fileId;return !!fileId;}).toBe(true);
  await expect.poll(async()=>(await readAccountStore(page,'blobs',{id:fileId}))?.state).toBe('failed');
  const p=await panel(page);await expect(value(p,'Failed uploads')).toHaveText('1');await expect(p.getByRole('list',{name:'Device uploads',exact:true})).toContainText('Synthetic recovery note.txt');await health(page,'reliability upload failed',info);await info.attach('reliability-upload-failed',{body:await page.screenshot(),contentType:'image/png'});
  await context.unroute('**/api/files/*/chunks/*');const retry=p.getByRole('button',{name:'Retry failed uploads',exact:true});await retry.focus();await retry.press('Enter');
  await expect.poll(async()=>(await readAccountStore(page,'blobs',{id:fileId}))?.state).toBe('uploaded');await expect(value(p,'Failed uploads')).toHaveText('0');await expect(value(p,'Pending uploads')).toHaveText('0');
  const response=await fetch(fixture.base+'/api/files/'+fileId,{headers:{Authorization:'Bearer '+fixture.admin.token}});expect(response.status).toBe(200);expect(await response.text()).toBe('Retained original upload bytes');
  await health(page,'reliability upload recovered',info);
 }finally{await context.unroute('**/api/files/*/chunks/*');if(fileId)await request('/api/sync/push',{protocol:3,changes:[{id:fileId,collection:'files',patch:{deleted:true},ts:Date.now()}]});await cleanup(f);}
});

test('reliability: held review and rejected export remain separate',async({page},info)=>{
 const f=await seed(info);
 try{
  await openPage(page,f);
  // Disposable local fixture only: simulate retained rejection/held envelopes.
  // Neither is sent to the server or interpreted as a genuine approval.
  await page.evaluate(async suffix=>{
   const name='workspace-'+localStorage.getItem('ws_uid');if(!(await indexedDB.databases()).some(d=>d.name===name))throw new Error('Actual account store required');
   const d=await new Promise((resolve,reject)=>{const r=indexedDB.open(name);r.onupgradeneeded=()=>{r.transaction.abort();reject(new Error('No new store'));};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
   try{await new Promise((resolve,reject)=>{const t=d.transaction(['outbox','accessQuarantine','accessQuarantineInfo'],'readwrite');t.objectStore('outbox').add({id:'rel-rejected-'+suffix,collection:'pages',patch:{title:'Synthetic rejected edit'},ts:Date.now(),state:'rejected',rejectReason:'synthetic_read_only'});const r=t.objectStore('accessQuarantine').add({id:'rel-held-'+suffix,kind:'outbox',reason:'access_revoked_or_read_only',generation:1,payload:{patch:{title:'SYNTHETIC HELD PRIVATE COPY'}},quarantinedAt:Date.now()});r.onsuccess=()=>t.objectStore('accessQuarantineInfo').put({autoId:r.result,id:'rel-held-'+suffix,kind:'outbox',collection:'pages',reason:'access_revoked_or_read_only',generation:1,quarantinedAt:Date.now()});t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);});}finally{d.close();}
  },f.suffix);
  const p=await panel(page);await expect(value(p,'Rejected changes (retained)')).toHaveText('1');await expect(value(p,'Held operations')).toHaveText('1');
  await p.getByRole('button',{name:'Review held work',exact:true}).click();const held=page.getByRole('dialog',{name:'Held work',exact:true});await expect(held).toBeVisible();await expect(held).not.toContainText('SYNTHETIC HELD PRIVATE COPY');await health(page,'reliability held review',info);await page.keyboard.press('Escape');
  const download=page.waitForEvent('download');await p.getByRole('button',{name:'Export rejected items',exact:true}).click();const file=await download;const payload=JSON.parse(readFileSync(await file.path(),'utf8'));expect(payload.entries).toHaveLength(1);expect(payload.entries[0].patch.title).toBe('Synthetic rejected edit');expect(JSON.stringify(payload)).not.toContain('SYNTHETIC HELD PRIVATE COPY');
  // Fixture cleanup removes only these exact test envelopes, never real work.
  await page.evaluate(async suffix=>{const r=indexedDB.open('workspace-'+localStorage.getItem('ws_uid'));await new Promise((resolve,reject)=>{r.onsuccess=resolve;r.onerror=()=>reject(r.error);});const d=r.result;try{await new Promise((resolve,reject)=>{const t=d.transaction(['outbox','accessQuarantine','accessQuarantineInfo'],'readwrite');for(const table of ['outbox','accessQuarantine','accessQuarantineInfo']){const request=t.objectStore(table).openCursor();request.onsuccess=()=>{const c=request.result;if(!c)return;if(c.value.id==='rel-held-'+suffix||c.value.id==='rel-rejected-'+suffix)c.delete();c.continue();};}t.oncomplete=resolve;t.onerror=()=>reject(t.error);});}finally{d.close();}},f.suffix);
 }finally{await cleanup(f);}
});
