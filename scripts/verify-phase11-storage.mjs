#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {chromium, firefox, webkit} from 'playwright';
import {createCertificationReporter} from './certification-report.mjs';
import {api, bootstrap, eventually, pull, push, startFixture} from './phase4-fixture.mjs';

const engines = {chromium, firefox, webkit};
const selected = process.argv.find(arg => arg.startsWith('--only='))?.slice(7);
if (selected && !engines[selected]) throw new Error('Unknown browser');
const browserEntries = Object.entries(engines).filter(([engine]) => !selected || engine === selected);
const profiles = {compact: 390, tablet: 768, desktop: 1440};
const journey = 'Offline browser upload, R2 preview, public share and deletion';
const output = process.env.CERT_ARTIFACT_DIR ?? '.artifacts/phase11/browser';
process.env.CERT_ARTIFACT_DIR = output;
process.env.CERT_RESULT_PATH = join(output, 'results.json');
process.env.CERT_SOURCE_SHA = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
const reporter = createCertificationReporter('phase11-storage', browserEntries.flatMap(([engine]) =>
  Object.keys(profiles).map(profile => `${engine}/${profile}/${journey}`)));
const fixture = await startFixture({port: Number(process.env.CERT_FIXTURE_PORT ?? 8811), build: false, artifactDirectory: output, r2: true});
reporter.setMetadata('storage', 'Disposable Wrangler local R2 with local D1 staging');
reporter.setMetadata('offlineSimulation', {chromium:'Playwright offline context',firefox:'Playwright offline context',webkit:'Blocked API transport because native offline emulation makes locally selected files unreadable'});
reporter.setMetadata('fixtureId', fixture.fixtureId);
const {base} = fixture;
const {admin} = await bootstrap(base);
mkdirSync(output, {recursive:true});
const image = resolve(output, 'storage.png');
writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xz1sAAAAASUVORK5CYII=', 'base64'));

try {
  for (const [engine, browserType] of browserEntries) {
    const browser = await reporter.trackBrowser(await browserType.launch(), engine);
    try {
      for (const [profile, width] of Object.entries(profiles)) {
        const context = await browser.newContext({
          viewport:{width,height:900},
          hasTouch:profile==='compact',
          ...(engine === 'webkit' ? {serviceWorkers:'block'} : {}),
        });
        let blocked = false;
        if (engine === 'webkit') {
          await context.route('**/api/**', route => blocked ? route.abort('internetdisconnected') : route.continue());
        }
        const id = `r2-${engine}-${profile}`;
        await reporter.run(`${engine}/${profile}/${journey}`, engine, profile, async () => {
          const update = changes => push(base, admin.token, changes);
          await update([
            {id, collection:'boards', patch:{name:id, columns:[{id:'open', name:'Open'}]}},
            {id:id+'-task', collection:'tasks', patch:{title:'Storage test', boardId:id, status:'open'}},
            {id:id+'-share', collection:'pages', patch:{title:'Attachment share'}},
          ]);
          await context.addInitScript(({token, user}) => {
            localStorage.setItem('ws_token', token);
            localStorage.setItem('ws_user', JSON.stringify(user));
            localStorage.setItem('ws_uid', user.id);
          }, admin);
          const page = await context.newPage();
          await page.goto(`${base}/boards/${id}/tasks/${id}-task`);
          const addPhoto = page.getByRole('button', {name:'Add photo'});
          await addPhoto.waitFor();
          if (engine === 'webkit') blocked = true;
          else await context.setOffline(true);
          const [chooser] = await Promise.all([page.waitForEvent('filechooser'), addPhoto.click()]);
          await chooser.setFiles(image);
          const deletePhoto = page.getByRole('button', {name:'Delete image'});
          await deletePhoto.waitFor();
          assert.ok(!(await pull(base, admin.token)).some(row => row.collection==='files' && row.data.parentId===id+'-task'));
          const completed = page.waitForResponse(response =>
            /\/api\/files\/[^/]+\/complete$/.test(response.url()) && response.ok());
          if (engine === 'webkit') {
            blocked = false;
            await page.evaluate(() => window.dispatchEvent(new Event('online')));
          } else {
            await context.setOffline(false);
          }
          await completed;
          const file = await eventually(async () => {
            const record = (await pull(base, admin.token)).find(row =>
              row.collection==='files' && row.data.parentId===id+'-task' && row.data.kind==='image');
            if (!record) return;
            const response = await context.request.get(`${base}/api/files/${record.id}`, {headers:{Authorization:`Bearer ${admin.token}`}});
            if (response.ok()) return {id:record.id, bytes:await response.body()};
          }, {timeout:30_000});
          assert.match(file.id, /^[a-zA-Z0-9_-]+$/);
          const location = (await fixture.sql(`SELECT storage,sha256 FROM files WHERE id='${file.id}'`))[0].results[0];
          assert.equal(location.storage, 'r2');
          assert.match(location.sha256, /^[a-f0-9]{64}$/);

          await update([{id:id+'-block', collection:'blocks', patch:{pageId:id+'-share', type:'file', fileId:file.id, order:'a0'}}]);
          const share = await api(base, '/api/shares', {token:admin.token, method:'POST', body:{pageId:id+'-share'}});
          assert.equal(share.status, 200);
          const visitor = await browser.newContext({viewport:{width,height:900}});
          try {
            const publicPage = await visitor.newPage();
            await publicPage.goto(`${base}/s/${share.data.token}`);
            const open = publicPage.getByRole('link', {name:'Open', exact:true});
            await open.waitFor();
            const response = await visitor.request.get(new URL(await open.getAttribute('href'), base).href);
            assert.equal(response.status(), 200);
            assert.deepEqual(await response.body(), file.bytes);
          } finally { await visitor.close(); }

          await update([{id:id+'-block', collection:'blocks', patch:{deleted:true}}]);
          await deletePhoto.click();
          await deletePhoto.waitFor({state:'hidden'});
          await eventually(async () => (await pull(base, admin.token)).find(row=>row.id===file.id)?.data.deleted===true);
          const retained = (await fixture.sql(`SELECT (SELECT COUNT(*) FROM files WHERE id='${file.id}') metadata,
            (SELECT COUNT(*) FROM file_storage_jobs WHERE file_id='${file.id}' AND operation='delete') pending`))[0].results[0];
          assert.deepEqual(retained, {metadata:0, pending:1});
          const time = (Math.floor(Date.now()/900_000/10)*10+5)*900_000;
          const scheduled = await fetch(`${base}/cdn-cgi/handler/scheduled?` + new URLSearchParams({cron:'*/15 * * * *',time:String(time)}));
          assert.equal(scheduled.status, 200);
          const cleaned = (await fixture.sql(`SELECT COUNT(*) AS pending FROM file_storage_jobs WHERE file_id='${file.id}'`))[0].results[0];
          assert.equal(cleaned.pending, 0);
          await page.screenshot({path:join(output, id+'.png')});
          reporter.record(engine, profile, journey, 'PASS');
          console.log(`PASS [${engine}/${profile}] ${journey}`);
        });
        await context.close();
      }
    } finally { await browser.close(); }
  }
} finally { await fixture.stop(); }
const report = reporter.finish();
console.log(`${report.summary.pass} PASS / ${report.summary.fail} FAIL`);
