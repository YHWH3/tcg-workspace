import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Browser-only platform interaction checks for the Phase 4 verifier.
 *
 * The caller owns the browser, fixture, result ledger, and `check` wrapper.
 * This helper deliberately does not start a server, seed data, or call the
 * application API: its evidence comes from the rendered controls and the
 * public form's real POST response.
 *
 * @param {{
 *   browser: import('playwright').Browser;
 *   engine: string;
 *   base: string;
 *   form: { url: string; token: string; title?: string; config?: { successMessage?: string; fields?: Array<{ label?: string; required?: boolean }> } };
 *   board: string;
 *   task: string;
 *   admin: { token: string; user: Record<string, unknown> };
 *   output: string;
 *   check: (engine: string, name: string, fn: () => Promise<void>) => Promise<void>;
 * }} args
 */
export async function verifyPlatformInteractions({ browser, engine, base, form, board, task, admin, output, check }) {
  assert.ok(browser, 'platform checks require a Playwright browser');
  assert.ok(base, 'platform checks require a fixture base URL');
  assert.ok(form?.url && form?.token, 'platform checks require a public form fixture');
  assert.ok(board && task, 'platform checks require board and task fixture ids');
  assert.ok(admin?.token && admin?.user, 'platform checks require an authenticated fixture user');
  assert.ok(output, 'platform checks require an output directory for screenshots');
  assert.equal(typeof check, 'function', 'platform checks require the verifier check wrapper');

  mkdirSync(output, { recursive: true });

  const taskUrl = `${base}/boards/${encodeURIComponent(board)}/tasks/${encodeURIComponent(task)}`;
  const authPayload = [admin.token, admin.user];
  const mobileEngine = engine === 'chromium' || engine === 'webkit';

  const waitFor = async (predicate, description, timeout = 12_000) => {
    const started = Date.now();
    let lastError;
    while (Date.now() - started < timeout) {
      try {
        if (await predicate()) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const suffix = lastError ? ` (${String(lastError?.message ?? lastError)})` : '';
    throw new Error(`Timed out waiting for ${description}${suffix}`);
  };

  const installAuth = async (context) => {
    // One init script per authenticated context mirrors the verifier's
    // login fixture and survives route changes without writing on each page.
    await context.addInitScript(
      ([token, user]) => {
        if (sessionStorage.getItem('v9_login_initialized')) return;
        sessionStorage.setItem('v9_login_initialized', '1');
        localStorage.setItem('ws_token', token);
        localStorage.setItem('ws_user', JSON.stringify(user));
        localStorage.setItem('ws_uid', user.id);
      },
      authPayload,
    );
  };

  const screenshot = async (page, filename) => {
    await page.screenshot({ path: join(output, `${engine}-${filename}.png`), fullPage: true });
  };

  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await installAuth(desktopContext);
  const touchContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    ...(mobileEngine ? { isMobile: true } : {}),
  });
  await installAuth(touchContext);
  const publicContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    ...(mobileEngine ? { isMobile: true } : {}),
  });

  try {
    const desktopPage = await desktopContext.newPage();
    await check(engine, 'platform desktop approval dialog keyboard semantics', async () => {
      await desktopPage.goto(taskUrl, { waitUntil: 'domcontentloaded' });
      const trigger = desktopPage.getByRole('button', { name: 'Request approval', exact: true }).first();
      await trigger.waitFor({ state: 'visible', timeout: 20_000 });

      // A task detail may already own a sheet/dialog. The new request dialog
      // is identified by the increase and is always the last dialog in DOM.
      const dialogs = desktopPage.getByRole('dialog');
      const baselineDialogCount = await dialogs.count();
      await trigger.focus();
      assert.equal(await trigger.evaluate((element) => element === document.activeElement), true, 'approval trigger did not receive focus');
      await trigger.press('Enter');
      await waitFor(async () => (await dialogs.count()) > baselineDialogCount, 'the new approval dialog');

      const newDialog = dialogs.nth((await dialogs.count()) - 1);
      assert.equal(await newDialog.getAttribute('aria-modal'), 'true', 'new approval dialog must be modal');
      assert.equal(await newDialog.getByRole('heading', { name: 'Request approval', exact: true }).count(), 1, 'approval dialog has no accessible name heading');
      assert.equal(
        await newDialog.evaluate((element) => {
          const labelledBy = element.getAttribute('aria-labelledby');
          return Boolean(labelledBy && element.ownerDocument.getElementById(labelledBy)?.textContent?.trim());
        }),
        true,
        'approval dialog must expose its labelled heading',
      );

      const focusables = newDialog.locator('a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[contenteditable="true"],[tabindex]:not([tabindex="-1"])');
      const focusableCount = await focusables.count();
      assert.ok(focusableCount > 0, 'approval dialog has no keyboard focusable controls');
      const first = focusables.first();
      const last = focusables.last();

      await first.focus();
      await desktopPage.keyboard.press('Tab');
      assert.equal(await newDialog.evaluate((element) => element.contains(document.activeElement)), true, 'Tab escaped the approval dialog');
      await desktopPage.keyboard.press('Shift+Tab');
      assert.equal(await newDialog.evaluate((element) => element.contains(document.activeElement)), true, 'Shift+Tab escaped the approval dialog');

      // Explicitly exercise both wrap edges, not only an interior focus move.
      await first.focus();
      await desktopPage.keyboard.press('Shift+Tab');
      assert.equal(await last.evaluate((element) => element === document.activeElement), true, 'Shift+Tab did not wrap to the last dialog control');
      await last.focus();
      await desktopPage.keyboard.press('Tab');
      assert.equal(await first.evaluate((element) => element === document.activeElement), true, 'Tab did not wrap to the first dialog control');

      await screenshot(desktopPage, 'platform-dialog-open');
      await desktopPage.keyboard.press('Escape');
      await waitFor(async () => (await dialogs.count()) === baselineDialogCount, 'only the new approval dialog to close');
      assert.equal(await trigger.evaluate((element) => element === document.activeElement), true, 'Escape did not restore focus to the exact approval trigger');
      await screenshot(desktopPage, 'platform-dialog-closed');
    });

    if (!mobileEngine) {
      // Playwright Firefox supports touch input but does not implement the
      // Chromium/WebKit `isMobile` context option. Keep this boundary visible
      // without recording a false PASS/FAIL result for unsupported emulation.
      console.log(`NOT RUN [${engine}] mobile context: Playwright Firefox does not support isMobile; hasTouch pointer checks continue below.`);
    }

    const touchPage = await touchContext.newPage();
    await check(engine, 'platform touch approval request tap and close', async () => {
      await touchPage.goto(taskUrl, { waitUntil: 'domcontentloaded' });
      const trigger = touchPage.getByRole('button', { name: 'Request approval', exact: true }).first();
      await trigger.waitFor({ state: 'visible', timeout: 20_000 });
      const dialogs = touchPage.getByRole('dialog');
      const baselineDialogCount = await dialogs.count();
      await trigger.tap();
      await waitFor(async () => (await dialogs.count()) > baselineDialogCount, 'touch approval dialog');
      const newDialog = dialogs.nth((await dialogs.count()) - 1);
      assert.equal(await newDialog.getAttribute('aria-modal'), 'true', 'touch approval dialog must be modal');
      assert.equal(await newDialog.getByRole('heading', { name: 'Request approval', exact: true }).count(), 1, 'touch approval dialog has no accessible name');
      await screenshot(touchPage, 'platform-touch-approval-open');
      await newDialog.getByRole('button', { name: 'Close', exact: true }).tap();
      await waitFor(async () => (await dialogs.count()) === baselineDialogCount, 'touch approval dialog to close');
      await screenshot(touchPage, 'platform-touch-approval-closed');
    });

    await check(engine, 'platform touch Inbox notification preferences', async () => {
      await touchPage.goto(`${base}/inbox`, { waitUntil: 'domcontentloaded' });
      const preferences = touchPage.getByRole('button', { name: 'Notification preferences', exact: true });
      await preferences.waitFor({ state: 'visible', timeout: 20_000 });
      await preferences.tap();
      await touchPage.getByLabel('Assignments', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
      await screenshot(touchPage, 'platform-touch-inbox-preferences');
      await preferences.tap();
    });

    const publicPage = await publicContext.newPage();
    await check(engine, 'platform public form touch submit accepted without auth', async () => {
      await publicPage.goto(form.url, { waitUntil: 'domcontentloaded' });
      assert.equal(await publicPage.evaluate(() => localStorage.getItem('ws_token')), null, 'public form context unexpectedly has an auth token');
      const name = publicPage.getByLabel(/^Your name/);
      await name.waitFor({ state: 'visible', timeout: 20_000 });
      await name.tap();
      await name.fill(`Platform ${engine} ${Date.now()}`);

      // The default fixture has only “Your name”. If the caller supplies the
      // people form, satisfy its exact optional Email label as well.
      const email = publicPage.getByLabel(/^Email/);
      if (await email.count()) {
        await email.tap();
        await email.fill(`platform-${engine}@example.test`);
      }

      const submit = publicPage.getByRole('button', { name: 'Submit', exact: true });
      await submit.waitFor({ state: 'visible', timeout: 10_000 });
      await waitFor(async () => !(await submit.isDisabled()), 'public form Submit button to become enabled');
      const responsePromise = publicPage.waitForResponse(
        (response) => response.request().method() === 'POST' && response.url().includes(`/api/public/forms/${encodeURIComponent(form.token)}`),
        { timeout: 20_000 },
      );
      // Mark the response wait handled immediately so a later fill/tap failure
      // cannot turn its eventual timeout into an unhandled rejection. The
      // original promise is still awaited below, preserving response asserts.
      void responsePromise.catch(() => undefined);
      await submit.tap();
      const response = await responsePromise;
      assert.equal(response.status(), 200, `public form POST failed with HTTP ${response.status()}`);
      assert.equal(response.request().headers().authorization, undefined, 'public form POST must not send an Authorization header');
      const body = await response.json();
      assert.equal(body?.state, 'accepted', `public form response was not accepted: ${JSON.stringify(body)}`);
      assert.equal(typeof body?.submissionId, 'string', 'accepted public form response has no submission id');
      assert.equal(typeof body?.message, 'string', 'accepted public form response has no receipt message');
      await publicPage.getByText(form.config?.successMessage ?? body.message, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
      await screenshot(publicPage, 'platform-public-form-receipt');
    });
  } finally {
    await Promise.all([desktopContext.close(), touchContext.close(), publicContext.close()]);
  }
}

