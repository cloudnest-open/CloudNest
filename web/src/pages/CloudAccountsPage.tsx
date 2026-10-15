import { useCallback, useEffect, useState } from 'react';
import { api, type ProviderInfo, type AccountInfo } from '../api.js';
import { confirmDestructive } from '../confirm.js';
import { Dialog, formatBytes, formatDateTime } from '../components/ui.js';
import { ProviderLogo } from '../components/ProviderLogo.js';
import { useI18n } from '../i18n-context.js';

/**
 * Cloud Accounts: real database rows only. Unknown quota is shown as unknown,
 * never as zero. MEGA is visibly Experimental. No fake progress or storage.
 * All copy resolves through the app-wide i18n context.
 *
 * Connection behavior (owner task 2026-10-15): every provider's Connect
 * action lives and stays on this page. OAuth start failures for a missing
 * application configuration open an explanatory dialog with an explicit
 * "Configure Provider" choice — the user is never auto-navigated to Settings.
 */

/**
 * Connect ↔ Provider-setup hand-off (owner task 2026-10-15).
 *
 * Connecting an account and configuring the installation's own OAuth app are
 * two different operations. When a Connect attempt finds the app credentials
 * missing, the user stays HERE and may deliberately choose “Configure
 * Provider”; these session-scoped hand-off entries then preserve the chosen
 * provider across the Settings round-trip so the user can continue connecting
 * it intentionally — nothing navigates on its own.
 */
const PENDING_KEY = 'cloudnest.pendingConnect';
const CONTINUE_KEY = 'cloudnest.connectContinue';

function readHandoff(key: string): { provider?: string; displayName?: string } | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { provider?: string; displayName?: string }) : null;
  } catch {
    return null;
  }
}

function writeHandoff(key: string, value: { provider: string; displayName?: string } | null): void {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    /* private mode: the hand-off is lost, nothing else breaks */
  }
}

