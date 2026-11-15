import { readFile } from 'node:fs/promises';
import { test, expect, open, health, request, fixture } from './support.mjs';

test('Moodboard export: standalone images, missing media, SVG, PNG, selection and print', async ({ page }, info) => {
  const suffix = info.project.name + '-' + Date.now();
  const board = 'export-board-' + suffix, note = 'export-note-' + suffix;
  const image = 'export-image-' + suffix, file = 'export-file-' + suffix;
  const missing = 'export-missing-' + suffix;
  const changes = [
    { id: board, collection: 'moodboards', patch: { title: 'Export test' } },
    { id: note, collection: 'mooditems', patch: { boardId: board, type: 'note', text: 'Export café 👩🏽‍💻 <script>', x: -120, y: -100, w: 200, h: 160 } },
    { id: image, collection: 'mooditems', patch: { boardId: board, type: 'image', fileId: file, x: 100, y: -100, w: 160, h: 160 } },
    { id: file, collection: 'files', patch: { parentType: 'mooditem', parentId: image, name: 'synthetic.png', mime: 'image/png', kind: 'image', size: 68 } },
    { id: missing, collection: 'mooditems', patch: { boardId: board, type: 'image', x: 100, y: 100, w: 160, h: 120 } },
  ];
  const push = rows => request('/api/sync/push', { protocol: 3, changes: rows.map(row => ({ ...row, ts: Date.now() })) });
  expect((await push(changes)).rejectedItems).toEqual([]);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
  const response = await fetch(fixture.base + '/api/files/' + file + '/chunks/0', {
    method: 'PUT', headers: { Authorization: 'Bearer ' + fixture.admin.token }, body: bytes,
  });
  expect(response.status, await response.text()).toBe(200);
  await request('/api/files/' + file + '/complete', { mime: 'image/png', size: bytes.length, chunks: 1 });
  try {
    await open(page, { id: 'moodboard-export', path: '/moodboards/' + board, ready: { role: 'button', name: 'Export moodboard', exact: true } });
    await page.getByRole('button', { name: 'Export moodboard', exact: true }).press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Export moodboard', exact: true });
    const svgButton = dialog.getByRole('button', { name: 'Download SVG', exact: true });
    await expect(svgButton).toBeVisible();
    await expect(dialog.getByRole('status')).toContainText('1 image is shown as placeholders');
    const [download] = await Promise.all([page.waitForEvent('download'), svgButton.press('Enter')]);
    const svg = await readFile(await download.path(), 'utf8');
    expect(svg).toContain('<image');
    expect(svg).toMatch(/href="data:image\/(webp|png);base64,/);
    const text = await page.evaluate(svg => [...new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('text')].map(node => node.textContent).join(''), svg);
    expect(text).toContain('Export café 👩🏽‍💻 <script>');
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('/api/');
    const [png] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download PNG', exact: true }).press('Enter')]);
    expect((await readFile(await png.path())).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.moodboard-print')).toBeVisible();
    await expect(page.locator('#root')).toBeHidden();
    await info.attach('moodboard-print', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await page.emulateMedia({ media: 'screen' });
    await page.addStyleTag({ content: 'html{font-size:200%!important}' });
    await health(page, 'export controls at enlarged text', info);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Export moodboard', exact: true })).toBeFocused();
    await page.locator('[data-testid="mood-canvas"]').focus();
    await page.keyboard.press('ControlOrMeta+a');
    await page.getByRole('button', { name: 'Export moodboard', exact: true }).press('Enter');
    await expect(dialog.getByRole('radio', { name: 'Selection', exact: true })).toBeChecked();
    await expect(svgButton).toBeVisible();
  } finally {
    await push(changes.map(({ id, collection }) => ({ id, collection, patch: { deleted: true } })));
  }
});
