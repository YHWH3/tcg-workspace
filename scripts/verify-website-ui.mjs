#!/usr/bin/env node
// Website section browser check (docs/integrations/the-common-ground.md §5).
// Builds the app, runs it on a disposable local Worker with the TEST-ONLY
// ingest secret from the integration doc (`local-test`), sends signed website
// events, then checks /website in Chromium, Firefox and WebKit at compact,
// tablet and desktop sizes: render, reflow (no root horizontal scroll),
// keyboard disclosure, the compact menu, dark mode and automated WCAG 2.2 A/AA
// rules (axe). Manual assistive technology and physical devices stay external.
//   node scripts/verify-website-ui.mjs [--skip-build] [--only=chromium|firefox|webkit]
//   node scripts/verify-website-ui.mjs --serve [--skip-build] [--port=8788]
//     Joint-test mode (integration doc §7): a fresh disposable built Worker with
//     the test-only ingest settings, admin + bob bootstrapped, NO events sent;
//     stays up until Ctrl-C. Point the relay's FORWARD_URL at it.
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium,firefox,webkit} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {startFixture,bootstrap,eventually} from './phase4-fixture.mjs';
import {freePort} from './certification/core.mjs';

const SECRET='local-test'; // the integration doc's local-only test value; never a deployed secret
const engines={chromium,firefox,webkit},only=process.argv.find(a=>a.startsWith('--only='))?.slice(7);
const viewports=[{name:'compact',width:390,height:844},{name:'tablet',width:820,height:1180},{name:'desktop',width:1280,height:800}];
const output=resolve(process.env.CERT_ARTIFACT_DIR??`.artifacts/website-ui-${new Date().toISOString().replaceAll(':','-')}`);
mkdirSync(output,{recursive:true});

async function sendEvent(base,body){
  const raw=JSON.stringify(body),ts=String(Math.floor(Date.now()/1000));
  const response=await fetch(base+'/api/ingest/website',{method:'POST',headers:{'Content-Type':'application/json','X-TCG-Timestamp':ts,'X-TCG-Signature':'sha256='+createHmac('sha256',SECRET).update(`${ts}.${raw}`).digest('hex')},body:raw});
  const json=await response.json();assert.equal(response.status,200,JSON.stringify(json));return json;
}
const CONSULTING={id:'consulting',title:'Project application',family:'consulting',fields:[{name:'Name',label:'Your name',type:'text',required:true},{name:'Email',label:'Email',type:'email',required:true},{name:'Building',label:'What are you building?',type:'choices',options:['Primary home','Retreat or studio','Community education or arts space']},{name:'Why',label:'Why',type:'textarea'}]};
const PATRON={id:'patron',title:'Patron application',family:'patrons',fields:[{name:'Name',label:'Your name',type:'text',required:true},{name:'Email',label:'Email',type:'email',required:true},{name:'Edition',label:'The edition you are interested in',type:'choice',options:['Founding Patron','Builder Patron','Partner Patron']}]};