export function CloudAccountsPage({ onGoToSettings }: { onGoToSettings: () => void }) {
  const { t, tf, plural } = useI18n();
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
  // Set when the user returned from Provider Setup having deliberately chosen
  // "Continue connecting {provider}": we then resume that provider's connect.
  const [continueProvider, setContinueProvider] = useState<string | null>(null);

  // On arrival, honour a pending "continue connecting" hand-off from Settings.
  useEffect(() => {
    const pending = readHandoff(CONTINUE_KEY);
    if (!pending?.provider) return;
    writeHandoff(CONTINUE_KEY, null);
    setPickerOpen(true);
    setContinueProvider(pending.provider);
  }, []);

  // Resume only once the provider catalog is loaded (connect() needs the record).
  useEffect(() => {
    if (!continueProvider || providers.length === 0) return;
    const target = providers.find((p) => p.id === continueProvider);
    setContinueProvider(null);
    if (target) void connect(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connect is stable per render cycle
  }, [continueProvider, providers]);

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
        setError(t.accounts.errorLoad);
      } else {
        setError(null);
      }
    } catch {
      setError(t.common.errorNetwork);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloads are user-driven; a language change must not re-fetch
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
      // the setup round-trip is complete; no stale hand-off should linger
      writeHandoff(PENDING_KEY, null);
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
    setError(data.error ?? t.accounts.startFailed);
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
      if (!result?.ok) setError(tf(t.accounts.quotaRefresh.failed, { code: result?.code ?? 'unknown' }));
      await reload();
    });
  }

  async function refreshAll() {
    await withBusy('__all__', async () => {
      const res = await api.refreshAllQuotas();
      const results = (res.data as { results?: Array<{ id: string; ok: boolean; code?: string }> }).results ?? [];
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) setError(plural(t.accounts.quotaRefresh.allFailed, failed.length, { total: results.length }));
      await reload();
    });
  }

  async function rename(account: AccountInfo) {
    const label = window.prompt(t.accounts.list.renamePrompt, account.displayLabel);
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
        setNotice(data.message ?? t.accounts.mega.reauthNotice);
        return;
      }
      setError((res.data as { error?: string }).error ?? t.accounts.reconnect.failed);
    });
  }

  async function disconnect(account: AccountInfo) {
    // Task §5.A: an account that holds chunk placements takes those files with
    // it until reconnection — warn with the real count before confirming.
    const tracked = account.usage?.trackedFiles ?? 0;
    const message = tracked > 0
      ? plural(t.accounts.disconnect.confirmWithFiles, tracked, { label: account.displayLabel })
      : tf(t.accounts.disconnect.confirmPlain, { label: account.displayLabel });
    const ok = await confirmDestructive(message, { title: t.accounts.disconnect.title, confirmLabel: t.accounts.disconnect.confirmLabel });
    if (!ok) return;
    await withBusy(account.id, async () => {
      const res = await api.disconnect(account.id);
      const data = res.data as { warning?: string | null };
      if (data.warning) setNotice(data.warning);
      else setNotice(t.accounts.disconnect.done);
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
      setNotice(t.accounts.mega.connected);
      await reload();
    } else {
      const data = res.data as { error?: string; code?: string };
      setError(data.code === 'invalid_credentials' ? t.accounts.mega.badCredentials : data.error ?? t.accounts.mega.failed);
    }
  }

  const setupSummary = (provider: ProviderInfo): { text: string; tone: string } => {
    if (!provider.requiresAppConfig) return { text: t.accounts.setupStatus.experimental, tone: 'warn' };
    if (provider.verificationStatus === 'verified') return { text: t.accounts.setupStatus.verified, tone: 'ok' };
    if (provider.verificationStatus === 'saved') return { text: t.accounts.setupStatus.saved, tone: 'warn' };
    if (provider.verificationStatus === 'needs_correction') return { text: t.accounts.setupStatus.needsCorrection, tone: 'bad' };
    return { text: t.accounts.setupStatus.notSet, tone: 'muted' };
  };

  const accountStatus = (a: AccountInfo): { text: string; tone: string } => {
    if (a.status === 'connected') return { text: t.states.account.connected, tone: 'ok' };
    if (a.status === 'needs_reauth') return { text: t.states.account.needs_reauth, tone: 'warn' };
    if (a.status === 'error') return { text: t.states.account.error, tone: 'bad' };
    return { text: t.states.account.disconnected, tone: 'muted' };
  };

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">{t.accounts.title}</h1>
        <button type="button" className="btn-primary btn-compact" onClick={() => setPickerOpen((v) => !v)}>
          {t.accounts.connectAccount}
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
          <h2>{t.accounts.picker.title}</h2>
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
                    {p.experimental && <span className="tag tag-warn">{t.accounts.picker.experimental}</span>}
                  </div>
                  <p className={`setup-state setup-${s.tone}`}>{tf(t.accounts.picker.setup, { status: s.text })}</p>
                  {!p.requiresAppConfig && (
                    <p className="muted small">{t.accounts.picker.megaNote}</p>
                  )}
                  {/* The real connection action always lives here. If the
                      instance lacks the app configuration, Connect explains
                      in place instead of rerouting to Settings. */}
                  <button type="button" className="btn-primary btn-block" onClick={() => void connect(p)}>
                    {tf(t.accounts.picker.connect, { provider: p.displayName })}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {setupNeeded && (
        <Dialog
          title={tf(t.accounts.setupNeeded.title, { provider: setupNeeded.displayName })}
          description={tf(t.accounts.setupNeeded.desc, { provider: setupNeeded.displayName })}
          onClose={() => setSetupNeeded(null)}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setSetupNeeded(null)}>
                {t.accounts.setupNeeded.back}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  // remember WHICH provider the user was connecting so the
                  // setup section can open it and offer the way back
                  writeHandoff(PENDING_KEY, { provider: setupNeeded.id, displayName: setupNeeded.displayName });
                  setSetupNeeded(null);
                  onGoToSettings();
                }}
              >
                {t.accounts.setupNeeded.configure}
              </button>
            </>
          }
        >
          <p className="small muted">{t.accounts.setupNeeded.body}</p>
        </Dialog>
      )}

      {megaOpen && (
        <section className="card">
          <h2>{t.accounts.mega.title} <span className="tag tag-warn">{t.accounts.mega.experimental}</span></h2>
          <p className="muted">{t.accounts.mega.note}</p>
          <form onSubmit={submitMega} className="password-form">
            <label htmlFor="mega-email">{t.accounts.mega.email}</label>
            <input id="mega-email" type="email" value={megaEmail} onChange={(e) => setMegaEmail(e.target.value)} required />
            <label htmlFor="mega-password">{t.accounts.mega.password}</label>
            <input id="mega-password" type="password" value={megaPassword} onChange={(e) => setMegaPassword(e.target.value)} required />
            <button type="submit" className="btn-primary">{t.accounts.mega.submit}</button>
            <button type="button" className="btn-secondary" onClick={() => { setMegaOpen(false); setMegaPassword(''); }}>
              {t.dialog.cancel}
            </button>
          </form>
        </section>
      )}

      <section className="card">
        <div className="page-head">
          <h2>{t.accounts.list.title}</h2>
          {accounts.length > 0 && (
            <button type="button" className="btn-secondary" disabled={busyId === '__all__'} onClick={() => void refreshAll()}>
              {busyId === '__all__' ? t.accounts.list.refreshing : t.accounts.list.refreshAll}
            </button>
          )}
        </div>
        {loading ? (
          <p className="muted">{t.common.loading}</p>
        ) : accounts.length === 0 ? (
          <p className="muted">{t.common.noAccountsYet}</p>
        ) : (
          <table className="accounts-table">
            <thead>
              <tr>
                <th>{t.accounts.list.provider}</th>
                <th>{t.accounts.list.account}</th>
                <th>{t.accounts.list.status}</th>
                <th>{t.accounts.list.usedTotal}</th>
                <th>{t.accounts.list.quota}</th>
                <th>{t.accounts.list.actions}</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const s = accountStatus(a);
                return (
                  <tr key={a.id}>
                    <td>
                      <span className="file-name-cell">
                        <ProviderLogo provider={a.provider} size={20} />
                        {a.displayName}
                      </span>
                      {a.experimental && <span className="tag tag-warn">{t.accounts.picker.experimental}</span>}
                    </td>
                    <td className="ellipsis">{a.displayLabel}</td>
                    <td>
                      <span className={`state state-${s.tone}`}>{s.text}</span>
                      {a.lastErrorCode && <div className="muted small">{a.lastErrorCode}</div>}
                    </td>
                    <td>
                      {a.quota.usedBytes === null ? t.common.unknown : formatBytes(a.quota.usedBytes)} /{' '}
                      {a.quota.totalBytes === null ? t.common.unknown : formatBytes(a.quota.totalBytes)}
                      {a.quota.availableBytes !== null && (
                        <div className="muted small">{tf(t.accounts.list.available, { size: formatBytes(a.quota.availableBytes) })}</div>
                      )}
                    </td>
                    <td>
                      <span className={`state state-${a.quota.status === 'current' ? 'ok' : 'warn'}`}>
                        {(t.states.quota as Record<string, string | undefined>)[a.quota.status] ?? a.quota.status}
                      </span>
                      {a.quota.lastCheckedAt && (
                        <div className="muted small">{tf(t.accounts.list.checked, { when: formatDateTime(a.quota.lastCheckedAt) })}</div>
                      )}
                      {a.quota.lastErrorCode && <div className="muted small">{a.quota.lastErrorCode}</div>}
                    </td>
                    <td className="actions">
                      <button type="button" className="btn-secondary" disabled={busyId === a.id} onClick={() => void refreshOne(a.id)}>{t.accounts.list.refreshQuota}</button>
                      <button type="button" className="btn-secondary" disabled={busyId === a.id} onClick={() => void rename(a)}>{t.accounts.list.rename}</button>
                      <button type="button" className="btn-secondary" disabled={busyId === a.id} onClick={() => void reconnect(a)}>{t.accounts.list.reconnect}</button>
                      <button type="button" className="btn-danger" disabled={busyId === a.id} onClick={() => void disconnect(a)}>{t.accounts.list.disconnect}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="muted small">{t.accounts.list.footnote}</p>
      </section>
    </>
  );
}
