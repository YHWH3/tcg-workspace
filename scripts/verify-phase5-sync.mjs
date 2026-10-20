#!/usr/bin/env node
// Built Worker + real browser storage checks. Disposable fixtures only. This
// focused suite is one Phase 5 gate; it does not certify unfinished workstreams.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { chromium, firefox, webkit } from 'playwright';
import { createCertificationReporter } from './certification-report.mjs';
import { freePort, fingerprint } from './certification/core.mjs';
import { readAccountStore } from './certification/browser-db.mjs';
import { startFixture, bootstrap, push, eventually } from './phase4-fixture.mjs';

const engines = { chromium, firefox, webkit }, selected = process.argv.find(a => a.startsWith('--only='))?.slice(7);
const names = ['legacy Core startup remains functional', 'startup gates cached views until current access is checked', 'offline edit survives browser close and is quarantined after revocation', 'regrant restores canonical content without replaying held work', 'another tab reconciles revocation before cached content reuse', 'access failure gates content and keyboard retry recovers', 'held-work review is redacted and explicit discard preserves D1', 'account replacement locks the old tab without clearing the new token'];
names.push('session controls confirm remote revocation and current-device signout', 'protocol 3 move evicts a relation and peer regrant restores it', 'protocol 3 backfill resumes after closing the browser between pages');
const reporter = createCertificationReporter('verify-phase5-sync', (selected ? [selected] : Object.keys(engines)).flatMap(engine => names.map(name => `${engine}/${name}`)));
if (selected && !engines[selected]) throw new Error('Unknown mandatory browser engine');
const output = process.env.CERT_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'tcg-phase5-sync-')); mkdirSync(output, { recursive: true });
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint = fingerprint(process.cwd());
process.env.CERT_SOURCE_SHA ??= sourceSha;
reporter.setMetadata('sourceFingerprint', sourceFingerprint);
reporter.setMetadata('workingTreeDirty', Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()));
reporter.setMetadata('responsiveWidths', [320, 390, 768, 1024, 1440]);
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
// An input can be visible and still empty while IndexedDB hydrates it (WebKit
// loses that race often). Assert the settled value, report the last one seen.
const expectValue = async (locator, expected) => {
  let last;
  try { await eventually(async () => (last = await locator.inputValue()) === expected, { timeout: 15_000 }); }
  catch { assert.equal(last, expected); }
};
// reporter.trackBrowser() already starts tracing on every context it creates when
// CERT_ARTIFACT_DIR is set (the certification harness always sets it).
const traceUnlessReported = context => process.env.CERT_ARTIFACT_DIR ? Promise.resolve() : context.tracing.start({ screenshots: true, snapshots: true });
// A gated route can outlive its request (unroute, navigation, page close). That
// rejection must never escape as an unhandled rejection that aborts the runner.
const settle = async fn => { try { await fn(); } catch { /* route already handled or page closed */ } };
let built = process.argv.includes('--skip-build');
for (const [engine, browserType] of Object.entries(engines).filter(([name]) => !selected || name === selected)) {
  let fixture, context;
  const directory = join(output, engine); mkdirSync(directory, { recursive: true });
  const profile = join(directory, 'profile');
  const check = async (name, fn) => {
    const started = performance.now(); let timer;
    try {
      await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Journey exceeded 90 seconds; inspect Worker log and browser trace')), 90_000); })]);
      reporter.record(engine, name === names[0] ? '1280x720' : name === names[3] ? '320/390/768/1024/1440' : '390x844', name, 'PASS', null, { durationMs: Math.round(performance.now() - started) }); console.log(`PASS [${engine}] ${name}`);
    } catch (error) {
      reporter.record(engine, '390x844', name, 'FAIL', error); console.error(`FAIL [${engine}] ${name}: ${error.message}`);
      for (const [i, page] of (context?.pages() ?? []).entries()) await page.screenshot({ path: join(directory, `failure-${names.indexOf(name)}-${i}.png`), fullPage: true, timeout: 5000 }).catch(() => {});
      await context?.tracing.stop({ path: join(directory, `failure-${names.indexOf(name)}.zip`) }).catch(() => {});
      // The journeys share one account/profile. In particular a timed-out
      // promise is still alive until its browser and Worker are closed. Abort
      // this engine and leave later checkpoints missing (blocking) rather than
      // running them beside an unfinished mutation. Other engines still run.
      throw error;
    } finally { clearTimeout(timer); reporter.complete(`${engine}/${name}`); }
  };
  try {
    fixture = await startFixture({ port: await freePort(), build: !built, artifactDirectory: directory }); built = true;
    const { admin, bob } = await bootstrap(fixture.base), prefix = `p5_${engine}`, pageId = `${prefix}_page`, coreId = `${prefix}_core`, space = `${prefix}_private`, originalTitle = `${engine} Private reference`, offlineTitle = `${engine} Offline confidential edit`;
    const imageId = `${prefix}_image`, thumbId = imageId + 't', blockId = `${prefix}_image_block`, caption = `${engine} Private image`;
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
    await push(fixture.base, admin.token, [{ id: coreId, collection: 'pages', patch: { title: `${engine} Core reference` } }, { id: pageId, collection: 'pages', patch: { title: originalTitle } },
      { id: blockId, collection: 'blocks', patch: { pageId, type: 'image', fileId: imageId, caption, order: 'a0' } },
      { id: imageId, collection: 'files', patch: { parentType: 'block', parentId: blockId, kind: 'image', name: 'Private fixture.png', mime: 'image/png', size: imageBytes.length, thumbId } }]);
    const sql = async query => (await fixture.sql(query)).flatMap(r => r.results ?? []);
    await sql(`INSERT INTO spaces(id,name,default_access,created_at) VALUES(${quote(space)},'Disposable private','private',1);
      INSERT INTO space_members(space_id,user_id,role) VALUES(${quote(space)},${quote(bob.user.id)},'editor');
      UPDATE users SET workspace_role='guest' WHERE id=${quote(bob.user.id)};
      UPDATE records SET space_id=${quote(space)} WHERE id IN (${[pageId, blockId, imageId].map(quote).join(',')});`);
    const start = async user => {
      context = await browserType.launchPersistentContext(profile, { headless: true, viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      await reporter.trackBrowser(context.browser(), engine);
      reporter.browserVersions[engine] = context.browser().version();
      await context.tracing.start({ screenshots: true, snapshots: true });
      await context.addInitScript(user => { if (localStorage.getItem('ws_uid')) return; localStorage.setItem('ws_token', user.token); localStorage.setItem('ws_uid', user.user.id); localStorage.setItem('ws_user', JSON.stringify(user.user)); }, user);
      const page = context.pages()[0] ?? await context.newPage(); page.setDefaultTimeout(20_000);
      page.on('pageerror', error => console.error(`[${engine}] page error: ${error.message}`));
      return page;
    };
    let page;
    await check(names[0], async () => {
      // A separate profile avoids silently changing identities in the active
      // guest profile. Both use the same built Worker and migrated D1.
      const legacy = await browserType.launch({ headless: true });
      await reporter.trackBrowser(legacy, engine);
      try {
        const c = await legacy.newContext(); await c.addInitScript(admin => { localStorage.setItem('ws_token', admin.token); localStorage.setItem('ws_uid', admin.user.id); localStorage.setItem('ws_user', JSON.stringify(admin.user)); }, admin);
        const p = await c.newPage(); await p.goto(`${fixture.base}/pages/${coreId}`);
        await p.getByPlaceholder('Untitled', { exact: true }).waitFor(); await expectValue(p.getByPlaceholder('Untitled', { exact: true }), `${engine} Core reference`);
      } finally { await legacy.close(); }
    });
    await sql('UPDATE access_state SET enabled=1 WHERE id=1');
    for (const id of [imageId, thumbId]) {
      assert.equal((await fetch(`${fixture.base}/api/files/${id}/chunks/0`, { method: 'PUT', headers: { Authorization: `Bearer ${bob.token}` }, body: imageBytes })).status, 200);
      assert.equal((await fetch(`${fixture.base}/api/files/${id}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${bob.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ chunks: 1, size: imageBytes.length, mime: 'image/png' }) })).status, 200);
      assert.equal((await fetch(`${fixture.base}/api/files/${id}`, { headers: { Authorization: `Bearer ${admin.token}` } })).status, 404);
    }
    await check(names[1], async () => {
      page = await start(bob);
      let release; const gate = new Promise(resolve => { release = resolve; });
      await context.route('**/api/access', async route => { await gate; await settle(() => route.continue()); });
      await page.goto(`${fixture.base}/pages/${pageId}`);
      await page.getByRole('heading', { name: 'Checking access' }).waitFor(); assert.ok(!(await page.locator('body').innerText()).includes(originalTitle));
      release(); await context.unroute('**/api/access');
      await page.getByPlaceholder('Untitled', { exact: true }).waitFor(); await expectValue(page.getByPlaceholder('Untitled', { exact: true }), originalTitle);
      await page.getByRole('img', { name: caption, exact: true }).waitFor();
      await eventually(async () => (await readAccountStore(page, 'blobs')).some(row => row.id === thumbId));
      const rows = await readAccountStore(page, 'pages'); assert.equal(rows.some(r => r.id === coreId), false); assert.equal(rows.some(r => r.id === pageId), true);
    });
    await check(names[2], async () => {
      await context.setOffline(true); await page.getByPlaceholder('Untitled', { exact: true }).fill(offlineTitle); await page.getByPlaceholder('Untitled', { exact: true }).press('Tab');
      await eventually(async () => (await readAccountStore(page, 'outbox')).some(r => r.id === pageId), { timeout: 15_000 });
      await sql(`UPDATE space_members SET access='deny' WHERE space_id=${quote(space)} AND user_id=${quote(bob.user.id)}`);
      await context.close(); context = null;
      page = await start(bob); await page.goto(`${fixture.base}/pages/${pageId}`);
      await page.getByText('Page not found', { exact: true }).waitFor();
      assert.equal((await readAccountStore(page, 'pages')).some(r => r.id === pageId), false);
      assert.equal((await readAccountStore(page, 'outbox')).length, 0);
      assert.equal((await readAccountStore(page, 'blobs')).some(row => [imageId, thumbId].includes(row.id)), false);
      assert.equal((await readAccountStore(page, 'files')).some(row => row.id === imageId), false);
      const held = await readAccountStore(page, 'accessQuarantine'); assert.ok(held.some(r => r.kind === 'outbox' && r.id === pageId));
      assert.equal((await sql(`SELECT json_extract(data,'$.title') title FROM records WHERE id=${quote(pageId)}`))[0].title, originalTitle);
      assert.ok(!(await page.locator('body').innerText()).includes(offlineTitle));
    });
    await check(names[3], async () => {
      await sql(`UPDATE space_members SET access='allow' WHERE space_id=${quote(space)} AND user_id=${quote(bob.user.id)}`);
      await page.reload(); await page.getByPlaceholder('Untitled', { exact: true }).waitFor();
      await expectValue(page.getByPlaceholder('Untitled', { exact: true }), originalTitle);
      await page.getByRole('img', { name: caption, exact: true }).waitFor();
      assert.ok((await readAccountStore(page, 'accessQuarantine')).length > 0);
      for (const width of [320, 390, 768, 1024, 1440]) { await page.setViewportSize({ width, height: 1000 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)); }
      await page.setViewportSize({ width: 390, height: 844 });
    });
    await check(names[4], async () => {
      const second = await context.newPage(); await second.goto(`${fixture.base}/pages/${pageId}`); await second.getByPlaceholder('Untitled', { exact: true }).waitFor();
      try {
      await sql(`UPDATE space_members SET access='deny' WHERE space_id=${quote(space)} AND user_id=${quote(bob.user.id)}`);
      await page.reload(); await page.getByText('Page not found', { exact: true }).waitFor();
      await second.getByText('Page not found', { exact: true }).waitFor(); assert.ok(!(await second.locator('body').innerText()).includes(originalTitle));
      } finally { await second.close(); await sql(`UPDATE space_members SET access='allow' WHERE space_id=${quote(space)} AND user_id=${quote(bob.user.id)}`); }
      await page.reload(); await page.getByPlaceholder('Untitled', { exact: true }).waitFor();
    });
    await check(names[5], async () => {
      await context.route('**/api/access', route => settle(() => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'processing_budget' }) })));
      await page.reload(); await page.getByRole('heading', { name: 'Access check required' }).waitFor();
      assert.ok(!(await page.locator('body').innerText()).includes(originalTitle));
      await context.unroute('**/api/access'); await page.getByRole('button', { name: 'Retry access check' }).focus(); await page.keyboard.press('Enter');
      await page.getByPlaceholder('Untitled', { exact: true }).waitFor();
    });
    await check(names[6], async () => {
      await page.getByRole('button', { name: /held · review/ }).click();
      const dialog = page.getByRole('dialog'); await dialog.getByRole('heading', { name: 'Held work', exact: true }).waitFor();
      assert.ok(!(await dialog.innerText()).includes(offlineTitle)); await dialog.getByRole('button', { name: 'Discard all held work' }).click();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.ok((await readAccountStore(page, 'accessQuarantine')).length > 0);
      await dialog.getByRole('button', { name: 'Discard all held work' }).click(); await dialog.getByRole('button', { name: 'Discard held work', exact: true }).click();
      await eventually(async () => (await readAccountStore(page, 'accessQuarantine')).length === 0);
      assert.equal((await readAccountStore(page, 'accessQuarantineInfo')).length, 0);
      assert.equal((await sql(`SELECT json_extract(data,'$.title') title FROM records WHERE id=${quote(pageId)}`))[0].title, originalTitle);
    });
    await check(names[9], async () => {
      const destination = `${prefix}_destination`, from = `${prefix}_relation_from`, to = `${prefix}_relation_to`, link = `${prefix}_relation`;
      await sql(`INSERT INTO spaces(id,name,default_access,created_at) VALUES(${quote(destination)},'Move destination','private',1);
        INSERT INTO space_members(space_id,user_id,role) VALUES(${quote(space)},${quote(admin.user.id)},'editor'),(${quote(destination)},${quote(admin.user.id)},'editor');`);
      const response = await fetch(`${fixture.base}/api/sync/push`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ protocol: 3, changes: [
        { id: from, collection: 'pages', patch: { title: 'Relation source', spaceId: space }, ts: Date.now() },
        { id: to, collection: 'pages', patch: { title: 'Relation target', spaceId: space }, ts: Date.now() },
        { id: link, collection: 'links', patch: { kind: 'related', fromType: 'page', fromId: from, toType: 'page', toId: to }, ts: Date.now() },
      ] }) });
      assert.equal(response.status, 200); assert.equal((await response.json()).rejected, 0);
      await page.reload(); await page.getByPlaceholder('Untitled', { exact: true }).waitFor();
      await eventually(async () => (await readAccountStore(page, 'links')).some(r => r.id === link));
      const moved = await fetch(`${fixture.base}/api/spaces/move`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ recordId: to, toSpaceId: destination, requestId: `${prefix}_move` }) });
      assert.equal(moved.status, 200); await page.reload(); await page.getByPlaceholder('Untitled', { exact: true }).waitFor();
      assert.equal((await readAccountStore(page, 'pages')).some(r => r.id === to), false);
      assert.equal((await readAccountStore(page, 'links')).some(r => r.id === link), false);
      await sql(`INSERT INTO space_members(space_id,user_id,role) VALUES(${quote(destination)},${quote(bob.user.id)},'viewer')`);
      await page.reload(); await page.getByPlaceholder('Untitled', { exact: true }).waitFor();
      await eventually(async () => (await readAccountStore(page, 'links')).some(r => r.id === link));
      assert.ok((await readAccountStore(page, 'pages')).some(r => r.id === to));
    });
    await check(names[10], async () => {
      const joining = `${prefix}_joining`, ids = Array.from({ length: 24 }, (_, i) => `${prefix}_joining_${i}`);
      await sql(`INSERT INTO spaces(id,name,default_access,created_at) VALUES(${quote(joining)},'Resumable backfill','private',1);
        INSERT INTO space_members(space_id,user_id,role) VALUES(${quote(joining)},${quote(admin.user.id)},'editor');`);
      const response = await fetch(`${fixture.base}/api/sync/push`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ protocol: 3, changes: ids.map(id => ({ id, collection: 'pages', patch: { title: id, spaceId: joining }, ts: Date.now() })) }) });
      assert.equal(response.status, 200); assert.equal((await response.json()).rejected, 0);
      await sql(`INSERT INTO space_members(space_id,user_id,role) VALUES(${quote(joining)},${quote(bob.user.id)},'viewer')`);
      let requests = 0, release;
      const blocked = new Promise(resolve => { release = resolve; });
      await context.route('**/api/sync/pull', async route => {
        const body = route.request().postDataJSON();
        if (!body.joining?.some(j => j.space === joining)) return settle(() => route.continue());
        if (++requests > 1) { await blocked; return settle(() => route.continue()); }
        body.limit = 8;
        await settle(async () => route.fulfill({ response: await route.fetch({ postData: JSON.stringify(body) }) }));
      });
      try {
        await page.reload();
        await eventually(async () => requests >= 2 && (await readAccountStore(page, 'syncStage')).some(r => r.spaceId === joining));
        assert.equal((await readAccountStore(page, 'pages')).some(r => ids.includes(r.id)), false);
        await context.close(); context = null;
      } finally { release(); }
      page = await start(bob); await page.goto(`${fixture.base}/pages/${pageId}`); await page.getByPlaceholder('Untitled', { exact: true }).waitFor();
      await eventually(async () => (await readAccountStore(page, 'pages')).filter(r => ids.includes(r.id)).length === ids.length);
      assert.equal((await readAccountStore(page, 'syncStage')).length, 0);
      const state = (await readAccountStore(page, 'meta')).find(r => r.key === 'access_feed')?.value;
      assert.equal(Object.keys(state.joining).length, 0);
    });
    await check(names[7], async () => {
      const other = await context.newPage(); await other.goto(`${fixture.base}/pages/${pageId}`); await other.getByPlaceholder('Untitled', { exact: true }).waitFor();
      await other.evaluate(admin => { localStorage.setItem('ws_uid', admin.user.id); localStorage.setItem('ws_token', admin.token); localStorage.setItem('ws_user', JSON.stringify(admin.user)); }, admin);
      await page.getByRole('heading', { name: 'Access check required' }).waitFor(); assert.ok(!(await page.locator('body').innerText()).includes(originalTitle));
      assert.equal(await page.evaluate(() => localStorage.getItem('ws_token')), admin.token); await other.close();
    });
    await check(names[8], async () => {
      const browser = await browserType.launch({ headless: true }); await reporter.trackBrowser(browser, engine);
      const sessionContexts = [];
      try {
        const response = await fetch(`${fixture.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'password123' }) });
        assert.equal(response.status, 200); const secondUser = await response.json();
        const open = async user => {
          const c = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
          sessionContexts.push(c); await traceUnlessReported(c);
          await c.addInitScript(user => { localStorage.setItem('ws_token', user.token); localStorage.setItem('ws_uid', user.user.id); localStorage.setItem('ws_user', JSON.stringify(user.user)); }, user);
          const p = await c.newPage(); p.setDefaultTimeout(20_000); return p;
        };
        const primary = await open(admin), secondary = await open(secondUser);
        await secondary.goto(`${fixture.base}/pages/${coreId}`); await secondary.getByPlaceholder('Untitled', { exact: true }).waitFor();
        await primary.goto(`${fixture.base}/settings`);
        const section = primary.getByRole('heading', { name: 'Signed-in devices', exact: true }).locator('..');
        await section.getByRole('list', { name: 'Signed-in devices' }).waitFor();
        await section.getByRole('button', { name: 'Sign out other devices', exact: true }).click();
        const dialog = primary.getByRole('dialog'); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal((await fetch(`${fixture.base}/api/me`, { headers: { Authorization: `Bearer ${secondUser.token}` } })).status, 200);
        await section.getByRole('button', { name: 'Sign out other devices', exact: true }).focus(); await primary.keyboard.press('Enter');
        await dialog.getByRole('button', { name: 'Confirm sign out', exact: true }).click();
        await eventually(async () => (await fetch(`${fixture.base}/api/me`, { headers: { Authorization: `Bearer ${secondUser.token}` } })).status === 401);
        assert.equal((await fetch(`${fixture.base}/api/me`, { headers: { Authorization: `Bearer ${admin.token}` } })).status, 200);
        await secondary.reload(); await secondary.locator('form').getByRole('button', { name: 'Sign in', exact: true }).waitFor();
        for (const width of [320, 768, 1024]) { await primary.setViewportSize({ width, height: 900 }); assert.ok(await primary.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)); }
        await section.getByRole('button', { name: 'Sign out this device', exact: true }).click();
        await dialog.getByRole('button', { name: 'Confirm sign out', exact: true }).click();
        await primary.locator('form').getByRole('button', { name: 'Sign in', exact: true }).waitFor();
      } catch (error) {
        for (const [i, c] of sessionContexts.entries()) {
          for (const [j, p] of c.pages().entries()) await p.screenshot({ path: join(directory, `failure-session-${i}-${j}.png`), fullPage: true, timeout: 5000 }).catch(() => {});
          await c.tracing.stop({ path: join(directory, `failure-session-${i}.zip`) }).catch(() => {});
        }
        throw error;
      } finally { await browser.close(); }
    });
    writeFileSync(join(directory, 'source-state.json'), JSON.stringify({ sourceSha, sourceFingerprint, fixture: fixture.fixtureId, local: true, permissionActivation: 'disposable fixture only' }, null, 2));
  } catch (error) { reporter.record(engine, 'none', 'engine execution', 'FAIL', error); }
  finally { await context?.close().catch(() => {}); await fixture?.stop(); }
}
if (fingerprint(process.cwd()) !== sourceFingerprint) reporter.record('system', 'none', 'source stability', 'FAIL', 'Source changed during browser verification; rebuild and rerun');
reporter.finish();
