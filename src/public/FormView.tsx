import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { Spinner } from '../core/ui';
import { cn } from '../core/utils';

/** Public form renderer — mounted at /f/:token OUTSIDE the auth shell.
 *  Never starts the sync engine, never redirects to login, sets noindex.
 *  Drafts autosave to localStorage so reloads (and flaky connections) don't
 *  lose answers; submissionId is minted once per draft so retries are
 *  idempotent server-side. */

interface PubField {
  key: string;
  type: 'text' | 'url' | 'email' | 'number' | 'date' | 'checkbox' | 'select' | 'multiselect';
  label: string;
  required: boolean;
  help?: string;
  options?: { id: string; name: string }[];
}

interface PubSchema {
  title: string;
  description?: string;
  intro?: string;
  fields: PubField[];
  successMessage: string;
  turnstileSiteKey: string;
}

interface Receipt {
  state: 'accepted';
  submissionId: string;
  message: string;
  at: number;
}

interface SubmissionResponse {
  state?: string;
  submissionId?: string;
  message?: string;
  at?: number;
  error?: string;
  fieldErrors?: Record<string, string>;
  retryable?: boolean;
}

interface PublicFile {
  id: string;
  name: string;
  claim: string;
  url: string;
}

interface Draft {
  values: Record<string, unknown>;
  fileLink: string;
  files?: { id: string; name: string; claim: string }[];
  submissionId: string;
  savedAt: number;
}

const DRAFT_PREFIX = 'wsform_';
const MAX_IMAGE = 5 * 1024 * 1024;

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: {
        sitekey: string;
        action?: string;
        callback(token: string): void;
        'error-callback'?(): void;
        'expired-callback'?(): void;
      }): string;
      remove(id: string): void;
      reset(id?: string): void;
    };
  }
}

function draftKey(token: string): string {
  return `${DRAFT_PREFIX}${token}`;
}

function loadDraft(token: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(token));
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    if (!d || typeof d !== 'object' || typeof d.values !== 'object') return null;
    return d;
  } catch {
    return null;
  }
}

function newSubmissionId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 32);
}

