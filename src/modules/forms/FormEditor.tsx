import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowDown, ArrowLeft, ArrowUp, Ban, Check, ClipboardList, Copy, ExternalLink, Link2, Plus, Trash2 } from 'lucide-react';
import { db } from '../../core/db';
import { Button, Field, Input, Select, Spinner, Textarea } from '../../core/ui';
import { toast } from '../../core/files';
import { useUsers } from '../../core/users';
import { cn } from '../../core/utils';
import { useBoard, type BoardRow, type TaskRow } from '../boards/api';
import { fieldsOf, propKey, type FieldDef } from '../boards/model';
import { getForm, mintToken, revokeToken, saveForm, type FormConfig, type FormFieldSpec, type FormToken } from './api';

const BUILTIN_CHOICES = [
  { key: 'title', label: 'Title (record name)' },
  { key: 'dueDate', label: 'Due date' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
];

/** fieldKeys a form may expose on this board (person/relation never). */
function exposableKeys(board: BoardRow | undefined): { key: string; label: string }[] {
  if (!board) return [];
  const out = [...BUILTIN_CHOICES];
  for (const f of fieldsOf(board)) {
    if (f.type === 'person' || f.type === 'relation') continue;
    out.push({ key: propKey(f.id), label: `${f.name} (${f.type.replace('_', ' ')})` });
  }
  return out;
}

function emptyForm(boardId: string): FormConfig {
  return {
    databaseId: boardId,
    title: 'Untitled form',
    fields: [{ fieldKey: 'title', label: 'Name', required: true, order: 0 }],
    successMessage: 'Thanks — your response has been recorded.',
    enabled: false,
    notifyUserIds: [],
  };
}

function toConfig(row: Record<string, unknown> | undefined, boardId: string): FormConfig {
  if (!row) return emptyForm(boardId);
  return {
    databaseId: boardId,
    title: typeof row.title === 'string' ? row.title : 'Untitled form',
    description: typeof row.description === 'string' ? row.description : undefined,
    fields: (Array.isArray(row.fields) ? (row.fields as FormFieldSpec[]) : []).map((f, i) => ({ ...f, order: i })),
    successMessage: typeof row.successMessage === 'string' ? row.successMessage : 'Thanks — your response has been recorded.',
    enabled: row.enabled === true,
    notifyUserIds: Array.isArray(row.notifyUserIds) ? (row.notifyUserIds as string[]) : [],
    createRelations: Array.isArray(row.createRelations) ? (row.createRelations as FormConfig['createRelations']) : [],
    peopleMatch: row.peopleMatch && typeof row.peopleMatch === 'object' ? (row.peopleMatch as FormConfig['peopleMatch']) : undefined,
    branding: row.branding && typeof row.branding === 'object' ? (row.branding as FormConfig['branding']) : undefined,
  };
}

/** /forms/:boardId/:formId — builder: stacked field editor + publish tokens
 *  + live 390px preview. */
export function FormEditor() {
  const { boardId = '', formId = '' } = useParams();
  const board = useBoard(boardId);
  const row = useLiveQuery(() => db.collection('forms').get(formId), [formId]);
  const [draft, setDraft] = useState<FormConfig | null>(null);
  const [saved, setSaved] = useState('');
  const [tokens, setTokens] = useState<FormToken[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (row && draft === null) {
      const cfg = toConfig(row, boardId);
      setDraft(cfg);
      setSaved(JSON.stringify(cfg));
    }
  }, [row, draft, boardId]);

  const refreshTokens = useMemo(
    () => async () => {
      try {
        const r = await getForm(formId);
        setTokens(r.tokens);
      } catch {
        /* tokens are best-effort */
      }
    },
    [formId],
  );
  useEffect(() => {
    void refreshTokens();
  }, [refreshTokens]);

  if (row === undefined || !draft) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }
  if (row === null || row.deleted) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-sm text-neutral-500">Form not found.</p>
        <Link to={`/forms/${boardId}`} className="text-sm text-blue-600 hover:underline dark:text-blue-400">
          Back to forms
        </Link>
      </div>
    );
  }

  const dirty = JSON.stringify(draft) !== saved;
  const patch = (p: Partial<FormConfig>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await saveForm(formId, draft);
      setSaved(JSON.stringify(draft));
      toast('Form saved');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const copyLink = (token: string) => {
    void navigator.clipboard?.writeText(`${location.origin}/f/${token}`).then(() => toast('Link copied'));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-neutral-200/70 px-4 py-2.5 dark:border-neutral-800/70">
        <Link to={`/forms/${boardId}`} className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800" aria-label="Back to forms">
          <ArrowLeft size={17} />
        </Link>
        <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <ClipboardList size={16} className="text-neutral-400" />
          {draft.title || 'Untitled form'}
        </h1>
        {draft.enabled && tokens.some((t) => !t.revokedAt) && (
          <a href={`/f/${tokens.find((t) => !t.revokedAt)!.token}`} target="_blank" rel="noreferrer" className="text-neutral-400 hover:text-blue-600" aria-label="Open public form">
            <ExternalLink size={14} />
          </a>
        )}
        <span className="flex-1" />
        {err && <span className="text-xs font-medium text-red-500">{err}</span>}
        <Button size="sm" onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? <Spinner size={13} /> : <Check size={14} />} Save
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        {/* editor column */}
        <div className="min-w-0 flex-1 space-y-6 p-4 md:overflow-y-auto">
          <section className="space-y-3">
            <Field label="Form title">
              <Input value={draft.title} onChange={(e) => patch({ title: e.target.value })} placeholder="Volunteer intake" />
            </Field>
            <Field label="Description" hint="Shown under the title on the public page.">
              <Textarea rows={2} value={draft.description ?? ''} onChange={(e) => patch({ description: e.target.value || undefined })} />
            </Field>
            <Field label="Intro card" hint="Optional highlighted note above the fields.">
              <Textarea rows={2} value={draft.branding?.intro ?? ''} onChange={(e) => patch({ branding: { intro: e.target.value || undefined } })} />
            </Field>
            <Field label="Success message" hint="What respondents see after submitting.">
              <Textarea rows={2} value={draft.successMessage} onChange={(e) => patch({ successMessage: e.target.value })} />
            </Field>
          </section>

          <FieldsEditor board={board} fields={draft.fields} onChange={(fields) => patch({ fields })} />

          <OptionsEditor board={board} draft={draft} patch={patch} />

          <PublishSection
            enabled={draft.enabled}
            tokens={tokens}
            onToggle={(enabled) => patch({ enabled })}
            onMint={async () => {
              const { token } = await mintToken(formId);
              await refreshTokens();
              copyLink(token);
            }}
            onCopy={copyLink}
            onRevoke={async (t) => {
              await revokeToken(t);
              await refreshTokens();
              toast('Link revoked');
            }}
          />

          <DangerZone
            onDelete={async () => {
              await saveForm(formId, { ...draft, enabled: false });
              const { mutate } = await import('../../core/sync/engine');
              await mutate('forms', formId, { deleted: true });
              navigate(`/forms/${boardId}`);
            }}
          />
        </div>

        {/* preview column — 390px device frame on md+, stacked below on mobile */}
        <div className="shrink-0 border-t border-neutral-200/70 bg-neutral-50/60 p-4 dark:border-neutral-800/70 dark:bg-neutral-900/40 md:w-[430px] md:border-l md:border-t-0 md:overflow-y-auto">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">Preview</p>
          <FormPreview draft={draft} board={board} />
        </div>
      </div>
    </div>
  );
}

