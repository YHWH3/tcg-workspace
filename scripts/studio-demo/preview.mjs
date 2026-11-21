import assert from 'node:assert/strict';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { chromium, webkit } from 'playwright';
import { expect } from '@playwright/test';
import { generateNKeysBetween } from 'fractional-indexing';
import { startFixture } from '../phase4-fixture.mjs';
import { freePort, fingerprint } from '../certification/core.mjs';
import { connectFixtureMcp } from '../certification/mcp-client.mjs';
import { ensureLabTls } from '../ux-lab/tls.mjs';
import { boards } from './data.mjs';

const root = resolve(import.meta.dirname, '../..');
const check = process.argv.includes('--check');
const artifacts = join(root, '.artifacts/studio-demo');
mkdirSync(artifacts, { recursive: true });
const out = mkdtempSync(join(artifacts, 'run-'));
const tls = { cert: join(out, 'tls/cert.pem'), key: join(out, 'tls/key.pem') };
const password = randomBytes(18).toString('base64url');
const recordCount = boards.reduce((total, board) => total + board.records.length, 0);
const sourceFingerprint = fingerprint(root);

let fixture, mcp, browser, mobileBrowser;
try {
  ensureLabTls(tls);
  setDefaultCACertificates([...getCACertificates('default'), readFileSync(tls.cert, 'utf8')]);
  fixture = await startFixture({ port: await freePort(), tls, artifactDirectory: join(out, 'local-worker') });
  async function post(path, body, token) {
    const response = await fetch(fixture.base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    assert.ok(response.ok, path + ' HTTP ' + response.status);
    return response.json();
  }
  const admin = await post('/api/auth/signup', { username: 'admin', name: 'Mira Desai', password });
  assert.ok(admin.token);
  const members = [admin.user.id];
  for (const [username, name] of [['noah', 'Noah Sen'], ['imani', 'Imani Rao'], ['leo', 'Leo Martin']]) {
    const invite = await post('/api/invites', {}, admin.token);
    const teammate = await post('/api/auth/signup', { username, name, password, inviteCode: invite.code });
    members.push(teammate.user.id);
  }

  const now = Date.now();
  const day = offset => new Date(now + offset * 86_400_000).toISOString().slice(0, 10);
  const boardOrder = generateNKeysBetween(null, null, boards.length);
  const changes = boards.flatMap(({ records, views, ...board }, boardIndex) => {
    const order = generateNKeysBetween(null, null, records.length);
    return [
      {
        collection: 'boards', id: board.id,
        patch: { ...board, order: boardOrder[boardIndex], showBuiltins: { due: true, assignee: true }, createdAt: now, createdBy: admin.user.id },
      },
      ...records.map(([title, stage, progress, group, due, duration, description], index) => ({
        collection: 'tasks', id: board.id + '-record-' + (index + 1),
        patch: {
          boardId: board.id, title, status: board.columns[stage - 1].id, description, assigneeId: members[index % members.length],
          p_progress: progress, p_group: group, p_start: day(due - duration), dueDate: day(due),
          createdAt: now - (index + 1) * 3_600_000, createdBy: admin.user.id, order: order[index],
        },
      })),
    ];
  });
  const push = await post('/api/sync/push', { protocol: 3, changes: changes.map(change => ({ ...change, ts: now })) }, admin.token);
  assert.deepEqual(push.rejectedItems ?? [], []);
  await fixture.sql('UPDATE access_state SET enabled=1 WHERE id=1');
  mcp = await connectFixtureMcp(fixture.base, { name: 'Studio sample setup', password, fixtureHuman: false, allowHttps: true });

  const catalogue = {};
  for (const board of boards) {
    const saved = {};
    for (const view of board.views) {
      const result = await mcp.call('add_view', { databaseId: board.id, ...view });
      assert.ok(result.id && result.url);
      saved[view.name] = result;
    }
    const listed = await mcp.call('list_database_views', { databaseId: board.id });
    assert.equal(listed.views.length, board.views.length);
    await mcp.call('set_default_view', { databaseId: board.id, viewId: saved[board.views[0].name].id, expectedRev: listed.databaseRev });
    const records = await mcp.call('query_records', { databaseId: board.id, viewId: saved[board.views[0].name].id });
    assert.equal(records.rows.length, board.records.length, board.name + ' record count');
    catalogue[board.name] = { id: board.id, records: records.rows.length, views: saved };
  }
  const form = await mcp.call('save_form_draft', {
    databaseId: 'sample-requests', title: 'Studio request form',
    description: 'Tell us what you need and when you need it. The studio team will triage your request.',
    fields: [
      { fieldKey: 'title', label: 'What do you need?', required: true },
      { fieldKey: 'p_group', label: 'Request type', required: true },
      { fieldKey: 'dueDate', label: 'Target date', help: 'Leave blank if the date is flexible.' },
    ],
  });
  assert.equal(form.enabled, false);
  const overview = await mcp.call('create_page', {
    title: 'Studio sample overview', icon: '🧭',
    markdown: 'A fictional studio workspace with sample projects, editorial work, and incoming requests.\n\n'
      + '## Start with To-dos\n'
      + 'Open Boards in the sidebar, choose To-dos, and switch between its saved views. Use + View to see the layout picker. '
      + 'Move a task between stages from its card menu, or open it to see its dates, owner and progress.',
  });
  await mcp.call('append_dashboard_widgets', {
    pageId: overview.id, widgets: [
      { type: 'metric', databaseId: 'sample-to-dos', label: 'Studio tasks', agg: 'count' },
      { type: 'metric', databaseId: 'sample-projects', label: 'Projects', agg: 'count' },
      { type: 'metric', databaseId: 'sample-editorial', label: 'Editorial stories', agg: 'count' },
      { type: 'metric', databaseId: 'sample-requests', label: 'Requests', agg: 'count' },
      { type: 'view', databaseId: 'sample-to-dos', viewId: catalogue['To-dos'].views.Feed.id, heading: 'Recent studio activity', limit: 3 },
    ],
  });
  await mcp.close();
  mcp = null;
  console.log('Seeded ' + recordCount + ' records and ' + boards.reduce((total, board) => total + board.views.length, 0) + ' views.');

  const spki = new X509Certificate(readFileSync(tls.cert)).publicKey.export({ type: 'spki', format: 'der' });
  browser = await chromium.launch({ headless: check, args: ['--window-size=1536,1000', '--ignore-certificate-errors-spki-list=' + createHash('sha256').update(spki).digest('base64')] });
  async function setupContext(browserInstance, options) {
    const context = await browserInstance.newContext({ ignoreHTTPSErrors: true, ...options });
    await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(fixture.base);
    await page.evaluate(({ user, token }) => {
      localStorage.setItem('ws_token', token);
      localStorage.setItem('ws_uid', user.id);
      localStorage.setItem('ws_user', JSON.stringify(user));
    }, { user: admin.user, token: admin.token });
    return { page, context };
  }
  const { page, context } = await setupContext(browser, { viewport: { width: 1536, height: 960 }, colorScheme: 'dark' });
  const main = catalogue['To-dos'].views;
  const capture = (tab, name) => tab.screenshot({ path: join(out, name + '.png'), animations: 'disabled' });
  async function showBoard(tab, board) {
    await tab.goto(catalogue[board.name].views[board.views[0].name].url);
    for (const column of board.columns) {
      const region = tab.getByRole('region', { name: column.name, exact: true });
      const rgb = column.color.slice(1).match(/../g).map(channel => parseInt(channel, 16)).join(', ');
      await expect(region.getByText(column.name, { exact: true })).toHaveAttribute('style', new RegExp(column.color + '|rgb\\(' + rgb + '\\)', 'i'));
      await expect(region.getByRole('meter', { name: 'Progress', exact: true })).toHaveCount(board.records.filter(record => record[1] === board.columns.indexOf(column) + 1).length);
    }
  }
  await showBoard(page, boards[0]);
  const task = 'Design the workshop landing page';
  const active = page.getByRole('region', { name: 'In progress', exact: true });
  const review = page.getByRole('region', { name: 'In review', exact: true });
  const card = region => region.getByRole('group', { name: task, exact: true });
  await expect(card(active).getByRole('meter', { name: 'Progress' })).toHaveAttribute('value', '0.5');
  await card(active).getByRole('button', { name: 'Card menu' }).click();
  await page.getByRole('button', { name: 'In review', exact: true }).click();
  await expect(card(review)).toBeVisible();
  await card(review).getByRole('button', { name: 'Card menu' }).click();
  await page.getByRole('button', { name: 'In progress', exact: true }).click();
  await expect(card(active)).toBeVisible();
  await expect(page.getByText('Synced', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await capture(page, 'to-dos-dark');

  const tabList = page.getByRole('tablist', { name: 'Views', exact: true });
  const checks = {
    Grid: () => page.getByTitle(task, { exact: true }).first(),
    Calendar: () => page.getByRole('tablist', { name: 'Calendar mode' }),
    Timeline: () => page.getByRole('combobox', { name: 'Scale' }),
    Dashboard: () => page.getByRole('region', { name: 'Database dashboard' }).getByText('12', { exact: true }).first(),
    Chart: () => page.getByRole('region', { name: 'Chart', exact: true }).getByText('12 matching records'),
    List: () => page.getByText(task, { exact: true }).first(),
    Gallery: () => page.getByRole('button', { name: new RegExp(task) }).first(),
    Feed: () => page.getByRole('article').filter({ hasText: task }),
    'By team': () => page.getByText('Engineering', { exact: true }).first(),
  };
  for (const [name, witness] of Object.entries(checks)) {
    const tab = tabList.getByRole('tab', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(witness()).toBeVisible();
    if (name === 'Calendar' || name === 'Timeline') {
      await expect(page.getByText(task, { exact: true }).first()).toBeVisible();
    }
    if (['Calendar', 'Timeline', 'Dashboard', 'Chart', 'Feed'].includes(name)) await capture(page, name.toLowerCase());
  }

  await page.goto(main.Board.url);
  const newView = page.getByRole('button', { name: 'New view', exact: true });
  await newView.click();
  const picker = page.getByRole('dialog', { name: 'Add a database view', exact: true });
  for (const name of ['Table', 'Board', 'Calendar', 'Timeline', 'Dashboard', 'Chart', 'List', 'Gallery', 'Feed', 'Form builder']) {
    await expect(picker.getByRole('button', { name: new RegExp('^' + name) })).toBeVisible();
  }
  await capture(page, 'view-picker-dark');
  await page.keyboard.press('Escape');

  const overviewTab = await context.newPage();
  await overviewTab.goto(overview.url);
  await expect(overviewTab.getByRole('button', { name: /Studio tasks show records/ })).toBeVisible();
  await expect(overviewTab.getByRole('link', { name: 'Outline the December brief', exact: true })).toBeVisible();
  await capture(overviewTab, 'overview');

  for (const board of boards.slice(1)) {
    const tab = await context.newPage();
    await showBoard(tab, board);
    await capture(tab, board.id);
  }
  const formTab = await context.newPage();
  await formTab.goto(form.url);
  await expect(formTab.getByPlaceholder('Volunteer intake')).toHaveValue('Studio request form');
  await expect(formTab.getByText('What do you need? *', { exact: true })).toBeVisible();
  await expect(formTab.getByRole('checkbox', { name: 'Accepting responses' })).not.toBeChecked();
  await capture(formTab, 'form-builder');

  mobileBrowser = await webkit.launch();
  const { page: mobile } = await setupContext(mobileBrowser, {
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light',
  });
  await mobile.goto(main.Board.url);
  await expect(mobile.getByRole('region', { name: 'To do', exact: true }).getByText('To do', { exact: true })).toBeVisible();
  assert.equal(await mobile.evaluate(() => document.documentElement.classList.contains('dark')), false);
  await capture(mobile, 'to-dos-mobile-light');
  await mobile.getByRole('button', { name: 'New view', exact: true }).tap();
  const mobilePicker = mobile.getByRole('dialog', { name: 'Add a database view', exact: true });
  await expect(mobilePicker.getByRole('button', { name: 'Gallery', exact: true })).toBeVisible();
  await expect(mobilePicker.getByRole('button', { name: /Form builder/ })).toBeVisible();
  const dimensions = await mobile.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert.equal(dimensions.width, dimensions.scroll, 'Mobile picker must fit the viewport');
  await capture(mobile, 'view-picker-mobile-light');
  await mobileBrowser.close();
  mobileBrowser = null;

  await page.bringToFront();
  await expect(active.getByRole('meter', { name: 'Progress' }).first()).toBeVisible();
  assert.equal(fingerprint(root), sourceFingerprint, 'Source changed during the Studio demo checks');
  const evidence = { base: fixture.base, sourceFingerprint, recordCount, members: members.length, overview: overview.url, form: form.url, boards: catalogue,
    checks: ['All four boards rendered colored stages and progress', 'Card moved to review and returned', 'All To-dos saved layouts rendered', 'All 10 picker options visible', 'Overview and draft form rendered', '390px WebKit touch picker fit viewport'],
  };
  writeFileSync(join(out, 'ready.json'), JSON.stringify(evidence, null, 2));
  console.log('Studio demo checks passed. Evidence: ' + out);
  if (!check) {
    console.log('Open in the demo window: ' + main.Board.url);
    await new Promise(resolve => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
      browser.once('disconnected', resolve);
    });
  }
} finally {
  await mobileBrowser?.close();
  await browser?.close();
  await mcp?.close();
  await fixture?.stop();
  if (fixture) rmSync(fixture.directory, { recursive: true, force: true });
  rmSync(tls.key, { force: true });
}
