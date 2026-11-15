import { useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { Button, Field } from './ui';

const endpoint = '/api/me/email';
interface EmailState {
  email: string | null;
  pending: string | null;
  available: boolean;
}

export function NotificationEmail() {
  const [state, setState] = useState<EmailState>();
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<{field?: 'address' | 'code'; message: string}>();
  const errorId = useId();
  const addressInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const focusCode = useRef(false);

  useEffect(() => {
    let current = true;
    void api<EmailState>(endpoint).then(value => {
      if (current) setState(value);
    }, () => {
      if (current) setLoadFailed(true);
    });
    return () => { current = false; };
  }, [reload]);

  useEffect(() => {
    if (busy) return;
    if (focusCode.current || error?.field === 'code') codeInput.current?.focus();
    if (error?.field === 'address') addressInput.current?.focus();
    focusCode.current = false;
  }, [busy, error]);

  if (state && !state.available && !state.email && !state.pending) return null;

  async function run(action: () => Promise<void>, field?: 'address' | 'code') {
    if (busy) return;
    setBusy(true);
    setStatus('');
    setError(undefined);
    try {
      await action();
    } catch (err) {
      const fieldError = err instanceof ApiError && err.status === 400;
      setError({
        field: fieldError ? field : undefined,
        message: err instanceof ApiError && [400, 429, 503].includes(err.status)
          ? err.message : 'Check your connection and try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 space-y-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
      <h3 className="text-sm font-medium">Email for notifications</h3>
      {!state && (loadFailed
        ? <Button className="min-h-11" onClick={() => { setLoadFailed(false); setReload(reload + 1); }}>Retry loading email settings</Button>
        : <p role="status" className="text-sm">Loading email settings…</p>)}
      {state?.email && <p className="break-all text-sm">Verified: {state.email}</p>}
      {state?.available && (
        <form className="grid gap-2" aria-busy={busy} onSubmit={event => {
          event.preventDefault();
          void run(async () => {
            const result = await api<{pending: string; delivery: 'accepted' | 'uncertain'}>(endpoint, {
              method: 'POST', body: { email: address },
            });
            setState({ ...state, pending: result.pending });
            focusCode.current = true;
            setCode('');
            setStatus(result.delivery === 'accepted' ? 'Check your email for the six-digit code.' :
              'Delivery could not be confirmed. Check your inbox before requesting another code.');
          }, 'address');
        }}>
          <Field label={state.email ? 'New email address' : 'Email address'}>
            <input className="ws-input" ref={addressInput} name="notification-email" type="email" autoComplete="email" spellCheck={false} required maxLength={254}
              value={address} onChange={event => setAddress(event.target.value)}
              aria-invalid={error?.field === 'address' || undefined}
              aria-describedby={error?.field === 'address' ? errorId : undefined} />
          </Field>
          {error?.field === 'address' && <p className="text-sm" id={errorId} role="alert">{error.message}</p>}
          <Button type="submit" disabled={busy} className="min-h-11 justify-self-start">Send verification code</Button>
        </form>
      )}
      {state?.available && state.pending && (
        <form className="grid gap-2" aria-busy={busy} onSubmit={event => {
          event.preventDefault();
          void run(async () => {
            const result = await api<{email: string}>(`${endpoint}/verify`, { method: 'POST', body: { code } });
            setState({ ...state, email: result.email, pending: null });
            setAddress('');
            setCode('');
            setStatus('Email verified.');
          }, 'code');
        }}>
          <p className="break-all text-sm">Enter the code for {state.pending}.</p>
          <Field label="Verification code">
            <input className="ws-input" ref={codeInput} name="email-verification-code" autoComplete="one-time-code" inputMode="numeric" required spellCheck={false}
              value={code} onChange={event => setCode(event.target.value)}
              aria-invalid={error?.field === 'code' || undefined}
              aria-describedby={error?.field === 'code' ? errorId : undefined} />
          </Field>
          {error?.field === 'code' && <p className="text-sm" id={errorId} role="alert">{error.message}</p>}
          <Button type="submit" disabled={busy} className="min-h-11 justify-self-start">Verify email</Button>
        </form>
      )}
      {(state?.email || state?.pending) && (
        <Button disabled={busy} className="min-h-11" onClick={() => void run(async () => {
          await api(endpoint, { method: 'DELETE' });
          setState({ ...state, email: null, pending: null });
          setAddress('');
          setCode('');
          setStatus('Email removed.');
        })}>Remove email</Button>
      )}
      {error && !error.field && <p className="text-sm" role="alert">{error.message}</p>}
      <p className="text-sm" role="status">{status}</p>
    </div>
  );
}