/* ---------------- fields ---------------- */

function FieldsEditor({ board, fields, onChange }: { board: BoardRow | undefined; fields: FormFieldSpec[]; onChange(f: FormFieldSpec[]): void }) {
  const used = new Set(fields.map((f) => f.fieldKey));
  const available = exposableKeys(board).filter((k) => !used.has(k.key));

  const set = (i: number, p: Partial<FormFieldSpec>) => {
    const next = fields.map((f, j) => (j === i ? { ...f, ...p } : f));
    onChange(next.map((f, j) => ({ ...f, order: j })));
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next.map((f, k) => ({ ...f, order: k })));
  };
  const remove = (i: number) => onChange(fields.filter((_, j) => j !== i).map((f, j) => ({ ...f, order: j })));
  const add = (key: string) => {
    if (!key) return;
    const label = exposableKeys(board).find((k) => k.key === key)?.label.split(' (')[0] ?? key;
    onChange([...fields, { fieldKey: key, label, required: false, order: fields.length }]);
  };

  return (
    <section>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">Fields</p>
      <div className="space-y-2">
        {fields.map((f, i) => (
          <div key={`${f.fieldKey}-${i}`} className="rounded-xl border border-neutral-200 bg-white p-2.5 dark:border-neutral-800 dark:bg-neutral-950">
            <div className="flex items-center gap-2">
              <span className="w-28 shrink-0 truncate text-[11px] font-medium uppercase tracking-wide text-neutral-400" title={f.fieldKey}>
                {fieldKeyName(board, f.fieldKey)}
              </span>
              <Input density="compact" value={f.label} onChange={(e) => set(i, { label: e.target.value })} placeholder="Field label" className="flex-1 text-sm" />
              <div className="flex shrink-0 flex-col">
                <button onClick={() => move(i, -1)} disabled={i === 0} className="text-neutral-400 hover:text-neutral-700 disabled:opacity-20 dark:hover:text-neutral-200" aria-label={`Move ${f.label} up`}>
                  <ArrowUp size={13} />
                </button>
                <button onClick={() => move(i, 1)} disabled={i === fields.length - 1} className="text-neutral-400 hover:text-neutral-700 disabled:opacity-20 dark:hover:text-neutral-200" aria-label={`Move ${f.label} down`}>
                  <ArrowDown size={13} />
                </button>
              </div>
              <button onClick={() => remove(i)} className="shrink-0 text-neutral-400 hover:text-red-500" aria-label={`Remove ${f.label}`}>
                <Trash2 size={14} />
              </button>
            </div>
            <div className="mt-2 flex items-center gap-3 pl-0.5">
              <label className="flex items-center gap-1.5 text-xs text-neutral-500">
                <input type="checkbox" checked={f.required === true} onChange={(e) => set(i, { required: e.target.checked })} className="h-3.5 w-3.5 rounded border-neutral-300 accent-blue-600" />
                Required
              </label>
              <label className="flex items-center gap-1.5 text-xs text-neutral-500">
                <input type="checkbox" checked={f.help !== undefined} onChange={(e) => set(i, { help: e.target.checked ? '' : undefined })} className="h-3.5 w-3.5 rounded border-neutral-300 accent-blue-600" />
                Help text
              </label>
            </div>
            {f.help !== undefined && (
              <Input density="compact" value={f.help} onChange={(e) => set(i, { help: e.target.value })} placeholder="Help text shown under the label" className="mt-2" />
            )}
          </div>
        ))}
      </div>
      <Select value="" onChange={(e) => add(e.target.value)} className="mt-2 text-sm" disabled={!available.length} aria-label="Add field">
        <option value="">＋ Add field…</option>
        {available.map((k) => (
          <option key={k.key} value={k.key}>
            {k.label}
          </option>
        ))}
      </Select>
    </section>
  );
}