if(process.argv.includes('--serve')){
  const port=Number(process.argv.find(a=>a.startsWith('--port='))?.slice(7)??8788);
  const fixture=await startFixture({port,build:!process.argv.includes('--skip-build'),artifactDirectory:join(output,'fixture'),vars:{WEBSITE_INGEST_SECRET:SECRET,WEBSITE_INGEST_ENABLED:'true'}});
  await bootstrap(fixture.base);
  // Prove the endpoint is wired without writing anything.
  assert.equal((await fetch(fixture.base+'/api/ingest/website',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const ts=String(Math.floor(Date.now()/1000));
  assert.equal((await fetch(fixture.base+'/api/ingest/website',{method:'POST',headers:{'Content-Type':'application/json','X-TCG-Timestamp':ts,'X-TCG-Signature':'sha256='+createHmac('sha256',SECRET).update(`${ts}.{}`).digest('hex')},body:'{}'})).status,400);
  console.log(`READY ${fixture.base}  ingest: ${fixture.base}/api/ingest/website  (unsigned → 401, signed {} → 400; inbox empty)`);
  console.log('Sign in as the fixture admin or bob (credentials in scripts/phase4-fixture.mjs). State is disposable: '+fixture.state);
  await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  await fixture.stop();process.exit(0);
}
const results=[];let fixture;
try{
  fixture=await startFixture({port:await freePort(),build:!process.argv.includes('--skip-build'),artifactDirectory:join(output,'fixture'),vars:{WEBSITE_INGEST_SECRET:SECRET,WEBSITE_INGEST_ENABLED:'true'}});
  const {admin}=await bootstrap(fixture.base);
  assert.equal((await fetch(fixture.base+'/api/admin/website-ingest',{method:'PUT',headers:{Authorization:'Bearer '+admin.token,'Content-Type':'application/json'},body:JSON.stringify({spaceId:'space-core'})})).status,200);
  const at=()=>new Date().toISOString();
  await sendEvent(fixture.base,{v:2,id:'ui-form-1',event:'form.submitted',occurred_at:at(),form_id:'consulting',subject:'Project application',page:'/consulting/',reply_to:'asha@example.org',form:CONSULTING,
    answers:[{name:'Name',label:'Your name',value:'Asha Menon'},{name:'Email',label:'Email',value:'asha@example.org'},{name:'Building',label:'What are you building?',value:'Retreat or studio, Community education or arts space'},{name:'Why',label:'Why',value:'A long answer that should wrap cleanly on a phone screen without making the page scroll sideways at all, even with averyveryverylongwordwithoutanyspacesinsideit.'}]});
  const patron={application_id:'pa_ui',tier:'founding',currency:'inr',amount_display:'₹85,000',edition:null,tx:null,token_id:null};
  await sendEvent(fixture.base,{v:2,id:'pa_ui:patron.applied',event:'patron.applied',occurred_at:at(),form_id:'patron',subject:'Patron application',page:'/patron/',reply_to:'ravi@example.org',form:PATRON,answers:[{name:'Name',label:'Your name',value:'Ravi Kumar'},{name:'Email',label:'Email',value:'ravi@example.org'},{name:'Edition',label:'Edition',value:'Founding Patron'}],patron});
  for(const event of ['patron.approved','patron.paid','patron.minted']) await sendEvent(fixture.base,{v:2,id:`pa_ui:${event}`,event,occurred_at:at(),form_id:'patron',subject:'Patron application',page:'/patron/',reply_to:'ravi@example.org',answers:[],patron:{...patron,...(event==='patron.minted'?{edition:12,token_id:'1000012',tx:'0xabc'}:{})}});

  for(const [engine,type] of Object.entries(engines).filter(([e])=>!only||e===only)){
    const browser=await type.launch({headless:true});
    try{
      for(const vp of viewports){
        const started=performance.now(),errors=[],violations=[],outside=[];let context;
        try{
          context=await browser.newContext({viewport:{width:vp.width,height:vp.height},hasTouch:vp.name!=='desktop',serviceWorkers:'block',reducedMotion:'reduce'});
          await context.addInitScript(a=>{localStorage.setItem('ws_token',a.token);localStorage.setItem('ws_uid',a.user.id);localStorage.setItem('ws_user',JSON.stringify(a.user));},admin);
          const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
          // Both the section and its shared shell are required accessibility surfaces.
          const audit=async surface=>{const tags=['wcag2a','wcag2aa','wcag21aa','wcag22aa'];const scan=await new AxeBuilder({page}).include('main').withTags(tags).analyze();const whole=await new AxeBuilder({page}).withTags(tags).analyze();writeFileSync(join(output,`${engine}-${vp.name}-${surface}-axe.json`),JSON.stringify({section:scan.violations,wholePage:whole.violations},null,2));violations.push(...whole.violations.map(v=>({surface,id:v.id,impact:v.impact,targets:v.nodes.map(n=>n.target)})));outside.push(...whole.violations.filter(v=>!scan.violations.some(s=>s.id===v.id)).map(v=>({surface,id:v.id,html:v.nodes.map(n=>n.html.slice(0,160))})));};
          const reflow=async surface=>{const m=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(m.scroll<=m.width+1,`${surface}: root horizontal overflow ${JSON.stringify(m)}`);};
          // Arrive the way the website sends people: /notion/... lands on the same route.
          await page.goto(fixture.base+'/notion/website');
          await page.getByRole('heading',{level:1,name:'Website'}).waitFor();
          assert.equal(new URL(page.url()).pathname,'/website');
          await eventually(async()=>await page.getByRole('link',{name:/Project application · Asha Menon/}).count()>0,{timeout:30000});
          for(const h of ['New this week','Patron applications','Time to first reply','Oldest unanswered','Views','AI help (optional)']) await page.getByRole('heading',{level:2,name:h}).waitFor();
          assert.match(await page.getByRole('region',{name:'Patron applications'}).innerText(),/99 of 100 left/);
          // Keyboard disclosure on the family count.
          const consulting=page.getByRole('button',{name:/^Consulting/});await consulting.focus();await page.keyboard.press('Enter');
          assert.equal(await consulting.getAttribute('aria-expanded'),'true');
          await page.getByRole('region',{name:'New this week'}).getByRole('link',{name:/Asha Menon/}).waitFor();
          await reflow('website');await audit('website');
          await page.screenshot({path:join(output,`${engine}-${vp.name}-website.png`),fullPage:true});
          if(vp.name==='compact'){
            assert.equal(await page.locator('nav').filter({has:page.getByRole('link',{name:'Quick capture'})}).getByRole('link',{name:'Website'}).count(),0,'compact tab bar stays short');
            await page.getByRole('button',{name:'Menu',exact:true}).click();await page.getByRole('dialog').getByRole('link',{name:'Website',exact:true}).waitFor();await page.keyboard.press('Escape');
          }
          await page.emulateMedia({colorScheme:'dark'});await page.reload();await page.getByRole('heading',{level:1,name:'Website'}).waitFor();
          await eventually(async()=>await page.getByRole('link',{name:/Asha Menon/}).count()>0,{timeout:30000});
          await reflow('website dark');await audit('website-dark');await page.screenshot({path:join(output,`${engine}-${vp.name}-website-dark.png`),fullPage:true});
          await page.emulateMedia({colorScheme:'light'});
          // The pipeline board view opens from the Views card.
          await page.getByRole('link',{name:'Patron pipeline'}).click();await page.waitForURL(/view-wi-pipeline/);
          await eventually(async()=>await page.getByText('Patron application · Ravi Kumar').count()>0,{timeout:30000});
          await reflow('pipeline');
          assert.deepEqual(errors,[],'no uncaught browser errors');
          assert.deepEqual(violations,[],`automated WCAG A/AA rules: ${JSON.stringify(violations).slice(0,800)}`);
          results.push({engine,viewport:`${vp.width}x${vp.height}`,name:vp.name,status:'PASS',ms:Math.round(performance.now()-started),outsideSection:outside});console.log(`PASS ${engine} ${vp.name} ${vp.width}x${vp.height}`);
        }catch(error){results.push({engine,viewport:`${vp.width}x${vp.height}`,name:vp.name,status:'FAIL',error:String(error.message??error).slice(0,1200)});console.error(`FAIL ${engine} ${vp.name}: ${String(error.message??error).slice(0,600)}`);}
        finally{await context?.close().catch(()=>{});}
      }
    }finally{await browser.close();}
  }
}finally{
  writeFileSync(join(output,'results.json'),JSON.stringify(results,null,2));
  await fixture?.stop?.();
  console.log(`Artifacts: ${output}`);
}
process.exitCode=results.length&&results.every(r=>r.status==='PASS')?0:1;
