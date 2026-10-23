import {readFileSync} from 'node:fs';
import {test as base,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {assertControlGeometry} from '../control-geometry.mjs';
export {expect};
export const fixture=JSON.parse(readFileSync(process.env.UX_FIXTURE,'utf8'));
const origin=new URL(fixture.base);
if(origin.protocol!=='https:'||!['127.0.0.1','localhost'].includes(origin.hostname)||fixture.disposable!==true)throw new Error('UX lab requires its owned disposable loopback HTTPS fixture');
export async function request(path,body,method='POST'){
  const response=await fetch(fixture.base+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+fixture.admin.token},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();expect(response.status,JSON.stringify(data)).toBe(200);return data;
}
export async function readRecord(id){
  const manifest=await request('/api/access',undefined,'GET');
  let cursor=0,joining=manifest.spaces.map(s=>({space:s.id,after:0,base:0}));
  for(let page=0;page<20;page++){
    const reply=await request('/api/sync/pull',{protocol:3,etag:manifest.etag,cursor,joining,limit:500});
    const row=reply.records.find(r=>r.id===id);if(row)return row;
    if(!reply.hasMore)return null;
    cursor=reply.cursor;joining=reply.joining;
  }
  throw new Error('Disposable UX data exceeded the bounded verification scan');
}
export async function setOfflineForTest(page,context,offline){
  if(offline)page._uxFaultWindows.push({start:Date.now(),end:Infinity,pending:[...page._uxPending.keys()].map(r=>r.url())});
  await context.setOffline(offline);
  if(!offline){const active=page._uxFaultWindows.at(-1);if(active?.end===Infinity)active.end=Date.now();}
}
export const test=base.extend({page:async({page,context,browser,browserName},use,info)=>{
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin.origin?route.continue():route.abort());
  await context.addInitScript(a=>{localStorage.setItem('ws_token',a.token);localStorage.setItem('ws_uid',a.user.id);localStorage.setItem('ws_user',JSON.stringify(a.user));localStorage.setItem('ws_theme','system');},fixture.admin);
  const errors=[],failedRequests=[],unhandled=[],navigations=[],pending=new Map();page._uxFaultWindows=[];page._uxPending=pending;
  for(const method of ['goto','reload']){
    const original=page[method].bind(page);
    page[method]=(...args)=>{navigations.push({time:Date.now(),pending:[...pending.keys()].map(r=>r.url()),method});return original(...args);};
  }
  await page.exposeFunction('__uxUnhandled',message=>unhandled.push(message));
  await context.addInitScript(()=>{
    addEventListener('unhandledrejection',e=>{void globalThis.__uxUnhandled(String(e.reason?.stack??e.reason)).catch(()=>{});});
    addEventListener('error',e=>{if(e.message)void globalThis.__uxUnhandled(e.error?.stack??e.message).catch(()=>{});});
  });
  page.on('pageerror',e=>errors.push({message:e.message,stack:e.stack,time:Date.now()}));
  page.on('requestfailed',r=>{failedRequests.push({url:r.url(),time:Date.now(),reason:r.failure()?.errorText});pending.delete(r);});
  page.on('requestfinished',r=>pending.delete(r));
  page.on('request',r=>{
    if(r.isNavigationRequest()&&r.resourceType()==='document')navigations.push({time:Date.now(),pending:[...pending.keys()].map(r=>r.url())});
    pending.set(r,Date.now());
    const fault=page._uxFaultWindows.at(-1);if(fault?.end===Infinity)fault.pending.push(r.url());
  });
  await info.attach('runtime.json',{body:JSON.stringify({engine:browserName,version:browser.version(),viewport:info.project.use.viewport,colorScheme:info.project.use.colorScheme,deviceScaleFactor:info.project.use.deviceScaleFactor,hasTouch:info.project.use.hasTouch,physicalDevice:false}),contentType:'application/json'});
  await use(page);
  // Playwright WebKit 1.63 maps javascript-source console errors to pageerror
  // (wkPage._onConsoleMessage), including handled offline Fetch refusals.
  // Correlate only exact local failed requests in our explicit fault windows.
  // Real window errors/rejections and all unmatched diagnostics still fail.
  const expected=errors.filter(e=>{
    if(browserName!=='webkit'||!e.stack?.startsWith('Fetch API cannot load '+fixture.base+'/api/')||!e.stack.includes('due to access control checks.'))return false;
    const injected=failedRequests.some(r=>e.stack.includes(r.url)&&Math.abs(r.time-e.time)<1000&&page._uxFaultWindows.some(w=>r.time>=w.start-50&&r.time<=w.end+200));
    // WebKit may cancel an entire old document's request group without emitting
    // requestfailed for every member. Only known read-only API diagnostics
    // that were already in flight when the old document navigated are expected.
    // New-document CORS failures cannot match this retained request snapshot.
    const cancelledRead=/^Fetch API cannot load https:\/\/[^ ]+\/api\/(?:notifications\/badge|approvals|access|sync\/pull)(?:\?| )/.test(e.stack)&&navigations.some(n=>e.time>=n.time-20&&e.time<=n.time+200&&n.pending.some(url=>e.stack.startsWith('Fetch API cannot load '+url+' due to access control checks.')));
    const injectedGroup=page._uxFaultWindows.some(w=>e.time>=w.start-20&&e.time<=w.end+300&&w.pending.some(url=>e.stack.startsWith('Fetch API cannot load '+url+' due to access control checks.')));
    return injected||injectedGroup||cancelledRead;
  });
  // A WebKit console diagnostic can be emitted before a failed request enters
  // Playwright's network stream. For the remaining read-only diagnostics (GET reads and protocol-3 POST pull),
  // require actual recovery in this browser, rather than hiding them by timing.
  const recoveredReads=[];
  const candidates=browserName==='webkit'?errors.filter(e=>!expected.includes(e)).map(e=>({e,url:e.stack?.match(/^Fetch API cannot load (https:\/\/[^ ]+\/api\/(?:access|notifications\/badge|approvals|sync\/pull)(?:\?[^ ]*)?) due to access control checks\./)?.[1]})).filter(x=>x.url&&new URL(x.url).origin===origin.origin):[];
  const urls=[...new Set(candidates.map(x=>x.url))];
  expect(urls.length,'Bounded read recovery verification').toBeLessThanOrEqual(20);
  for(const url of urls){
    const recovery=await page.evaluate(async url=>{
      if(!navigator.onLine)return {online:false,status:0};
      try{
        const headers={Authorization:'Bearer '+localStorage.getItem('ws_token')};
        if(new URL(url).pathname==='/api/sync/pull'){
          const manifestResponse=await fetch('/api/access',{headers});
          if(!manifestResponse.ok)return {online:true,status:manifestResponse.status};
          const manifest=await manifestResponse.json();
          if(manifest.protocol!==3||!Array.isArray(manifest.spaces))return {online:true,status:0};
          const body={protocol:3,etag:manifest.etag,cursor:0,joining:manifest.spaces.map(s=>({space:s.id,after:0,base:0})),limit:1};
          return {online:true,status:(await fetch(url,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)})).status};
        }
        return {online:true,status:(await fetch(url,{headers})).status};
      }
      catch{return {online:true,status:0};}
    },url);
    recoveredReads.push({url,...recovery});
    expect(recovery,'Handled WebKit read diagnostic must recover in the browser: '+url).toEqual({online:true,status:200});
    expected.push(...candidates.filter(x=>x.url===url).map(x=>x.e));
  }
  await info.attach('injected-network-diagnostics.json',{body:JSON.stringify({expected,recoveredReads,failedRequests,faultWindows:page._uxFaultWindows,navigations},null,2),contentType:'application/json'});
  expect(unhandled,'Unhandled JavaScript errors/rejections, including injected-fault paths').toEqual([]);
  expect(errors.filter(e=>!expected.includes(e)),'Unmatched browser errors').toEqual([]);
}});
export async function open(page,surface){
  await page.goto(fixture.base+surface.path);
  const ready=surface.ready.placeholder?page.getByPlaceholder(surface.ready.placeholder,{exact:true}):page.getByRole(surface.ready.role,{name:surface.ready.name,exact:true});
  await expect(ready.first()).toBeVisible();
  await page.evaluate(()=>document.fonts.ready);
}
export async function health(page,label,info,{axe=true}={}){
  // An asset transport failure is a failed render, not a collection of misleading
  // accessibility results against an unstyled document. Never retry tests to pass.
  expect(await page.evaluate(()=>getComputedStyle(document.body).fontFamily),label+': stylesheet must load').toContain('Inter');
  await assertControlGeometry(page,label);
  const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,positiveTabs:document.querySelectorAll('[tabindex]').length&&[...document.querySelectorAll('[tabindex]')].filter(e=>Number(e.getAttribute('tabindex'))>0).length}));
  expect(layout.scroll,`${label}: root overflow`).toBeLessThanOrEqual(layout.width+1);
  expect(layout.positiveTabs,`${label}: positive tabindex`).toBe(0);
  if(axe){
    const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
    await info.attach(`${label}-axe`,{body:JSON.stringify(result.violations,null,2),contentType:'application/json'});
    expect(result.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),label+' whole-page accessibility').toEqual([]);
  }
}
