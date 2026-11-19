import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { newReport, writeReport } from './access/dump.mjs';

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const markerPattern = /^[A-Za-z0-9]{16,64}$/;

function validate(config, loopback) {
  const { origin, samples, reader, restricted } = config;
  const url = new URL(origin);
  if (origin !== url.origin || (!loopback && url.protocol !== 'https:') ||
      (loopback && (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'))) throw new Error('Invalid verification origin');
  for (const account of [reader, restricted]) {
    if (!['session', 'mcp'].every(type => typeof account?.[type] === 'string' && /^[\x21-\x7e]{16,4096}$/.test(account[type]))) throw new Error('Two session and connector credentials are required');
  }
  if (reader.session === restricted.session || reader.mcp === restricted.mcp) throw new Error('Use different accounts');
  if (!Array.isArray(samples) || samples.length < 1 || samples.length > 50) throw new Error('Supply between 1 and 50 synthetic samples');
  const visited = new Set();
  for (const s of samples) {
    if (!['spaceId', 'pageId', 'databaseId', 'taskId', 'publicShareToken'].every(key => typeof s[key] === 'string' && idPattern.test(s[key])) ||
        typeof s.marker !== 'string' || !markerPattern.test(s.marker) || visited.has(s.spaceId)) throw new Error('Invalid or duplicate sample');
    visited.add(s.spaceId);
  }
  return url;
}

export async function verifyRestricted(config, { loopback = false } = {}) {
  const base = validate(config, loopback);
  const report = { status: 'HOLD', sampleCount: config.samples.length, scope: loopback ? 'disposable local fixture' : 'owner staging', checks: [] };
  const sameOriginFetch = (input, init = {}) => {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : input);
    if (url.origin !== base.origin) throw new Error('Cross-origin requests are prohibited');
    return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  };
  const api = async (identity, path, body, expected = 200) => {
    const response = await sameOriginFetch(new URL(path, base), {
      method: body ? 'POST' : 'GET', headers: {
        ...(identity ? { Authorization: 'Bearer ' + identity.session } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status !== expected) throw new Error('Unexpected API status');
    return response.json();
  };
  const checkPages = async (request, inspect, next) => {
    let cursor;
    for (let page = 0; page < 100; page++) {
      const data = await request(cursor);
      if (inspect(data)) return;
      const after = next(data);
      if (!after) return;
      if (after === cursor) throw new Error('Read cursor did not advance');
      cursor = after;
    }
    throw new Error('Read scan limit reached');
  };
  const clients = [];
  let stage = 'credentials_and_protocol';
  try {
    const [allowed, denied] = await Promise.all([api(config.reader, '/api/access'), api(config.restricted, '/api/access')]);
    if (allowed.protocol !== 3 || denied.protocol !== 3 || allowed.userId === denied.userId) throw new Error('Expected distinct users and Protocol 3');
    for (const identity of [config.reader, config.restricted]) {
      const client = new Client({ name: 'TCG restricted-content verification', version: '1.0.0' }, { capabilities: {} });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), {
        requestInit: { headers: { Authorization: 'Bearer ' + identity.mcp } }, fetch: sameOriginFetch,
      }));
    }
    const call = async (index, name, args, expectedError) => {
      const result = await clients[index].callTool({ name, arguments: args });
      const output = result.content?.find(part => part.type === 'text');
      if (!output) throw new Error('Missing MCP response');
      const data = JSON.parse(output.text);
      if (expectedError ? !result.isError || data.error !== expectedError : result.isError || data.error) throw new Error('Unexpected MCP outcome');
      return data;
    };
    stage = 'authorization_and_read_surfaces';
    for (const s of config.samples) {
      const key = '?' + new URLSearchParams({ q: s.marker });
      const encoded = encodeURIComponent;
      const includes = (data, value) => JSON.stringify(data).includes(value);
      const positive = (data, value = s.marker) => { if (!includes(data, value)) throw new Error('Missing positive control'); };
      const absent = data => {
        if ([s.marker, s.pageId, s.databaseId, s.taskId].some(value => includes(data, value))) throw new Error('Restricted content present');
      };
      const test = async (name, run) => {
        try { await run(); report.checks.push({ name, status: 'PASS' }); }
        catch { report.checks.push({ name, status: 'FAIL' }); }
      };
      await test('per-space access manifest', async () => {
        if (!allowed.spaces.some(space => space.id === s.spaceId) || denied.spaces.some(space => space.id === s.spaceId)) throw new Error('Invalid access sample');
      });
      await test('sync pull', async () => {
        // Walk Protocol 3 joining pages until the control is observed, or the
        // bounded scan says the complete space has been read.
        const pull = async (identity, manifest, group, check) => {
          let cursor = 0;
          let joining = group.map(space => ({ space, after: 0, base: 0 }));
          for (let page = 0; page < 100; page++) {
            const result = await api(identity, '/api/sync/pull', {
              protocol: 3, etag: manifest.etag, cursor, joining, deferred: manifest.spaces.map(space => space.id).filter(space => !group.includes(space)),
            });
            if (check(result) || !result.hasMore) return;
            if (result.cursor <= cursor) throw new Error('Sync cursor did not advance');
            cursor = result.cursor;
            joining = result.joining;
          }
          throw new Error('Sync scan limit reached');
        };
        let seen = false;
        await pull(config.reader, allowed, [s.spaceId], data => (seen = includes(data, s.marker)));
        if (!seen) throw new Error('Missing sync positive control');
        const spaces = denied.spaces.map(space => space.id);
        if (!spaces.length) await pull(config.restricted, denied, [], absent);
        for (let i = 0; i < spaces.length; i += 20) await pull(config.restricted, denied, spaces.slice(i, i + 20), absent);
      });
      await test('HTTP search', async () => {
        positive(await api(config.reader, '/api/search' + key));
        await checkPages(cursor => api(config.restricted, '/api/search' + key + (cursor ? '&cursor=' + encoded(cursor) : '')), absent, data => data.nextCursor);
      });
      await test('MCP search', async () => {
        const args = { query: s.marker, mode: 'keyword' };
        positive(await call(0, 'search', args));
        await checkPages(cursor => call(1, 'search', { ...args, cursor }), absent, data => data.nextCursor);
      });
      await test('MCP fetch', async () => {
        const args = { id: 'page:' + s.pageId };
        positive(await call(0, 'fetch', args));
        absent(await call(1, 'fetch', args, 'page not found'));
      });
      await test('MCP query_records', async () => {
        const args = { databaseId: s.databaseId };
        positive(await call(0, 'query_records', args));
        absent(await call(1, 'query_records', args, 'database not found'));
      });
      await test('MCP dashboard_snapshot', async () => {
        const args = { pageId: s.pageId };
        positive(await call(0, 'dashboard_snapshot', args), s.pageId);
        absent(await call(1, 'dashboard_snapshot', args, 'not_found'));
      });
      await test('MCP attention_queue', async () => {
        const args = { approvalDatabaseId: s.databaseId, kinds: ['approval_pending'] };
        positive(await call(0, 'attention_queue', args));
        await checkPages(cursor => call(1, 'attention_queue', { ...args, cursor }), data => {
          if (data.partial) throw new Error('Partial attention result');
          absent(data);
        }, data => data.nextCursor);
      });
      await test('notifications', async () => {
        positive(await api(config.reader, '/api/notifications?limit=100'));
        await checkPages(cursor => api(config.restricted, '/api/notifications?limit=100' + (cursor ? '&cursor=' + encoded(cursor) : '')), absent, data => data.nextCursor);
      });
      await test('approvals', async () => {
        const path = '/api/approvals?targetId=' + encoded(s.taskId);
        positive(await api(config.reader, path));
        absent(await api(config.restricted, path));
      });
      await test('public share subtree', async () => {
        const path = '/api/public/' + encoded(s.publicShareToken);
        absent(await api(null, path));
        absent(await api(null, path + '/pages/' + encoded(s.pageId), null, 404));
      });
      await test('record history', async () => {
        const path = '/api/history/' + encoded(s.pageId);
        positive(await api(config.reader, path));
        absent(await api(config.restricted, path, null, 404));
      });
      await test('deterministic digest', async () => {
        positive(await api(config.reader, '/api/ai/digest'));
        const data = await api(config.restricted, '/api/ai/digest');
        if (data.truncated) throw new Error('Partial digest result');
        absent(data);
      });
    }
    report.status = report.checks.every(check => check.status === 'PASS') ? 'PASS' : 'HOLD';
  } catch {
    report.failure = stage;
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [option, path, ...extra] = process.argv.slice(2);
  if (option !== '--staging' || !path || extra.length) {
    console.error('Usage: node scripts/access-verify.mjs --staging /private/synthetic-probes.json');
    process.exitCode = 2;
  } else {
    const folder = newReport('restricted');
    let report;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > 64 * 1024) throw new Error('Supply a private regular configuration file');
      report = await verifyRestricted(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      report = { status: 'HOLD', failure: 'configuration' };
    }
    writeReport(folder, 'restricted.json', report);
    console.log(report.status, folder);
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  }
}
