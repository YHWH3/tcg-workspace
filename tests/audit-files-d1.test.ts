// Cross-phase audit regressions — files, public shares and public forms
// (Phase 0/1 file pipeline × Phase 2 public canvas × Phase 4 public forms).
// The question each test answers: can attacker-chosen metadata or bytes reach
// a browser as active content on the application origin, and can a legitimate
// visitor complete the documented flow?
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { files } from '../worker/files';
import { publicApi } from '../worker/public';
import { publicFormsApi, FORM_MAX_FILES } from '../worker/forms';
import { importFileFromUrl } from '../worker/remotefile';
import { applyChanges } from '../worker/sync';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';

vi.mock('../worker/events', async (original) => ({
  ...(await original<typeof import('../worker/events')>()),
  scheduleOutbox: vi.fn(),
}));

let fx: AuditFixture;
beforeEach(async () => {
  fx = await openAuditFixture([{ id: 'alice', role: 'admin' }, { id: 'bob' }], { WORKSPACE_ENV: 'local-test', TURNSTILE_LOCAL_TEST: '1' });
});
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await fx.dispose(); });

const bytes = (text: string) => new TextEncoder().encode(text);

/** Upload through the real authenticated chunk/complete routes. */
async function uploadAuthed(user: string, id: string, body: Uint8Array<ArrayBuffer>, mime: string) {
  const put = await files.request(`http://localhost/${id}/chunks/0`, { method: 'PUT', headers: { authorization: fx.auth(user).authorization }, body }, fx.env, ctx);
  expect(put.status).toBe(200);
  const done = await files.request(`http://localhost/${id}/complete`, { method: 'POST', headers: fx.auth(user), body: JSON.stringify({ mime, size: body.byteLength, chunks: 1 }) }, fx.env, ctx);
  expect(done.status).toBe(200);
}

/** A page with one file block, shared by public token `tok`. */
async function sharedPageWithFile(fileId: string, mime: string, kind = 'file') {
  await applyChanges(fx.env, 'alice', [
    { id: 'pg', collection: 'pages', patch: { title: 'Public page' }, ts: 1 },
    { id: 'blk', collection: 'blocks', patch: { pageId: 'pg', type: 'file', fileId, order: 'a0' }, ts: 1 },
    { id: fileId, collection: 'files', patch: { name: 'upload', mime, kind, parentType: 'block', parentId: 'blk' }, ts: 1 },
  ]);
  await fx.db.prepare("INSERT INTO shares(token,target_type,page_id,created_by,created_at) VALUES('tok','page','pg','alice',1)").run();
}

