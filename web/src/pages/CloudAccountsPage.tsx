import { useCallback, useEffect, useState } from 'react';
import { api, type ProviderInfo, type AccountInfo } from '../api.js';
import { confirmDestructive } from '../confirm.js';

/**
 * Cloud Accounts: real database rows only. Unknown quota is shown as unknown,
 * never as zero. MEGA is visibly Experimental. No fake progress or storage.
 */

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

function statusLabel(account: AccountInfo): { text: string; tone: string } {
  if (account.status === 'connected') return { text: 'Connected', tone: 'ok' };
  if (account.status === 'needs_reauth') return { text: 'Needs reconnect', tone: 'warn' };
  if (account.status === 'error') return { text: 'Error', tone: 'bad' };
  return { text: 'Disconnected', tone: 'muted' };
}

export function CloudAccountsPage({ onGoToSettings }: { onGoToSettings: () => void }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [megaOpen, setMegaOpen] = useState(false);
  const [megaEmail, setMegaEmail] = useState('');
  const [megaPassword, setMegaPassword] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const reload = useCallback(async () => {
    const [p, a] = await Promise.all([api.providers(), api.accounts()]);
    if (p.status === 200) setProviders((p.data as { providers: ProviderInfo[] }).providers);
    if (a.status === 200) setAccounts((a.data as { accounts: AccountInfo[] }).accounts);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function connect(provider: string) {
    setError(null);
    setNotice(null);
    if (provider === 'mega') {
      setMegaOpen(true);
      return;
    }
    const res = await api.oauthStart(provider);
    if (res.status === 200) {
      const url = (res.data as { authorizationUrl: string }).authorizationUrl;
      window.location.assign(url);
      return;
    }
    const data = res.data as { error?: string; code?: string };
    if (data.code === 'provider_not_configured') {
      setError('That provider is not set up yet. Configure it in Settings → Provider Setup.');
    } else {
      setError(data.error ?? 'Could not start the connection.');
    }
    setPickerOpen(false);
  }

  async function withBusy(id: string, fn: () => Promise<void>) {
    setBusyId(id);
    setError(null);
    try {
      await fn();
    } finally {
      setBusyId(null);
    }
  }

  async function refreshOne(id: string) {
    await withBusy(id, async () => {
      const res = await api.refreshQuota(id);
      const result = (res.data as { result?: { ok: boolean; code?: string } }).result;
      if (!result?.ok) setError(`Quota refresh failed (${result?.code ?? 'unknown'}). Previous data was kept.`);
      await reload();
    });
  }

  async function refreshAll() {
    await withBusy('__all__', async () => {
      const res = await api.refreshAllQuotas();
      const results = (res.data as { results?: Array<{ id: string; ok: boolean; code?: string }> }).results ?? [];
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) setError(`${failed.length} of ${results.length} quota refresh(es) failed. Other accounts were still updated.`);
      await reload();
    });
  }

  async function rename(account: AccountInfo) {
    const label = window.prompt('New label for this account:', account.displayLabel);
    if (!label) return;
    await withBusy(account.id, async () => {
      await api.updateAccount(account.id, { displayLabel: label });
      await reload();
    });
  }

  async function reconnect(account: AccountInfo) {
    await withBusy(account.id, async () => {
      const res = await api.reconnect(account.id);
      const data = res.data as { mode?: string; authorizationUrl?: string; message?: string };
      if (data.mode === 'oauth' && data.authorizationUrl) {
        window.location.assign(data.authorizationUrl);
        return;
      }
      if (data.mode === 'credentials') {
        setMegaOpen(true);
        setNotice(data.message ?? 'Enter your MEGA credentials again.');
        return;
      }
      setError((res.data as { error?: string }).error ?? 'Reconnect failed.');
    });
  }

  async function disconnect(account: AccountInfo) {
    if (!(await confirmDestructive(`Disconnect ${account.displayLabel}? Local credentials are removed. No remote files are deleted.`))) return;
    await withBusy(account.id, async () => {
      const res = await api.disconnect(account.id);
      const data = res.data as { warning?: string | null };
      if (data.warning) setNotice(data.warning);
      else setNotice('Account disconnected. No remote files were deleted.');
      await reload();
    });
  }

  async function submitMega(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await api.megaConnect(megaEmail, megaPassword);
    setMegaPassword('');
    if (res.status === 201) {
      setMegaOpen(false);
      setMegaEmail('');
      setNotice('MEGA account connected (experimental).');
      await reload();
    } else {
      const data = res.data as { error?: string; code?: string };
      setError(data.code === 'invalid_credentials' ? 'MEGA rejected those credentials.' : data.error ?? 'MEGA connection failed.');
    }
  }

  const setupSummary = (provider: ProviderInfo): { text: string; tone: string } => {
    if (!provider.requiresAppConfig) return { text: 'Experimental', tone: 'warn' };
    if (provider.verificationStatus === 'verified') return { text: 'Verified', tone: 'ok' };
    if (provider.verificationStatus === 'saved') return { text: 'Saved — not yet verified', tone: 'warn' };
    if (provider.verificationStatus === 'needs_correction') return { text: 'Needs correction', tone: 'bad' };
    return { text: 'Not set', tone: 'muted' };
  };

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Cloud Accounts</h1>
        <button type="button" className="btn-primary btn-inline" onClick={() => setPickerOpen((v) => !v)}>
          + Connect Account
        </button>
      </div>

      {notice && (
        <div className="card notice-card" role="status">
          <p>{notice}</p>
        </div>
      )}
      {error && (
        <div className="card error-card" role="alert">
          <p>{error}</p>
        </div>
      )}

      {pickerOpen && (
        <section className="card">
          <h2>Choose a provider</h2>
          <div className="provider-grid">
            {providers.map((p) => {
              const s = setupSummary(p);
              const configured = !p.requiresAppConfig || p.verificationStatus === 'verified' || p.verificationStatus === 'saved';
              return (
                <div key={p.id} className="provider-card">
                  <div className="provider-card-head">
                    <strong>{p.displayName}</strong>
                    {p.experimental && <span className="tag tag-warn">Experimental</span>}
                  </div>
                  <p className={`setup-state setup-${s.tone}`}>Setup: {s.text}</p>
                  {!configured ? (
                    <>
                      <p className="muted">One-time provider setup is required before connecting.</p>
                      <button type="button" className="btn-secondary" onClick={onGoToSettings}>
                        Open Provider Setup
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn-primary" onClick={() => void connect(p.id)}>
                      Connect {p.displayName}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {megaOpen && (
        <section className="card">
          <h2>Connect MEGA <span className="tag tag-warn">Experimental</span></h2>
          <p className="muted">
            MEGA uses an unofficial Node.js library. Credentials are sent only to your local CloudNest
            server and stored encrypted. Two-factor codes are never saved.
          </p>
          <form onSubmit={submitMega} className="password-form">
            <label htmlFor="mega-email">MEGA email</label>
            <input id="mega-email" type="email" value={megaEmail} onChange={(e) => setMegaEmail(e.target.value)} required />
            <label htmlFor="mega-password">MEGA password</label>
            <input id="mega-password" type="password" value={megaPassword} onChange={(e) => setMegaPassword(e.target.value)} required />
            <button type="submit" className="btn-primary">Connect MEGA</button>
            <button type="button" className="btn-secondary" onClick={() => { setMegaOpen(false); setMegaPassword(''); }}>
              Cancel
            </button>
          </form>
        </section>
      )}

      <section className="card">
        <div className="page-head">
          <h2>Accounts</h2>
          {accounts.length > 0 && (
            <button type="button" className="btn-secondary" disabled={busyId === '__all__'} onClick={() => void refreshAll()}>
              {busyId === '__all__' ? 'Refreshing…' : 'Refresh All Quotas'}
            </button>
          )}
        </div>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="muted">No cloud accounts connected yet.</p>
        ) : (
          <table className="accounts-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Account</th>
                <th>Status</th>
                <th>Used / Total</th>
                <th>Quota</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const s = statusLabel(a);
                return (
                  <tr key={a.id}>
                    <td>
                      {a.displayName}
                      {a.experimental && <span className="tag tag-warn">Beta</span>}
                    </td>
                    <td className="ellipsis">{a.displayLabel}</td>
                    <td>
                      <span className={`state state-${s.tone}`}>{s.text}</span>
                      {a.lastErrorCode && <div className="muted small">{a.lastErrorCode}</div>}
                    </td>
                    <td>
                      {a.quota.usedBytes === null ? 'Unknown' : formatBytes(a.quota.usedBytes)} /{' '}
                      {a.quota.totalBytes === null ? 'Unknown' : formatBytes(a.quota.totalBytes)}
                      {a.quota.availableBytes !== null && (
                        <div className="muted small">Available (estimated): {formatBytes(a.quota.availableBytes)}</div>
                      )}
                    </td>
                    <td>
                      <span className={`state state-${a.quota.status === 'current' ? 'ok' : 'warn'}`}>{a.quota.status}</span>
                      {a.quota.lastCheckedAt && (
                        <div className="muted small">Checked {new Date(a.quota.lastCheckedAt).toLocaleString()}</div>
                      )}
                      {a.quota.lastErrorCode && <div className="muted small">{a.quota.lastErrorCode}</div>}
                    </td>
                    <td className="actions">
                      <button type="button" className="btn-secondary" disabled={busyId === a.id} onClick={() => void refreshOne(a.id)}>Refresh quota</button>
                      <button type="button" className="btn-secondary" disabled={busyId === a.id} onClick={() => void rename(a)}>Rename</button>
                      <button type="button" className="btn-secondary" disabled={busyId === a.id} onClick={() => void reconnect(a)}>Reconnect</button>
                      <button type="button" className="btn-danger" disabled={busyId === a.id} onClick={() => void disconnect(a)}>Disconnect</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted small">
          Provider-reported quotas can change outside CloudNest. “Available” is an estimate, not a reservation guarantee.
          Remote files are never deleted by disconnecting.
        </p>
      </section>
    </>
  );
}
