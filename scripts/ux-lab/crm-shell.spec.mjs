import { randomUUID } from 'node:crypto';
import { test, expect, health, request, fixture, setOfflineForTest } from './support.mjs';
import { navigateReady } from '../navigation-ready.mjs';

async function createMember(suffix) {
  const { code } = await request('/api/invites');
  const username = `commons-${suffix}`;
  const password = randomUUID();
  const res = await fetch(fixture.base + '/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, name: `Commons ${suffix}`, password, inviteCode: code }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

test('CRM switcher, Home empty state, and Accounts/Capabilities/History accessibility', async ({ page, context }, info) => {
  const teammate = await createMember('teammate');
  const inactiveGrantUser = await createMember('inactive');

  try {
    // Seed a specialised grant without crm.access on inactiveGrantUser to verify SC-2 inactive indicator.
    await request('/api/crm/commands/capability.grant', {
      requestId: 'ux_' + randomUUID().replace(/-/g, ''),
      input: { userId: inactiveGrantUser.user.id, capability: 'crm.send:email', scope: '*' },
    });

    await navigateReady(page, fixture.base + '/');
    const isCompact = info.project.use.viewport.width < 768;

    // On mobile Workspace, AppSwitcher lives inside the Menu drawer; on desktop/tablet, in the sidebar.
    if (isCompact) {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
    }
    const trigger = page.getByTestId('app-switcher-trigger');
    await expect(trigger).toBeVisible();
    await trigger.focus();
    await trigger.press('Enter');

    const menu = page.getByTestId('app-switcher-menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.press('ArrowDown');
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: /CRM/ }).click();

    await expect(page).toHaveURL(/\/crm$/);
    await expect(page.getByRole('heading', { name: /Welcome,/ })).toBeVisible();
    await expect(page.getByText('13 of 13 enabled')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await health(page, 'crm-home', info);
    await expect(page.locator('[data-app="crm"]')).toHaveScreenshot('crm-home.png');

    // Navigate to Accounts & capabilities settings
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/crm\/settings\/access/);
    await expect(page.getByText(/places in use \(guests included\)/)).toBeVisible();

    // Owner protection: owner row exposes zero account mutation actions.
    const ownerRow = page.getByTestId(`crm-account-${fixture.admin.user.id}`);
    await expect(ownerRow).toContainText('All (owner)');
    await expect(ownerRow.getByRole('button', { name: /Disable|Remove/ })).toHaveCount(0);
    await health(page, 'crm-accounts', info);

    // Compact layout: exercise full-screen capability sheet and focus return.
    if (isCompact) {
      const capBtn = page
        .getByTestId(`crm-account-${teammate.user.id}`)
        .getByRole('button', { name: 'Capabilities' });
      await capBtn.scrollIntoViewIfNeeded();
      await capBtn.focus();
      await capBtn.press('Enter');
      const sheet = page.getByRole('dialog', { name: `Capabilities for ${teammate.user.name}` });
      await expect(sheet).toBeVisible();
      await health(page, 'crm-mobile-cap-sheet', info);
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(capBtn).toBeFocused();
    }

    // Keyboard ARIA tablist navigation: Accounts -> Capabilities
    const accountsTab = page.getByRole('tab', { name: 'Accounts', exact: true });
    await accountsTab.focus();
    await accountsTab.press('ArrowRight');
    const capTab = page.getByRole('tab', { name: 'Capabilities', exact: true });
    await expect(capTab).toHaveAttribute('aria-selected', 'true');

    // Verify inactive specialised grants warning on inactiveGrantUser and assert CRM Settings visual reference
    const combo = page.getByRole('combobox', { name: 'Account', exact: true });
    await combo.selectOption(inactiveGrantUser.user.id);
    await expect(
      page.getByText('Specialised grants are inactive until Open the CRM is granted'),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('[data-app="crm"]')).toHaveScreenshot('crm-settings-capabilities.png', {
      mask: [page.locator('[data-app="crm"] p:has(time)')],
    });

    // Select teammate and toggle via keyboard Space -> real grant -> non-optimistic failure -> revoke
    await combo.selectOption(teammate.user.id);
    const accessSwitch = page.getByTestId('cap-switch-crm.access');
    await expect(accessSwitch).toHaveAttribute('aria-checked', 'false');

    // Touch target sizing check (>=24x24 AA and >=44x44 touch hit container)
    const switchHitBox = await accessSwitch.locator('..').boundingBox();
    expect(switchHitBox.width).toBeGreaterThanOrEqual(44);
    expect(switchHitBox.height).toBeGreaterThanOrEqual(44);

    // Non-optimistic failure: inject 503 write_interrupted and verify switch stays false with retry
    const cmdRoute = '**/api/crm/commands/capability.grant';
    await page.route(cmdRoute, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'write_interrupted', retryable: true }),
      }),
    );
    await accessSwitch.focus();
    await accessSwitch.press('Space');
    await expect(accessSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('alert')).toContainText('interrupted');
    await page.unroute(cmdRoute);

    // Retry using the inline Retry button (same requestId) and confirm switch turns on
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(accessSwitch).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });
    await expect(page.getByRole('status').filter({ hasText: 'Granted Open the CRM' })).toBeAttached();
    await health(page, 'crm-capabilities', info);

    // Offline disables switches with explicit explanation; reconnect restores
    await setOfflineForTest(page, context, true);
    await expect(accessSwitch).toBeDisabled();
    await expect(page.getByText('Capability changes need a connection').first()).toBeVisible();
    await setOfflineForTest(page, context, false);
    await expect(accessSwitch).toBeEnabled({ timeout: 15_000 });

    // Revoke via keyboard Space
    await accessSwitch.focus();
    await accessSwitch.press('Space');
    await expect(accessSwitch).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });

    // History tab: verify Granted and Revoked entries
    await capTab.press('ArrowRight');
    const historyTab = page.getByRole('tab', { name: 'History', exact: true });
    await expect(historyTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Granted').first()).toBeVisible();
    await expect(page.getByText('Revoked').first()).toBeVisible();
    await health(page, 'crm-history', info);
  } finally {
    await request(`/api/users/${teammate.user.id}`, undefined, 'DELETE').catch(() => {});
    await request(`/api/users/${inactiveGrantUser.user.id}`, undefined, 'DELETE').catch(() => {});
  }
});

