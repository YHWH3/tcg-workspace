import {test, expect, open, health, request, readRecord, fixture, setOfflineForTest} from './support.mjs';
import {readAccountStore} from '../certification/browser-db.mjs';

test('Sync conflicts: two offline devices, retained value, guarded recovery and dismissal', async ({page,context,browser}, info) => {
  const id='conflict-'+info.project.name.replaceAll('-','')+Date.now();
  const other=await browser.newContext({...info.project.use,ignoreHTTPSErrors:true});
  await other.route('**/*',route=>new URL(route.request().url()).origin===new URL(fixture.base).origin?route.continue():route.abort());
  await other.addInitScript(a=>{localStorage.setItem('ws_token',a.token);localStorage.setItem('ws_uid',a.user.id);localStorage.setItem('ws_user',JSON.stringify(a.user));localStorage.setItem('ws_theme','system');},fixture.admin);
  const second=await other.newPage(), otherErrors=[], otherUnhandled=[], otherFaults=[], pending=new Set();
  second.on('pageerror',e=>otherErrors.push({stack:e.stack??e.message,at:Date.now()}));
  second.on('request',r=>{pending.add(r.url());const fault=otherFaults.at(-1);if(fault?.end===Infinity)fault.urls.add(r.url());});
  second.on('requestfinished',r=>pending.delete(r.url()));second.on('requestfailed',r=>pending.delete(r.url()));
  await second.exposeFunction('__otherUnhandled',message=>otherUnhandled.push(message));
  await other.addInitScript(()=>{addEventListener('unhandledrejection',e=>void globalThis.__otherUnhandled(String(e.reason?.stack??e.reason)));});
  const otherOffline=async offline=>{if(offline)otherFaults.push({start:Date.now(),end:Infinity,urls:new Set(pending)});await other.setOffline(offline);if(!offline&&otherFaults.at(-1)?.end===Infinity)otherFaults.at(-1).end=Date.now();};
  const seed = async patch => expect((await request('/api/sync/push',{protocol:3,changes:[{id,collection:'pages',patch,ts:Date.now()}]})).rejectedItems).toEqual([]);
  await seed({title:'Shared original'});
  const surface={id:'conflict-page',path:'/pages/'+id,ready:{placeholder:'Untitled'}};
  try {
    await open(page,surface);await open(second,surface);
    await expect(page.getByPlaceholder('Untitled',{exact:true})).toHaveValue('Shared original');
    await expect(second.getByPlaceholder('Untitled',{exact:true})).toHaveValue('Shared original');
    await setOfflineForTest(page,context,true);await otherOffline(true);
    await page.getByPlaceholder('Untitled',{exact:true}).fill('Retained device A 👩🏽‍💻');await page.getByPlaceholder('Untitled',{exact:true}).press('Tab');
    await expect.poll(async()=>(await readAccountStore(page,'outbox')).some(r=>r.id===id&&r.patch.title==='Retained device A 👩🏽‍💻')).toBe(true);
    await second.getByPlaceholder('Untitled',{exact:true}).fill('Winning device B नमस्ते');await second.getByPlaceholder('Untitled',{exact:true}).press('Tab');
    const times=await Promise.all([readAccountStore(page,'pages',{id}),readAccountStore(second,'pages',{id})]);
    expect(times[1]._ts.title).toBeGreaterThan(times[0]._ts.title);
    await otherOffline(false);
    await expect.poll(async()=>(await readRecord(id))?.data.title,{timeout:30000}).toBe('Winning device B नमस्ते');
    await setOfflineForTest(page,context,false);
    const indicator=page.getByRole('button',{name:'Review conflicting edits',exact:true});
    await expect(indicator).toBeVisible({timeout:30000});
    await indicator.press('Enter');
    const review=page.getByRole('dialog',{name:"Changes that didn't win",exact:true});
    await expect(review).toContainText('Retained device A 👩🏽‍💻');await expect(review).toContainText('Winning device B नमस्ते');
    await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});
    await review.getByRole('button',{name:'Use mine',exact:true}).scrollIntoViewIfNeeded();
    await health(page,'conflict recovery enlarged',info);
    await info.attach('conflict-review',{body:await page.screenshot(),contentType:'image/png'});
    await review.getByRole('button',{name:'Use mine',exact:true}).press('Enter');
    await expect.poll(async()=>(await readRecord(id))?.data.title,{timeout:30000}).toBe('Retained device A 👩🏽‍💻');
    await expect(review).toContainText('queued for sync');await expect(review).toContainText('No retained changes remain');
    await page.keyboard.press('Escape');await page.evaluate(()=>{document.documentElement.style.fontSize='';});
    await expect(second.getByPlaceholder('Untitled',{exact:true})).toHaveValue('Retained device A 👩🏽‍💻',{timeout:30000});
    // A second independent loss exercises dismissal through the same UI.
    await setOfflineForTest(page,context,true);
    await page.getByPlaceholder('Untitled',{exact:true}).fill('Dismissed candidate');await page.getByPlaceholder('Untitled',{exact:true}).press('Tab');
    await expect.poll(async()=>(await readAccountStore(page,'outbox')).some(r=>r.id===id&&r.patch.title==='Dismissed candidate')).toBe(true);
    await second.getByPlaceholder('Untitled',{exact:true}).fill('Keep current server');await second.getByPlaceholder('Untitled',{exact:true}).press('Tab');
    await expect.poll(async()=>(await readRecord(id))?.data.title,{timeout:30000}).toBe('Keep current server');
    await setOfflineForTest(page,context,false);await indicator.press('Enter',{timeout:30000});
    await review.getByRole('button',{name:'Dismiss',exact:true}).press('Enter');
    await expect(review).toContainText('dismissed');expect((await readRecord(id)).data.title).toBe('Keep current server');
    await page.keyboard.press('Escape');await health(page,'conflict dismissed',info);
    expect(otherUnhandled).toEqual([]);
    const expected=e=>info.project.name.startsWith('webkit-')&&e.stack.startsWith('Fetch API cannot load '+fixture.base+'/api/')&&e.stack.includes('due to access control checks.')&&otherFaults.some(w=>e.at>=w.start-20&&e.at<=w.end+300&&[...w.urls].some(url=>e.stack.startsWith('Fetch API cannot load '+url+' due to access control checks.')));
    await info.attach('secondary-device-diagnostics',{body:JSON.stringify({errors:otherErrors,faults:otherFaults.map(w=>({...w,urls:[...w.urls]}))}),contentType:'application/json'});
    expect(otherErrors.filter(e=>!expected(e))).toEqual([]);
  } finally {
    await setOfflineForTest(page,context,false);await otherOffline(false);await other.close();await seed({deleted:true});
  }
});
