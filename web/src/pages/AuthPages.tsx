import { useState, type FormEvent } from 'react';
import { api, refreshCsrfToken } from '../api.js';

/**
 * Authenticated-area auth widgets. The public entry/login/first-run pages live
 * in EntryPage.tsx (CloudNest-LOGIN-PAGE-REFERENCE-SPEC.md implementation);
 * only the in-app password change panel stays here.
 */

function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="form-error" role="alert">
      {message}
    </p>
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
