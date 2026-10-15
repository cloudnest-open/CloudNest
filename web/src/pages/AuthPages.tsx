import { useState, type FormEvent } from 'react';
import { api, refreshCsrfToken } from '../api.js';
import { useI18n } from '../i18n-context.js';

/**
 * Authenticated-area auth widgets. The public entry/login/first-run pages live
 * in EntryPage.tsx (CloudNest-LOGIN-PAGE-REFERENCE-SPEC.md implementation);
 * only the in-app password change panel stays here. All copy resolves through
 * the app-wide i18n context.
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
  const { t } = useI18n();
  const cp = t.auth.changePassword;
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
      onDone(cp.success);
    } else {
      setError((data as { error?: string })?.error ?? cp.failed);
    }
    setBusy(false);
  }

  return (
    <section className="card">
      <h2>{cp.title}</h2>
      <form onSubmit={submit} className="password-form">
        <label htmlFor="cp-current">{cp.current}</label>
        <input id="cp-current" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        <label htmlFor="cp-new">{cp.next}</label>
        <input id="cp-new" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
        <label htmlFor="cp-confirm">{cp.confirm}</label>
        <input id="cp-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        <ErrorNote message={error} />
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? cp.changing : cp.submit}
        </button>
      </form>
    </section>
  );
}