function fieldKeyName(board: BoardRow | undefined, key: string): string {
  const b = BUILTIN_CHOICES.find((x) => x.key === key);
  if (b) return b.label;
  if (key.startsWith('p_')) return fieldsOf(board).find((f) => f.id === key.slice(2))?.name ?? key;
  return key;
}

/* ---------------- options ---------------- */

function OptionsEditor({ board, draft, patch }: { board: BoardRow | undefined; draft: FormConfig; patch(p: Partial<FormConfig>): void }) {
  const users = useUsers();
  const textFields = fieldsOf(board).filter((f) => f.type === 'text' || f.type === 'url');
  const relFields = fieldsOf(board).filter((f) => f.type === 'relation');

  return (
    <section className="space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Options</p>

      <div>
        <p className="mb-1.5 text-sm font-medium">Notify on submission</p>
        <div className="space-y-1">
          {users.map((u) => (
            <label key={u.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.notifyUserIds.includes(u.id)}
                onChange={(e) =>
                  patch({ notifyUserIds: e.target.checked ? [...draft.notifyUserIds, u.id] : draft.notifyUserIds.filter((x) => x !== u.id) })
                }
                className="h-4 w-4 rounded border-neutral-300 accent-blue-600"
              />
              {u.name || u.username}
            </label>
          ))}
          {!users.length && <p className="text-xs text-neutral-400">No members to notify.</p>}
        </div>
      </div>

      <div>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={!!draft.peopleMatch}
            onChange={(e) => patch({ peopleMatch: e.target.checked ? { emailField: textFields[0]?.id ?? '' } : undefined })}
            className="h-4 w-4 rounded border-neutral-300 accent-blue-600"
          />
          Match submissions to existing people
        </label>
        <p className="mt-1 text-xs text-neutral-400">Matches the submitted email against records in this database; duplicates are flagged for review.</p>
        {draft.peopleMatch && (
          <Select value={draft.peopleMatch.emailField} onChange={(e) => patch({ peopleMatch: { emailField: e.target.value } })} className="mt-2 text-sm" aria-label="Email field">
            {textFields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
            {!textFields.length && <option value="">No text/url fields on this database</option>}
          </Select>
        )}
      </div>

      <RelationsEditor board={board} draft={draft} patch={patch} relFields={relFields} />
    </section>
  );
}

function RelationsEditor({ board, draft, patch, relFields }: { board: BoardRow | undefined; draft: FormConfig; patch(p: Partial<FormConfig>): void; relFields: FieldDef[] }) {
  const [targets, setTargets] = useState<Record<string, { id: string; title: string }[]>>({});

  useEffect(() => {
    let dead = false;
    void (async () => {
      const map: Record<string, { id: string; title: string }[]> = {};
      for (const f of relFields) {
        const target = f.relation?.target;
        if (!target) continue;
        if (target === 'pages') {
          const rows = (await db.collection('pages').toArray()).filter((p) => !p.deleted);
          map[f.id] = rows.map((p) => ({ id: p.id, title: String(p.title ?? 'Untitled') }));
        } else {
          const rows = (await db.collection('tasks').toArray()).filter((t) => !t.deleted && String(t.boardId) === target) as TaskRow[];
          map[f.id] = rows.map((t) => ({ id: t.id, title: String(t.title ?? 'Untitled') }));
        }
      }
      if (!dead) setTargets(map);
    })();
    return () => {
      dead = true;
    };
  }, [board?.id, relFields.length]);

  const rels = draft.createRelations ?? [];
  const setRels = (next: NonNullable<FormConfig['createRelations']>) => patch({ createRelations: next.length ? next : undefined });

  if (!relFields.length) return null;
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium">Attach every submission to</p>
      <p className="mb-2 text-xs text-neutral-400">Fixed relations added to each created record.</p>
      <div className="space-y-2">
        {rels.map((r, i) => {
          const def = relFields.find((f) => f.id === r.fieldId);
          const opts = targets[r.fieldId] ?? [];
          return (
            <div key={i} className="flex items-center gap-2">
              <Select
                value={r.fieldId}
                onChange={(e) => setRels(rels.map((x, j) => (j === i ? { fieldId: e.target.value, toId: '' } : x)))}
                className="w-40 text-sm"
                aria-label="Relation field"
              >
                {relFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
              <Select value={r.toId} onChange={(e) => setRels(rels.map((x, j) => (j === i ? { ...x, toId: e.target.value } : x)))} className="flex-1 text-sm" aria-label="Target record">
                <option value="">Choose {def?.name ?? 'record'}…</option>
                {opts.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title}
                  </option>
                ))}
              </Select>
              <button onClick={() => setRels(rels.filter((_, j) => j !== i))} className="text-neutral-400 hover:text-red-500" aria-label="Remove relation">
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <Button size="sm" variant="ghost" className="mt-2" onClick={() => setRels([...rels, { fieldId: relFields[0].id, toId: '' }])}>
        <Plus size={13} /> Add relation
      </Button>
    </div>
  );
}

/* ---------------- publish ---------------- */

function PublishSection({
  enabled,
  tokens,
  onToggle,
  onMint,
  onCopy,
  onRevoke,
}: {
  enabled: boolean;
  tokens: FormToken[];
  onToggle(v: boolean): void;
  onMint(): Promise<void>;
  onCopy(t: string): void;
  onRevoke(t: string): Promise<void>;
}) {
  return (
    <section className="space-y-3 rounded-xl border border-neutral-200 p-3.5 dark:border-neutral-800">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} className="h-4 w-4 rounded border-neutral-300 accent-blue-600" />
        Accepting responses
      </label>
      <p className="text-xs text-neutral-400">Public links only work while this is on — turning it off shows visitors a closed page.</p>
      <div>
        <p className="mb-1.5 text-sm font-medium">Publish links</p>
        <div className="space-y-1.5">
          {tokens.map((t) => (
            <div key={t.token} className={cn('flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs', t.revokedAt ? 'border-neutral-200 opacity-50 dark:border-neutral-800' : 'border-neutral-200 dark:border-neutral-800')}>
              <Link2 size={13} className="shrink-0 text-neutral-400" />
              <code className="min-w-0 flex-1 truncate">{t.token.slice(0, 12)}…</code>
              {t.revokedAt ? (
                <span className="shrink-0 text-neutral-400">Revoked</span>
              ) : (
                <>
                  <button onClick={() => onCopy(t.token)} className="shrink-0 text-neutral-400 hover:text-blue-600" aria-label="Copy link">
                    <Copy size={13} />
                  </button>
                  <button onClick={() => void onRevoke(t.token)} className="shrink-0 text-neutral-400 hover:text-red-500" aria-label="Revoke link">
                    <Ban size={13} />
                  </button>
                </>
              )}
            </div>
          ))}
          {!tokens.length && <p className="text-xs text-neutral-400">No links yet — create one to share this form.</p>}
        </div>
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => void onMint()}>
          <Plus size={13} /> New publish link
        </Button>
      </div>
    </section>
  );
}

