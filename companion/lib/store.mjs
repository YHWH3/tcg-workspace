// Local credential storage under ~/.config/tcg-workspace-companion/ (0700 dir,
// 0600 files, atomic writes). ChatGPT registrations and Workspace credentials
// live in SEPARATE files. Nothing here ever prints a token.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensurePrivateDir, readJson, removeFile, sha256Hex, writeFileAtomic } from './util.mjs';

export const defaultConfigDir = () => join(homedir(), '.config', 'tcg-workspace-companion');

const TOKEN_FIELDS = ['id_token', 'access_token', 'refresh_token'];

/** Public (token-free) view of a registration, safe to print. */
export function publicAccount(rec) {
  if (!rec) return null;
  return {
    label: rec.label,
    email: rec.email ?? null,
    client_id: rec.client_id,
    plan_usage: rec.scopes?.includes('chatgpt.tokens.use.direct') ? 'active' : 'disabled',
    signed_in: Boolean(rec.access_token || rec.refresh_token),
    saved_at: rec.saved_at ?? null,
  };
}

export class CompanionStore {
  /** @param {{configDir?: string, now?: () => number}} [opts] */
  constructor(opts = {}) {
    this.dir = opts.configDir ?? defaultConfigDir();
    this.now = opts.now ?? Date.now;
    ensurePrivateDir(this.dir);
  }

  path(name) { return join(this.dir, name); }

  // ---- host id -------------------------------------------------------------
  /**
   * Stable, opaque per-host identifier (`urn:uuid:<uuidv4>`), created once
   * before the first sign-in and never cleared by sign-out.
   */
  hostId() {
    const p = this.path('host-id.json');
    const existing = readJson(p);
    if (existing?.ext_agent_host_id) return existing.ext_agent_host_id;
    const id = `urn:uuid:${randomUUID()}`;
    writeFileAtomic(p, { ext_agent_host_id: id, created_at: new Date(this.now()).toISOString() });
    return id;
  }

  // ---- ChatGPT registrations ------------------------------------------------
  /** File holding one registration. Label is hashed so it is filename-safe. */
  accountFile(label) { return this.path(`chatgpt-${sha256Hex(label).slice(0, 16)}.json`); }
  accountLock(label) { return this.path(`chatgpt-${sha256Hex(label).slice(0, 16)}.lock`); }

  index() { return readJson(this.path('accounts.json'), { active: null, labels: [] }); }
  saveIndex(idx) { writeFileAtomic(this.path('accounts.json'), idx); }

  listAccounts() { return this.index().labels.map((l) => this.readAccount(l)).filter(Boolean); }
  readAccount(label) { return label ? readJson(this.accountFile(label)) : null; }
  activeLabel() { return this.index().active; }
  activeAccount() { return this.readAccount(this.activeLabel()); }

  /** Write a registration record (full replacement — callers merge first). */
  writeAccount(rec) {
    if (!rec.label) throw new Error('registration needs a label');
    if (rec.client_id === 'dynamic_agent_client') throw new Error('refusing to save dynamic_agent_client as an issued client id');
    writeFileAtomic(this.accountFile(rec.label), rec);
    const idx = this.index();
    if (!idx.labels.includes(rec.label)) { idx.labels.push(rec.label); this.saveIndex(idx); }
  }

  setActive(label) {
    const idx = this.index();
    if (!idx.labels.includes(label) || !this.readAccount(label)) throw new Error(`No saved ChatGPT account named "${label}".`);
    idx.active = label;
    this.saveIndex(idx);
  }

  /** Clear tokens but keep account/client mapping (and the host id). */
  clearTokens(label, fields = TOKEN_FIELDS) {
    const rec = this.readAccount(label);
    if (!rec) return;
    for (const f of fields) delete rec[f];
    this.writeAccount(rec);
  }

  /** A distinct, stable label for a new registration. */
  uniqueLabel(base) {
    const clean = String(base || 'chatgpt').trim().slice(0, 64) || 'chatgpt';
    const labels = new Set(this.index().labels);
    if (!labels.has(clean)) return clean;
    for (let i = 2; ; i++) if (!labels.has(`${clean}-${i}`)) return `${clean}-${i}`;
  }

  // ---- settings -------------------------------------------------------------
  settings() { return readJson(this.path('settings.json'), {}); }
  saveSettings(s) { writeFileAtomic(this.path('settings.json'), s); }

  // ---- Workspace credentials (separate file) -------------------------------
  workspaceFile() { return this.path('workspace.json'); }
  workspaceLock() { return this.path('workspace.lock'); }
  readWorkspace() { return readJson(this.workspaceFile()); }
  writeWorkspace(rec) { writeFileAtomic(this.workspaceFile(), rec); }
  clearWorkspace() { removeFile(this.workspaceFile()); }
}
