import { useCallback, useEffect, useState } from 'react';
import { api, type ProviderInfo, type AccountInfo } from '../api.js';
import { confirmDestructive } from '../confirm.js';
import { Dialog } from '../components/ui.js';
import { ProviderLogo } from '../components/ProviderLogo.js';

/**
 * Cloud Accounts: real database rows only. Unknown quota is shown as unknown,
 * never as zero. MEGA is visibly Experimental. No fake progress or storage.
 *
 * Connection behavior (owner task 2026-10-15): every provider's Connect
 * action lives and stays on this page. OAuth start failures for a missing
 * application configuration open an explanatory dialog with an explicit
 * "Configure Provider" choice — the user is never auto-navigated to Settings.
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
  return `${value.toFixed(value >= 100 ? 0 : 1)}\u00A0${units[i]}`;
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
  // The connect picker stays open across navigation so a user who followed the
  // explicit "Configure Provider" jump into Settings returns to their context.
  const [pickerOpen, setPickerOpen] = useState(() => {
    try { return sessionStorage.getItem('cloudnest.connectPickerOpen') === '1'; } catch { return false; }
  });
  // Set when an OAuth start fails because this instance lacks the provider's
  // application configuration; rendered as the explanatory dialog below.
  const [setupNeeded, setSetupNeeded] = useState<ProviderInfo | null>(null);

  useEffect(() => {
    try { sessionStorage.setItem('cloudnest.connectPickerOpen', pickerOpen ? '1' : '0'); } catch { /* private mode */ }
  }, [pickerOpen]);

  const reload = useCallback(async () => {
    // FE-04: without this the page showed "Loading…" forever on a network error
    try {
      const [p, a] = await Promise.all([api.providers(), api.accounts()]);
      if (p.status === 200) setProviders((p.data as { providers: ProviderInfo[] }).providers);
      if (a.status === 200) setAccounts((a.data as { accounts: AccountInfo[] }).accounts);
      if (p.status !== 200 && a.status !== 200) {
        setError('Could not load cloud accounts. The server did not answer with real data.');
      } else {
        setError(null);
      }
    } catch {
      setError('Could not reach the server. Check that CloudNest is running, then retry.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function connect(p: ProviderInfo) {
    setError(null);
    setNotice(null);
    if (p.id === 'mega') {
      // MEGA uses its own credentials form here — never pretend it is OAuth.
      setMegaOpen(true);
      return;
    }
    const res = await api.oauthStart(p.id);
    if (res.status === 200) {
      const url = (res.data as { authorizationUrl: string }).authorizationUrl;
      window.location.assign(url);
      return;
    }
    const data = res.data as { error?: string; code?: string };
    if (data.code === 'provider_not_configured') {
      // Stay on Cloud Accounts: explain, and let the user choose to open
      // Settings. Nothing navigates automatically and nothing was connected.
      setSetupNeeded(p);
      return;
    }
    setError(data.error ?? 'Could not start the connection.');
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
    // Task §5.A: an account that holds chunk placements takes those files with
    // it until reconnection — warn with the real count before confirming.
    const tracked = account.usage?.trackedFiles ?? 0;
    const message = tracked > 0
      ? `Disconnect ${account.displayLabel}? ${tracked} file${tracked === 1 ? ' stores' : 's store'} chunks on this account and may be unavailable until it is reconnected. Local credentials are removed. No remote files are deleted.`
      : `Disconnect ${account.displayLabel}? Local credentials are removed. No remote files are deleted.`;
    const ok = await confirmDestructive(message, { title: 'Disconnect account', confirmLabel: 'Disconnect' });
    if (!ok) return;
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
        <button type="button" className="btn-primary btn-compact" onClick={() => setPickerOpen((v) => !v)}>
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
              return (
                <div key={p.id} className="provider-card">
                  <div className="provider-card-head">
                    <span className="provider-id">
                      <ProviderLogo provider={p.id} size={24} />
                      <strong>{p.displayName}</strong>
                    </span>
                    {p.experimental && <span className="tag tag-warn">Experimental</span>}
                  </div>
                  <p className={`setup-state setup-${s.tone}`}>Setup: {s.text}</p>
                  {!p.requiresAppConfig && (
                    <p className="muted small">Connects with email and password — experimental, not OAuth.</p>
                  )}
                  {/* The real connection action always lives here. If the
                      instance lacks the app configuration, Connect explains
                      in place instead of rerouting to Settings. */}
                  <button type="button" className="btn-primary btn-block" onClick={() => void connect(p)}>
                    Connect {p.displayName}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {setupNeeded && (
        <Dialog
          title={`${setupNeeded.displayName} needs administrator setup`}
          description={`Connecting ${setupNeeded.displayName} requires this CloudNest instance's application credentials, which only an administrator can configure. Nothing was connected and no account was changed.`}
          onClose={() => setSetupNeeded(null)}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setSetupNeeded(null)}>
                Back
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => { setSetupNeeded(null); onGoToSettings(); }}
              >
                Configure Provider
              </button>
            </>
          }
        >
          <p className="small muted">
            Application-level OAuth setup (Client ID, secret, Authorized Redirect URI) is separate from your
            personal cloud-account connections. Once it is configured, Connect from this page starts the real
            authorization flow — no more trips to Settings.
          </p>
        </Dialog>
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
                      <span className="file-name-cell">
                        <ProviderLogo provider={a.provider} size={20} />
                        {a.displayName}
                      </span>
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