function DangerZone({ onDelete }: { onDelete(): Promise<void> }) {
  return (
    <section className="pb-8">
      <button onClick={() => void onDelete()} className="text-xs font-medium text-red-500 hover:underline">
        Delete form
      </button>
    </section>
  );
}

/* ---------------- preview ---------------- */

/** Static render of the PUBLIC schema — same controls a respondent sees,
 *  non-interactive. Mirrors worker publicFormSchema projection. */
function FormPreview({ draft, board }: { draft: FormConfig; board: BoardRow | undefined }) {
  return (
    <div className="mx-auto w-full max-w-[390px] rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
      <h2 className="text-xl font-bold tracking-tight">{draft.title || 'Untitled form'}</h2>
      {draft.description && <p className="mt-1.5 whitespace-pre-wrap text-xs text-neutral-500">{draft.description}</p>}
      {draft.branding?.intro && <p className="mt-2 whitespace-pre-wrap rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">{draft.branding.intro}</p>}
      <div className="mt-4 space-y-4">
        {draft.fields.map((f, i) => (
          <PreviewField key={`${f.fieldKey}-${i}`} spec={f} board={board} />
        ))}
        {!draft.fields.length && <p className="text-xs text-neutral-400">Add fields to see them here.</p>}
        <div className="rounded-xl bg-blue-600 px-4 py-2.5 text-center text-xs font-semibold text-white opacity-60">Submit</div>
      </div>
    </div>
  );
}

