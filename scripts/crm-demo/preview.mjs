import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { chromium, webkit } from 'playwright';
import { expect } from '@playwright/test';
import { startFixture } from '../phase4-fixture.mjs';
import { freePort, fingerprint } from '../certification/core.mjs';
import { ensureLabTls } from '../ux-lab/tls.mjs';
import {
  COMMONS_FACTS,
  COMMONS_MEMBERS,
  COMMONS_OPPORTUNITIES,
  COMMONS_ORGS,
  COMMONS_OWNER,
  COMMONS_PATRON_SUBMISSIONS,
  COMMONS_PEOPLE,
  COMMONS_PROGRAMME_RECORDS,
  COMMONS_SAMPLE_PROGRAMME_PROFILE,
} from './data.mjs';

const root = resolve(import.meta.dirname, '../..');
const check = process.argv.includes('--check');
const artifacts = join(root, '.artifacts/crm-demo');
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(join(artifacts, 'run-'));
const tls = { cert: join(scratch, 'tls/cert.pem'), key: join(scratch, 'tls/key.pem') };
const password = randomBytes(18).toString('base64url');
const sourceFingerprint = fingerprint(root);
const ingestSecret = 'demo-ingest-disposable';

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;
function fnv1a64hex(input) {
  let h = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * FNV_PRIME) & FNV_MASK;
  }
  return h.toString(16).padStart(16, '0');
}
function linkId(kind, fieldId, fromId, toId) {
  const fwd = `${kind}|${fieldId ?? ''}|${fromId}|${toId}`;
  const rev = [...fwd].reverse().join('');
  return `lk_${fnv1a64hex(fwd)}${fnv1a64hex(rev)}`;
}

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
    vars: {
      CRM_ENABLED: 'true',
      WORKSPACE_ENV: 'local-test',
      WEBSITE_INGEST_ENABLED: 'true',
      WEBSITE_INGEST_SECRET: ingestSecret,
    },
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

  async function pullAllRecords(token) {
    const manifest = await requestJson('/api/access', { method: 'GET', token });
    const all = [];
    if (Array.isArray(manifest?.spaces)) {
      let cursor = 0;
      let joining = manifest.spaces.map((s) => ({ space: s.id, after: 0, base: 0 }));
      for (let i = 0; i < 20; i++) {
        const reply = await requestJson('/api/sync/pull', {
          token,
          body: { protocol: 3, etag: manifest.etag, cursor, joining, limit: 500 },
        });
        all.push(...reply.records);
        if (!reply.hasMore) break;
        cursor = reply.cursor;
        joining = reply.joining;
      }
    } else {
      let since = 0;
      for (let i = 0; i < 20; i++) {
        const reply = await requestJson(`/api/sync/pull?since=${since}&limit=500`, {
          method: 'GET',
          token,
        });
        all.push(...reply.records);
        if (!reply.hasMore) break;
        since = reply.cursor;
      }
    }
    return all;
  }

  async function ingestWebsiteEvent(payload) {
    const raw = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = 'sha256=' + createHmac('sha256', ingestSecret).update(`${ts}.${raw}`).digest('hex');
    const res = await fetch(fixture.base + '/api/ingest/website', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TCG-Timestamp': ts,
        'X-TCG-Signature': sig,
      },
      body: raw,
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json();
    assert.equal(res.status, 200, `POST /api/ingest/website -> ${res.status}: ${JSON.stringify(data)}`);
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
    for (const sg of member.scopedGrants ?? []) {
      const cmd = await requestJson('/api/crm/commands/capability.grant', {
        token: owner.token,
        body: {
          requestId: 'demo_' + randomUUID().replace(/-/g, ''),
          input: {
            userId: signed.user.id,
            capability: sg.capability,
            scope: sg.scope,
            reason: sg.reason,
          },
        },
      });
      assert.equal(cmd.ok, true, `Seed scoped grant ${sg.capability} (${sg.scope}) for ${member.username}`);
    }
  }

  // Leave one unused invite visible in Accounts (5 of 7 places used).
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

  const shots = {};

  // =========================================================================
  // Part A — S0 Foundation checks (before P1 records populate Home My Work)
  // =========================================================================
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
  shots.homeDesktopLight = await capture(page, 'home-desktop-light.png');

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/crm\/settings\/access/);
  await expect(page.getByText('5 of 7 places in use (guests included)')).toBeVisible();
  const ownerRow = page.getByTestId(`crm-account-${owner.user.id}`);
  await expect(ownerRow).toContainText('All (owner)');
  await expect(ownerRow.getByRole('button', { name: /Disable|Remove/ })).toHaveCount(0);
  await expect(page.getByText(unusedInvite.code)).toBeVisible();
  shots.accountsDesktopLight = await capture(page, 'accounts-desktop-light.png');

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

  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByRole('region', { name: 'Capability audit history' })).toBeVisible();
  await expect(page.getByText('Granted').first()).toBeVisible();
  await expect(page.getByText('Revoked').first()).toBeVisible();
  shots.historyDesktopLight = await capture(page, 'history-desktop-light.png');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: 'Dark theme' }).click();
  await page.getByRole('tab', { name: 'Capabilities' }).click();
  await expect(page.getByTestId('cap-switch-crm.send:email')).toBeVisible();
  shots.capabilitiesDesktopDark = await capture(page, 'capabilities-desktop-dark.png');

  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Pia' })).toBeVisible();
  shots.homeDesktopDark = await capture(page, 'home-desktop-dark.png');

  // Switch back to Light mode on desktop owner page before capturing P1 light screenshots
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Light theme' }).click();

  // Access denied check (Kiran Rao)
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

  // Mobile S0 captures (390x844 WebKit touch)
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

  // =========================================================================
  // Part B — Install TCG Operating Pack v12 & Seed P1 Commons Fixture
  // =========================================================================
  await page.getByRole('link', { name: 'People' }).click();
  const initPackBtn = page.getByRole('button', { name: 'Initialise TCG CRM databases' });
  await expect(initPackBtn).toBeVisible({ timeout: 15_000 });
  await initPackBtn.click();
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible({ timeout: 25_000 });

  // Wait until bundled pack boards reach D1 via sync outbox
  let boardByKey = {};
  for (let attempt = 0; attempt < 40; attempt++) {
    const records = await pullAllRecords(owner.token);
    boardByKey = {};
    for (const r of records) {
      if (r.collection === 'boards' && !r.data.deleted && typeof r.data.templateDbKey === 'string') {
        boardByKey[r.data.templateDbKey] = r.id;
      }
    }
    if (
      boardByKey.people &&
      boardByKey.organizations &&
      boardByKey.programs &&
      boardByKey.affiliations &&
      boardByKey.applications &&
      boardByKey.activities &&
      boardByKey.opportunities &&
      boardByKey.projects
    ) {
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  for (const reqKey of ['people', 'organizations', 'programs', 'affiliations', 'applications', 'activities', 'opportunities', 'projects']) {
    assert.ok(boardByKey[reqKey], `Expected installed board ${reqKey}`);
  }

  // Enable website ingest service grant
  await requestJson('/api/admin/website-ingest', {
    method: 'PUT',
    token: owner.token,
    body: { spaceId: 'space-core' },
  });

  // Push Commons Organisations, People, Affiliations, Programmes, Activities, Opportunities, and Patrons
  const now = Date.now();
  const todayStr = new Date(now).toISOString().slice(0, 10);
  const yesterdayStr = new Date(now - 86_400_000).toISOString().slice(0, 10);
  const nextWeekStr = new Date(now + 5 * 86_400_000).toISOString().slice(0, 10);
  const changes = [];

  for (let i = 0; i < COMMONS_ORGS.length; i++) {
    const o = COMMONS_ORGS[i];
    changes.push({
      id: `demo_${o.key}`,
      collection: 'tasks',
      ts: now,
      patch: {
        boardId: boardByKey.organizations,
        title: o.title,
        order: `a${String(i).padStart(2, '0')}`,
        p_f_org_type: o.type,
        p_f_partnership: o.partnership,
        p_f_location: o.location,
        p_f_focus: o.focus,
        p_f_website: o.website,
        p_f_relationship_owner: owner.user.id,
      },
    });
  }

  for (let i = 0; i < COMMONS_PEOPLE.length; i++) {
    const p = COMMONS_PEOPLE[i];
    const personId = `demo_${p.key}`;
    const orgId = `demo_${COMMONS_ORGS[p.orgIndex].key}`;
    changes.push({
      id: personId,
      collection: 'tasks',
      ts: now,
      patch: {
        boardId: boardByKey.people,
        title: p.title,
        order: `a${String(i).padStart(2, '0')}`,
        p_f_email: p.email,
        p_f_phone: p.phone,
        p_f_location: p.location,
        p_f_source: p.source,
        p_f_membership: p.membership,
        p_f_skills: p.skills,
        p_f_languages: p.languages,
        p_f_interests: p.interests,
        p_f_relationship_owner: i % 2 === 0 ? owner.user.id : createdUsers.arun.user.id,
      },
    });

    if (i < 12) {
      const affId = `demo_aff_${i}`;
      changes.push({
        id: affId,
        collection: 'tasks',
        ts: now,
        patch: {
          boardId: boardByKey.affiliations,
          title: `${p.title} — ${COMMONS_ORGS[p.orgIndex].title}`,
          status: 'active',
          order: `a${String(i).padStart(2, '0')}`,
          p_f_role: p.role,
          p_f_kind: i % 2 === 0 ? 'member' : 'partner',
        },
      });
      changes.push(
        {
          id: linkId('relation', 'f_person', affId, personId),
          collection: 'links',
          ts: now,
          patch: { fromType: 'record', fromId: affId, toType: 'record', toId: personId, kind: 'relation', fieldId: 'f_person', createdBy: owner.user.id, createdAt: now, deleted: false },
        },
        {
          id: linkId('relation', 'f_org', affId, orgId),
          collection: 'links',
          ts: now,
          patch: { fromType: 'record', fromId: affId, toType: 'record', toId: orgId, kind: 'relation', fieldId: 'f_org', createdBy: owner.user.id, createdAt: now, deleted: false },
        },
      );
    }
  }

  for (let i = 0; i < COMMONS_PROGRAMME_RECORDS.length; i++) {
    const pr = COMMONS_PROGRAMME_RECORDS[i];
    changes.push({
      id: `demo_${pr.key}`,
      collection: 'tasks',
      ts: now,
      patch: {
        boardId: boardByKey.programs,
        title: pr.title,
        status: pr.status,
        order: `a${String(i).padStart(2, '0')}`,
        p_f_slug: pr.slug,
        p_f_area: pr.area,
        p_f_public_forms: pr.forms,
        p_f_summary: pr.summary,
        p_f_lead: i % 2 === 0 ? owner.user.id : createdUsers.arun.user.id,
      },
    });
  }

  const demoActivities = [
    { id: 'demo_act_1', title: 'Follow up with Nandini Menon on studio induction', type: 'call', when: `${todayStr}T10:30:00Z`, due: todayStr, done: false, personId: 'demo_person_0' },
    { id: 'demo_act_2', title: 'Overdue check-in: Palmyra timber brief', type: 'follow_up', when: `${yesterdayStr}T15:00:00Z`, due: yesterdayStr, done: false, personId: 'demo_person_2' },
    { id: 'demo_act_3', title: 'Site walk at Dhaanyam Food Forest', type: 'visit', when: `${nextWeekStr}T09:00:00Z`, due: nextWeekStr, done: false, personId: 'demo_person_1' },
    { id: 'demo_act_4', title: 'Common Lab quarterly partner sync', type: 'meeting', when: `${todayStr}T16:00:00Z`, due: todayStr, done: false, personId: 'demo_person_3' },
    { id: 'demo_act_5', title: 'Initial WhatsApp greeting completed', type: 'note', when: `${yesterdayStr}T11:00:00Z`, due: yesterdayStr, done: true, personId: 'demo_person_4' },
  ];
  for (let i = 0; i < demoActivities.length; i++) {
    const a = demoActivities[i];
    changes.push({
      id: a.id,
      collection: 'tasks',
      ts: now,
      patch: {
        boardId: boardByKey.activities,
        title: a.title,
        status: a.done ? 'done' : 'planned',
        order: `a${i}`,
        p_f_type: a.type,
        p_f_when: a.when,
        p_f_due: a.due,
        p_f_owner: owner.user.id,
        p_f_done: a.done,
        p_f_summary: '[Commons Sample Fixture] Logged follow-up activity.',
      },
    });
    changes.push({
      id: linkId('relation', 'f_people', a.id, a.personId),
      collection: 'links',
      ts: now,
      patch: { fromType: 'record', fromId: a.id, toType: 'record', toId: a.personId, kind: 'relation', fieldId: 'f_people', createdBy: owner.user.id, createdAt: now, deleted: false },
    });
  }

  for (let i = 0; i < COMMONS_OPPORTUNITIES.length; i++) {
    const opp = COMMONS_OPPORTUNITIES[i];
    const oppId = `demo_${opp.key}`;
    const pId = `demo_person_${opp.personIndex}`;
    const oId = `demo_${COMMONS_ORGS[opp.orgIndex].key}`;
    const progId = `demo_prog_${opp.programmeSlug}`;
    changes.push({
      id: oppId,
      collection: 'tasks',
      ts: now,
      patch: {
        boardId: boardByKey.opportunities,
        title: opp.title,
        status: opp.status,
        order: `a${i}`,
        p_f_pipeline: opp.pipeline,
        p_f_type: opp.type,
        p_f_amount: opp.amount,
        p_f_owner: owner.user.id,
        p_f_next_action: opp.nextAction,
        p_f_next_action_date: nextWeekStr,
      },
    });
    changes.push(
      { id: linkId('relation', 'f_people', oppId, pId), collection: 'links', ts: now, patch: { fromType: 'record', fromId: oppId, toType: 'record', toId: pId, kind: 'relation', fieldId: 'f_people', createdBy: owner.user.id, createdAt: now, deleted: false } },
      { id: linkId('relation', 'f_org', oppId, oId), collection: 'links', ts: now, patch: { fromType: 'record', fromId: oppId, toType: 'record', toId: oId, kind: 'relation', fieldId: 'f_org', createdBy: owner.user.id, createdAt: now, deleted: false } },
      { id: linkId('relation', 'f_programme', oppId, progId), collection: 'links', ts: now, patch: { fromType: 'record', fromId: oppId, toType: 'record', toId: progId, kind: 'relation', fieldId: 'f_programme', createdBy: owner.user.id, createdAt: now, deleted: false } },
    );
  }

  for (let i = 0; i < COMMONS_PATRON_SUBMISSIONS.length; i++) {
    const pat = COMMONS_PATRON_SUBMISSIONS[i];
    changes.push({
      id: pat.key,
      collection: 'tasks',
      ts: now,
      patch: {
        boardId: 'board-website-inbox',
        title: pat.title,
        status: pat.stage,
        order: `z${i}`,
        p_wi_family: 'patrons',
        p_wi_email: pat.email,
        p_wi_tier: pat.tier,
        p_wi_stage: pat.stage,
        p_wi_edition: pat.edition,
        p_wi_event: pat.event,
        p_wi_received: pat.received,
        p_wi_paid: pat.paid,
        p_wi_application: pat.code,
        createdAt: now - i * 60_000,
      },
    });
  }

  const pushRes = await requestJson('/api/sync/push', { token: owner.token, body: { changes } });
  assert.ok(!pushRes.rejected && !(pushRes.rejectedItems?.length), `Demo push rejected: ${JSON.stringify(pushRes)}`);

  // Website ingest submissions
  const subLab = await ingestWebsiteEvent({
    v: 2,
    id: 'demo-lab-enq-1',
    event: 'form.submitted',
    occurred_at: '2026-10-22T10:15:00.000Z',
    form_id: 'lab',
    subject: 'Common Lab Residency Proposal — Nandini Menon',
    page: '/common-lab/',
    reply_to: COMMONS_PEOPLE[0].email,
    answers: [
      { name: 'Name', label: 'Your name', value: COMMONS_PEOPLE[0].title },
      { name: 'Practice', label: 'Practice & proposal', value: '[Commons Sample Fixture] Natural dye & woven acoustic panel exploration over 4 weeks.' },
    ],
  });
  await ingestWebsiteEvent({
    v: 2,
    id: 'demo-consulting-enq-2',
    event: 'form.submitted',
    occurred_at: '2026-10-23T11:30:00.000Z',
    form_id: 'consulting',
    subject: 'Bamboo Canopy Consultation — Kavya Deshmukh',
    page: '/consulting/',
    reply_to: COMMONS_PEOPLE[2].email,
    answers: [
      { name: 'Name', label: 'Your name', value: COMMONS_PEOPLE[2].title },
      { name: 'Scope', label: 'Project scope', value: '[Commons Sample Fixture] Low-embodied-carbon roof retrofit inquiry.' },
    ],
  });

  // Backfill endpoints in <=25-item batches -> detects 2 intentional duplicate collisions
  const bfDry = await requestJson('/api/crm/commands/endpoints.backfill', {
    token: owner.token,
    body: { requestId: 'demo_bf_dry', input: { limit: 25, dryRun: true } },
  });
  assert.equal(bfDry.ok, true);
  assert.ok(bfDry.result.wouldCreate >= 20);

  const bfBatch1 = await requestJson('/api/crm/commands/endpoints.backfill', {
    token: owner.token,
    body: { requestId: 'demo_bf_1', input: { limit: 25, dryRun: false } },
  });
  assert.equal(bfBatch1.ok, true);

  const bfBatch2 = await requestJson('/api/crm/commands/endpoints.backfill', {
    token: owner.token,
    body: {
      requestId: 'demo_bf_2',
      input: {
        personIds: COMMONS_PEOPLE.slice(20).map((p) => `demo_${p.key}`),
        dryRun: false,
      },
    },
  });
  assert.equal(bfBatch2.ok, true);

  const dupList = await requestJson('/api/crm/read/duplicates?state=open', { method: 'GET', token: owner.token });
  assert.ok(dupList.items.length >= 2, 'Expected intentional duplicate candidates in demo');

  // Record explicit consent (granted for person 0, withdrawn for person 2)
  await requestJson('/api/crm/commands/person.record_consent', {
    token: owner.token,
    body: {
      requestId: 'demo_consent_0',
      input: { personId: 'demo_person_0', channel: 'whatsapp', scope: 'updates', status: 'granted', source: 'demo_onboarding' },
    },
  });
  await requestJson('/api/crm/commands/person.add_endpoint', {
    token: owner.token,
    body: {
      requestId: 'demo_wa_ep_2',
      input: { personId: 'demo_person_2', kind: 'whatsapp', value: COMMONS_PEOPLE[2].phone, makePrimary: true },
    },
  });
  await requestJson('/api/crm/commands/person.record_consent', {
    token: owner.token,
    body: {
      requestId: 'demo_consent_2',
      input: { personId: 'demo_person_2', channel: 'whatsapp', scope: 'updates', status: 'withdrawn', source: 'demo_opt_out' },
    },
  });

  // Configure sample programme profile
  await requestJson('/api/crm/commands/programme.update_profile', {
    token: owner.token,
    body: {
      requestId: 'demo_prog_profile',
      input: { slug: 'common-lab', profile: COMMONS_SAMPLE_PROGRAMME_PROFILE },
    },
  });

  // Create application from website submission + request Workspace approval
  const subRecordId = subRecordIdFromPull(await pullAllRecords(owner.token), subLab.recordId);
  const appCmd = await requestJson('/api/crm/commands/application.create_from_submission', {
    token: owner.token,
    body: {
      requestId: 'demo_app_1',
      input: { submissionId: subRecordId, programmeSlug: 'common-lab', applicationsBoardId: boardByKey.applications },
    },
  });
  assert.equal(appCmd.ok, true);
  await requestJson('/api/approvals', {
    token: owner.token,
    body: {
      targetType: 'record',
      targetId: appCmd.result.applicationId,
      approverId: createdUsers.arun.user.id,
      note: '[Commons Sample Fixture] Review Common Lab residency proposal before acceptance',
      requestId: 'demo_appr_app_1',
    },
  });

  // Propose + Verify facts (2 fresh + 1 stale)
  const factIds = [];
  for (let i = 0; i < COMMONS_FACTS.length; i++) {
    const f = COMMONS_FACTS[i];
    const proposed = await requestJson('/api/crm/commands/fact.propose', {
      token: owner.token,
      body: {
        requestId: `demo_fact_prop_${i}`,
        input: {
          programmeSlug: f.programmeSlug,
          category: f.category,
          title: f.title,
          statement: f.statement,
          sourceRef: f.sourceRef,
          reviewBy: f.stale ? now - 86_400_000 : now + 90 * 86_400_000,
        },
      },
    });
    const fId = proposed.result.fact.id;
    factIds.push(fId);
    await requestJson('/api/crm/commands/fact.verify', {
      token: owner.token,
      body: {
        requestId: `demo_fact_ver_${i}`,
        input: {
          factId: fId,
          reviewBy: f.stale ? now - 86_400_000 : now + 90 * 86_400_000,
          expectedRev: proposed.result.fact.rev,
        },
      },
    });
  }

  // Simulated multi-channel inbound + manual conversation + internal note + grounded AI draft
  const waInbound = await requestJson('/api/crm/commands/conversation.simulate_inbound', {
    token: owner.token,
    body: {
      requestId: 'demo_sim_wa_0',
      input: {
        channel: 'whatsapp',
        externalEventId: 'demo_wa_evt_1',
        fromValue: COMMONS_PEOPLE[0].phone,
        subject: 'Common Lab studio induction & hours',
        bodyText: 'Hi Commons team! Could you confirm studio hours for next Tuesday induction and fee waivers?',
        programmeSlug: 'common-lab',
      },
    },
  });
  const waConvId = waInbound.result.conversationId;

  await requestJson('/api/crm/commands/message.add_note', {
    token: owner.token,
    body: {
      requestId: 'demo_note_wa_0',
      input: {
        conversationId: waConvId,
        bodyText: 'Internal note: Nandini has valid WhatsApp consent; reply with verified studio hours only.',
      },
    },
  });

  const aiDraft = await requestJson('/api/crm/commands/message.generate_ai_draft', {
    token: owner.token,
    body: {
      requestId: 'demo_ai_draft_0',
      input: {
        conversationId: waConvId,
        prompt: 'Reply warmly confirming Common Lab studio hours and mention fee policy requires confirmation.',
      },
    },
  });
  assert.ok(aiDraft.result.citedFactIds.includes(factIds[0]), 'Expected grounded AI draft to cite verified fact');

  // Withdrawn consent thread
  await requestJson('/api/crm/commands/conversation.simulate_inbound', {
    token: owner.token,
    body: {
      requestId: 'demo_sim_wa_withdrawn',
      input: {
        channel: 'whatsapp',
        externalEventId: 'demo_wa_evt_2',
        fromValue: COMMONS_PEOPLE[2].phone,
        subject: 'Pavilion site follow-up (withdrawn consent)',
        bodyText: 'Checking when timber samples arrive.',
        programmeSlug: 'architecture-consulting',
      },
    },
  });

  // Manual phone log
  await requestJson('/api/crm/commands/conversation.log_manual', {
    token: owner.token,
    body: {
      requestId: 'demo_manual_call',
      input: {
        channel: 'call',
        personId: 'demo_person_1',
        programmeSlug: 'partnerships-collaborations',
        subject: 'Phone call: Periyar Watershed partnership logistics',
        direction: 'inbound',
        bodyText: 'Spoke with Rohan Dutta about joint community workshops and bamboo delivery schedule.',
      },
    },
  });

  // Opportunity -> Workspace Project idempotent handoff
  const handoff1 = await requestJson('/api/crm/commands/opportunity.handoff_project', {
    token: owner.token,
    body: {
      requestId: 'demo_handoff_1',
      input: { opportunityId: 'demo_opp_partnership_1', projectsBoardId: boardByKey.projects },
    },
  });
  assert.equal(handoff1.result.already, false);
  const handoff2 = await requestJson('/api/crm/commands/opportunity.handoff_project', {
    token: owner.token,
    body: {
      requestId: 'demo_handoff_2',
      input: { opportunityId: 'demo_opp_partnership_1', projectsBoardId: boardByKey.projects },
    },
  });
  assert.equal(handoff2.result.already, true);

  // =========================================================================
  // Part C — Desktop, Tablet & Mobile WebKit P1 Verification + Screenshots
  // =========================================================================
  await page.reload();
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('checkbox', { name: 'Select Nandini Menon' }).or(page.getByText('Nandini Menon')).first()).toBeVisible({ timeout: 20_000 });
  shots.peopleDesktopLight = await capture(page, 'people-desktop-light.png');

  // Open Person panel -> Endpoints & consent + Timeline
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'My work' })).toBeVisible({ timeout: 15_000 });
  await page.goto(fixture.base + '/crm/people/demo_person_0');
  const personPanel = page.getByRole('complementary', { name: 'Person details' }).or(page.getByRole('dialog'));
  await expect(personPanel).toBeVisible({ timeout: 15_000 });
  await personPanel.getByRole('tab', { name: 'Endpoints & consent' }).click();
  await expect(personPanel.getByText('granted').first()).toBeVisible();
  shots.personPanelDesktopLight = await capture(page, 'person-panel-desktop-light.png');

  await page.getByRole('link', { name: 'Programmes' }).click();
  await expect(page.getByRole('heading', { name: 'Programmes (14)' })).toBeVisible();
  shots.programmesDesktopLight = await capture(page, 'programmes-desktop-light.png');

  await page.goto(fixture.base + `/crm/applications/${appCmd.result.applicationId}`);
  await expect(page.getByRole('tab', { name: "Visitor's words" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: "Visitor's words" }).click();
  await expect(page.getByText('Immutable sender submission (read-only)').first()).toBeVisible();
  shots.applicationsDesktopLight = await capture(page, 'applications-desktop-light.png');

  await page.goto(fixture.base + `/crm/conversations/${waConvId}`);
  await expect(page.getByText('Cited verified facts:', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Internal team note (not sent)').first()).toBeVisible();
  shots.conversationsDesktopLight = await capture(page, 'conversations-desktop-light.png');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: 'Dark theme' }).click();
  shots.conversationsDesktopDark = await capture(page, 'conversations-desktop-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Light theme' }).click();

  await page.getByRole('link', { name: 'Pipelines' }).click();
  await expect(page.getByRole('heading', { name: 'Pipelines', exact: true })).toBeVisible();
  shots.pipelinesDesktopLight = await capture(page, 'pipelines-desktop-light.png');

  await page.getByRole('link', { name: 'Patrons' }).click();
  await expect(page.getByRole('heading', { name: 'Patrons (read-only mirror)' })).toBeVisible();
  await expect(page.getByText('Read-only projection from The Common Ground website relay')).toBeVisible();
  await expect(page.getByText('Nandini Menon — Founding Patron').first()).toBeVisible();
  shots.patronsDesktopLight = await capture(page, 'patrons-desktop-light.png');

  // =========================================================================
  // Part D — P2 S10 Reversible Contact Merge, Conflict & Unmerge Walkthrough
  // =========================================================================
  await page.getByRole('link', { name: 'People' }).click();
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: 'Duplicates review' }).click();
  const nandiniDupCard = page.locator('li', { hasText: 'Nandini Menon (Alt)' }).first();
  await expect(nandiniDupCard).toBeVisible({ timeout: 15_000 });
  await nandiniDupCard.getByRole('button', { name: 'Compare & merge…' }).click();
  const mergeDialog = page.getByRole('dialog', { name: 'Compare & merge people' });
  await expect(mergeDialog).toBeVisible({ timeout: 15_000 });
  await expect(mergeDialog.getByRole('button', { name: 'Merge people' })).toBeVisible();
  shots.mergePreviewDesktopLight = await capture(page, 'merge-preview-desktop-light.png');

  await mergeDialog.getByRole('checkbox').check();
  await mergeDialog.getByRole('button', { name: 'Merge people' }).click();
  await expect(page.getByText('Merged Nandini Menon (Alt) into Nandini Menon.')).toBeVisible({ timeout: 15_000 });

  await page.goto(fixture.base + '/crm/people/demo_person_28');
  await expect(page.getByText('This person record was merged and archived.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: 'Open canonical person' })).toHaveAttribute('href', '/crm/people/demo_person_0');
  await page.getByRole('button', { name: 'Close record panel' }).click();

  await page.getByRole('tab', { name: 'Merge history' }).click();
  await expect(page.getByText('Person merge ledger (reversible while clean)')).toBeVisible({ timeout: 15_000 });
  const nandiniHistoryRow = page.locator('li', { hasText: 'Nandini Menon (Alt)' }).first();
  await expect(nandiniHistoryRow).toBeVisible({ timeout: 15_000 });
  shots.mergeHistoryDesktopLight = await capture(page, 'merge-history-desktop-light.png');

  // Reversible clean unmerge in UI
  await nandiniHistoryRow.getByRole('button', { name: 'Unmerge…' }).click();
  const unmergeDialog = page.getByRole('dialog', { name: 'Reverse person merge' });
  await expect(unmergeDialog).toBeVisible();
  await unmergeDialog.getByRole('checkbox').check();
  await unmergeDialog.getByRole('button', { name: 'Confirm unmerge' }).click();
  await expect(page.getByText('Unmerged Nandini Menon (Alt) from Nandini Menon.')).toBeVisible({ timeout: 15_000 });
  await expect(nandiniHistoryRow.getByText('Unmerged', { exact: true })).toBeVisible({ timeout: 15_000 });

  // Second pair in dark theme + post-merge survivor edit conflict refusal
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: 'Dark theme' }).click();
  await page.getByRole('tab', { name: 'Duplicates review' }).click();
  const rohanDupCard = page.locator('li', { hasText: 'Rohan Dutta (Studio)' }).first();
  await expect(rohanDupCard).toBeVisible({ timeout: 15_000 });
  await rohanDupCard.getByRole('button', { name: 'Compare & merge…' }).click();
  await expect(mergeDialog).toBeVisible({ timeout: 15_000 });
  await expect(mergeDialog.getByRole('button', { name: 'Merge people' })).toBeVisible();
  shots.mergePreviewDesktopDark = await capture(page, 'merge-preview-desktop-dark.png');

  await mergeDialog.getByRole('checkbox').check();
  await mergeDialog.getByRole('button', { name: 'Merge people' }).click();
  await expect(page.getByText('Merged Rohan Dutta (Studio) into Rohan Dutta.')).toBeVisible({ timeout: 15_000 });

  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Light theme' }).click();

  // Edit survivor independently, then attempt unmerge -> blocked with explicit conflict
  await requestJson('/api/sync/push', {
    token: owner.token,
    body: {
      changes: [
        {
          id: 'demo_person_1',
          collection: 'tasks',
          ts: Date.now() + 10_000,
          patch: { title: 'Rohan Dutta (Verified Studio Lead)' },
        },
      ],
    },
  });
  await page.getByRole('tab', { name: 'Merge history' }).click();
  const rohanHistoryRow = page.locator('li', { hasText: 'Rohan Dutta (Studio)' }).first();
  await expect(rohanHistoryRow).toBeVisible({ timeout: 15_000 });
  await rohanHistoryRow.getByRole('button', { name: 'Unmerge…' }).click();
  await expect(unmergeDialog).toBeVisible();
  await unmergeDialog.getByRole('checkbox').check();
  await unmergeDialog.getByRole('button', { name: 'Confirm unmerge' }).click();
  await expect(unmergeDialog.getByRole('alert')).toContainText('survivor_edited', { timeout: 15_000 });
  await unmergeDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(unmergeDialog).toBeHidden();
  await ownerCtx.close();

  // Tablet 820x1180 Light verification
  const { context: tabletCtx, page: tabletPage } = await openAuthedPage(browser, owner, {
    viewport: { width: 820, height: 1180 },
    hasTouch: true,
    colorScheme: 'light',
  });
  await tabletPage.goto(fixture.base + '/crm/people');
  await expect(tabletPage.getByRole('heading', { name: 'People', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(tabletPage.getByRole('checkbox', { name: 'Select Nandini Menon' }).or(tabletPage.getByText('Nandini Menon')).first()).toBeVisible({ timeout: 15_000 });
  shots.peopleTabletLight = await capture(tabletPage, 'people-tablet-light.png');
  await tabletCtx.close();

  // Mobile WebKit 390x844 Light Conversations + Dark Pipelines
  const { context: mobP1LightCtx, page: mobP1Light } = await openAuthedPage(mobileBrowser, owner, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'light',
  });
  await mobP1Light.goto(fixture.base + `/crm/conversations/${waConvId}`);
  await expect(mobP1Light.getByText('Internal team note (not sent)')).toBeVisible({ timeout: 15_000 });
  shots.conversationsMobileLight = await capture(mobP1Light, 'conversations-mobile-light.png');
  await mobP1LightCtx.close();

  const { context: mobP1DarkCtx, page: mobP1Dark } = await openAuthedPage(mobileBrowser, owner, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  });
  await mobP1Dark.goto(fixture.base + '/crm/pipelines');
  await expect(mobP1Dark.getByRole('heading', { name: 'Pipelines', exact: true })).toBeVisible({ timeout: 15_000 });
  shots.pipelinesMobileDark = await capture(mobP1Dark, 'pipelines-mobile-dark.png');
  await mobP1DarkCtx.close();

  // Mobile WebKit 390x844 Light Merge Preview (restored Nandini pair) & Dark Merge History
  const { context: mobP2LightCtx, page: mobP2Light } = await openAuthedPage(mobileBrowser, owner, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'light',
  });
  await mobP2Light.goto(fixture.base + '/crm/people');
  await mobP2Light.getByRole('tab', { name: 'Duplicates review' }).click();
  const mobNandiniCard = mobP2Light.locator('li', { hasText: 'Nandini Menon (Alt)' }).first();
  await expect(mobNandiniCard).toBeVisible({ timeout: 15_000 });
  await mobNandiniCard.getByRole('button', { name: 'Compare & merge…' }).click();
  const mobMergeDialog = mobP2Light.getByRole('dialog', { name: 'Compare & merge people' });
  await expect(mobMergeDialog).toBeVisible({ timeout: 15_000 });
  await expect(mobMergeDialog.getByRole('button', { name: 'Merge people' })).toBeVisible();
  shots.mergePreviewMobileLight = await capture(mobP2Light, 'merge-preview-mobile-light.png');
  await mobP2LightCtx.close();

  const { context: mobP2DarkCtx, page: mobP2Dark } = await openAuthedPage(mobileBrowser, owner, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  });
  await mobP2Dark.goto(fixture.base + '/crm/people');
  await mobP2Dark.getByRole('tab', { name: 'Merge history' }).click();
  await expect(mobP2Dark.getByText('Person merge ledger (reversible while clean)')).toBeVisible({ timeout: 15_000 });
  await expect(mobP2Dark.locator('li', { hasText: 'Rohan Dutta (Studio)' }).first()).toBeVisible({ timeout: 15_000 });
  shots.mergeHistoryMobileDark = await capture(mobP2Dark, 'merge-history-mobile-dark.png');
  await mobP2DarkCtx.close();

  // =========================================================================
  // Part E — P3 Communications (Channels Settings, Templates & Mobile Check)
  // =========================================================================
  const p3WaAccount = await requestJson('/api/crm/commands/channel.configure', {
    token: owner.token,
    body: {
      requestId: 'demo_p3_wa_acct',
      input: {
        channel: 'whatsapp',
        provider: 'whatsapp_cloud',
        label: 'Riverbank WhatsApp Desk (Disabled)',
        externalId: 'wa-demo-phone-01',
        mode: 'disabled',
        active: false,
        config: { phoneNumberId: '100000000001', graphVersion: 'v21.0' },
      },
    },
  });
  assert.equal(p3WaAccount.ok, true, 'Configure disabled WhatsApp Cloud channel account');

  const p3ZohoAccount = await requestJson('/api/crm/commands/channel.configure', {
    token: owner.token,
    body: {
      requestId: 'demo_p3_zoho_acct',
      input: {
        channel: 'email',
        provider: 'email_zoho',
        label: 'Riverbank Zoho Mail (Disabled)',
        externalId: 'hello@riverbank.example',
        mode: 'disabled',
        active: false,
        config: { dataCenter: 'in', fromAddress: 'hello@riverbank.example' },
      },
    },
  });
  assert.equal(p3ZohoAccount.ok, true, 'Configure disabled Zoho Mail channel account');

  const p3Tpl = await requestJson('/api/crm/commands/template.upsert', {
    token: owner.token,
    body: {
      requestId: 'demo_p3_tpl_upsert',
      input: {
        channel: 'whatsapp',
        name: 'programme_followup_utility',
        language: 'en',
        category: 'utility',
        bodyText: 'Hello {{1}}, we have an update regarding {{2}}.',
        variables: ['name', 'programme'],
      },
    },
  });
  assert.equal(p3Tpl.ok, true, 'Create WhatsApp template draft');

  const p3TplSync = await requestJson('/api/crm/commands/template.sync_status', {
    token: owner.token,
    body: {
      requestId: 'demo_p3_tpl_approve',
      input: {
        templateId: p3Tpl.result.template.id,
        status: 'approved',
        providerTemplateId: 'meta_tpl_demo_01',
      },
    },
  });
  assert.equal(p3TplSync.ok, true, 'Sync WhatsApp template approved status');

  const { context: p3DesktopCtx, page: p3Desktop } = await openAuthedPage(browser, owner, {
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
  });
  await p3Desktop.emulateMedia({ colorScheme: 'light' });
  await p3Desktop.goto(fixture.base + '/crm/settings/channels');
  await expect(p3Desktop.getByRole('heading', { name: 'Channels, templates & delivery' })).toBeVisible({ timeout: 15_000 });
  await expect(p3Desktop.getByText('Riverbank WhatsApp Desk (Disabled)')).toBeVisible({ timeout: 15_000 });
  await expect(p3Desktop.getByText('Riverbank Zoho Mail (Disabled)')).toBeVisible({ timeout: 15_000 });
  const p3DesktopOverflow = await p3Desktop.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(p3DesktopOverflow, false, 'Desktop Channels settings must not overflow horizontally');
  shots.channelsDesktopLight = await capture(p3Desktop, 'channels-desktop-light.png');

  await p3Desktop.getByRole('tab', { name: /Templates/ }).click();
  await expect(p3Desktop.getByText('programme_followup_utility')).toBeVisible({ timeout: 15_000 });
  await p3Desktop.getByRole('tab', { name: /Delivery & review/ }).click();
  await expect(p3Desktop.getByRole('button', { name: /Process due outbox/i })).toBeVisible({ timeout: 15_000 });

  await p3Desktop.emulateMedia({ colorScheme: 'dark' });
  await p3Desktop.getByRole('button', { name: 'Dark theme' }).click();
  await p3Desktop.getByRole('tab', { name: /Channels/ }).click();
  shots.channelsDesktopDark = await capture(p3Desktop, 'channels-desktop-dark.png');
  await p3DesktopCtx.close();

  const { context: p3MobCtx, page: p3Mob } = await openAuthedPage(mobileBrowser, owner, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'light',
  });
  await p3Mob.goto(fixture.base + '/crm/settings/channels');
  await expect(p3Mob.getByRole('heading', { name: 'Channels, templates & delivery' })).toBeVisible({ timeout: 15_000 });
  await expect(p3Mob.getByText('Riverbank WhatsApp Desk (Disabled)')).toBeVisible({ timeout: 15_000 });
  const p3MobOverflow = await p3Mob.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(p3MobOverflow, false, 'Mobile 390px Channels settings must not overflow horizontally');
  shots.channelsMobileLight = await capture(p3Mob, 'channels-mobile-light.png');
  await p3MobCtx.close();

  assert.equal(fingerprint(root), sourceFingerprint, 'Source changed during CRM demo check');
  const evidence = {
    base: fixture.base,
    sourceFingerprint,
    accounts: 1 + COMMONS_MEMBERS.length,
    people: COMMONS_PEOPLE.length,
    organisations: COMMONS_ORGS.length,
    programmes: COMMONS_PROGRAMME_RECORDS.length,
    opportunities: COMMONS_OPPORTUNITIES.length,
    patrons: COMMONS_PATRON_SUBMISSIONS.length,
    facts: COMMONS_FACTS.length,
    p2MergeVerified: true,
    p3CommunicationsVerified: true,
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

function subRecordIdFromPull(records, preferredId) {
  if (preferredId && records.some((r) => r.id === preferredId)) return preferredId;
  const hit = records.find((r) => r.collection === 'tasks' && r.data?.boardId === 'board-website-inbox' && r.data?.p_wi_email);
  assert.ok(hit, 'Expected ingested website submission record');
  return hit.id;
}
