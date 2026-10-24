#!/usr/bin/env node
// Additional release viewport acceptance, using the existing disposable Worker
// and fail-closed reporter. This complements (does not replace) Phase 0–6 journeys.
import assert from 'node:assert/strict';
import {assertControlGeometry} from './control-geometry.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium,firefox,webkit} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {WCAG_AA_TAGS} from './accessibility-tags.mjs';
import {startFixture,bootstrap,push,eventually} from './phase4-fixture.mjs';
import {freePort,fingerprint} from './certification/core.mjs';
import {createCertificationReporter} from './certification-report.mjs';
const engines={chromium,firefox,webkit},only=process.argv.find(a=>a.startsWith('--only='))?.slice(7);
if(only&&!engines[only])throw new Error('Unknown required browser engine');
const widths=[320,390,430,768,1024,1440],selected=Object.entries(engines).filter(([e])=>!only||e===only);
const output=resolve(process.env.CERT_ARTIFACT_DIR??`.artifacts/release-candidate/frontend-${new Date().toISOString().replaceAll(':','-')}`);
mkdirSync(output,{recursive:true});process.env.CERT_ARTIFACT_DIR=output;process.env.CERT_RESULT_PATH??=join(output,'results.json');
process.env.CERT_SOURCE_SHA??=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const initialFingerprint=fingerprint(process.cwd());
const reporter=createCertificationReporter('verify-release-ui',selected.flatMap(([engine])=>widths.map(width=>`${engine}/${width}x900/core release UI`)));
reporter.setMetadata('permissionMode','ENABLED');reporter.setMetadata('sourceFingerprint',initialFingerprint);
reporter.setMetadata('scope','Rendered shell, settings, AI library and search; keyboard/touch/reflow. Physical devices, native zoom and manual assistive technology are external checks.');
let fixture;
try{
 fixture=await startFixture({port:await freePort(),build:!process.argv.includes('--skip-build'),artifactDirectory:join(output,'fixture')});
 process.env.CERT_FIXTURE_ID=fixture.fixtureId;
 const {admin}=await bootstrap(fixture.base);
 await push(fixture.base,admin.token,[{id:'release-ui-page',collection:'pages',patch:{title:'Release acceptance journal',order:'a0'}},{id:'release-ui-body',collection:'blocks',patch:{pageId:'release-ui-page',type:'paragraph',text:'Field observations: multilingual recovery café 日本語 — source evidence remains editable.',order:'a0'}},{id:'release-ui-board',collection:'boards',patch:{name:'Release tasks',kind:'tasks',columns:[{id:'todo',name:'To do',color:'gray'},{id:'done',name:'Done',color:'green'}],fields:[],order:'a0'}},{id:'release-ui-task',collection:'tasks',patch:{title:'Release accessibility task',boardId:'release-ui-board',status:'todo',order:'a0'}}]);
 await fixture.sql('UPDATE access_state SET enabled=1 WHERE id=1');
 for(const [engine,type]of selected){
  let browser;
  try{
   browser=await type.launch({headless:true});await reporter.trackBrowser(browser,engine);
   for(const width of widths){
    const size=`${width}x900`,name='core release UI',started=performance.now();let context,page;const errors=[],accessibility=[];
    try{
     // Safari autozooms focused form controls below 16px. Check the shared
     // unauthenticated input surface as well as the already signed-in shell.
     const loginContext=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
     try{const loginPage=await loginContext.newPage();await loginPage.goto(fixture.base);await loginPage.getByRole('textbox',{name:'Username',exact:true}).waitFor();
      const fontSizes=await loginPage.locator('input').evaluateAll(nodes=>nodes.map(e=>Number.parseFloat(getComputedStyle(e).fontSize)));
      assert.ok(fontSizes.length>=2,'Login exposes username and password controls');
      if(width<640)assert.ok(fontSizes.every(size=>size>=16),`Compact input text must prevent Safari autozoom: ${fontSizes}`);
     }finally{await loginContext.close();}
     context=await browser.newContext({viewport:{width,height:900},hasTouch:true,serviceWorkers:'block',reducedMotion:'reduce'});
     await context.addInitScript(a=>{localStorage.setItem('ws_token',a.token);localStorage.setItem('ws_uid',a.user.id);localStorage.setItem('ws_user',JSON.stringify(a.user));},admin);
     page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
     const audit=async surface=>{const scan=await new AxeBuilder({page}).withTags(WCAG_AA_TAGS).analyze();const path=join(output,`${engine}-${width}-${surface}-axe.json`);writeFileSync(path,JSON.stringify(scan,null,2));reporter.artifacts.push(path);accessibility.push(...scan.violations.map(v=>({surface,id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})));};
     const screenshot=async surface=>{await page.evaluate(async()=>{await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished));});const path=join(output,`${engine}-${width}-${surface}.png`);await page.screenshot({path,fullPage:true});reporter.artifacts.push(path);};
     const reflow=async surface=>{await assertControlGeometry(page,surface);const actual=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,main:document.querySelectorAll('main').length,positiveTabs:[...document.querySelectorAll('[tabindex]')].filter(e=>Number(e.getAttribute('tabindex'))>0).length}));assert.ok(actual.scroll<=actual.width+1,`${surface}: root overflow ${JSON.stringify(actual)}`);assert.ok(actual.main>=1,`${surface}: missing main landmark`);assert.equal(actual.positiveTabs,0,`${surface}: positive tab order`);};
     await page.goto(fixture.base+'/pages/release-ui-page');await page.getByPlaceholder('Untitled',{exact:true}).waitFor();await reflow('page');await audit('page');await screenshot('page');
     if(width<768){const menu=page.getByRole('button',{name:'Menu',exact:true});await menu.focus();await menu.press('Enter');await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(await menu.evaluate(e=>e===document.activeElement),true,'Keyboard drawer must restore trigger focus');await menu.tap();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});}
     const trigger=page.getByRole('button',{name:/^Search/}).first();await trigger.focus();await trigger.press('Enter');
     const input=page.getByRole('combobox',{name:'Search workspace',exact:true});await input.waitFor();await input.fill('Release acceptance');
     await eventually(async()=>await page.getByRole('listbox',{name:'Search results',exact:true}).getByRole('option').filter({hasText:'Release acceptance journal'}).count()>0);
     if(width<768){
      const filters=page.getByRole('button',{name:/^Filters/});assert.equal(await filters.getAttribute('aria-expanded'),'false');
      await filters.tap();assert.equal(await filters.getAttribute('aria-expanded'),'true');await page.getByRole('combobox',{name:'Search type',exact:true}).waitFor();await filters.tap();
      const previousHeight=await page.evaluate(()=>{const style=document.documentElement.style;const old=style.getPropertyValue('--vvh');style.setProperty('--vvh','362px');return old;});
      const resultBox=await page.getByRole('listbox',{name:'Search results',exact:true}).boundingBox();assert.ok(resultBox&&resultBox.height>=66,`Keyboard-height search must show a touch-sized result, got ${JSON.stringify(resultBox)}`);
      await page.evaluate(old=>document.documentElement.style.setProperty('--vvh',old),previousHeight);
     }
     await reflow('search');assert.ok(await page.evaluate(()=>[...document.querySelectorAll('.anim-fade,.anim-slide-bottom')].every(e=>getComputedStyle(e).animationName==='none')),'Reduced motion must disable overlay animations');await input.press('ArrowDown');await input.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('[role="dialog"]')),true,'Search focus must remain inside dialog');
     await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('[role="dialog"]')),true);
     await audit('search');await screenshot('search');await page.keyboard.press('Escape');await input.waitFor({state:'hidden'});assert.equal(await trigger.evaluate(e=>e===document.activeElement),true,'Search must restore trigger focus');
     await trigger.tap();await input.fill('Release acceptance');await eventually(async()=>await page.getByRole('listbox',{name:'Search results',exact:true}).getByRole('option').filter({hasText:'Release acceptance journal'}).count()>0);await page.getByRole('listbox',{name:'Search results',exact:true}).getByRole('option').filter({hasText:'Release acceptance journal'}).first().tap();await input.waitFor({state:'hidden'});assert.ok(page.url().endsWith('/pages/release-ui-page'));
     await page.goto(fixture.base+'/boards/release-ui-board/tasks/release-ui-task');await page.getByRole('textbox',{name:'Task title',exact:true}).waitFor();
     for(const name of ['Board','Stage','Priority','Assignee'])await page.getByRole('combobox',{name,exact:true}).waitFor();
     await page.getByLabel('Due date',{exact:true}).waitFor();const nextPriority=widths.indexOf(width)%2?'medium':'high';await page.getByRole('combobox',{name:'Priority',exact:true}).selectOption(nextPriority);await eventually(async()=>await page.getByRole('combobox',{name:'Priority',exact:true}).inputValue()===nextPriority);
     await reflow('task detail');await audit('task-detail');await screenshot('task-detail');
     await page.goto(fixture.base+'/settings');await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();await page.getByRole('heading',{name:'AI connectors',exact:true}).waitFor();await reflow('settings');await audit('settings');await screenshot('settings');
     await page.goto(fixture.base+'/ai');await page.getByRole('heading',{name:'AI workflows',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Copy instructions',exact:true}).count(),7);await page.getByRole('heading',{name:'Optional AI and budget',exact:true}).waitFor();await reflow('AI workflows');await audit('ai');await screenshot('ai');
     await page.goto(fixture.base+'/inbox');await page.getByRole('heading',{name:'Inbox',exact:true}).waitFor();await reflow('Inbox');await audit('inbox');
     if(width===320||width===1440){await page.emulateMedia({colorScheme:'dark'});for(const [surface,path,heading]of [['page','/pages/release-ui-page',null],['task-detail','/boards/release-ui-board/tasks/release-ui-task',null],['settings','/settings','Settings'],['ai','/ai','AI workflows'],['inbox','/inbox','Inbox']]){await page.goto(fixture.base+path);if(heading)await page.getByRole('heading',{name:heading,exact:true}).waitFor();else if(surface==='task-detail')await page.getByRole('textbox',{name:'Task title',exact:true}).waitFor();else await page.getByPlaceholder('Untitled',{exact:true}).waitFor();await reflow(surface+' dark');await audit(surface+'-dark');await screenshot(surface+'-dark');}}
     assert.deepEqual(errors,[],'No uncaught browser errors');
     assert.deepEqual(accessibility,[],'Automated applicable WCAG A/AA rules must pass');
     reporter.record(engine,size,name,'PASS',null,{durationMs:Math.round(performance.now()-started),permissionMode:'ENABLED'});console.log(`PASS [${engine}/${size}] ${name}`);
    }catch(error){reporter.record(engine,size,name,'FAIL',error,{durationMs:Math.round(performance.now()-started)});console.error(`FAIL [${engine}/${size}] ${error.message}`);}
    finally{await context?.close().catch(()=>{});}
   }
  }catch(error){reporter.record(engine,'none','browser launch/setup','FAIL',error);}
  finally{await browser?.close().catch(()=>{});}
 }
 assert.equal(fingerprint(process.cwd()),initialFingerprint,'Source changed during rendered acceptance');
}catch(error){reporter.record('system','none','fixture/source integrity','FAIL',error);}
finally{await fixture?.stop().catch(()=>{});}
const result=reporter.finish();writeFileSync(join(output,'scope.json'),JSON.stringify({fixture:'Disposable built local Worker/D1',permissionMode:'ENABLED',widths,physicalDevices:'NOT RUN',nativeZoom:'NOT RUN',manualScreenReaders:'NOT RUN'},null,2));console.log(`${result.status}: ${result.summary.pass} PASS / ${result.summary.fail} FAIL; ${output}`);
