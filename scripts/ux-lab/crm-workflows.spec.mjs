import { createHmac, randomUUID } from 'node:crypto';
import { test, expect, health, request, fixture } from './support.mjs';
import { navigateReady } from '../navigation-ready.mjs';

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

async function pullBoardsByKey() {
  const manifest = await request('/api/access', undefined, 'GET');
  const byKey = {};
  if (Array.isArray(manifest?.spaces)) {
    let cursor = 0;
    let joining = manifest.spaces.map((s) => ({ space: s.id, after: 0, base: 0 }));
    for (let i = 0; i < 20; i++) {
      const reply = await request('/api/sync/pull', { protocol: 3, etag: manifest.etag, cursor, joining, limit: 500 });
      for (const r of reply.records) {
        if (r.collection === 'boards' && !r.data?.deleted && typeof r.data?.templateDbKey === 'string') {
          byKey[r.data.templateDbKey] = r.id;
        }
      }
      if (!reply.hasMore) break;
      cursor = reply.cursor;
      joining = reply.joining;
    }
  } else {
    let since = 0;
    for (let i = 0; i < 20; i++) {
      const reply = await request(`/api/sync/pull?since=${since}&limit=500`, undefined, 'GET');
      for (const r of reply.records) {
        if (r.collection === 'boards' && !r.data?.deleted && typeof r.data?.templateDbKey === 'string') {
          byKey[r.data.templateDbKey] = r.id;
        }
      }
      if (!reply.hasMore) break;
      since = reply.cursor;
    }
  }
  return byKey;
}

async function syncPush(changes) {
  const manifest = await request('/api/access', undefined, 'GET');
  return request('/api/sync/push', Array.isArray(manifest?.spaces) ? { protocol: 3, changes } : { changes });
}

const REQUIRED_PACK_KEYS = [
  'people',
  'organizations',
  'programs',
  'affiliations',
  'applications',
  'activities',
  'opportunities',
  'projects',
];