describe('served file responses cannot become active content on the app origin', () => {
  const html = '<!doctype html><script>fetch("/steal?"+localStorage.getItem("ws_token"))</script>';

  it('public share route never serves attacker-chosen text/html as a document', async () => {
    await uploadAuthed('bob', 'evil', bytes(html), 'text/html');
    await sharedPageWithFile('evil', 'text/html');
    const res = await publicApi.request('http://localhost/tok/files/evil', {}, fx.env, ctx);
    expect(res.status).toBe(200);
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    expect(type).not.toContain('html');
    expect(type).not.toContain('xml');
    expect(type).not.toContain('javascript');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition') ?? '').toMatch(/^attachment/i);
  });

  it('authenticated file route applies the same serving policy (blob: URLs inherit the app origin)', async () => {
    await uploadAuthed('bob', 'evil2', bytes(html), 'application/xhtml+xml');
    const res = await files.request('http://localhost/evil2', { headers: fx.auth('alice') }, fx.env, ctx);
    expect(res.status).toBe(200);
    expect((res.headers.get('content-type') ?? '').toLowerCase()).not.toMatch(/html|xml|javascript/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('keeps legitimate previews working: png, pdf, audio and video retain their type; sanitized svg keeps its sandbox', async () => {
    await uploadAuthed('bob', 'img', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]), 'image/png');
    await uploadAuthed('bob', 'doc', bytes('%PDF-1.4 minimal'), 'application/pdf');
    await uploadAuthed('bob', 'vid', new Uint8Array(32), 'video/mp4');
    for (const [id, expected] of [['img', 'image/png'], ['doc', 'application/pdf'], ['vid', 'video/mp4']] as const) {
      const res = await files.request(`http://localhost/${id}`, { headers: fx.auth('alice') }, fx.env, ctx);
      expect(res.headers.get('content-type')).toBe(expected);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
    await uploadAuthed('bob', 'vec', bytes('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'), 'image/svg+xml');
    const svg = await files.request('http://localhost/vec', { headers: fx.auth('alice') }, fx.env, ctx);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-security-policy')).toContain('sandbox');
  });
});

describe('SVG is sanitized on every write path, not only the authenticated chunk route', () => {
  const evilSvg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="4" height="4" onload="alert(2)"/></svg>';

  async function formWithUploads() {
    await applyChanges(fx.env, 'alice', [
      { id: 'board', collection: 'boards', patch: { name: 'Board', columns: [{ id: 'open' }], fields: [] }, ts: 1 },
      { id: 'form', collection: 'forms', patch: { databaseId: 'board', title: 'Upload', enabled: true, fields: [{ fieldKey: 'title', label: 'Name', required: true }], successMessage: 'ok', notifyUserIds: [] }, ts: 1 },
    ]);
    await fx.db.prepare("INSERT INTO form_tokens(token,form_id,created_at) VALUES('pub','form',1)").run();
  }
  const postImage = (name: string, type: string, body: Uint8Array<ArrayBuffer> | string) => {
    const data = new FormData();
    data.set('turnstileToken', 'pass');
    data.set('file', new File([body], name, { type }));
    return publicFormsApi.request('http://localhost/pub/files', { method: 'POST', body: data }, fx.env, ctx);
  };

  it('public form upload stores a sanitized SVG (or refuses it) — never the raw document', async () => {
    await formWithUploads();
    const res = await postImage('x.svg', 'image/svg+xml', evilSvg);
    if (res.status === 200) {
      const { id } = (await res.json()) as { id: string };
      const chunks = (await fx.db.prepare('SELECT data FROM file_chunks WHERE file_id=? ORDER BY idx').bind(id).all<{ data: ArrayBuffer | number[] }>()).results;
      const stored = chunks.map((c) => new TextDecoder().decode(c.data instanceof ArrayBuffer ? new Uint8Array(c.data) : new Uint8Array(c.data))).join('');
      expect(stored).not.toMatch(/<script|onload/i);
    } else {
      expect([400, 415]).toContain(res.status);
      expect((await fx.db.prepare('SELECT COUNT(*) n FROM files').first<{ n: number }>())!.n).toBe(0);
    }
  });

  it('remote URL import stores a sanitized SVG (or refuses it) — never the raw document', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(evilSvg, { headers: { 'content-type': 'image/svg+xml' } })));
    let stored = '';
    let refused = false;
    try {
      const out = await importFileFromUrl(fx.env, 'https://assets.example.test/logo.svg', { parentType: 'block', parentId: 'blk', userId: 'alice' });
      const chunks = (await fx.db.prepare('SELECT data FROM file_chunks WHERE file_id=?').bind(out.fileId).all<{ data: ArrayBuffer | number[] }>()).results;
      stored = chunks.map((c) => new TextDecoder().decode(c.data instanceof ArrayBuffer ? new Uint8Array(c.data) : new Uint8Array(c.data))).join('');
    } catch {
      refused = true;
    }
    if (!refused) expect(stored).not.toMatch(/<script|onload/i);
  });
});

describe('public form attachment limits are reachable', () => {
  it('a visitor can upload the documented maximum number of images and still submit', async () => {
    await applyChanges(fx.env, 'alice', [
      { id: 'board', collection: 'boards', patch: { name: 'Board', columns: [{ id: 'open' }], fields: [] }, ts: 1 },
      { id: 'form', collection: 'forms', patch: { databaseId: 'board', title: 'Photos', enabled: true, fields: [{ fieldKey: 'title', label: 'Name', required: true }], successMessage: 'ok', notifyUserIds: [] }, ts: 1 },
    ]);
    await fx.db.prepare("INSERT INTO form_tokens(token,form_id,created_at) VALUES('pub','form',1)").run();
    const claims: Record<string, string> = {};
    const ids: string[] = [];
    for (let i = 0; i < FORM_MAX_FILES; i++) {
      const data = new FormData();
      data.set('turnstileToken', 'pass');
      data.set('file', new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, i])], `p${i}.png`, { type: 'image/png' }));
      const res = await publicFormsApi.request('http://localhost/pub/files', { method: 'POST', body: data }, fx.env, ctx);
      expect(res.status, `upload ${i + 1}`).toBe(200);
      const { id, claim } = (await res.json()) as { id: string; claim: string };
      ids.push(id);
      claims[id] = claim;
    }
    const submit = await publicFormsApi.request('http://localhost/pub', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ submissionId: 'full-gallery', values: { title: 'Visitor' }, turnstileToken: 'pass', fileIds: ids, fileClaims: claims }),
    }, fx.env, ctx);
    expect(submit.status).toBe(200);
  });
});
