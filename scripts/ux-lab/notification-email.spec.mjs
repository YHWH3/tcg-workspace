import { test, expect, open, health } from './support.mjs';
import { surfaces } from './catalog.mjs';

test('notification email: keyboard verification, failure recovery and removal', async ({ page }, info) => {
  // Browser contract fixture. The separate D1 suite connects the real route
  // to a disposable delivery sink and tests the server-side checks.
  let email = null;
  let pending = null;
  const respond = (route, status, data) => route.fulfill({ status, json: data });
  await page.route('**/api/me/email', route => {
    switch (route.request().method()) {
      case 'POST':
        pending = route.request().postDataJSON().email;
        return respond(route, 202, { pending, delivery: 'accepted' });
      case 'DELETE':
        email = pending = null;
        return respond(route, 200, { ok: true });
      default:
        return respond(route, 200, { email, pending, available: true });
    }
  });
  await page.route('**/api/me/email/verify', route => {
    if (route.request().postDataJSON().code !== '123456') {
      return respond(route, 400, { error: 'That code could not be verified. Check it or request a new code.' });
    }
    email = pending;
    pending = null;
    return respond(route, 200, { email });
  });
  await open(page, surfaces.find(surface => surface.id === 'settings'));
  const address = page.getByRole('textbox', { name: 'Email address', exact: true });
  const code = page.getByRole('textbox', { name: 'Verification code', exact: true });
  await address.fill('owner@example.test');
  await address.press('Enter');
  await expect(code).toBeFocused();
  await expect(page.getByText('Check your email for the six-digit code.')).toBeVisible();
  await code.fill('000000');
  await code.press('Enter');
  await expect(code).toHaveAttribute('aria-invalid', 'true');
  await expect(code).toBeFocused();
  await health(page, 'notification email invalid code', info);
  await code.fill('123456');
  await code.press('Enter');
  await expect(page.getByText('Email verified.', { exact: true })).toBeVisible();
  await expect(page.getByText('Verified: owner@example.test', { exact: true })).toBeVisible();
  const remove = page.getByRole('button', { name: 'Remove email', exact: true });
  await remove.focus();
  await remove.press('Enter');
  await expect(page.getByText('Email removed.', { exact: true })).toBeVisible();
});

test('notification email preferences: channel choice and admin title opt-in', async ({ page }, info) => {
  await page.route('**/api/me/email/delivery', route => route.fulfill({json:{available:true,verified:true}}));
  await open(page, surfaces.find(surface => surface.id === 'settings'));
  const mentions = page.getByRole('combobox', {name:'Mentions', exact:true});
  await expect(mentions.locator('option[value="email"]')).toBeEnabled();
  await mentions.selectOption('email');
  await expect(mentions).toHaveValue('email');
  const titles = page.getByRole('checkbox', {name:'Include readable record titles in notification emails'});
  await expect(titles).not.toBeChecked();
  await titles.focus();
  await titles.press('Space');
  const save = page.getByRole('button', {name:'Save workspace settings'});
  await save.focus();
  await save.press('Enter');
  await expect(page.getByText('Workspace settings saved.')).toBeVisible();
  await health(page, 'notification email preferences', info);
  await page.reload();
  await expect(titles).toBeChecked();
  await expect(mentions).toHaveValue('email');
  await mentions.selectOption('inbox');
  await expect(mentions).toHaveValue('inbox');
  await titles.uncheck();
  await save.click();
  await expect(page.getByText('Workspace settings saved.')).toBeVisible();
});
