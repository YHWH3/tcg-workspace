import { test, expect, open, health, request, readRecord, fixture } from './support.mjs';
import { connectFixtureMcp } from '../certification/mcp-client.mjs';

test('Database platform: browse layouts, copy a Feed and open an MCP-authored form and dashboard', async ({ page }, info) => {
  const suffix = info.project.name.replaceAll('-', '');
  const databaseId = 'platform-' + suffix;
  const pageId = 'platform-home-' + suffix;
  const write = changes => request('/api/sync/push', {
    protocol: 3,
    changes: changes.map(change => ({ ...change, ts: Date.now() })),
  });
  await write([
    { id: databaseId, collection: 'boards', patch: { name: 'Studio projects', icon: '', kind: 'tasks', columns: [{ id: 'todo', name: 'To do', color: '#8a8a8a' }, { id: 'done', name: 'Done', color: '#30a46c' }], fields: [{ id: 'progress', name: 'Progress', type: 'number', format: 'percent', showOnCard: true }] } },
    { id: pageId, collection: 'pages', patch: { title: 'Studio dashboard', order: 'a0' } },
    { id: 'first-' + suffix, collection: 'tasks', patch: { boardId: databaseId, title: 'First project update', description: 'A synthetic progress note', p_progress: 0.5, status: 'todo', createdAt: 100, order: 'a0' } },
    { id: 'second-' + suffix, collection: 'tasks', patch: { boardId: databaseId, title: 'Second project update', status: 'done', createdAt: 200, order: 'a1' } },
  ]);
  const mcp = await connectFixtureMcp(fixture.base, { name: 'Disposable database platform', fixtureHuman: false, allowHttps: true });
  try {
    await open(page, { path: '/boards/' + databaseId, ready: { role: 'heading', name: 'Studio projects' } });
    await expect(page.getByRole('meter', { name: 'Progress', exact: true })).toHaveAttribute('value', '0.5');
    const planned = page.getByRole('region', { name: 'To do', exact: true });
    const done = page.getByRole('region', { name: 'Done', exact: true });
    await planned.getByRole('button', { name: 'Column menu', exact: true }).click();
    await page.getByRole('button', { name: 'Purple', exact: true }).click();
    await expect.poll(async () => (await readRecord(databaseId))?.data.columns[0].color).toBe('#8e4ec6');
    await mcp.call('update_stage', { boardId: databaseId, stage: 'todo', color: '#0091ff' });
    await expect.poll(async () => (await readRecord(databaseId))?.data.columns[0].color).toBe('#0091ff');
    await page.reload();
    await expect(planned.getByText('To do', { exact: true })).toHaveAttribute('style', /#0091ff|rgb\(0, 145, 255\)/);
    await planned.getByRole('button', { name: 'Card menu', exact: true }).press('Enter');
    await page.getByRole('button', { name: 'Done', exact: true }).press('Enter');
    await expect(done.getByRole('button', { name: 'First project update', exact: true })).toBeVisible();
    await expect.poll(async () => (await readRecord('first-' + suffix))?.data.status).toBe('done');
    await page.getByRole('button', { name: 'Saved views', exact: true }).press('Enter');
    const add = page.getByRole('button', { name: 'New view', exact: true });
    await add.press('Enter');
    const picker = page.getByRole('dialog', { name: 'Add a database view', exact: true });
    for (const label of ['Table', 'Board', 'Calendar', 'Timeline', 'Dashboard', 'Chart', 'List', 'Gallery', 'Feed']) {
      await expect(picker.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    await expect(picker.getByRole('button', { name: /Form builder/ })).toBeVisible();
    await picker.getByRole('button', { name: 'Feed', exact: true }).press('Enter');
    await expect(page.getByRole('tab', { name: 'Feed', exact: true })).toHaveAttribute('aria-selected', 'true');
    const sourceView = new URL(page.url()).pathname.split('/').at(-1);
    const cards = page.getByRole('article');
    await expect(cards.first()).toContainText('Second project update');
    await expect(cards.last()).toContainText('A synthetic progress note');
    await expect.poll(async () => (await readRecord(sourceView))?.data.type).toBe('feed');
    await page.getByRole('button', { name: 'Feed options', exact: true }).press('Enter');
    await page.getByRole('button', { name: 'Duplicate view', exact: true }).press('Enter');
    await expect(page.getByRole('tab', { name: 'Feed copy', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(cards).toHaveCount(2);
    const copy = new URL(page.url()).pathname.split('/').at(-1);
    await expect.poll(async () => (await readRecord(copy))?.data.type).toBe('feed');
    const listed = await mcp.call('list_database_views', { databaseId });
    expect(listed.views.map(view => view.id)).toEqual([sourceView, copy]);
    const query = await mcp.call('query_records', { databaseId, viewId: copy });
    expect(query.rows.map(row => row.id)).toEqual(['second-' + suffix, 'first-' + suffix]);
    await page.addStyleTag({ content: 'html{font-size:200%!important}' });
    await health(page, 'feed at enlarged text', info);
    await add.press('Enter');
    await expect(picker.getByRole('button', { name: 'Feed', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(add).toBeFocused();
    await add.press('Enter');
    await picker.getByRole('button', { name: 'Dashboard', exact: true }).press('Enter');
    const dashboard = page.getByRole('region', { name: 'Database dashboard', exact: true });
    await expect(dashboard).toBeVisible();
    const dashboardId = new URL(page.url()).pathname.split('/').at(-1);
    await expect.poll(async () => (await readRecord(dashboardId))?.data.type).toBe('dashboard');
    await dashboard.getByRole('button', { name: 'To do', exact: true }).press('Enter');
    await expect(dashboard.getByText('No matching records', { exact: true })).toBeVisible();
    await dashboard.getByRole('button', { name: 'Done', exact: true }).press('Enter');
    await expect(dashboard.getByRole('link', { name: 'First project update', exact: true })).toBeVisible();
    const result = await mcp.call('query_records', { databaseId, viewId: dashboardId });
    expect(result.dashboard).toMatchObject({
      total: 2, stages: [{ id: 'todo', color: '#0091ff', count: 0 }, { id: 'done', count: 2 }],
    });
    await health(page, 'dashboard at enlarged text', info);

    await mcp.call('append_dashboard_widgets', { pageId, widgets: [
      { type: 'view', databaseId, viewId: sourceView, heading: 'Latest updates' },
      { type: 'metric', databaseId, agg: 'count', label: 'Projects count' },
    ], requestId: 'dashboard-' + suffix });
    await open(page, { path: '/pages/' + pageId, ready: { role: 'button', name: /Projects count/ } });
    await expect(page.getByRole('link', { name: 'First project update', exact: true })).toBeVisible();
    const form = await mcp.call('save_form_draft', {
      databaseId, title: 'Studio project request', fields: [{ fieldKey: 'title', label: 'Project name', required: true }],
      requestId: 'form-' + suffix,
    });
    expect(form.enabled).toBe(false);
    await open(page, { path: '/forms/' + databaseId, ready: { role: 'link', name: /Studio project request/ } });
    await expect(page.getByRole('link', { name: /Studio project request/ })).toContainText('Off');
  } finally {
    await mcp.close();
  }
});
