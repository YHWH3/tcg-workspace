import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { chromium, webkit } from 'playwright';
import { expect } from '@playwright/test';
import { startFixture } from '../phase4-fixture.mjs';
import { freePort, fingerprint } from '../certification/core.mjs';
import { ensureLabTls } from '../ux-lab/tls.mjs';
import { COMMONS_MEMBERS, COMMONS_OWNER } from './data.mjs';

const root = resolve(import.meta.dirname, '../..');
const check = process.argv.includes('--check');
const artifacts = join(root, '.artifacts/crm-demo');
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(join(artifacts, 'run-'));
const tls = { cert: join(scratch, 'tls/cert.pem'), key: join(scratch, 'tls/key.pem') };
const password = randomBytes(18).toString('base64url');
const sourceFingerprint = fingerprint(root);

let fixture;
let browser;
let mobileBrowser;

try {
  ensureLabTls(tls);
  setDefaultCACertificates([...getCACertificates('default'), readFileSync(tls.cert, 'utf8')]);
  fixture = await startFixture({
    port: await freePort(),
    tls,
    artifactDirectory: join(scratch, 'local-worker'),
    vars: { CRM_ENABLED: 'true' },
  });

  async function requestJson(path, { method = 'POST', body, token } = {}) {
    const res = await fetch(fixture.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json();
    assert.ok(res.ok, `${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }

  const owner = await requestJson('/api/auth/signup', {
    body: { username: COMMONS_OWNER.username, name: COMMONS_OWNER.name, password },
  });
  assert.ok(owner.token);

  const createdUsers = {};
  for (const member of COMMONS_MEMBERS) {
    const invite = await requestJson('/api/invites', { token: owner.token });
    const signed = await requestJson('/api/auth/signup', {
      body: { username: member.username, name: member.name, password, inviteCode: invite.code },
    });
    createdUsers[member.username] = signed;
    if (member.role === 'admin') {
      await requestJson(`/api/users/${signed.user.id}`, {
        method: 'PATCH',
        token: owner.token,
        body: { role: 'admin' },
      });
    }
    for (const capability of member.capabilities) {
      const cmd = await requestJson('/api/crm/commands/capability.grant', {
        token: owner.token,
        body: {
          requestId: 'demo_' + randomUUID().replace(/-/g, ''),
          input: {
            userId: signed.user.id,
            capability,
            scope: '*',
            ...(member.reason ? { reason: member.reason } : {}),
          },
        },
      });
      assert.equal(cmd.ok, true, `Seed grant ${capability} for ${member.username}`);
    }
  }

  // Leave one unused invite visible in Accounts.
  const unusedInvite = await requestJson('/api/invites', { token: owner.token });
  assert.ok(unusedInvite.code);

  const spki = new X509Certificate(readFileSync(tls.cert)).publicKey.export({
    type: 'spki',
    format: 'der',
  });
  browser = await chromium.launch({
    headless: check,
    args: [
      '--window-size=1440,960',
      '--ignore-certificate-errors-spki-list=' + createHash('sha256').update(spki).digest('base64'),
    ],
  });

  async function openAuthedPage(browserInstance, session, options) {
    const context = await browserInstance.newContext({ ignoreHTTPSErrors: true, ...options });
    await context.route('**/*', (route) =>
      route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort(),
    );
    await context.addInitScript((s) => {
      localStorage.setItem('ws_token', s.token);
      localStorage.setItem('ws_uid', s.user.id);
      localStorage.setItem('ws_user', JSON.stringify(s.user));
    }, session);
    const page = await context.newPage();
    return { context, page };
  }

  const capture = async (page, filename) => {
    const target = join(artifacts, filename);
    await page.screenshot({ path: target, animations: 'disabled' });
    return target;
  };

  // 1. Desktop Light: Workspace -> AppSwitcher -> CRM Home -> Settings (Accounts, Capabilities, History)
  const { context: ownerCtx, page } = await openAuthedPage(browser, owner, {
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(fixture.base + '/');
  const switcher = page.getByTestId('app-switcher-trigger');
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  await switcher.click();
  const menu = page.getByTestId('app-switcher-menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /CRM/ }).click();

  await expect(page).toHaveURL(/\/crm$/);
  await expect(page.getByRole('heading', { name: 'Welcome, Pia' })).toBeVisible();
  await expect(page.getByText('13 of 13 enabled')).toBeVisible();
  const shots = {};
  shots.homeDesktopLight = await capture(page, 'home-desktop-light.png');

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/crm\/settings\/access/);
  await expect(page.getByText('5 of 7 places in use (guests included)')).toBeVisible();
  const ownerRow = page.getByTestId(`crm-account-${owner.user.id}`);
  await expect(ownerRow).toContainText('All (owner)');
  await expect(ownerRow.getByRole('button', { name: /Disable|Remove/ })).toHaveCount(0);
  await expect(page.getByText(unusedInvite.code)).toBeVisible();
  shots.accountsDesktopLight = await capture(page, 'accounts-desktop-light.png');

  // Capabilities tab: check Dev Nair's inactive-grant warning, then grant & revoke Send email on Meera.
  await page.getByRole('tab', { name: 'Capabilities' }).click();
  const accountCombo = page.getByRole('combobox', { name: 'Account' });
  await accountCombo.selectOption(createdUsers.dev.user.id);
  await expect(
    page.getByText('Specialised grants are inactive until Open the CRM is granted'),
  ).toBeVisible();

  await accountCombo.selectOption(createdUsers.meera.user.id);
  const sendEmailSwitch = page.getByTestId('cap-switch-crm.send:email');
  await expect(sendEmailSwitch).toHaveAttribute('aria-checked', 'false');
  await sendEmailSwitch.click();
  await expect(sendEmailSwitch).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });
  await page.reload();
  await page.getByRole('tab', { name: 'Capabilities' }).click();
  await page.getByRole('combobox', { name: 'Account' }).selectOption(createdUsers.meera.user.id);
  await expect(page.getByTestId('cap-switch-crm.send:email')).toHaveAttribute('aria-checked', 'true');
  shots.capabilitiesDesktopLight = await capture(page, 'capabilities-desktop-light.png');

  await page.getByTestId('cap-switch-crm.send:email').click();
  await expect(page.getByTestId('cap-switch-crm.send:email')).toHaveAttribute('aria-checked', 'false', {
    timeout: 15_000,
  });

  // History tab
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByRole('region', { name: 'Capability audit history' })).toBeVisible();
  await expect(page.getByText('Granted').first()).toBeVisible();
  await expect(page.getByText('Revoked').first()).toBeVisible();
  shots.historyDesktopLight = await capture(page, 'history-desktop-light.png');

  // 2. Desktop Dark theme
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: 'Dark theme' }).click();
  await page.getByRole('tab', { name: 'Capabilities' }).click();
  await expect(page.getByTestId('cap-switch-crm.send:email')).toBeVisible();
  shots.capabilitiesDesktopDark = await capture(page, 'capabilities-desktop-dark.png');

  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Pia' })).toBeVisible();
  shots.homeDesktopDark = await capture(page, 'home-desktop-dark.png');
  await ownerCtx.close();

  // 3. Non-CRM member Access Denied (Kiran Rao)
  const { context: kiranCtx, page: kiranPage } = await openAuthedPage(browser, createdUsers.kiran, {
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
  });
  await kiranPage.goto(fixture.base + '/');
  await expect(kiranPage.getByText('No pages yet', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(kiranPage.getByText('Synced', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(kiranPage.getByTestId('app-switcher-trigger')).toHaveCount(0);
  await kiranPage.goto(fixture.base + '/crm');
  await expect(kiranPage.getByRole('heading', { name: "You don't have access to this" })).toBeVisible();
  shots.accessDeniedDesktopLight = await capture(kiranPage, 'access-denied-desktop-light.png');
  await kiranCtx.close();

  // 4. Mobile 390x844 (WebKit touch): light + dark + full-screen capability sheet
  mobileBrowser = await webkit.launch();
  const { context: mobileLightCtx, page: mobileLight } = await openAuthedPage(mobileBrowser, owner, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'light',
  });
  await mobileLight.goto(fixture.base + '/crm');
  await expect(mobileLight.getByRole('heading', { name: 'Welcome, Pia' })).toBeVisible();
  shots.homeMobileLight = await capture(mobileLight, 'home-mobile-light.png');

  await mobileLight.getByRole('link', { name: 'Settings' }).click();
  await expect(mobileLight.getByText('5 of 7 places in use (guests included)')).toBeVisible();
  const meeraCard = mobileLight.getByTestId(`crm-account-${createdUsers.meera.user.id}`);
  await meeraCard.getByRole('button', { name: 'Capabilities' }).click();
  const sheetDialog = mobileLight.getByRole('dialog', { name: 'Capabilities for Meera Krishnan' });
  await expect(sheetDialog).toBeVisible();
  shots.capabilitiesSheetMobileLight = await capture(
    mobileLight,
    'capabilities-sheet-mobile-light.png',
  );
  await sheetDialog.getByRole('button', { name: 'Done' }).click();
  await expect(sheetDialog).toBeHidden();
  await mobileLightCtx.close();

  const { context: mobileDarkCtx, page: mobileDark } = await openAuthedPage(mobileBrowser, owner, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  });
  await mobileDark.goto(fixture.base + '/crm/settings/access');
  await expect(mobileDark.getByText('5 of 7 places in use (guests included)')).toBeVisible();
  shots.accountsMobileDark = await capture(mobileDark, 'accounts-mobile-dark.png');
  await mobileDarkCtx.close();

  assert.equal(fingerprint(root), sourceFingerprint, 'Source changed during CRM demo check');
  const evidence = {
    base: fixture.base,
    sourceFingerprint,
    accounts: 1 + COMMONS_MEMBERS.length,
    shots,
  };
  writeFileSync(join(artifacts, 'ready.json'), JSON.stringify(evidence, null, 2));
  console.log('CRM Commons demo checks passed. Screenshots: ' + artifacts);

  if (!check) {
    console.log('Preview ready at ' + fixture.base + '/crm');
    await new Promise((resolveDone) => {
      process.once('SIGINT', resolveDone);
      process.once('SIGTERM', resolveDone);
      browser.once('disconnected', resolveDone);
    });
  }
} finally {
  await mobileBrowser?.close();
  await browser?.close();
  await fixture?.stop();
  if (fixture) rmSync(fixture.directory, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
