import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check } from 'lucide-react';
import { api, type ProviderInfo } from '../api.js';
import { ProviderLogo } from './ProviderLogo.js';

/**
 * Settings → Provider Setup: one-time app credentials per provider
 * (reference spec §12.2). The heading and card live in SettingsPage; this
 * renders the per-provider rows: identity mark + status pill, then the
 * Client ID → Client secret → Authorized Redirect URI (read-only, Copy URI)
 * → note → Save/Cancel form. The compact row keeps only identity, status and
 * the setup action — the raw URI is never squeezed in beside them.
 */
export function ProviderSetupCard({ onChanged }: { onChanged: () => void }) {
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
      setCopyError('Copy failed — select the URI text below and copy it manually.');
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
      setMessage(`${provider.displayName} configuration saved. It is not verified until a successful sign-in.`);
      onChanged();
      const refreshed = await api.providers();
      if (refreshed.status === 200) setProviders((refreshed.data as { providers: ProviderInfo[] }).providers);
      return;
    }
    const data = res.data as { error?: string; requiresConfirmation?: boolean };
    if (data.requiresConfirmation) setNeedsConfirm(true);
    setError(data.error ?? 'Could not save the configuration.');
  }

  return (
    <>
      <p className="muted">
        Configure CloudNest's own application credentials once per provider. This is separate from connecting
        your accounts — the Connect button cannot bypass each provider's app registration.
      </p>
      {message && <p className="form-ok" role="status">{message}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="setup-list">
        {providers.map((p) => (
          <div key={p.id} className="setup-row">
            <div className="setup-row-head">
              <ProviderLogo provider={p.id} size={22} />
              <strong>{p.displayName}</strong>
              <span className={`state state-${p.verificationStatus === 'verified' ? 'ok' : p.verificationStatus === 'needs_correction' ? 'bad' : 'warn'}`}>
                {!p.requiresAppConfig
                  ? 'Experimental (no app config)'
                  : p.verificationStatus === 'not_configured'
                    ? 'Not configured'
                    : p.verificationStatus === 'saved'
                      ? 'Saved — not yet verified'
                      : p.verificationStatus === 'verified'
                        ? 'Verified'
                        : 'Needs correction'}
              </span>
            </div>

            {!p.requiresAppConfig ? (
              <p className="muted">
                MEGA connects with an account email and password over the local connection. It is experimental
                and has no OAuth app setup.
              </p>
            ) : openId === p.id ? (
              <form onSubmit={(e) => void save(e, p)} className="password-form">
                <label htmlFor={`${p.id}-client-id`}>
                  {p.id === 'pcloud' ? 'Client ID' : 'Client ID'}
                </label>
                <input id={`${p.id}-client-id`} type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} required />
                <label htmlFor={`${p.id}-client-secret`}>Client secret</label>
                <input id={`${p.id}-client-secret`} type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} required />
                {p.id === 'onedrive' && (
                  <>
                    <label htmlFor="onedrive-authority">Authority (common / consumers / organizations / tenant ID)</label>
                    <input id="onedrive-authority" type="text" value={authority} onChange={(e) => setAuthority(e.target.value)} />
                  </>
                )}
                <label htmlFor={`${p.id}-redirect-uri`}>Authorized Redirect URI</label>
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
                    {copiedId === p.id ? <><Check size={14} aria-hidden="true" /> Copied</> : 'Copy URI'}
                  </button>
                </div>
                {copyError && <p className="form-error" role="alert">{copyError}</p>}
                {p.id === 'google_drive' && (
                  <p className="muted small">
                    Google note: an External app in “Testing” status can receive Drive-scope refresh tokens that
                    expire after 7 days, and access may be limited to configured test users. CloudNest cannot
                    detect your project's publishing status automatically — review your Google Cloud consent
                    screen settings before relying on unattended access.
                  </p>
                )}
                {needsConfirm && (
                  <p className="form-error">
                    Accounts are already connected. Saving new app credentials may require those accounts to
                    reconnect. Confirm to replace them.
                  </p>
                )}
                <div className="actions">
                  <button type="submit" className="btn-primary">
                    {needsConfirm ? 'Replace configuration anyway' : 'Save configuration'}
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => { setOpenId(null); setNeedsConfirm(false); setClientSecret(''); }}>
                    Cancel
                  </button>
                </div>
                <p className="muted small">
                  The saved secret is never shown again. Replacing credentials is a write-only operation.
                </p>
              </form>
            ) : (
              <div className="actions">
                <button type="button" className="btn-secondary" onClick={() => { setOpenId(p.id); setClientId(''); setClientSecret(''); setNeedsConfirm(false); setError(null); setMessage(null); setCopyError(null); }}>
                  {p.verificationStatus === 'not_configured' ? 'Set up' : 'Replace credentials'}
                </button>
                {/* Compact row stays lean: identity + status + action only.
                    The full URI lives in the expanded panel above. */}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