test('CRM access denied, automatic and manual revocation, 320px reflow and 200% text scaling', async ({ page, browser }, info) => {
  const member = await createMember('denied');
  const memberCtx = await browser.newContext({
    viewport: info.project.use.viewport,
    colorScheme: info.project.use.colorScheme,
    hasTouch: info.project.use.hasTouch,
    deviceScaleFactor: info.project.use.deviceScaleFactor,
    reducedMotion: info.project.use.reducedMotion,
    locale: info.project.use.locale,
    timezoneId: info.project.use.timezoneId,
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
  });
  await memberCtx.route('**/*', (route) =>
    new URL(route.request().url()).origin === new URL(fixture.base).origin
      ? route.continue()
      : route.abort(),
  );
  await memberCtx.addInitScript((s) => {
    localStorage.setItem('ws_token', s.token);
    localStorage.setItem('ws_uid', s.user.id);
    localStorage.setItem('ws_user', JSON.stringify(s.user));
    localStorage.setItem('ws_theme', 'system');
  }, member);
  const memberPage = await memberCtx.newPage();

  try {
    // Member without crm.access sees no AppSwitcher in Workspace and Access Denied on /crm
    await navigateReady(memberPage, fixture.base + '/');
    await expect(memberPage.getByTestId('app-switcher-trigger')).toHaveCount(0);
    await navigateReady(memberPage, fixture.base + '/crm');
    await expect(memberPage.getByRole('heading', { name: "You don't have access to this" })).toBeVisible();
    await memberPage.evaluate(() => document.fonts.ready);
    await health(memberPage, 'crm-access-denied', info);
    await expect(memberPage.locator('[data-app="crm"]')).toHaveScreenshot('crm-access-denied.png');

    // Grant admin + crm.access + crm.capabilities.manage
    await request(`/api/users/${member.user.id}`, { role: 'admin' }, 'PATCH');
    for (const capability of ['crm.access', 'crm.capabilities.manage']) {
      await request('/api/crm/commands/capability.grant', {
        requestId: 'ux_' + randomUUID().replace(/-/g, ''),
        input: { userId: member.user.id, capability, scope: '*' },
      });
    }

    await navigateReady(memberPage, fixture.base + '/crm/settings/access');
    await expect(memberPage.getByRole('heading', { name: 'Accounts and capabilities' })).toBeVisible();
    await expect(memberPage.getByRole('tablist')).toBeVisible();

    // 1. Automatic capability revocation (NO manual Refresh, reload, or focus/visibility click)
    await request('/api/crm/commands/capability.revoke', {
      requestId: 'ux_' + randomUUID().replace(/-/g, ''),
      input: { userId: member.user.id, capability: 'crm.capabilities.manage', scope: '*' },
    });
    await expect(memberPage.getByRole('heading', { name: "You don't have access to this" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(memberPage.getByRole('heading', { name: 'Accounts and capabilities' })).toHaveCount(0);
    await expect(memberPage.getByRole('tablist')).toHaveCount(0);

    // 2. Automatic remote admin demotion (NO manual Refresh)
    await request('/api/crm/commands/capability.grant', {
      requestId: 'ux_' + randomUUID().replace(/-/g, ''),
      input: { userId: member.user.id, capability: 'crm.capabilities.manage', scope: '*' },
    });
    await navigateReady(memberPage, fixture.base + '/crm/settings/access');
    await expect(memberPage.getByRole('heading', { name: 'Accounts and capabilities' })).toBeVisible();

    await request(`/api/users/${member.user.id}`, { role: 'member' }, 'PATCH');
    await expect(memberPage.getByRole('heading', { name: "You don't have access to this" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(memberPage.getByRole('heading', { name: 'Accounts and capabilities' })).toHaveCount(0);
    await expect(memberPage.getByRole('tablist')).toHaveCount(0);

    // 3. Retained manual-refresh revocation test (re-promote admin -> revoke crm.access -> click Refresh)
    await request(`/api/users/${member.user.id}`, { role: 'admin' }, 'PATCH');
    await navigateReady(memberPage, fixture.base + '/crm/settings/access');
    await expect(memberPage.getByRole('heading', { name: 'Accounts and capabilities' })).toBeVisible();

    await request('/api/crm/commands/capability.revoke', {
      requestId: 'ux_' + randomUUID().replace(/-/g, ''),
      input: { userId: member.user.id, capability: 'crm.access', scope: '*' },
    });
    await memberPage.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(memberPage.getByRole('heading', { name: "You don't have access to this" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(memberPage.getByRole('heading', { name: 'Accounts and capabilities' })).toHaveCount(0);

    // 320x568 reflow and 200% text scaling on owner CRM Home & Settings
    await navigateReady(page, fixture.base + '/crm');
    await page.setViewportSize({ width: 320, height: 568 });
    await expect(page.getByRole('heading', { name: /Welcome,/ })).toBeVisible();
    const reflowHome = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(reflowHome.scroll).toBeLessThanOrEqual(reflowHome.width + 1);

    await navigateReady(page, fixture.base + '/crm/settings/access');
    await page.getByRole('tab', { name: 'Capabilities', exact: true }).click();
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await health(page, 'crm-200pct', info);
  } finally {
    await memberCtx.close();
    await request(`/api/users/${member.user.id}`, undefined, 'DELETE').catch(() => {});
  }
});
