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
names.push('session controls confirm remote revocation and current-device signout');
const reporter = createCertificationReporter('verify-phase5-sync', (selected ? [selected] : Object.keys(engines)).flatMap(engine => names.map(name => `${engine}/${name}`)));
if (selected && !engines[selected]) throw new Error('Unknown mandatory browser engine');
const output = process.env.CERT_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'tcg-phase5-sync-')); mkdirSync(output, { recursive: true });
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFingerprint = fingerprint(process.cwd());
process.env.CERT_SOURCE_SHA ??= sourceSha;
reporter.setMetadata('sourceFingerprint', sourceFingerprint);
reporter.setMetadata('workingTreeDirty', Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()));
reporter.setMetadata('responsiveWidths', [320, 390, 768, 1024, 1440]);
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
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
      await context?.tracing.start({ screenshots: true, snapshots: true }).catch(() => {});
    } finally { clearTimeout(timer); reporter.complete(`${engine}/${name}`); }
  };
  try {
    fixture = await startFixture({ port: await freePort(), build: !built, artifactDirectory: directory }); built = true;
    const { admin, bob } = await bootstrap(fixture.base), prefix = `p5_${engine}`, pageId = `${prefix}_page`, coreId = `${prefix}_core`, space = `${prefix}_private`, originalTitle = `${engine} Private reference`, offlineTitle = `${engine} Offline confidential edit`;
    await push(fixture.base, admin.token, [{ id: coreId, collection: 'pages', patch: { title: `${engine} Core reference` } }, { id: pageId, collection: 'pages', patch: { title: originalTitle } }]);
    const sql = async query => (await fixture.sql(query)).flatMap(r => r.results ?? []);
    await sql(`INSERT INTO spaces(id,name,default_access,created_at) VALUES(${quote(space)},'Disposable private','private',1);
      INSERT INTO space_members(space_id,user_id,role) VALUES(${quote(space)},${quote(bob.user.id)},'editor');
      UPDATE users SET workspace_role='guest' WHERE id=${quote(bob.user.id)};
      UPDATE records SET space_id=${quote(space)} WHERE id=${quote(pageId)};`);
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
        await p.getByPlaceholder('Untitled', { exact: true }).waitFor(); assert.equal(await p.getByPlaceholder('Untitled', { exact: true }).inputValue(), `${engine} Core reference`);
      } finally { await legacy.close(); }
    });
    await sql('UPDATE access_state SET enabled=1 WHERE id=1');
    await check(names[1], async () => {
      page = await start(bob);
      let release; const gate = new Promise(resolve => { release = resolve; });
      await context.route('**/api/access', async route => { await gate; await route.continue(); });
      await page.goto(`${fixture.base}/pages/${pageId}`);
      await page.getByRole('heading', { name: 'Checking access' }).waitFor(); assert.ok(!(await page.locator('body').innerText()).includes(originalTitle));
      release(); await context.unroute('**/api/access');
      await page.getByPlaceholder('Untitled', { exact: true }).waitFor(); assert.equal(await page.getByPlaceholder('Untitled', { exact: true }).inputValue(), originalTitle);
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
      const held = await readAccountStore(page, 'accessQuarantine'); assert.ok(held.some(r => r.kind === 'outbox' && r.id === pageId));
      assert.equal((await sql(`SELECT json_extract(data,'$.title') title FROM records WHERE id=${quote(pageId)}`))[0].title, originalTitle);
      assert.ok(!(await page.locator('body').innerText()).includes(offlineTitle));
    });
    await check(names[3], async () => {
      await sql(`UPDATE space_members SET access='allow' WHERE space_id=${quote(space)} AND user_id=${quote(bob.user.id)}`);
      await page.reload(); await page.getByPlaceholder('Untitled', { exact: true }).waitFor();
      assert.equal(await page.getByPlaceholder('Untitled', { exact: true }).inputValue(), originalTitle);
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
      await context.route('**/api/access', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'processing_budget' }) }));
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
    await check(names[7], async () => {
      const other = await context.newPage(); await other.goto(`${fixture.base}/pages/${pageId}`); await other.getByPlaceholder('Untitled', { exact: true }).waitFor();
      await other.evaluate(admin => { localStorage.setItem('ws_uid', admin.user.id); localStorage.setItem('ws_token', admin.token); localStorage.setItem('ws_user', JSON.stringify(admin.user)); }, admin);
      await page.getByRole('heading', { name: 'Access check required' }).waitFor(); assert.ok(!(await page.locator('body').innerText()).includes(originalTitle));
      assert.equal(await page.evaluate(() => localStorage.getItem('ws_token')), admin.token); await other.close();
    });
    await check(names[8], async () => {
      const browser = await browserType.launch({ headless: true }); await reporter.trackBrowser(browser, engine);
      try {
        const response = await fetch(`${fixture.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'password123' }) });
        assert.equal(response.status, 200); const secondUser = await response.json();
        const open = async user => {
          const c = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
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
      } finally { await browser.close(); }
    });
    writeFileSync(join(directory, 'source-state.json'), JSON.stringify({ sourceSha, sourceFingerprint, fixture: fixture.fixtureId, local: true, permissionActivation: 'disposable fixture only' }, null, 2));
  } catch (error) { reporter.record(engine, 'none', 'fixture or engine initialization', 'FAIL', error); }
  finally { await context?.close().catch(() => {}); await fixture?.stop(); }
}
if (fingerprint(process.cwd()) !== sourceFingerprint) reporter.record('system', 'none', 'source stability', 'FAIL', 'Source changed during browser verification; rebuild and rerun');
reporter.finish();
