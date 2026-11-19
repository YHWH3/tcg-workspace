import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { localDump, dumpStatements } from '../prod-copy-rehearsal.mjs';
import { verifyMigrationManifest } from '../release-rehearsal.mjs';

const root = new URL('../../', import.meta.url);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const rows = async (db, query, ...bindings) => (await db.prepare(query).bind(...bindings).all()).results;

export function newReport(kind) {
  const parent = new URL('.artifacts/access-readiness/', root);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(fileURLToPath(parent), kind + '-'));
}

export function writeReport(folder, file, report) {
  writeFileSync(join(folder, file), typeof report === 'string' ? report : JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}

export async function withDump(input, callback, script = 'export default {fetch(){return new Response(null,{status:404})}}') {
  const bytes = readFileSync(localDump(input));
  const manifest = verifyMigrationManifest();
  const statements = dumpStatements(bytes.toString('utf8'));
  const operation = sql => sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '').trim();
  const sql = statements.filter(statement => !/^(?:BEGIN(?:\s+TRANSACTION)?|COMMIT|END(?:\s+TRANSACTION)?)\s*;$/i.test(operation(statement)));
  for (const statement of sql) {
    if (/^(?:ATTACH|DETACH|VACUUM)\b|^PRAGMA\b(?!\s+(?:defer_foreign_keys|foreign_keys)\s*=)/i.test(operation(statement))) {
      throw new Error('Unsupported SQL dump operation');
    }
  }
  const mf = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0, workers: [{ name: 'access-readiness', modules: true, script,
      compatibilityDate: '2026-09-25', d1Databases: { DB: 'access-readiness' } }],
  }));
  try {
    const db = await mf.getD1Database('DB');
    for (let offset = 0; offset < sql.length; offset += 25) {
      await db.batch(sql.slice(offset, offset + 25).map(statement => db.prepare(statement)));
    }
    const ledger = await rows(db, 'SELECT name FROM d1_migrations ORDER BY name');
    const names = ledger.map(row => row.name);
    if (names.length < 35 || names.length > manifest.length || names.some((name, i) => name !== manifest[i].name)) {
      throw new Error('Expected an exact release migration prefix through at least 0035');
    }
    return await callback({
      db, dispatch: path => mf.dispatchFetch('http://localhost' + path),
      inputSha256: sha256(bytes), applied: manifest.slice(0, names.length), pending: manifest.slice(names.length),
    });
  } finally {
    await mf.dispose();
  }
}

export async function applyPending(db, pending) {
  for (const { name } of pending) {
    const statements = dumpStatements(readFileSync(new URL('migrations/' + name, root), 'utf8'));
    await db.batch([...statements.map(s => db.prepare(s)), db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(name)]);
  }
}
