import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check } from 'lucide-react';
import { api, type ProviderInfo } from '../api.js';
import { ProviderLogo } from './ProviderLogo.js';
import { useI18n } from '../i18n-context.js';
import { useUiMode } from '../ui-mode-context.js';
import { providerTier } from '../ui-mode.js';

/**
 * Settings → Provider Setup: one-time app credentials per provider
 * (reference spec §12.2). The heading and card live in SettingsPage; this
 * renders the per-provider rows: identity mark + status pill, then the
 * Client ID → Client secret → Authorized Redirect URI (read-only, Copy URI)
 * → note → Save/Cancel form. The compact row keeps only identity, status and
 * the setup action — the raw URI is never squeezed in beside them. All copy
 * resolves through the app-wide i18n context.
 */
export function ProviderSetupCard({ onChanged, onGoToCloudAccounts }: { onChanged: () => void; onGoToCloudAccounts?: () => void }) {
  const { t, tf } = useI18n();
  const { uiMode } = useUiMode();
  const ps = t.settings.providerSetup;
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [authority, setAuthority] = useState('common');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  // Per-provider Copy URI feedback: brief "Copied" confirmation or a manual
  // fallback note — the URI itself is never truncated for copying.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);
  // Arriving from Cloud Accounts' “Configure Provider”: which provider the
  // user was connecting, so this dedicated section opens THAT form and can
  // offer the deliberate way back and (after saving) the continue action.
  const [context, setContext] = useState<{ provider: string; displayName: string } | null>(() => {
    try {
      const raw = sessionStorage.getItem('cloudnest.pendingConnect');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { provider?: string; displayName?: string };
      return parsed.provider ? { provider: parsed.provider, displayName: parsed.displayName ?? parsed.provider } : null;
    } catch {
      return null;
    }
  });
  const [savedProvider, setSavedProvider] = useState<string | null>(null);
  const autoOpened = useRef(false);

  // Open the arriving provider's form exactly once (a later Cancel must stay cancelled).
  useEffect(() => {
    if (!context || autoOpened.current) return;
    autoOpened.current = true;
    setOpenId(context.provider);
  }, [context]);

  function clearContext(): void {
    try { sessionStorage.removeItem('cloudnest.pendingConnect'); } catch { /* private mode */ }
    setContext(null);
  }

  /** Only a deliberate click here resumes the connection for that provider. */
  function continueConnecting(): void {
    if (!context) return;
    try { sessionStorage.setItem('cloudnest.connectContinue', JSON.stringify({ provider: context.provider })); } catch { /* private mode */ }
    clearContext();
    onGoToCloudAccounts?.();
  }

  useEffect(() => {
    void (async () => {
      const res = await api.providers();
      if (res.status === 200) setProviders((res.data as { providers: ProviderInfo[] }).providers);
    })();
  }, []);

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  async function copyUri(p: ProviderInfo) {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(p.callbackUri ?? '');
      setCopiedId(p.id);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedId(null), 2500);
    } catch {
      setCopyError(ps.copyFailed);
    }
  }

  async function save(e: FormEvent, provider: ProviderInfo, confirmReplace = false) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    const res = await api.saveProviderConfig(provider.id, {
      clientId,
      clientSecret,
      ...(provider.id === 'onedrive' ? { authority } : {}),
      ...(confirmReplace ? { confirmReplace: true } : {}),
    } as { clientId: string; clientSecret: string; authority?: string });
    if (res.status === 200) {
      setClientSecret('');
      setNeedsConfirm(false);
      setSavedProvider(provider.id);
      setMessage(tf(ps.savedMessage, { provider: provider.displayName }));
      onChanged();
      const refreshed = await api.providers();
      if (refreshed.status === 200) setProviders((refreshed.data as { providers: ProviderInfo[] }).providers);
      return;
    }
    const data = res.data as { error?: string; requiresConfirmation?: boolean };
    if (data.requiresConfirmation) setNeedsConfirm(true);
    setError(data.error ?? ps.saveFailed);
  }

  const statusPill = (p: ProviderInfo): { text: string; tone: 'ok' | 'bad' | 'warn' | 'muted' } => {
    if (!p.requiresAppConfig) return { text: ps.noAppSetupNeeded, tone: 'muted' };
    if (p.verificationStatus === 'not_configured') return { text: ps.notConfigured, tone: 'warn' };
    if (p.verificationStatus === 'saved') return { text: ps.savedNotVerified, tone: 'warn' };
    if (p.verificationStatus === 'verified') return { text: ps.verified, tone: 'ok' };
    return { text: ps.needsCorrection, tone: 'bad' };
  };

  return (
    <>
      <p className="muted">{ps.intro}</p>

      {context && (
        <div className="setup-context">
          <p className="small" style={{ margin: 0 }}>
            {tf(ps.context, { provider: context.displayName })}
          </p>
          <div className="actions">
            {savedProvider === context.provider && (
              <button type="button" className="btn-primary" onClick={continueConnecting}>
                {tf(ps.continueConnecting, { provider: context.displayName })}
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={() => { clearContext(); onGoToCloudAccounts?.(); }}>
              {ps.backToCloudAccounts}
            </button>
          </div>
        </div>
      )}

      {message && <p className="form-ok" role="status">{message}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="setup-list">
        {providers.filter((p) => providerTier(p.id) === uiMode).map((p) => {
          const pill = statusPill(p);
          return (
            <div key={p.id} className="setup-row">
              <div className="setup-row-head">
                <ProviderLogo provider={p.id} size={22} />
                <strong>{p.displayName}</strong>
                <span className={`state state-${pill.tone}`}>{pill.text}</span>
              </div>

              {!p.requiresAppConfig ? (
                <p className="muted">{p.id === 's3' ? ps.s3Note : ps.megaNote}</p>
              ) : openId === p.id ? (
                <form onSubmit={(e) => void save(e, p)} className="password-form">
                  <label htmlFor={`${p.id}-client-id`}>{ps.clientId}</label>
                  <input id={`${p.id}-client-id`} type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} required />
                  <label htmlFor={`${p.id}-client-secret`}>{ps.clientSecret}</label>
                  <input id={`${p.id}-client-secret`} type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} required />
                  {p.id === 'onedrive' && (
                    <>
                      <label htmlFor="onedrive-authority">{ps.authority}</label>
                      <input id="onedrive-authority" type="text" value={authority} onChange={(e) => setAuthority(e.target.value)} />
                    </>
                  )}
                  <label htmlFor={`${p.id}-redirect-uri`}>{ps.redirectUri}</label>
                  <div className="uri-row">
                    {/* Read-only, fully wrapped, select-all-on-focus: the exact
                        URI the backend uses, never truncated for copying. */}
                    <textarea
                      id={`${p.id}-redirect-uri`}
                      className="uri-field"
                      readOnly
                      rows={2}
                      value={p.callbackUri ?? ''}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <button type="button" className="btn-secondary" onClick={() => void copyUri(p)}>
                      {copiedId === p.id ? <><Check size={14} aria-hidden="true" /> {t.common.copied}</> : ps.copyUri}
                    </button>
                  </div>
                  {copyError && <p className="form-error" role="alert">{copyError}</p>}
                  {p.id === 'google_drive' && (
                    <p className="muted small">{ps.googleNote}</p>
                  )}
                  {needsConfirm && (
                    <p className="form-error">{ps.confirmReplace}</p>
                  )}
                  <div className="actions">
                    <button type="submit" className="btn-primary">
                      {needsConfirm ? ps.replaceAnyway : ps.save}
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => { setOpenId(null); setNeedsConfirm(false); setClientSecret(''); }}>
                      {t.dialog.cancel}
                    </button>
                  </div>
                  <p className="muted small">{ps.secretNote}</p>
                </form>
              ) : (
                <div className="actions">
                  <button type="button" className="btn-secondary" onClick={() => { setOpenId(p.id); setClientId(''); setClientSecret(''); setNeedsConfirm(false); setError(null); setMessage(null); setCopyError(null); }}>
                    {p.verificationStatus === 'not_configured' ? ps.setupAction : ps.replaceAction}
                  </button>
                  {/* Compact row stays lean: identity + status + action only.
                      The full URI lives in the expanded panel above. */}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
