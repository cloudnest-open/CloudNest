import { useCallback, useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { api, type UserInfo } from '../api.js';
import { useI18n } from '../i18n-context.js';
import { Badge, ConfirmDialog, Dialog, EmptyState, SkeletonRows, formatBytes, useToast } from '../components/ui.js';

/**
 * Roadmap Phase 3 (§4.3): the admin Users panel. EMAIL | ROLE | USED |
 * ALLOWANCE | STATUS | ACTIONS + one-time invite/reset links that are shown
 * exactly once (no email in this product). Every action maps to a real
 * server-side API; server safe codes resolve to the honest localized message.
 */
export function UsersPanel() {
  const { t, tf } = useI18n();
  const toast = useToast();
  const [users, setUsers] = useState<UserInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<UserInfo | null>(null);
  const [removeTarget, setRemoveTarget] = useState<UserInfo | null>(null);
  /** The one-time invite/reset URL: rendered once, then gone. */
  const [oneTimeLink, setOneTimeLink] = useState<{ url: string; kind: 'invite' | 'reset' } | null>(null);

  const [email, setEmail] = useState('');
  const [displayName, setName] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [inviteAllowance, setInviteAllowance] = useState('');
  const [editRole, setEditRole] = useState<'admin' | 'member'>('member');
  const [editAllowance, setEditAllowance] = useState('');
  // session-26 F18: the allowance carries its own unit — a business owner
  // thinks in TB, not in five-digit GB values.
  const [inviteAllowanceUnit, setInviteAllowanceUnit] = useState<'gb' | 'tb'>('gb');
  const [editAllowanceUnit, setEditAllowanceUnit] = useState<'gb' | 'tb'>('gb');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.listUsers();
      if (res.status === 200) {
        setUsers((res.data as { users: UserInfo[] }).users ?? []);
        setError(null);
      } else {
        setError(errorText(t, (res.data as { code?: string })?.code));
      }
    } catch {
      setError(t.common.errorNetwork);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-driven; a language change must not re-fetch
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const gBytes = (raw: string, unit: 'gb' | 'tb' = 'gb'): number | null | undefined => {
    const v = raw.trim();
    if (v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return undefined;
    // F18: a whole number of TB is always a whole number of GB — the byte
    // contract (allowanceBytes) never changes.
    return n * 1024 * 1024 * 1024 * (unit === 'tb' ? 1024 : 1);
  };

  function safeErrorText(body: unknown): string {
    const code = (body as { code?: string } | null)?.code;
    return errorText(t, code);
  }

  async function submitInvite(ev: React.FormEvent) {
    ev.preventDefault();
    if (busy) return;
    const allowance = gBytes(inviteAllowance, inviteAllowanceUnit);
    if (allowance === undefined) {
      setError(t.users.errors.invalid_allowance);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.inviteUser({ email: email.trim(), displayName, role: inviteRole, allowanceBytes: allowance });
      if (res.status === 201) {
        setInviteOpen(false);
        setEmail('');
        setName('');
        setInviteAllowance('');
        setInviteAllowanceUnit('gb');
        setOneTimeLink({ url: (res.data as { acceptUrl: string }).acceptUrl, kind: 'invite' });
        toast.push({ kind: 'success', title: t.users.toast.invited });
        void load();
      } else {
        setError(safeErrorText(res.data));
      }
    } catch {
      setError(t.common.errorNetwork);
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit(ev: React.FormEvent) {
    ev.preventDefault();
    if (busy || !editTarget) return;
    const allowance = gBytes(editAllowance, editAllowanceUnit);
    if (allowance === undefined) {
      setError(t.users.errors.invalid_allowance);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.updateUser(editTarget.id, { role: editRole, allowanceBytes: allowance });
      if (res.status === 200) {
        setEditTarget(null);
        toast.push({ kind: 'success', title: t.users.toast.updated });
        void load();
      } else {
        setError(safeErrorText(res.data));
      }
    } catch {
      setError(t.common.errorNetwork);
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(user: UserInfo) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.resetUserPassword(user.id);
      if (res.status === 200) {
        setOneTimeLink({ url: (res.data as { resetUrl: string }).resetUrl, kind: 'reset' });
        toast.push({ kind: 'success', title: t.users.toast.reset });
      } else {
        setError(safeErrorText(res.data));
      }
    } catch {
      setError(t.common.errorNetwork);
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(user: UserInfo) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.updateUser(user.id, { status: user.status === 'disabled' ? 'active' : 'disabled' });
      if (res.status === 200) {
        toast.push({ kind: 'success', title: t.users.toast.updated });
        void load();
      } else {
        setError(safeErrorText(res.data));
      }
    } catch {
      setError(t.common.errorNetwork);
    } finally {
      setBusy(false);
    }
  }

  async function removeUser(user: UserInfo) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.removeUser(user.id);
      if (res.status === 200) {
        toast.push({ kind: 'success', title: t.users.toast.removed });
        void load();
      } else {
        setError(safeErrorText(res.data));
      }
    } catch {
      setError(t.common.errorNetwork);
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(url: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  }

  if (users === null) {
    return (
      <section className="card">
        <h2>{t.users.title}</h2>
        {error ? <p className="muted">{error}</p> : <SkeletonRows rows={3} />}
      </section>
    );
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>{t.users.title}</h2>
        <div className="card-tools">
          <button type="button" className="btn-primary" onClick={() => { setError(null); setInviteOpen(true); }}>
            {t.users.invite}
          </button>
        </div>
      </div>
      <p className="muted small">{t.users.note}</p>
      {error && <div className="error-card" role="alert"><p>{error}</p></div>}

      {users.length === 0 ? (
        <EmptyState title={t.users.empty.title} body={t.users.empty.body} />
      ) : (
        <table className="accounts-table users-table">
          <thead>
            <tr>
              <th>{t.users.table.email}</th>
              <th>{t.users.table.role}</th>
              <th>{t.users.table.used}</th>
              <th>{t.users.table.allowance}</th>
              <th>{t.users.table.status}</th>
              <th>{t.users.table.actions}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              // the built-in root admin is the instance's anchor account: the
              // server refuses to edit or remove it, so the UI says so too
              const builtIn = user.email === 'admin' && user.role === 'admin';
              return (
                <tr key={user.id}>
                  <td>
                    <strong>{user.email}</strong>
                    {builtIn && <span className="muted small"> · {t.shell.account.role}</span>}
                  </td>
                  <td><Badge tone={user.role === 'admin' ? 'info' : 'muted'}>{t.users.role[user.role]}</Badge></td>
                  <td>{formatBytes(user.usedBytes)}</td>
                  <td>{user.allowanceBytes === null ? t.users.unlimited : formatBytes(user.allowanceBytes)}</td>
                  <td>
                    <Badge tone={user.status === 'active' ? 'ok' : user.status === 'invited' ? 'warn' : 'bad'}>
                      {t.users.status[user.status]}
                    </Badge>
                  </td>
                  <td className="actions">
                    <button
                      type="button"
                      className="btn-secondary btn-compact"
                      disabled={busy || builtIn}
                      onClick={() => {
                        setEditTarget(user);
                        setEditRole(user.role);
                        setEditAllowance(user.allowanceBytes === null ? '' : String(user.allowanceBytes / (1024 * 1024 * 1024)));
                      }}
                    >
                      {t.users.actions.edit}
                    </button>{' '}
                    <button
                      type="button"
                      className="btn-secondary btn-compact"
                      disabled={busy || builtIn}
                      onClick={() => void resetPassword(user)}
                    >
                      {t.users.actions.reset}
                    </button>{' '}
                    <button
                      type="button"
                      className="btn-secondary btn-compact"
                      disabled={busy || builtIn}
                      onClick={() => void toggleStatus(user)}
                    >
                      {user.status === 'disabled' ? t.users.actions.enable : t.users.actions.disable}
                    </button>{' '}
                    <button
                      type="button"
                      className="btn-danger btn-compact"
                      disabled={busy || builtIn}
                      onClick={() => setRemoveTarget(user)}
                    >
                      {t.users.actions.remove}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {inviteOpen && (
        <Dialog title={t.users.inviteDialog.title} onClose={() => setInviteOpen(false)}>
          <form className="upload-form" onSubmit={submitInvite}>
            <label htmlFor="invite-email">{t.users.inviteDialog.email}</label>
            <input
              id="invite-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
            />
            <label htmlFor="invite-name">{t.users.inviteDialog.name}</label>
            <input id="invite-name" type="text" required value={displayName} onChange={(e) => setName(e.target.value)} />
            <label htmlFor="invite-role">{t.users.inviteDialog.role}</label>
            <select id="invite-role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member')}>
              <option value="member">{t.users.role.member}</option>
              <option value="admin">{t.users.role.admin}</option>
            </select>
            <label htmlFor="invite-allowance">{t.users.inviteDialog.allowance}</label>
            <div className="allowance-row">
              <input
                id="invite-allowance"
                type="number"
                min={1}
                value={inviteAllowance}
                onChange={(e) => setInviteAllowance(e.target.value)}
                placeholder={t.users.unlimited}
              />
              <select
                aria-label={t.users.inviteDialog.allowance}
                value={inviteAllowanceUnit}
                onChange={(e) => setInviteAllowanceUnit(e.target.value as 'gb' | 'tb')}
              >
                <option value="gb">GB</option>
                <option value="tb">TB</option>
              </select>
            </div>
            <p className="muted small">{t.users.inviteDialog.allowanceHint}</p>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="actions">
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? t.common.working : t.users.inviteDialog.submit}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setInviteOpen(false)}>
                {t.dialog.cancel}
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {editTarget && (
        <Dialog title={t.users.editDialog.title} onClose={() => setEditTarget(null)}>
          <form className="upload-form" onSubmit={submitEdit}>
            <label htmlFor="edit-role">{t.users.editDialog.role}</label>
            <select id="edit-role" value={editRole} onChange={(e) => setEditRole(e.target.value as 'admin' | 'member')}>
              <option value="member">{t.users.role.member}</option>
              <option value="admin">{t.users.role.admin}</option>
            </select>
            <label htmlFor="edit-allowance">{t.users.editDialog.allowance}</label>
            <div className="allowance-row">
              <input
                id="edit-allowance"
                type="number"
                min={1}
                value={editAllowance}
                onChange={(e) => setEditAllowance(e.target.value)}
                placeholder={t.users.unlimited}
              />
              <select
                aria-label={t.users.editDialog.allowance}
                value={editAllowanceUnit}
                onChange={(e) => setEditAllowanceUnit(e.target.value as 'gb' | 'tb')}
              >
                <option value="gb">GB</option>
                <option value="tb">TB</option>
              </select>
            </div>
            <p className="muted small">{t.users.editDialog.allowanceHint}</p>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="actions">
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? t.common.working : t.users.editDialog.save}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setEditTarget(null)}>
                {t.dialog.cancel}
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {oneTimeLink && (
        <Dialog
          title={t.users.linkDialog.title}
          onClose={() => setOneTimeLink(null)}
          footer={
            <button type="button" className="btn-secondary" onClick={() => setOneTimeLink(null)}>
              {t.dialog.close}
            </button>
          }
        >
          <p className="muted small">{t.users.linkDialog.note}</p>
          <div className="one-time-link-row">
            <code className="one-time-link">{oneTimeLink.url}</code>
            <button
              type="button"
              className="btn-secondary btn-compact"
              onClick={async () => {
                const ok = await copyLink(oneTimeLink.url);
                if (ok) toast.push({ kind: 'success', title: t.users.linkDialog.copied });
              }}
            >
              <Copy size={14} aria-hidden="true" />
              {t.users.linkDialog.copy}
            </button>
          </div>
        </Dialog>
      )}

      {removeTarget && (
        <ConfirmDialog
          title={t.users.actions.remove}
          lines={[
            removeTarget.email,
            `${t.users.table.used}: ${formatBytes(removeTarget.usedBytes)} — ${t.users.note}`,
          ]}
          confirmLabel={t.users.actions.remove}
          onConfirm={() => void removeUser(removeTarget)}
          onClose={() => setRemoveTarget(null)}
        />
      )}
    </section>
  );
}

/** Server safe code → honest localized message (raw code as diagnostic). */
function errorText(t: import('../i18n.js').AppStrings, code: string | undefined): string {
  if (code && code in t.users.errors) {
    return (t.users.errors as Record<string, string>)[code]!;
  }
  return t.users.errors.fallback;
}
