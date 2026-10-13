import { useState, type FormEvent } from 'react';
import { api, refreshCsrfToken } from '../api.js';

function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="form-error" role="alert">
      {message}
    </p>
  );
}

export function FirstRunPage({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { status, data } = await api.setup(password);
    if (status === 201) {
      setPassword('');
      setConfirm('');
      await refreshCsrfToken();
      onDone();
    } else {
      setError((data as { error?: string })?.error ?? 'Setup failed.');
    }
    setBusy(false);
  }

  return (
    <div className="auth-card" role="main">
      <p className="brand-word">CLOUDNEST</p>
      <h1>First-time setup</h1>
      <p className="muted">Create your private admin password. There is no default password.</p>
      <form onSubmit={submit}>
        <label htmlFor="setup-password">Password (min 12 characters)</label>
        <input
          id="setup-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
        />
        <label htmlFor="setup-confirm">Confirm password</label>
        <input
          id="setup-confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
        <ErrorNote message={error} />
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Creating…' : 'CREATE ADMIN ACCOUNT'}
        </button>
      </form>
    </div>
  );
}

export function LoginPage({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { status, data } = await api.login(password);
    if (status === 200) {
      setPassword('');
      await refreshCsrfToken();
      onDone();
    } else {
      setError((data as { error?: string })?.error ?? 'Sign in failed.');
    }
    setBusy(false);
  }

  return (
    <div className="auth-card" role="main">
      <p className="brand-word">CLOUDNEST</p>
      <h1>Sign in</h1>
      <form onSubmit={submit}>
        <label htmlFor="login-username">Username</label>
        <input id="login-username" type="text" value="admin" readOnly />
        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        <ErrorNote message={error} />
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'SIGN IN'}
        </button>
      </form>
    </div>
  );
}

export function ChangePasswordPanel({ onDone }: { onDone: (message: string) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { status, data } = await api.changePassword(current, next);
    if (status === 200) {
      setCurrent('');
      setNext('');
      setConfirm('');
      await refreshCsrfToken();
      onDone('Password changed. Other sessions were signed out.');
    } else {
      setError((data as { error?: string })?.error ?? 'Password change failed.');
    }
    setBusy(false);
  }

  return (
    <section className="card">
      <h2>Change admin password</h2>
      <form onSubmit={submit} className="password-form">
        <label htmlFor="cp-current">Current password</label>
        <input id="cp-current" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        <label htmlFor="cp-new">New password (min 12 characters)</label>
        <input id="cp-new" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
        <label htmlFor="cp-confirm">Confirm new password</label>
        <input id="cp-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        <ErrorNote message={error} />
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Changing…' : 'CHANGE PASSWORD'}
        </button>
      </form>
    </section>
  );
}