function PreviewField({ spec, board }: { spec: FormFieldSpec; board: BoardRow | undefined }) {
  const pub = publicTypeOf(spec, board);
  return (
    <div>
      <p className="mb-1 text-xs font-medium">
        {spec.label || 'Field'} {spec.required && <span className="text-red-500">*</span>}
      </p>
      {spec.help && <p className="mb-1 text-[10px] text-neutral-400">{spec.help}</p>}
      {pub === 'select' ? (
        <div className="rounded-lg border border-neutral-200 px-2.5 py-2 text-xs text-neutral-400 dark:border-neutral-700">Choose…</div>
      ) : pub === 'multiselect' ? (
        <div className="space-y-1">{optionsOf(spec, board).map((o) => (
          <p key={o.id} className="flex items-center gap-1.5 text-xs text-neutral-500">
            <span className="h-3 w-3 rounded border border-neutral-300 dark:border-neutral-600" /> {o.name}
          </p>
        ))}</div>
      ) : pub === 'checkbox' ? (
        <p className="flex items-center gap-1.5 text-xs text-neutral-500">
          <span className="h-3 w-3 rounded border border-neutral-300 dark:border-neutral-600" /> Yes
        </p>
      ) : (
        <div className="rounded-lg border border-neutral-200 px-2.5 py-2 text-xs text-neutral-300 dark:border-neutral-700 dark:text-neutral-600">{placeholderOf(pub)}</div>
      )}
    </div>
  );
}

function publicTypeOf(spec: FormFieldSpec, board: BoardRow | undefined): 'text' | 'url' | 'email' | 'number' | 'date' | 'checkbox' | 'select' | 'multiselect' {
  if (spec.fieldKey === 'status' || spec.fieldKey === 'priority') return 'select';
  if (spec.fieldKey === 'dueDate') return 'date';
  if (spec.fieldKey.startsWith('p_')) {
    const def = fieldsOf(board).find((f) => f.id === spec.fieldKey.slice(2));
    if (!def) return 'text';
    if (def.type === 'select') return 'select';
    if (def.type === 'multi_select') return 'multiselect';
    if (def.type === 'url' && /e-?mail/i.test(def.name)) return 'email';
    return def.type === 'relation' || def.type === 'person' ? 'text' : def.type;
  }
  return 'text';
}

function optionsOf(spec: FormFieldSpec, board: BoardRow | undefined): { id: string; name: string }[] {
  if (spec.fieldKey === 'status') return (board?.columns ?? []).map((c) => ({ id: c.id, name: c.name }));
  if (spec.fieldKey === 'priority') return [{ id: 'none', name: 'None' }, { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }, { id: 'urgent', name: 'Urgent' }];
  if (spec.fieldKey.startsWith('p_')) {
    const def = fieldsOf(board).find((f) => f.id === spec.fieldKey.slice(2));
    return (def?.options ?? []).map((o) => ({ id: o.id, name: o.name }));
  }
  return [];
}

function placeholderOf(t: string): string {
  switch (t) {
    case 'email': return 'you@example.com';
    case 'url': return 'https://…';
    case 'number': return '0';
    case 'date': return 'yyyy-mm-dd';
    default: return 'Type an answer…';
  }
}
