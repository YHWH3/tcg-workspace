import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { localOrigin } from '../certification-report.mjs';

/** Real OAuth/PKCE fixture connection, also used by mixed MCP → browser journeys. */
export async function connectFixtureMcp(base, { username = 'admin', password = 'password123', name = 'Certification browser' } = {}) {
  base = localOrigin(base);
  const request = async (path, { body, form, cookie, method = 'GET' } = {}) => {
    const response = await fetch(base + path, { method, redirect: 'manual', signal: AbortSignal.timeout(60000), headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : form ? new URLSearchParams(form) : undefined });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = null; }
    return { response, text, data };
  };
  const registration = await request('/register', { method: 'POST', body: { client_name: name, redirect_uris: ['http://localhost:8123/cb'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' } });
  assert.ok(registration.data?.client_id, 'Fixture OAuth registration did not return a client id');
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: registration.data.client_id, redirect_uri: 'http://localhost:8123/cb', state: randomBytes(8).toString('hex'), code_challenge: challenge, code_challenge_method: 'S256', resource: base + '/mcp', scope: 'mcp' });
  const consent = await request('/oauth/authorize?' + query), cookie = (consent.response.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ') || consent.response.headers.get('set-cookie')?.split(';')[0] || '';
  const handle = consent.text.match(/name="handle" value="([^"]+)"/)?.[1]; assert.ok(handle, 'Fixture OAuth consent handle missing');
  const approval = await request('/oauth/authorize?' + query, { method: 'POST', cookie, form: { handle, username, password, decision: 'allow' } });
  const code = new URL(approval.response.headers.get('location') ?? '', base).searchParams.get('code'); assert.ok(code, 'Fixture OAuth approval did not return an authorization code');
  const tokens = await request('/token', { method: 'POST', form: { grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:8123/cb', client_id: registration.data.client_id, code_verifier: verifier, resource: base + '/mcp' } });
  assert.ok(tokens.data?.access_token, 'Fixture OAuth token exchange failed');
  const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${tokens.data.access_token}` } } }));
  return { close: () => client.close(), call: async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
    let data; try { data = JSON.parse(text); } catch { throw new Error(`Malformed MCP JSON result for ${name}`); }
    if (result.isError || data.error) throw new Error(`MCP ${name} rejected: ${text.slice(0, 300)}`);
    return data;
  } };
}