export function FormView() {
  const { token = '' } = useParams();
  const [schema, setSchema] = useState<PubSchema | null>(null);
  const [gone, setGone] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [fileLink, setFileLink] = useState('');
  const [files, setFiles] = useState<PublicFile[]>([]);
  const [submissionId, setSubmissionId] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [tsToken, setTsToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const widgetRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // noindex + referrer policy + title
  useEffect(() => {
    const metas: HTMLMetaElement[] = [];
    for (const [name, content] of [
      ['robots', 'noindex'],
      ['referrer', 'no-referrer'],
    ] as const) {
      const m = document.createElement('meta');
      m.name = name;
      m.content = content;
      document.head.appendChild(m);
      metas.push(m);
    }
    const prev = document.title;
    return () => {
      metas.forEach((m) => m.remove());
      document.title = prev;
    };
  }, []);

  // fetch schema once + restore draft
  useEffect(() => {
    let dead = false;
    // React reuses this route component when only the public token changes.
    // Never carry another form's receipt, answers or upload claims across it.
    setSchema(null);
    setReceipt(null);
    setGone(false);
    setLoadErr(false);
    setValues({});
    setFiles([]);
    setFileLink('');
    setSubmissionId('');
    setFieldErrors({});
    setFormError(null);
    setBusy(false);
    setTsToken(null);
    void fetch(`/api/public/forms/${token}`)
      .then(async (r) => {
        if (dead) return;
        if (r.status === 410 || r.status === 404) return setGone(true);
        if (!r.ok) return setLoadErr(true);
        const j = (await r.json()) as PubSchema;
        setSchema(j);
        document.title = j.title;
        const draft = loadDraft(token);
        if (draft) {
          setValues(draft.values ?? {});
          setFileLink(draft.fileLink ?? '');
          setFiles(
            (draft.files ?? [])
              .filter((file) => typeof file.id === 'string' && typeof file.name === 'string' && typeof file.claim === 'string')
              .map((file) => ({ ...file, url: '' })),
          );
          setSubmissionId(draft.submissionId || newSubmissionId());
        } else {
          setSubmissionId(newSubmissionId());
        }
      })
      .catch(() => !dead && setLoadErr(true));
    return () => {
      dead = true;
    };
  }, [token]);

  // debounced draft autosave
  useEffect(() => {
    if (!schema || !submissionId || receipt) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        const draft: Draft = {
          values,
          fileLink,
          files: files.map(({ id, name, claim }) => ({ id, name, claim })),
          submissionId,
          savedAt: Date.now(),
        };
        localStorage.setItem(draftKey(token), JSON.stringify(draft));
      } catch {
        /* quota/private mode — drafts are best-effort */
      }
    }, 400);
    return () => clearTimeout(saveTimer.current);
  }, [values, fileLink, files, submissionId, schema, token, receipt]);

  const resetChallenge = useCallback(() => {
    if (schema?.turnstileSiteKey === 'test') {
      setTsToken('pass');
      return;
    }
    setTsToken(null);
    const widgetId = widgetIdRef.current;
    if (widgetId && window.turnstile) window.turnstile.reset(widgetId);
  }, [schema?.turnstileSiteKey]);

  // Turnstile: 'test' sentinel = dev mode, auto-'pass'; otherwise keep a
  // retained widget id so upload/submit/expiry can reset the same challenge.
  useEffect(() => {
    if (!schema || receipt) return;
    let cancelled = false;
    if (schema.turnstileSiteKey === 'test') {
      setTsToken('pass');
      return;
    }
    setTsToken(null);
    if (!window.turnstile) {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => renderWidget();
      document.head.appendChild(s);
    } else {
      renderWidget();
    }
    function renderWidget() {
      if (cancelled || !widgetRef.current || !window.turnstile) return;
      if (widgetIdRef.current) window.turnstile.remove(widgetIdRef.current);
      widgetIdRef.current = window.turnstile.render(widgetRef.current, {
        sitekey: schema!.turnstileSiteKey,
        action: 'form_submit',
        callback: (t) => setTsToken(t),
        'error-callback': () => {
          setTsToken(null);
          setFormError('Security check failed — complete the challenge again.');
        },
        'expired-callback': () => {
          setTsToken(null);
          setFormError('Security check expired — complete the challenge again.');
        },
      });
    }
    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) window.turnstile.remove(widgetIdRef.current);
      widgetIdRef.current = null;
    };
  }, [schema, receipt]);

  const setVal = useCallback((key: string, v: unknown) => {
    setValues((prev) => ({ ...prev, [key]: v }));
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  useEffect(() => {
    const firstKey = Object.keys(fieldErrors)[0];
    if (!firstKey) return;
    const field = document.getElementById(`ff_${firstKey}`);
    const focusTarget = field?.matches('input, select, textarea, [tabindex]')
      ? field
      : field?.querySelector<HTMLElement>('input, select, textarea, [tabindex]');
    focusTarget?.focus();
  }, [fieldErrors]);

  const uploadFile = useCallback(
    async (f: File) => {
      if (!f.type.startsWith('image/')) {
        setFormError('Only image files are accepted.');
        return;
      }
      if (f.size > MAX_IMAGE) {
        setFormError('Images must be 5 MB or smaller — paste a Drive link below instead.');
        return;
      }
      if (!tsToken) {
        setFormError('Complete the security check before uploading an image.');
        return;
      }
      setFormError(null);
      const fd = new FormData();
      fd.append('file', f);
      fd.append('turnstileToken', tsToken);
      try {
        const r = await fetch(`/api/public/forms/${token}/files`, { method: 'POST', body: fd });
        const j = (await r.json().catch(() => null)) as { id?: string; claim?: string } | null;
        if (!r.ok || !j?.id || !j.claim) {
          setFormError(
            r.status === 403
              ? 'Security check failed — complete the challenge again.'
              : r.status === 429
                ? 'Too many attempts — please wait and retry.'
                : r.status === 503
                  ? 'Uploads are temporarily unavailable — paste a Drive link instead.'
                  : 'Upload failed — you can paste a Drive link instead.',
          );
          return;
        }
        setFiles((prev) => [...prev, { id: j.id!, claim: j.claim!, name: f.name, url: URL.createObjectURL(f) }]);
      } catch {
        setFormError('Network error — your image remains on this device; retry or paste a Drive link instead.');
      } finally {
        resetChallenge();
      }
    },
    [resetChallenge, token, tsToken],
  );

  const submit = useCallback(async () => {
    if (!schema || !submissionId || busy) return;
    setFormError(null);
    setFieldErrors({});

    const missing: Record<string, string> = {};
    for (const field of schema.fields) {
      if (!field.required) continue;
      const value = values[field.key];
      if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) missing[field.key] = 'required';
    }
    if (Object.keys(missing).length) {
      setFieldErrors(missing);
      setFormError('Please complete the required fields.');
      return;
    }
    if (!tsToken) {
      setFormError('Complete the security check before submitting.');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/public/forms/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submissionId,
          values,
          fileIds: files.map((f) => f.id),
          fileClaims: Object.fromEntries(files.map((f) => [f.id, f.claim])),
          fileLink: fileLink.trim() || undefined,
          turnstileToken: tsToken,
        }),
      });
      const j = (await r.json().catch(() => null)) as SubmissionResponse | null;
      if (r.ok && j?.state === 'accepted' && typeof j.submissionId === 'string' && typeof j.message === 'string' && typeof j.at === 'number') {
        localStorage.removeItem(draftKey(token));
        setReceipt({ state: 'accepted', submissionId: j.submissionId, message: j.message, at: j.at });
        return;
      }
      if (r.status === 422 && j?.fieldErrors) {
        setFieldErrors(j.fieldErrors);
        setFormError('Please fix the highlighted fields.');
        // The server intentionally terminalizes a rejected submission id.
        // Keep the answers and file claims, but mint a fresh intentional retry.
        setSubmissionId(newSubmissionId());
      } else if (r.status === 403) {
        setFormError('Security check failed — complete the challenge again.');
      } else if (r.status === 429) {
        setFormError('Too many attempts — please wait a bit and retry.');
      } else if (r.status === 202 || j?.state === 'processing' || j?.state === 'retryable_failure') {
        setFormError('Your submission is still processing — retry shortly if no confirmation appears.');
      } else if (r.status === 410 || r.status === 404) {
        setGone(true);
      } else {
        setFormError('Something went wrong — please try again.');
      }
    } catch {
      setFormError('Network error — your answers are saved on this device, retry when you are back online.');
    } finally {
      resetChallenge();
      setBusy(false);
    }
  }, [schema, submissionId, busy, token, values, files, fileLink, resetChallenge, tsToken]);

  const copyAnswers = useCallback(async () => {
    if (!schema) return;
    const lines = schema.fields.map((f) => {
      const v = values[f.key];
      const text = Array.isArray(v)
        ? v.map((id) => f.options?.find((o) => o.id === id)?.name ?? String(id)).join(', ')
        : typeof v === 'string' && f.options
          ? (f.options.find((o) => o.id === v)?.name ?? v)
          : v === true
            ? 'Yes'
            : String(v ?? '');
      return `${f.label}: ${text}`;
    });
    if (fileLink.trim()) lines.push(`Attachment link: ${fileLink.trim()}`);
    try {
      await navigator.clipboard.writeText(`${schema.title}\n\n${lines.join('\n')}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }, [schema, values, fileLink]);

  /* ---------- states ---------- */

  if (gone)
    return (
      <Center>
        <p className="text-5xl">📋</p>
        <h1 className="text-lg font-semibold">This form is no longer accepting responses</h1>
        <p className="text-sm text-neutral-400">The link may have expired or the form was turned off by its owner.</p>
        {schema && (
          <button onClick={copyAnswers} className="mt-2 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800">
            {copied ? 'Copied!' : 'Copy your answers'}
          </button>
        )}
      </Center>
    );
  if (loadErr)
    return (
      <Center>
        <h1 className="text-lg font-semibold">Could not load this form</h1>
        <p className="text-sm text-neutral-400">Check your connection and reload.</p>
      </Center>
    );
  if (!schema)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  if (receipt)
    return (
      <Center>
        <p className="text-5xl" aria-hidden="true">✅</p>
        <h1 className="text-lg font-semibold">{schema.title}</h1>
        <p className="max-w-md text-sm text-neutral-500 dark:text-neutral-400">{receipt.message}</p>
      </Center>
    );

  /* ---------- form ---------- */

  return (
    <div className="min-h-full min-w-0 break-words bg-white dark:bg-neutral-950">
      <div className="mx-auto max-w-xl px-5 pb-16 pt-10 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight">{schema.title}</h1>
        {schema.description && <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-500 dark:text-neutral-400">{schema.description}</p>}
        {schema.intro && <p className="mt-3 whitespace-pre-wrap rounded-xl bg-neutral-50 p-4 text-sm text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">{schema.intro}</p>}
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{copied ? 'Answers copied.' : ''}</div>

        {Object.keys(fieldErrors).length > 0 && (
          <p id="form-error" role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
            {formError ?? 'Please fix the highlighted fields.'}
          </p>
        )}
        {formError && !Object.keys(fieldErrors).length && (
          <p id="form-error" role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
            {formError}
          </p>
        )}

        <form
          className="mt-6 flex flex-col gap-5"
          aria-busy={busy}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {schema.fields.map((f) => (
            <FieldInput key={f.key} field={f} value={values[f.key]} error={fieldErrors[f.key]} onChange={(v) => setVal(f.key, v)} />
          ))}

          <div>
            <span className="mb-1.5 block text-sm font-medium" id="form-attachment-label">Attachment <span className="font-normal text-neutral-400">(optional)</span></span>
            <p id="form-attachment-help" className="mb-1.5 text-xs text-neutral-400">Images only, up to 5 MB. Complete the security check before uploading.</p>
            <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-dashed border-neutral-300 px-4 py-3 text-sm text-neutral-500 hover:bg-neutral-50 focus-within:ring-2 focus-within:ring-blue-500/30 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-900">
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                aria-labelledby="form-attachment-label"
                aria-describedby="form-attachment-help"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void uploadFile(f);
                }}
              />
              <span className="min-w-0">＋ Upload an image (max 5 MB)</span>
            </label>
            {files.map((f) => (
              <div key={f.id} className="mt-2 flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800">
                {f.url ? <img src={f.url} alt="" className="h-8 w-8 rounded object-cover" /> : <span className="flex h-8 w-8 items-center justify-center rounded bg-neutral-100 text-xs dark:bg-neutral-800" aria-hidden="true">IMG</span>}
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <button type="button" onClick={() => setFiles((prev) => prev.filter((x) => x.id !== f.id))} className="min-h-10 min-w-10 rounded-md text-neutral-400 hover:text-red-500 focus-visible:outline-2 focus-visible:outline-offset-2" aria-label={`Remove ${f.name}`}>
                  ✕
                </button>
              </div>
            ))}
            <label htmlFor="form-file-link" className="sr-only">Attachment link</label>
            <input
              id="form-file-link"
              name="fileLink"
              type="url"
              inputMode="url"
              value={fileLink}
              onChange={(e) => setFileLink(e.target.value)}
              placeholder="Paste a link instead (Google Drive, Dropbox)"
              className={inputCls(false, 'mt-2')}
            />
          </div>

          {schema.turnstileSiteKey !== 'test' && (
            <div role="group" aria-labelledby="security-check-label">
              <span id="security-check-label" className="sr-only">Security check</span>
              <div ref={widgetRef} className="min-h-[65px]" />
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-1 min-h-11 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
          >
            {busy ? 'Submit — sending…' : 'Submit'}
          </button>
          <p className="text-center text-[11px] text-neutral-400">Responses and upload claims are saved on this device until submitted.</p>
        </form>
      </div>
    </div>
  );
}

function inputCls(err: boolean, extra = ''): string {
  return cn(
    'w-full min-w-0 rounded-xl border bg-white px-3.5 py-2.5 text-sm transition-colors placeholder:text-neutral-400 focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500/20 dark:bg-neutral-900',
    err ? 'border-red-400 dark:border-red-700' : 'border-neutral-300 dark:border-neutral-700',
    extra,
  );
}

function FieldInput({ field, value, error, onChange }: { field: PubField; value: unknown; error?: string; onChange(v: unknown): void }) {
  const id = `ff_${field.key}`;
  const errorId = `${id}_error`;
  return (
    <div>
      {field.type === 'checkbox' ? (
        <span id={`${id}_label`} className="sr-only">{field.label} {field.required ? '(required)' : ''}</span>
      ) : field.type === 'multiselect' ? (
        <span id={`${id}_label`} className="mb-1.5 block text-sm font-medium">
          {field.label} {field.required && <span className="text-red-500" aria-hidden="true">*</span>}
        </span>
      ) : (
        <label htmlFor={id} className="mb-1.5 block text-sm font-medium">
          {field.label} {field.required && <span className="text-red-500" aria-hidden="true">*</span>}
        </label>
      )}
      {field.help && (
        <p id={`${id}_help`} className="mb-1.5 text-xs text-neutral-400">
          {field.help}
        </p>
      )}
      <Control field={field} id={id} value={value} error={!!error} errorId={errorId} onChange={onChange} />
      {error && (
        <p id={errorId} className="mt-1 text-xs font-medium text-red-600 dark:text-red-400">
          {error === 'required' ? 'This field is required.' : error === 'invalid' ? 'Enter a valid value.' : error}
        </p>
      )}
    </div>
  );
}

function Control({ field, id, value, error, errorId, onChange }: { field: PubField; id: string; value: unknown; error: boolean; errorId: string; onChange(v: unknown): void }) {
  const describedBy = [`${id}_help`, error ? errorId : ''].filter(Boolean).join(' ') || undefined;
  const common = { 'aria-describedby': describedBy, 'aria-invalid': error || undefined, name: field.key, required: field.required };
  switch (field.type) {
    case 'select':
      return (
        <select id={id} {...common} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)} className={inputCls(error)}>
          <option value="">Choose…</option>
          {(field.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
    case 'multiselect': {
      const sel = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div id={id} className="flex flex-col gap-1.5" role="group" aria-labelledby={`${id}_label`} aria-describedby={describedBy} aria-invalid={error || undefined}>
          {(field.options ?? []).map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm">
              <input
                id={`${id}_${o.id}`}
                name={`${field.key}[]`}
                type="checkbox"
                checked={sel.includes(o.id)}
                onChange={(e) => onChange(e.target.checked ? [...sel, o.id] : sel.filter((x) => x !== o.id))}
                className="h-4 w-4 rounded border-neutral-300 accent-blue-600"
              />
              {o.name}
            </label>
          ))}
        </div>
      );
    }
    case 'checkbox':
      return (
        <label htmlFor={id} className="flex min-h-10 items-center gap-2 text-sm">
          <input id={id} {...common} aria-labelledby={`${id}_label ${id}_option`} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-neutral-300 accent-blue-600" />
          <span id={`${id}_option`}>Yes</span>
        </label>
      );
    case 'number':
      return <input id={id} {...common} type="number" inputMode="decimal" value={typeof value === 'number' || typeof value === 'string' ? (value as number) : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} className={inputCls(error)} />;
    case 'date':
      return <input id={id} {...common} type="date" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)} className={inputCls(error)} />;
    case 'url':
    case 'email':
      return <input id={id} {...common} type={field.type === 'email' ? 'email' : 'url'} inputMode={field.type} autoComplete={field.type === 'email' ? 'email' : 'url'} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} className={inputCls(error)} />;
    default:
      return <input id={id} {...common} type="text" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} className={inputCls(error)} />;
  }
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">{children}</div>;
}