async function ensureP1PackInstalled(page) {
  let byKey = await pullBoardsByKey();
  if (REQUIRED_PACK_KEYS.every((k) => Boolean(byKey[k]))) {
    return byKey;
  }
  await navigateReady(page, fixture.base + '/crm/organisations');
  const orgsHeading = page.getByRole('heading', { name: 'Organisations', exact: true });
  const initBtn = page.getByRole('button', { name: 'Initialise TCG CRM databases' });
  await expect(orgsHeading.or(initBtn)).toBeVisible({ timeout: 25_000 });
  if (await initBtn.isVisible()) {
    await initBtn.click();
  }
  await expect(orgsHeading).toBeVisible({ timeout: 25_000 });
  for (let i = 0; i < 60; i++) {
    byKey = await pullBoardsByKey();
    if (REQUIRED_PACK_KEYS.every((k) => Boolean(byKey[k]))) {
      return byKey;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timed out waiting for TCG Operating Pack boards to sync');
}

async function openCrmSection(page, path, isCompact) {
  await navigateReady(page, fixture.base + path);
  if (isCompact) {
    // Also verify the More sheet exposes additional CRM sections cleanly on compact viewports when invoked from Home/People.
    return;
  }
}

test('P1 S1–S2 People, Duplicates, Record Panel, Scoped Grants & Enquiries', async ({ page }, info) => {
  const isCompact = info.project.use.viewport.width < 768;
  const boards = await ensureP1PackInstalled(page);

  const member = await (async () => {
    const { code } = await request('/api/invites');
    const res = await fetch(fixture.base + '/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: `ux-p1-${randomUUID().slice(0, 6)}`,
        name: 'Asha Staff',
        password: randomUUID(),
        inviteCode: code,
      }),
    });
    expect(res.status).toBe(200);
    return res.json();
  })();

  try {
    const fixedTs = Date.UTC(2026, 9, 24, 10, 0, 0);
    const changes = [
      {
        id: 'ux-p1-org-1',
        collection: 'tasks',
        ts: fixedTs,
        patch: {
          boardId: boards.organizations,
          title: 'Malabar Weavers Co-op',
          order: 'a0',
          p_f_org_type: 'collective',
          p_f_partnership: 'partner',
          p_f_location: 'Kochi',
        },
      },
      {
        id: 'ux-p1-person-1',
        collection: 'tasks',
        ts: fixedTs,
        patch: {
          boardId: boards.people,
          title: 'Nandini Menon',
          order: 'a0',
          p_f_email: 'nandini.ux@commons-demo.example.org',
          p_f_phone: '+919800000301',
          p_f_location: 'Kochi',
          p_f_source: 'website',
        },
      },
      {
        id: 'ux-p1-person-2',
        collection: 'tasks',
        ts: fixedTs,
        patch: {
          boardId: boards.people,
          title: 'Nandini Menon (Duplicate)',
          order: 'a1',
          p_f_email: 'nandini.ux@commons-demo.example.org',
          p_f_phone: '+919800000302',
          p_f_location: 'Ernakulam',
          p_f_source: 'manual',
        },
      },
      {
        id: 'ux-p1-prog-lab',
        collection: 'tasks',
        ts: fixedTs,
        patch: {
          boardId: boards.programs,
          title: 'Common Lab',
          status: 'active',
          order: 'a0',
          p_f_slug: 'common-lab',
          p_f_area: 'experiences_learning',
        },
      },
      {
        id: 'ux-p1-aff-1',
        collection: 'tasks',
        ts: fixedTs,
        patch: {
          boardId: boards.affiliations,
          title: 'Nandini Menon — Malabar Weavers Co-op',
          status: 'active',
          order: 'a0',
          p_f_role: 'Co-organiser',
        },
      },
      {
        id: linkId('relation', 'f_person', 'ux-p1-aff-1', 'ux-p1-person-1'),
        collection: 'links',
        ts: fixedTs,
        patch: { fromType: 'record', fromId: 'ux-p1-aff-1', toType: 'record', toId: 'ux-p1-person-1', kind: 'relation', fieldId: 'f_person', createdBy: fixture.admin.user.id, createdAt: fixedTs, deleted: false },
      },
      {
        id: linkId('relation', 'f_org', 'ux-p1-aff-1', 'ux-p1-org-1'),
        collection: 'links',
        ts: fixedTs,
        patch: { fromType: 'record', fromId: 'ux-p1-aff-1', toType: 'record', toId: 'ux-p1-org-1', kind: 'relation', fieldId: 'f_org', createdBy: fixture.admin.user.id, createdAt: fixedTs, deleted: false },
      },
    ];
    const pushed = await syncPush(changes);
    expect(pushed.rejected).toBeFalsy();

    await request('/api/crm/commands/endpoints.backfill', {
      requestId: 'ux_' + randomUUID().replace(/-/g, ''),
      input: { personIds: ['ux-p1-person-1', 'ux-p1-person-2'], dryRun: false },
    });
    await request('/api/crm/commands/person.record_consent', {
      requestId: 'ux_' + randomUUID().replace(/-/g, ''),
      input: { personId: 'ux-p1-person-1', channel: 'whatsapp', scope: 'updates', status: 'granted', source: 'ux_lab' },
    });

    // People directory visual baseline & accessibility
    await openCrmSection(page, '/crm/people', isCompact);
    await expect(page.getByRole('checkbox', { name: 'Select Nandini Menon' }).or(page.getByText('Nandini Menon')).first()).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    await health(page, 'crm-people', info);
    await expect(page.locator('[data-app="crm"]')).toHaveScreenshot('crm-people.png', {
      mask: [page.locator('[data-app="crm"] time')],
    });

    // Duplicates review tab
    await page.getByRole('tab', { name: 'Duplicates review' }).click();
    await expect(page.getByRole('button', { name: 'Dismiss' }).first()).toBeVisible({ timeout: 15_000 });

    // Person RecordPanel -> Overview / Endpoints & consent / Timeline
    await navigateReady(page, fixture.base + '/crm/people/ux-p1-person-1');
    const panel = page.getByRole('complementary', { name: 'Person details' }).or(page.getByRole('dialog'));
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await panel.getByRole('tab', { name: 'Endpoints & consent' }).click();
    await expect(panel.getByText('granted').first()).toBeVisible({ timeout: 15_000 });
    await panel.getByRole('tab', { name: 'Timeline' }).click();
    await expect(panel).toBeVisible();
    await health(page, 'crm-person-panel', info);
    if (info.project.use.viewport.width < 1100) {
      await page.keyboard.press('Escape');
    } else {
      await panel.getByRole('button', { name: /^Close/ }).click();
    }

    // Compact "More CRM sections" sheet exposes Pipelines & Programmes cleanly
    if (isCompact) {
      const moreBtn = page.getByRole('button', { name: 'More CRM sections' });
      await moreBtn.click();
      await expect(page.getByRole('link', { name: 'Pipelines', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
    }

    // Programmes & Enquiries -> Create Application -> Visitor's words
    await navigateReady(page, fixture.base + '/crm/applications');
    await page.getByRole('tab', { name: /^Website enquiries/ }).click();
    const createAppBtn = page.getByRole('button', { name: 'Create application' }).first();
    await expect(createAppBtn).toBeVisible({ timeout: 15_000 });
    await createAppBtn.click();
    await expect(page.getByRole('tab', { name: "Visitor's words" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('tab', { name: "Visitor's words" }).click();
    await expect(page.getByText('Immutable sender submission (read-only)')).toBeVisible();

    // Scoped grant & owner-only rename controls in Settings
    await navigateReady(page, fixture.base + '/crm/settings/access');
    await expect(
      page.getByTestId(`crm-account-${member.user.id}`).getByRole('button', { name: `Rename ${member.user.name}` }),
    ).toBeVisible();
    await page.getByRole('tab', { name: 'Capabilities', exact: true }).click();
    await page.getByRole('combobox', { name: 'Account', exact: true }).selectOption(member.user.id);
    await expect(page.getByRole('combobox', { name: /programme scope/ }).first()).toBeVisible();
  } finally {
    await request(`/api/users/${member.user.id}`, undefined, 'DELETE').catch(() => {});
  }
});

test('P1 S3–S4 Activities, My Work, Conversations, Verified Facts & Grounded AI Drafts', async ({ page }, info) => {
  const boards = await ensureP1PackInstalled(page);
  const todayStr = new Date().toISOString().slice(0, 10);
  const now = Date.now();

  const changes = [
    {
      id: 'ux-p1-person-conv',
      collection: 'tasks',
      ts: now,
      patch: {
        boardId: boards.people,
        title: 'Tariq Hussain',
        order: 'b0',
        p_f_email: 'tariq.ux@commons-demo.example.org',
        p_f_phone: '+919800000401',
        p_f_source: 'whatsapp',
      },
    },
    {
      id: 'ux-p1-person-withdrawn',
      collection: 'tasks',
      ts: now,
      patch: {
        boardId: boards.people,
        title: 'Deepa OptOut',
        order: 'b1',
        p_f_phone: '+919800000402',
        p_f_source: 'whatsapp',
      },
    },
    {
      id: 'ux-p1-act-today',
      collection: 'tasks',
      ts: now,
      patch: {
        boardId: boards.activities,
        title: 'Follow up Tariq Hussain studio note',
        status: 'planned',
        order: 'a0',
        p_f_type: 'follow_up',
        p_f_when: `${todayStr}T10:00:00Z`,
        p_f_due: todayStr,
        p_f_owner: fixture.admin.user.id,
        p_f_done: false,
      },
    },
  ];
  await syncPush(changes);
  await request('/api/crm/commands/endpoints.backfill', {
    requestId: 'ux_' + randomUUID().replace(/-/g, ''),
    input: { personIds: ['ux-p1-person-conv', 'ux-p1-person-withdrawn'], dryRun: false },
  });
  await request('/api/crm/commands/person.add_endpoint', {
    requestId: 'ux_' + randomUUID().replace(/-/g, ''),
    input: { personId: 'ux-p1-person-withdrawn', kind: 'whatsapp', value: '+919800000402', makePrimary: true },
  });
  await request('/api/crm/commands/person.record_consent', {
    requestId: 'ux_' + randomUUID().replace(/-/g, ''),
    input: { personId: 'ux-p1-person-withdrawn', channel: 'whatsapp', scope: 'updates', status: 'withdrawn', source: 'ux_lab' },
  });

  // Facts (1 fresh verified + 1 stale verified)
  const freshProp = await request('/api/crm/commands/fact.propose', {
    requestId: 'ux_' + randomUUID().replace(/-/g, ''),
    input: {
      programmeSlug: 'common-lab',
      category: 'operations',
      title: '[Sample] Common Lab open table hours',
      statement: 'Studio tables open Tuesday–Saturday 09:30–18:00 IST (sample fixture).',
      sourceRef: 'ux:handbook',
      reviewBy: now + 60 * 86_400_000,
    },
  });
  await request('/api/crm/commands/fact.verify', {
    requestId: 'ux_' + randomUUID().replace(/-/g, ''),
    input: { factId: freshProp.result.fact.id, reviewBy: now + 60 * 86_400_000, expectedRev: freshProp.result.fact.rev },
  });

  const staleProp = await request('/api/crm/commands/fact.propose', {
    requestId: 'ux_' + randomUUID().replace(/-/g, ''),
    input: {
      programmeSlug: 'common-spaces-network',
      category: 'logistics',
      title: '[Sample] Legacy shuttle timing',
      statement: 'Verify current bus timing before replying.',
      sourceRef: 'ux:old',
      reviewBy: now - 86_400_000,
    },
  });
  await request('/api/crm/commands/fact.verify', {
    requestId: 'ux_' + randomUUID().replace(/-/g, ''),
    input: { factId: staleProp.result.fact.id, reviewBy: now - 86_400_000, expectedRev: staleProp.result.fact.rev },
  });

  // Inbound WhatsApp thread + withdrawn consent thread + grounded AI draft
  const waRes = await request('/api/crm/commands/conversation.simulate_inbound', {
    requestId: 'ux_' + randomUUID().replace(/-/g, ''),
    input: {
      channel: 'whatsapp',
      externalEventId: 'ux_wa_' + randomUUID().slice(0, 8),
      fromValue: '+919800000401',
      subject: 'Common Lab studio hours question',
      bodyText: 'Hello, what are the Common Lab studio hours and current fees?',
      programmeSlug: 'common-lab',
    },
  });
  const convId = waRes.result.conversationId;

  const withdrawnRes = await request('/api/crm/commands/conversation.simulate_inbound', {
    requestId: 'ux_' + randomUUID().replace(/-/g, ''),
    input: {
      channel: 'whatsapp',
      externalEventId: 'ux_wa_w_' + randomUUID().slice(0, 8),
      fromValue: '+919800000402',
      subject: 'Opt-out inquiry',
      bodyText: 'Please confirm you received my opt-out.',
      programmeSlug: 'common-lab',
    },
  });

  // Home My work + Activities
  await navigateReady(page, fixture.base + '/crm');
  await expect(page.getByRole('heading', { name: 'My work' })).toBeVisible({ timeout: 15_000 });
  await navigateReady(page, fixture.base + '/crm/activities');
  await expect(page.getByRole('heading', { name: 'Activities', exact: true })).toBeVisible();
  await expect(page.getByText('Follow up Tariq Hussain studio note')).toBeVisible();

  // Conversations -> Internal note + AI Draft + Visual baseline + Consent lock check
  await navigateReady(page, fixture.base + `/crm/conversations/${convId}`);
  await page.getByRole('tab', { name: 'Internal note' }).click();
  await page.getByLabel('Internal team note').fill('UX Lab internal team note only');
  await page.getByRole('button', { name: 'Add internal note' }).click();
  await expect(page.getByText('UX Lab internal team note only')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('tab', { name: /Reply/ }).click();
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByLabel('Reply message')).not.toHaveValue('', { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await health(page, 'crm-conversations', info);
  await expect(page.locator('[data-app="crm"]')).toHaveScreenshot('crm-conversations.png', {
    mask: [
      page.locator('[data-app="crm"] time'),
      page.getByLabel('Reply message'),
      page.locator('[data-app="crm"] article').filter({ hasText: 'Draft (not sent)' }).locator('p'),
    ],
  });

  // Consent-withdrawn send lock
  await navigateReady(page, fixture.base + `/crm/conversations/${withdrawnRes.result.conversationId}`);
  await expect(page.getByText('Consent is withdrawn for this person/channel. Sending is blocked.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send reply' })).toBeDisabled();

  // Verified facts settings
  await navigateReady(page, fixture.base + '/crm/settings/facts');
  await expect(page.getByRole('heading', { name: 'Verified knowledge' })).toBeVisible();
  await expect(page.getByText('[Sample] Legacy shuttle timing')).toBeVisible();
  await health(page, 'crm-facts', info);
});

test('P1 S9 Pipelines, Project Handoff, Read-Only Patrons, 320px Reflow & 200% Scaling', async ({ page }, info) => {
  const boards = await ensureP1PackInstalled(page);
  const fixedTs = Date.UTC(2026, 9, 24, 10, 0, 0);

  const changes = [
    {
      id: 'ux-p1-opp-partner',
      collection: 'tasks',
      ts: fixedTs,
      patch: {
        boardId: boards.opportunities,
        title: 'Periyar Classroom Partnership',
        status: 'proposal',
        order: 'a0',
        p_f_pipeline: 'partnership',
        p_f_amount: 350000,
        p_f_next_action: 'Hand off to Workspace Project',
      },
    },
    {
      id: 'ux-p1-opp-consult',
      collection: 'tasks',
      ts: fixedTs,
      patch: {
        boardId: boards.opportunities,
        title: 'Palmyra Pavilion Consulting',
        status: 'negotiation',
        order: 'a1',
        p_f_pipeline: 'consulting',
        p_f_amount: 420000,
        p_f_next_action: 'Confirm timber details',
      },
    },
    {
      id: 'ux-p1-patron-1',
      collection: 'tasks',
      ts: fixedTs,
      patch: {
        boardId: 'board-website-inbox',
        title: 'Nandini Menon — Founding Patron',
        status: 'approved',
        order: 'z0',
        p_wi_family: 'patrons',
        p_wi_email: 'nandini.ux@commons-demo.example.org',
        p_wi_tier: 'founding',
        p_wi_stage: 'approved',
        p_wi_edition: '08/100',
        p_wi_event: 'patron.approved',
      },
    },
    {
      id: 'ux-p1-patron-2',
      collection: 'tasks',
      ts: fixedTs,
      patch: {
        boardId: 'board-website-inbox',
        title: 'Tariq Hussain — Builder Patron',
        status: 'paid',
        order: 'z1',
        p_wi_family: 'patrons',
        p_wi_email: 'tariq.ux@commons-demo.example.org',
        p_wi_tier: 'builder',
        p_wi_stage: 'paid',
        p_wi_edition: '24/25',
        p_wi_event: 'patron.paid',
      },
    },
  ];
  await syncPush(changes);

  // Pipelines Grid & Board stage move + visual baseline + handoff
  await navigateReady(page, fixture.base + '/crm/pipelines');
  await expect(page.getByRole('heading', { name: 'Pipelines', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('checkbox', { name: 'Select Periyar Classroom Partnership' }).or(page.getByText('Periyar Classroom Partnership')).first()).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await health(page, 'crm-pipelines', info);
  await expect(page.locator('[data-app="crm"]')).toHaveScreenshot('crm-pipelines.png', {
    mask: [page.locator('[data-app="crm"] time')],
  });

  // Switch to Board tab -> verify accessible non-drag stage <select> (>=44px)
  await page.getByRole('tab', { name: 'Board', exact: true }).click();
  const stageSelect = page.getByLabel('Move Periyar Classroom Partnership stage');
  await expect(stageSelect).toBeVisible();
  const stageBox = await stageSelect.boundingBox();
  expect(stageBox.height).toBeGreaterThanOrEqual(44);

  // Hand off opportunity to Workspace Project
  await navigateReady(page, fixture.base + '/crm/pipelines/ux-p1-opp-partner');
  const handoffBtn = page.getByRole('button', { name: 'Hand off' });
  await expect(handoffBtn).toBeVisible({ timeout: 15_000 });
  await handoffBtn.click();
  await expect(page.getByRole('link', { name: 'Project', exact: true })).toBeVisible({ timeout: 15_000 });

  // Patrons strictly read-only mirror + visual baseline
  await navigateReady(page, fixture.base + '/crm/patrons');
  await expect(page.getByRole('heading', { name: 'Patrons (read-only mirror)' })).toBeVisible();
  await expect(page.getByText('Read-only projection from The Common Ground website relay')).toBeVisible();
  await expect(page.getByText('Nandini Menon — Founding Patron')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await health(page, 'crm-patrons', info);
  await expect(page.locator('[data-app="crm"]')).toHaveScreenshot('crm-patrons.png', {
    mask: [page.locator('[data-app="crm"] time')],
  });

  // Filter tier by founding
  await page.getByLabel('Filter by tier').selectOption('founding');
  await expect(page.getByText('Nandini Menon — Founding Patron')).toBeVisible();
  await expect(page.getByText('Tariq Hussain — Builder Patron')).toHaveCount(0);

  // 320px reflow + 200% text scaling check on Patrons
  await page.setViewportSize({ width: 320, height: 568 });
  const reflowPatrons = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(reflowPatrons.scroll).toBeLessThanOrEqual(reflowPatrons.width + 1);

  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  await health(page, 'crm-p1-200pct', info);
});

test('P2 S10 Contact Merge, Conflict Refusal, Reversible Unmerge & 320px Reflow', async ({ page }, info) => {
  const boards = await ensureP1PackInstalled(page);
  const fixedTs = Date.UTC(2026, 9, 25, 10, 0, 0);

  const changes = [
    {
      id: 'ux-p2-org-1',
      collection: 'tasks',
      ts: fixedTs,
      patch: {
        boardId: boards.organizations,
        title: 'Wayanad Seed Commons',
        order: 'b0',
        p_f_org_type: 'collective',
        p_f_location: 'Kalpetta',
      },
    },
    {
      id: 'ux-p2-person-a',
      collection: 'tasks',
      ts: fixedTs,
      patch: {
        boardId: boards.people,
        title: 'Maya Sen',
        order: 'c0',
        p_f_email: 'maya.ux.p2@commons-demo.example.org',
        p_f_phone: '+919800000501',
        p_f_location: 'Kochi',
        p_f_source: 'website',
        p_f_skills: ['facilitation'],
      },
    },
    {
      id: 'ux-p2-person-b',
      collection: 'tasks',
      ts: fixedTs,
      patch: {
        boardId: boards.people,
        title: 'Maya Sen (Alt)',
        order: 'c1',
        p_f_email: 'maya.ux.p2@commons-demo.example.org',
        p_f_phone: '+919800000502',
        p_f_location: 'Ernakulam',
        p_f_source: 'manual',
        p_f_skills: ['writing'],
      },
    },
    {
      id: 'ux-p2-aff-1',
      collection: 'tasks',
      ts: fixedTs,
      patch: {
        boardId: boards.affiliations,
        title: 'Maya Sen (Alt) — Wayanad Seed Commons',
        status: 'active',
        order: 'b0',
        p_f_role: 'Field coordinator',
      },
    },
    {
      id: linkId('relation', 'f_person', 'ux-p2-aff-1', 'ux-p2-person-b'),
      collection: 'links',
      ts: fixedTs,
      patch: { fromType: 'record', fromId: 'ux-p2-aff-1', toType: 'record', toId: 'ux-p2-person-b', kind: 'relation', fieldId: 'f_person', createdBy: fixture.admin.user.id, createdAt: fixedTs, deleted: false },
    },
    {
      id: linkId('relation', 'f_org', 'ux-p2-aff-1', 'ux-p2-org-1'),
      collection: 'links',
      ts: fixedTs,
      patch: { fromType: 'record', fromId: 'ux-p2-aff-1', toType: 'record', toId: 'ux-p2-org-1', kind: 'relation', fieldId: 'f_org', createdBy: fixture.admin.user.id, createdAt: fixedTs, deleted: false },
    },
  ];
  const pushed = await syncPush(changes);
  expect(pushed.rejected).toBeFalsy();

  await request('/api/crm/commands/endpoints.backfill', {
    requestId: 'ux_p2_bf_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: { personIds: ['ux-p2-person-a', 'ux-p2-person-b'], dryRun: false },
  });
  await request('/api/crm/commands/person.record_consent', {
    requestId: 'ux_p2_ca_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: { personId: 'ux-p2-person-a', channel: 'whatsapp', scope: 'updates', status: 'granted', source: 'ux_p2' },
  });
  await request('/api/crm/commands/person.add_endpoint', {
    requestId: 'ux_p2_ep_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: { personId: 'ux-p2-person-b', kind: 'whatsapp', value: '+919800000502', makePrimary: true },
  });
  await request('/api/crm/commands/person.record_consent', {
    requestId: 'ux_p2_cb_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: { personId: 'ux-p2-person-b', channel: 'whatsapp', scope: 'updates', status: 'withdrawn', source: 'ux_p2_optout' },
  });
  await request('/api/crm/commands/conversation.simulate_inbound', {
    requestId: 'ux_p2_inb_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: {
      channel: 'whatsapp',
      externalEventId: 'ux_p2_wa_' + randomUUID().slice(0, 8),
      fromValue: '+919800000502',
      subject: 'Wayanad Seed inquiry',
      bodyText: 'Question from alternate contact line.',
      programmeSlug: 'common-lab',
    },
  });

  await navigateReady(page, fixture.base + '/crm/people');
  await page.getByRole('tab', { name: 'Duplicates review' }).click();
  const candItem = page.locator('li', { hasText: 'Maya Sen (Alt)' }).first();
  await expect(candItem).toBeVisible({ timeout: 15_000 });
  await candItem.getByRole('button', { name: 'Compare & merge…' }).click();

  const dialog = page.getByRole('dialog', { name: 'Compare & merge people' });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText('Strictest applied — withdrawal preserved cleanly')).toBeVisible();
  await expect(dialog.getByText('withdrawn').first()).toBeVisible();

  await page.evaluate(() => document.fonts.ready);
  await health(page, 'crm-merge-preview', info);
  await expect(dialog).toHaveScreenshot('crm-merge-preview.png', {
    mask: [dialog.locator('time')],
  });

  // Verify 320px reflow inside merge comparison dialog
  const origViewport = info.project.use.viewport;
  await page.setViewportSize({ width: 320, height: 568 });
  const dialogReflow = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dialogReflow.scroll).toBeLessThanOrEqual(dialogReflow.width + 1);
  await page.setViewportSize(origViewport);

  await dialog.getByLabel('Merge note (optional audit note)').fill('UX Lab P2 S10 merge');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Merge people' }).click();
  await expect(page.getByText('Merged Maya Sen (Alt) into Maya Sen.')).toBeVisible({ timeout: 15_000 });

  // Archived loser banner + canonical link
  await navigateReady(page, fixture.base + '/crm/people/ux-p2-person-b');
  await expect(page.getByText('This person record was merged and archived.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: 'Open canonical person' })).toHaveAttribute('href', '/crm/people/ux-p2-person-a');
  if (info.project.use.viewport.width < 1100) {
    await page.keyboard.press('Escape');
  } else {
    await page.getByRole('button', { name: 'Close record panel' }).click();
  }

  // Merge history visual baseline + health + clean unmerge
  await page.getByRole('tab', { name: 'Merge history' }).click();
  const histRow = page.locator('li', { hasText: 'Maya Sen (Alt)' }).first();
  await expect(histRow).toBeVisible({ timeout: 15_000 });
  await expect(histRow.getByText('Merged', { exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await health(page, 'crm-merge-history', info);
  await expect(page.locator('[data-app="crm"]').first()).toHaveScreenshot('crm-merge-history.png', {
    mask: [page.locator('[data-app="crm"] time')],
  });

  await histRow.getByRole('button', { name: 'Unmerge…' }).click();
  const unmergeDialog = page.getByRole('dialog', { name: 'Reverse person merge' });
  await expect(unmergeDialog).toBeVisible();
  await unmergeDialog.getByRole('checkbox').check();
  await unmergeDialog.getByRole('button', { name: 'Confirm unmerge' }).click();
  await expect(page.getByText('Unmerged Maya Sen (Alt) from Maya Sen.')).toBeVisible({ timeout: 15_000 });
  await expect(histRow.getByText('Unmerged', { exact: true })).toBeVisible({ timeout: 15_000 });

  // Conflict refusal when survivor was edited post-merge
  const preview = await request('/api/crm/read/merge-preview?survivorId=ux-p2-person-a&loserId=ux-p2-person-b', undefined, 'GET');
  const remerge = await request('/api/crm/commands/person.merge', {
    requestId: 'ux_p2_rm_' + randomUUID().replace(/-/g, '').slice(0, 16),
    expected: { 'ux-p2-person-a': preview.survivor.rev, 'ux-p2-person-b': preview.loser.rev },
    input: { survivorId: 'ux-p2-person-a', loserId: 'ux-p2-person-b', confirm: true, note: 'Post-unmerge conflict test' },
  });
  expect(remerge.ok).toBe(true);

  await syncPush([
    {
      id: 'ux-p2-person-a',
      collection: 'tasks',
      ts: Date.now() + 20_000,
      patch: { title: 'Maya Sen (Post-Merge Edit)' },
    },
  ]);

  await page.getByRole('button', { name: 'Refresh' }).first().click();
  const conflictRow = page.locator('li', { hasText: 'Post-unmerge conflict test' }).first();
  await expect(conflictRow).toBeVisible({ timeout: 15_000 });
  await conflictRow.getByRole('button', { name: 'Unmerge…' }).click();
  await expect(unmergeDialog).toBeVisible();
  await unmergeDialog.getByRole('checkbox').check();
  await unmergeDialog.getByRole('button', { name: 'Confirm unmerge' }).click();
  await expect(unmergeDialog.getByRole('alert')).toContainText('survivor_edited', { timeout: 15_000 });
  await unmergeDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(conflictRow.getByText('Merged', { exact: true })).toBeVisible();
});
