import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { newReport, rows, withDump, writeReport } from './access/dump.mjs';

export async function inventory(db, quotaMiB) {
  const [accounts, spaces, memberships, recordsBySpace, rootOwnership, connections, findings, state] = await Promise.all([
    rows(db, `SELECT u.id, COALESCE(u.workspace_role,u.role) role, u.disabled_at,
      (SELECT MAX(created_at) FROM sessions WHERE user_id=u.id) last_retained_session_at FROM users u ORDER BY u.id`),
    rows(db, 'SELECT id,name,default_access,guest_directory_restricted,deleted_at FROM spaces ORDER BY id'),
    rows(db, 'SELECT space_id,user_id,role,access FROM space_members ORDER BY space_id,user_id'),
    rows(db, 'SELECT space_id,COUNT(*) records FROM records GROUP BY space_id ORDER BY space_id'),
    rows(db, `SELECT r.space_id,r.collection,json_extract(r.data,'$.createdBy') AS creator_id,COUNT(*) roots FROM records r
      WHERE r.collection IN ('pages','boards','moodboards') AND COALESCE(json_extract(r.data,'$.parentId'),'')=''
      AND COALESCE(json_extract(r.data,'$.deleted'),0)=0
      GROUP BY r.space_id,r.collection,creator_id ORDER BY r.space_id,r.collection,creator_id`),
    rows(db, 'SELECT id,user_id,spaces_json,expires_at,revoked_at FROM ai_connections ORDER BY id'),
    rows(db, `SELECT
      (SELECT COUNT(*) FROM records r LEFT JOIN spaces s ON s.id=r.space_id WHERE s.id IS NULL) unassigned_or_unknown_space,
      (SELECT COUNT(*) FROM records r LEFT JOIN records p ON p.id=json_extract(r.data,'$.parentId') AND p.collection='pages'
       WHERE r.collection='pages' AND COALESCE(json_extract(r.data,'$.deleted'),0)=0
       AND COALESCE(json_extract(r.data,'$.parentId'),'')<>'' AND p.id IS NULL) orphan_pages,
      (SELECT COUNT(*) FROM records r LEFT JOIN records f ON f.id=json_extract(r.data,'$.fromId')
       LEFT JOIN records t ON t.id=json_extract(r.data,'$.toId')
       WHERE r.collection='links' AND COALESCE(json_extract(r.data,'$.deleted'),0)=0 AND (f.id IS NULL OR t.id IS NULL)) orphan_links,
      (SELECT COUNT(*) FROM shares h LEFT JOIN records r ON r.id=h.page_id WHERE r.id IS NULL OR h.space_id IS NOT r.space_id) unavailable_or_moved_shares,
      (SELECT COUNT(*) FROM ai_connections c,json_each(c.spaces_json) j
       LEFT JOIN spaces s ON s.id=j.value WHERE c.revoked_at IS NULL AND c.expires_at>?
       AND (s.id IS NULL OR s.deleted_at IS NOT NULL)) unknown_active_connector_scopes,
      (SELECT COALESCE(SUM(size),0) FROM files WHERE complete=1) used_bytes`, Date.now()),
    rows(db, 'SELECT enabled FROM access_state WHERE id=1'),
  ]);
  const shares = await rows(db, `SELECT h.page_id,h.space_id pinned_space_id,r.space_id current_space_id
    FROM shares h LEFT JOIN records r ON r.id=h.page_id ORDER BY h.page_id`);
  const integrity = await rows(db, 'PRAGMA quick_check');
  const foreignKeys = await rows(db, 'PRAGMA foreign_key_check');
  const core = spaces.find(space => space.id === 'space-core' && space.deleted_at === null);
  const coreOwner = memberships.some(member => member.space_id === 'space-core' && member.role === 'owner'
    && member.access === 'allow' && accounts.some(account => account.id === member.user_id && account.disabled_at === null));
  const active = accounts.filter(account => account.disabled_at === null).length;
  const { used_bytes: usedBytes, ...counts } = findings[0];
  const blockers = Object.entries(counts).filter(([, count]) => count > 0).map(([key]) => key);
  if (!core || !coreOwner) blockers.push('missing_active_core_owner');
  if (state.length !== 1 || state[0].enabled !== 0) blockers.push('unexpected_permission_mode');
  if (active > 7) blockers.push('active_account_capacity');
  if (integrity.length !== 1 || integrity[0].quick_check !== 'ok' || foreignKeys.length) blockers.push('database_integrity');
  const quotaBytes = quotaMiB * 1024 * 1024;
  if (usedBytes >= quotaBytes) blockers.push('file_quota_exhausted');
  return {
    accounts, spaces, memberships, recordsBySpace, rootOwnership, shares,
    connections: connections.map(({ spaces_json, ...connection }) => ({ ...connection, spaces: JSON.parse(spaces_json) })),
    legacyGrants: { status: 'OWNER_VERIFICATION_REQUIRED', source: 'OAUTH_KV' },
    limits: { activeAccounts: active, availableSeats: 7 - active, usedBytes, quotaBytes, freeBytes: quotaBytes - usedBytes },
    findings: counts, blockers,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [input, quota = '450', ...extra] = process.argv.slice(2);
  const quotaMiB = Number(quota);
  if (!input || extra.length || !Number.isSafeInteger(quotaMiB) || quotaMiB < 1 || quotaMiB > 1024 * 1024) {
    console.error('Usage: node scripts/access-inventory.mjs /private/dump.sql [quotaMiB]');
    process.exitCode = 2;
  } else {
    const folder = newReport('inventory');
    try {
      const result = await withDump(input, async ({ db, inputSha256, applied, pending }) => ({
        ...await inventory(db, quotaMiB), inputSha256, applied, pending,
        source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        migrationEvidence: 'The dump ledger proves migration names. The listed hashes are the verified checkout files.',
      }));
      const status = result.blockers.length ? 'HOLD' : 'PASS';
      writeReport(folder, 'inventory.json', { status, ...result });
      writeReport(folder, 'inventory.md', [
        '# Private permission inventory', '', 'Result ' + status, '',
        '| Inventory | Count |', '|---|---:|',
        ...['accounts', 'spaces', 'memberships', 'rootOwnership', 'shares', 'connections'].map(name => `| ${name} | ${result[name].length} |`),
        '', 'Review the accompanying private JSON for account and space details.',
        '', 'Blocking checks: ' + (result.blockers.join(', ') || 'none'),
        '', 'Legacy OAuth grants require a separate owner inventory in OAUTH_KV.', '',
      ].join('\n'));
      console.log(status, folder);
      process.exitCode = status === 'PASS' ? 0 : 1;
    } catch {
      console.error('HOLD: local dump import or inventory failed.');
      writeReport(folder, 'inventory.json', { status: 'HOLD', failure: 'local_dump_import_or_inventory' });
      process.exitCode = 1;
    }
  }
}
