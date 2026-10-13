import { useEffect, useState, type FormEvent } from 'react';
import { api, type ProviderInfo } from '../api.js';

/** Settings → Provider Setup: one-time app credentials per provider. */
export function ProviderSetupCard({ onChanged }: { onChanged: () => void }) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [authority, setAuthority] = useState('common');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await api.providers();
      if (res.status === 200) setProviders((res.data as { providers: ProviderInfo[] }).providers);
    })();
  }, []);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage('Callback URI copied.');
    } catch {
      setMessage('Copy failed; select the URI text and copy it manually.');
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
    <section className="card">
      <h2>Provider Setup</h2>
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
                <label>Exact callback URI to register in the provider console</label>
                <div className="copy-row">
                  <code className="callback-uri">{p.callbackUri}</code>
                  <button type="button" className="btn-secondary" onClick={() => p.callbackUri && void copy(p.callbackUri)}>Copy</button>
                </div>
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
                <button type="button" className="btn-secondary" onClick={() => { setOpenId(p.id); setClientId(''); setClientSecret(''); setNeedsConfirm(false); setError(null); setMessage(null); }}>
                  {p.verificationStatus === 'not_configured' ? 'Set up' : 'Replace credentials'}
                </button>
                {p.callbackUri && (
                  <span className="muted small">Callback: <code>{p.callbackUri}</code></span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
