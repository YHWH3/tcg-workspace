import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { signIn, signUp } from './auth';
import { APP_NAME } from './config';
import { Button, Field, Input, Spinner } from './ui';
import { cn } from './utils';

type Mode = 'login' | 'join';

export function AuthScreen() {
  const [status, setStatus] = useState<{ needsBootstrap: boolean; seatsUsed?: number } | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    api<{ needsBootstrap: boolean; seatsUsed: number }>('/api/auth/status')
      .then(setStatus)
      .catch(() => setOffline(true));
  }, []);

  if (offline) {
    return (
      <Center>
        <Logo />
        <p className="text-sm font-medium">You're offline</p>
        <p className="max-w-60 text-center text-xs text-neutral-400">This device has no saved session. Connect to sign in.</p>
      </Center>
    );
  }
  if (!status) {
    return (
      <Center>
        <Spinner size={20} />
      </Center>
    );
  }
  if (status.needsBootstrap) return <BootstrapForm />;
  return <LoginJoin seatsUsed={status.seatsUsed ?? 0} />;
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-6">
      {children}
    </div>
  );
}

function Logo() {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-neutral-900 text-lg font-bold text-white dark:bg-white dark:text-neutral-900">
        {APP_NAME[0]}
      </div>
      <h1 className="text-lg font-semibold tracking-tight">{APP_NAME}</h1>
    </div>
  );
}

function FormShell({ children, onSubmit, error, busy, submitLabel }: { children: React.ReactNode; onSubmit: (e: FormEvent) => void; error: string | null; busy: boolean; submitLabel: string }) {
  return (
    <form onSubmit={onSubmit} className="anim-slide-up flex w-full max-w-80 flex-col gap-3.5">
      {children}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">{error}</p>}
      <Button variant="primary" type="submit" disabled={busy} className="mt-1 h-10">
        {busy ? <Spinner size={15} /> : submitLabel}
      </Button>
    </form>
  );
}

function BootstrapForm() {
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Center>
      <Logo />
      <div className="text-center">
        <p className="text-sm font-medium">Create your workspace</p>
        <p className="text-xs text-neutral-400">The first account becomes the admin.</p>
      </div>
      <FormShell
        submitLabel="Create workspace"
        busy={busy}
        error={error}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await signUp({ username, name, password });
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Sign up failed');
            setBusy(false);
          }
        }}
      >
        <Field label="Your name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" autoFocus required />
        </Field>
        <Field label="Username">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ada" autoComplete="username" required />
        </Field>
        <Field label="Password" hint="At least 8 characters">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={8} />
        </Field>
      </FormShell>
    </Center>
  );
}

function LoginJoin({ seatsUsed }: { seatsUsed: number }) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await signIn({ username, password });
      else await signUp({ username, name, password, inviteCode });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      setBusy(false);
    }
  };

  return (
    <Center>
      <Logo />
      <div className="flex rounded-xl bg-neutral-100 p-1 dark:bg-neutral-800">
        {(['login', 'join'] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setError(null);
            }}
            className={cn(
              'rounded-lg px-4 py-1.5 text-sm font-medium transition-all',
              mode === m ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-900 dark:text-white' : 'text-neutral-500',
            )}
          >
            {m === 'login' ? 'Sign in' : 'Join with invite'}
          </button>
        ))}
      </div>
      <FormShell submitLabel={mode === 'login' ? 'Sign in' : 'Join workspace'} busy={busy} error={error} onSubmit={submit}>
        {mode === 'join' && (
          <Field label="Invite code">
            <Input value={inviteCode} onChange={(e) => setInviteCode(e.target.value.toUpperCase())} placeholder="XXXXXX99" autoFocus required className="tracking-widest" />
          </Field>
        )}
        {mode === 'join' && (
          <Field label="Your name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" required />
          </Field>
        )}
        <Field label="Username">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ada" autoComplete="username" autoFocus={mode === 'login'} required />
        </Field>
        <Field label="Password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'join' ? 8 : undefined} />
        </Field>
        {mode === 'join' && <p className="text-center text-xs text-neutral-400">{7 - seatsUsed} of 7 seats remaining</p>}
      </FormShell>
    </Center>
  );
}
