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
export const test=base.extend({page:async({page,context,browser,browserName},use,info)=>{
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin.origin?route.continue():route.abort());
  await context.addInitScript(a=>{localStorage.setItem('ws_token',a.token);localStorage.setItem('ws_uid',a.user.id);localStorage.setItem('ws_user',JSON.stringify(a.user));localStorage.setItem('ws_theme','system');},fixture.admin);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await info.attach('runtime.json',{body:JSON.stringify({engine:browserName,version:browser.version(),viewport:info.project.use.viewport,colorScheme:info.project.use.colorScheme,deviceScaleFactor:info.project.use.deviceScaleFactor,hasTouch:info.project.use.hasTouch,physicalDevice:false}),contentType:'application/json'});
  await use(page);
  expect(errors,'Uncaught browser errors').toEqual([]);
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
