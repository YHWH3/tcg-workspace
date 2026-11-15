import { reloadReady } from '../navigation-ready.mjs';
import { test, expect, open, health, request, readRecord } from './support.mjs';

test('Automation branches: preserve legacy actions, reorder by keyboard and reload', async ({ page }, info) => {
  const id = 'ux-branches-' + info.project.name;
  const conditions = [{ key: 'p_date', op: 'on_or_before', value: 'today+30' }];
  const actions = [{ type: 'set_field', fieldKey: 'title', value: 'Matched' }];
  const push = patch => request('/api/sync/push', {
    protocol: 3, changes: [{ id, collection: 'automations', ts: Date.now(), patch }],
  });
  expect((await push({
    databaseId: 'ux-records', name: 'Conditional routing ' + info.project.name, enabled: false,
    trigger: { kind: 'record.created' }, conditions, actions,
  })).rejectedItems).toEqual([]);
  try {
    await open(page, { id: 'automation-branches', path: '/automations/ux-records', ready: { role: 'heading', name: /Automations/ } });
    const card = page.locator('section').filter({ has: page.getByRole('textbox', { name: 'Automation name' }) })
      .filter({ has: page.locator('input[value="Conditional routing ' + info.project.name + '"]') });
    await card.getByRole('button', { name: 'Use conditional branches', exact: true }).press('Enter');
    const first = card.getByRole('group', { name: 'Branch 1', exact: true });
    await expect(first.getByRole('spinbutton', { name: 'Condition days' })).toHaveValue('30');
    await expect.poll(async () => (await readRecord(id))?.data.branches).toEqual([{ conditions, actions }]);

    await first.getByRole('textbox', { name: 'Branch 1 name' }).fill('Due soon');
    await card.getByRole('button', { name: 'Add branch', exact: true }).press('Enter');
    const second = card.getByRole('group', { name: 'Branch 2', exact: true });
    await second.getByRole('textbox', { name: 'Branch 2 name' }).fill('All remaining');
    await second.getByRole('button', { name: 'Move branch 2 up' }).press('Enter');
    await expect(first.getByRole('textbox', { name: 'Branch 1 name' })).toHaveValue('All remaining');
    await expect(second.getByRole('spinbutton', { name: 'Condition days' })).toHaveValue('30');
    await card.getByRole('button', { name: 'Add Otherwise', exact: true }).press('Enter');
    await expect(card.getByRole('group', { name: 'Otherwise', exact: true })).toBeVisible();
    await expect.poll(async () => (await readRecord(id))?.data).toMatchObject({
      branches: [
        { name: 'All remaining', conditions: [] },
        { name: 'Due soon', conditions, actions },
      ],
      otherwise: [{ type: 'notify' }],
    });
    await reloadReady(page);
    await expect(second.getByRole('textbox', { name: 'Branch 2 name' })).toHaveValue('Due soon');

    await page.addStyleTag({ content: 'html{font-size:200%!important}' });
    await second.getByRole('textbox', { name: 'Branch 2 name' }).scrollIntoViewIfNeeded();
    const captions = await second.getByRole('combobox').evaluateAll(elements => elements.map(el => {
      const style = getComputedStyle(el), probe = document.createElement('span');
      Object.assign(probe.style, { position: 'fixed', visibility: 'hidden', whiteSpace: 'pre', font: style.font });
      probe.textContent = el.selectedOptions[0]?.text ?? '';
      document.body.append(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return { caption: el.selectedOptions[0]?.text, width,
        available: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
    }));
    expect(captions.filter(caption => caption.width > caption.available + 1), 'Selected captions fit at 200% text').toEqual([]);
    const name = second.getByRole('textbox', { name: 'Branch 2 name' });
    expect(await name.evaluate(el => el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight))).toBeGreaterThan(160);
    await health(page, 'automation branch editor at enlarged text', info);
    await info.attach('automation branches', { body: await page.screenshot(), contentType: 'image/png' });
  } finally {
    expect((await push({ deleted: true })).rejectedItems).toEqual([]);
  }
});
