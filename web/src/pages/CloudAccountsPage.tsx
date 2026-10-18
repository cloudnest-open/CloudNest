import { useCallback, useEffect, useState } from 'react';
import { api, type ProviderInfo, type AccountInfo } from '../api.js';
import { confirmDestructive } from '../confirm.js';
import { Dialog, RowMenu, RowMenuItem, formatBytes, formatDateTime } from '../components/ui.js';
import { ProviderLogo } from '../components/ProviderLogo.js';
import { ProviderSetupCard } from '../components/ProviderSetupCard.js';
import { useI18n } from '../i18n-context.js';
import { useUiMode } from '../ui-mode-context.js';
import { providerTier } from '../ui-mode.js';

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
  // wizard §2: MEGA's one-time TOTP code (never durable — re-login asks again)
  const [mega2fa, setMega2fa] = useState('');
  const [mega2faRevealed, setMega2faRevealed] = useState(false);
  // Roadmap Phase 1: two tiers, one engine — the list is filtered by the
  // selected tier tab, and S3-compatible buckets connect through the form below.
  // UI mode (personal vs business) decides which tier tab exists at all; the
  // tab follows the mode whenever the sidebar switch changes it.
  const { uiMode } = useUiMode();
  const [tierTab, setTierTab] = useState<'personal' | 'business'>(uiMode ?? 'personal');
  useEffect(() => {
    if (uiMode) setTierTab(uiMode);
  }, [uiMode]);
  const [s3Open, setS3Open] = useState(false);
  const [s3Endpoint, setS3Endpoint] = useState('');
  const [s3Region, setS3Region] = useState('');
  const [s3AccessKey, setS3AccessKey] = useState('');
  const [s3Secret, setS3Secret] = useState('');
  const [s3Bucket, setS3Bucket] = useState('');
  const [s3Prefix, setS3Prefix] = useState('');
  const [s3Cap, setS3Cap] = useState('');
  // wizard §3: the owner's name for this S3-compatible provider (Wasabi, …)
  const [s3ProviderName, setS3ProviderName] = useState('');
  // The connect picker stays open across navigation so a user who followed the
  // explicit "Configure Provider" jump into Settings returns to their context.
  const [pickerOpen, setPickerOpen] = useState(() => {
    try { return sessionStorage.getItem('cloudnest.connectPickerOpen') === '1'; } catch { return false; }
  });
  // Set when an OAuth start fails because this instance lacks the provider's
  // application configuration; rendered as the explanatory dialog below.
  // Set when the user returned from Provider Setup having deliberately chosen
  // "Continue connecting {provider}": we then resume that provider's connect.
  const [continueProvider, setContinueProvider] = useState<string | null>(null);
  // §6.2 shared-quota pool editor: the account whose provider pool is being
  // grouped, plus the currently selected member set (always includes it).
  const [scopeTarget, setScopeTarget] = useState<AccountInfo | null>(null);
  const [scopeSelection, setScopeSelection] = useState<string[]>([]);
  // wizard §1 (one-time credential step): an OAuth Connect that found the
  // instance's app credentials missing opens the setup form INLINE — no
  // bouncing to Settings; once saved the config exists for life.
  const [wizardSetup, setWizardSetup] = useState<ProviderInfo | null>(null);
  // wizard §4 (one surface): per-account Edit-Replace-credentials dialog.
  const [editTarget, setEditTarget] = useState<AccountInfo | null>(null);
  const [editEndpoint, setEditEndpoint] = useState('');
  const [editRegion, setEditRegion] = useState('');
  const [editAccessKey, setEditAccessKey] = useState('');
  const [editSecret, setEditSecret] = useState('');
  const [editBucket, setEditBucket] = useState('');
  const [editPrefix, setEditPrefix] = useState('');
  const [editCap, setEditCap] = useState('');
  const [editProviderName, setEditProviderName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [edit2fa, setEdit2fa] = useState('');
  // session-26 F2: Rename is a branded dialog — the native window.prompt was
  // invisible in embedded browsers and off-tone with every other surface.
  const [renameTarget, setRenameTarget] = useState<AccountInfo | null>(null);
  const [renameLabel, setRenameLabel] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  // session-26 F9: OAuth runs in a NEW tab (the tunnel wizard's pattern) — the
  // app stays here, keeps its state, and polls for the outcome instead of
  // navigating itself away and losing everything on-screen.
  const [oauthWait, setOauthWait] = useState<{
    providerId: string;
    providerName: string;
    accountId: string | null;
    baseline: number;
    deadline: number;
  } | null>(null);

  // On arrival, honour a pending "continue connecting" hand-off from Settings.
  useEffect(() => {
    const pending = readHandoff(CONTINUE_KEY);
    if (!pending?.provider) return;
    writeHandoff(CONTINUE_KEY, null);
    setPickerOpen(true);
    setContinueProvider(pending.provider);
  }, []);

  // wizard §1: the OAuth callback redirects back with ?connect=<result>.
  // Surface the honest result once, then clean the URL — a silent return told
  // the user nothing (and never explained an already_connected refusal).
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('connect');
    if (!result) return;
    window.history.replaceState(null, '', window.location.pathname);
    setPickerOpen(true);
    if (result === 'connected') setNotice(t.accounts.result.connected);
    else if (result === 'already_connected') setNotice(t.accounts.result.alreadyConnected);
    else if (result === 'oauth_denied') setNotice(t.accounts.result.denied);
    else if (result === 'refresh_token_missing') setNotice(t.accounts.result.refreshMissing);
    else setError(tf(t.accounts.result.failed, { code: result }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on arrival
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

  // session-26 F9: poll the account list while the provider tab is open. A
  // first-ever connect succeeds when this provider gains an account; a
  // reconnect succeeds when its account returns to 'connected'. Five honest
  // minutes, then the notice says exactly that — the user can also stop
  // waiting explicitly.
  useEffect(() => {
    if (!oauthWait) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        if (Date.now() > oauthWait.deadline) {
          setOauthWait(null);
          setError(tf(t.accounts.oauthWait.timeout, { provider: oauthWait.providerName }));
          return;
        }
        try {
          const res = await api.accounts();
          if (cancelled || res.status !== 200) return;
          const rows = (res.data as { accounts?: AccountInfo[] }).accounts ?? [];
          setAccounts(rows);
          if (oauthWait.accountId) {
            const target = rows.find((r) => r.id === oauthWait.accountId);
            if (target?.status === 'connected') {
              setOauthWait(null);
              setNotice(tf(t.accounts.oauthWait.completed, { provider: oauthWait.providerName }));
            }
            return;
          }
          const count = rows.filter((r) => r.provider === oauthWait.providerId).length;
          if (count > oauthWait.baseline) {
            setOauthWait(null);
            setNotice(tf(t.accounts.oauthWait.completed, { provider: oauthWait.providerName }));
          }
        } catch {
          // the next tick retries; the provider tab stays open
        }
      })();
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the wait object fully identifies the poll
  }, [oauthWait]);

  const reload = useCallback(async () => {
    // FE-04: without this the page showed "Loading…" forever on a network error
    try {
      const [p, a] = await Promise.all([api.providers(), api.accounts()]);
      if (p.status === 200) setProviders((p.data as { providers: ProviderInfo[] }).providers);
      if (a.status === 200) setAccounts((a.data as { accounts: AccountInfo[] }).accounts);
      if (p.status !== 200 || a.status !== 200) {
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
    if (p.id === 's3') {
      // Business tier: S3-compatible buckets connect through the keys form.
      setS3Open(true);
      return;
    }
    // session-26 F9: open the provider's consent page in a NEW tab — opened
    // synchronously inside the click so popup blockers allow it, then pointed
    // at the real authorization URL once the server answers. This page never
    // navigates away; it polls and reports the outcome.
    const authWindow = window.open('', '_blank');
    if (!authWindow) {
      setError(t.accounts.popupBlocked);
      return;
    }
    authWindow.opener = null;
    const res = await api.oauthStart(p.id);
    if (res.status === 200) {
      const url = (res.data as { authorizationUrl: string }).authorizationUrl;
      // the setup round-trip is complete; no stale hand-off should linger
      writeHandoff(PENDING_KEY, null);
      authWindow.location.replace(url);
      setOauthWait({
        providerId: p.id,
        providerName: p.displayName,
        accountId: null,
        baseline: accounts.filter((a) => a.provider === p.id).length,
        deadline: Date.now() + 5 * 60_000,
      });
      return;
    }
    // the tab is useless without an authorization URL — close it and handle
    // the failure honestly right here
    authWindow.close();
    const data = res.data as { error?: string; code?: string };
    if (data.code === 'provider_not_configured') {
      // wizard §1 (rclone-style): the FIRST-EVER connect opens the one-time
      // credential step right here — exact Redirect URI with a copy button,
      // console links, the known pitfalls. Once saved, it exists for life and
      // this step never shows again; Connect stays one click.
      setWizardSetup(p);
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

  function openRename(account: AccountInfo) {
    setRenameError(null);
    setRenameLabel(account.displayLabel);
    setRenameTarget(account);
  }

  async function saveRename() {
    const target = renameTarget;
    if (!target) return;
    const label = renameLabel.trim();
    // F1-sibling honesty: an empty submit explains itself instead of vanishing.
    if (label === '') { setRenameError(t.accounts.list.renameDialog.required); return; }
    if (label === target.displayLabel) { setRenameTarget(null); return; }
    await withBusy(target.id, async () => {
      await api.updateAccount(target.id, { displayLabel: label });
      setRenameTarget(null);
      await reload();
    });
  }

  // M0016: in/out of the upload pool. Out stops NEW placements only — existing
  // chunks stay readable, so this is safe to flip freely.
  async function toggleParticipation(account: AccountInfo) {
    await withBusy(account.id, async () => {
      await api.updateAccount(account.id, { participatesInUploads: !account.participatesInUploads });
      await reload();
    });
  }

  async function reconnect(account: AccountInfo) {
    await withBusy(account.id, async () => {
      // wizard §4: Reconnect = silent token refresh first (the scheduler's own
      // path); a provider that has revoked the grant honestly fails, and the
      // browser re-auth flow takes over — never a dead button.
      const refresh = await api.reconnect(account.id, { mode: 'refresh' });
      const rData = refresh.data as { mode?: string; result?: { ok: boolean; code?: string } };
      if (rData.mode === 'refreshed') {
        if (rData.result?.ok) {
          setNotice(tf(t.accounts.reconnect.refreshed, { label: account.displayLabel }));
          await reload();
          return;
        }
        // fall through to the browser flow below
      }
      const res = await api.reconnect(account.id);
      const data = res.data as { mode?: string; authorizationUrl?: string; message?: string };
      if (data.mode === 'oauth' && data.authorizationUrl) {
        // session-26 F9: the browser re-auth also opens in a new tab; this
        // page polls until the account reports 'connected' again.
        const authWindow = window.open('', '_blank');
        if (!authWindow) {
          setError(t.accounts.popupBlocked);
          return;
        }
        authWindow.opener = null;
        authWindow.location.replace(data.authorizationUrl);
        setOauthWait({
          providerId: account.provider,
          providerName: providers.find((x) => x.id === account.provider)?.displayName ?? account.provider,
          accountId: account.id,
          baseline: 0,
          deadline: Date.now() + 5 * 60_000,
        });
        return;
      }
      if (data.mode === 'credentials') {
        openEditDialog(account);
        setNotice(data.message ?? t.accounts.mega.reauthNotice);
        return;
      }
      setError((res.data as { error?: string }).error ?? t.accounts.reconnect.failed);
    });
  }

  /** wizard §4: Test/Verify — the provider's own cheapest identity call. */
  async function verify(account: AccountInfo) {
    await withBusy(account.id, async () => {
      const res = await api.verifyAccount(account.id);
      const data = res.data as { ok?: boolean; quotaStatus?: string; code?: string };
      if (res.status === 200 && data.ok) {
        setNotice(tf(t.accounts.verify.ok, { label: account.displayLabel }));
      } else if (data.code === 'two_factor_required') {
        setError(t.accounts.verify.twoFactor);
      } else {
        setError(tf(t.accounts.verify.failed, { code: data.code ?? 'unknown' }));
      }
      await reload();
    });
  }

  /** wizard §4: OAuth accounts edit their APP config (browser-granted tokens
   * are never hand-typed); S3/MEGA get the credential dialog instead. */
  function openWizardSetup(account: AccountInfo) {
    const p = providers.find((x) => x.id === account.provider);
    if (p) setWizardSetup(p);
  }

  function openEditDialog(account: AccountInfo) {
    setEditTarget(account);
    setEditSecret('');
    setEditPassword('');
    setEdit2fa('');
    setEditEndpoint(account.provider === 's3' ? '' : '');
    setEditRegion('');
    setEditAccessKey('');
    setEditBucket('');
    setEditPrefix('');
    setEditCap(account.capacityCapBytes !== null && account.capacityCapBytes !== undefined ? String(account.capacityCapBytes) : '');
    setEditProviderName(account.providerDisplayName ?? '');
    setEditEmail('');
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editTarget) return;
    setError(null);
    const account = editTarget;
    await withBusy(account.id, async () => {
      const body: Record<string, unknown> = account.provider === 's3'
        ? {
            endpoint: editEndpoint.trim(),
            region: editRegion.trim() || 'auto',
            accessKeyId: editAccessKey.trim(),
            secretAccessKey: editSecret,
            bucket: editBucket.trim(),
            prefix: editPrefix.trim() || 'cloudnest',
          }
        : {
            email: editEmail.trim(),
            password: editPassword,
            ...(edit2fa.trim() ? { secondFactorCode: edit2fa.trim() } : {}),
          };
      const res = await api.editAccountCredentials(account.id, body);
      const data = (res.data ?? {}) as { error?: string; code?: string };
      if (res.status === 200) {
        setEditTarget(null);
        setNotice(tf(t.accounts.edit.saved, { label: account.displayLabel }));
        await reload();
        return;
      }
      setError(data.code === 'invalid_credentials' ? t.accounts.edit.badCredentials : data.error ?? t.accounts.edit.failed);
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

  /** §6.2: open the shared-pool editor preselected with the account's current group. */
  function openScopeEditor(account: AccountInfo) {
    const sameProvider = accounts.filter((a) => a.provider === account.provider && a.status === 'connected');
    const currentKey = account.quotaScopeKey;
    const preselected = currentKey
      ? sameProvider.filter((a) => a.quotaScopeKey === currentKey).map((a) => a.id)
      : [account.id];
    setScopeTarget(account);
    setScopeSelection(preselected);
  }

  function toggleScopeMember(id: string) {
    setScopeSelection((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function saveScope(clear: boolean) {
    if (!scopeTarget) return;
    const provider = scopeTarget.provider;
    const ids = clear ? null : [...new Set([scopeTarget.id, ...scopeSelection])];
    await withBusy('__scope__', async () => {
      const res = await api.setQuotaScope(provider, ids);
      if (res.status !== 200) {
        const data = (res.data ?? {}) as { error?: string };
        setError(data.error ?? t.accounts.sharedPool.title);
        return;
      }
      setScopeTarget(null);
      await reload();
    });
  }

  async function submitMega(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // session-26 F16: branded inline validation — the browser's native
    // "Please fill out this field." bubble was off-tone with every other
    // surface in the app.
    if (megaEmail.trim() === '' || megaPassword === '') {
      setError(t.accounts.mega.missingFields);
      return;
    }
    const res = await api.megaConnect(megaEmail, megaPassword, mega2fa.trim() || undefined);
    setMegaPassword('');
    if (res.status === 201) {
      setMegaOpen(false);
      setMegaEmail('');
      setMega2fa('');
      setMega2faRevealed(false);
      setNotice(t.accounts.mega.connected);
      await reload();
    } else {
      const data = res.data as { error?: string; code?: string };
      if (data.code === 'two_factor_required') {
        // wizard §2: reveal the TOTP field with the honest one-time note
        setMega2faRevealed(true);
        setError(t.accounts.mega.twoFactorRequired);
        return;
      }
      setError(data.code === 'invalid_credentials' ? t.accounts.mega.badCredentials : data.error ?? t.accounts.mega.failed);
    }
  }

  async function submitS3(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // session-26 F16: same branded validation as the MEGA form.
    if (s3Endpoint.trim() === '' || s3AccessKey.trim() === '' || s3Secret === '' || s3Bucket.trim() === '') {
      setError(t.accounts.s3.missingFields);
      return;
    }
    const capBytes = s3Cap.trim() ? Number(s3Cap.trim()) : null;
    const res = await api.connectS3({
      endpoint: s3Endpoint.trim(),
      region: s3Region.trim() || 'auto',
      accessKeyId: s3AccessKey.trim(),
      secretAccessKey: s3Secret,
      bucket: s3Bucket.trim(),
      prefix: s3Prefix.trim() || 'cloudnest',
      capacityCapBytes: capBytes !== null && Number.isInteger(capBytes) && capBytes > 0 ? capBytes : null,
      providerName: s3ProviderName.trim() || null,
    });
    setS3Secret('');
    if (res.status === 201) {
      setS3Open(false);
      setS3Endpoint(''); setS3Region(''); setS3AccessKey(''); setS3Bucket(''); setS3Prefix(''); setS3Cap(''); setS3ProviderName('');
      setTierTab('business');
      setNotice(t.accounts.s3.connected);
      await reload();
    } else {
      const data = res.data as { error?: string; code?: string };
      setError(data.code === 'invalid_credentials' ? t.accounts.s3.failed : data.error ?? t.accounts.s3.failed);
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

      {oauthWait && (
        <div className="card notice-card" role="status">
          <p>{tf(t.accounts.oauthWait.waiting, { provider: oauthWait.providerName })}</p>
          <button type="button" className="btn-secondary" onClick={() => setOauthWait(null)}>
            {t.accounts.oauthWait.cancel}
          </button>
        </div>
      )}

      {pickerOpen && (
        <section className="card">
          <h2>{t.accounts.picker.title}</h2>
          <div className="provider-grid">
            {providers.filter((p) => providerTier(p.id) === uiMode).map((p) => {
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
                    <p className="muted small">{p.id === 's3' ? t.accounts.picker.s3Note : t.accounts.picker.megaNote}</p>
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

      {wizardSetup && (
        <Dialog
          title={tf(t.accounts.setupNeeded.title, { provider: wizardSetup.displayName })}
          description={tf(t.accounts.setupNeeded.desc, { provider: wizardSetup.displayName })}
          onClose={() => setWizardSetup(null)}
          footer={
            <>
              <button type="button" className="btn-secondary" onClick={() => setWizardSetup(null)}>
                {t.accounts.setupNeeded.back}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  const p = wizardSetup;
                  setWizardSetup(null);
                  void connect(p);
                }}
              >
                {tf(t.accounts.wizard.continueConnect, { provider: wizardSetup.displayName })}
              </button>
            </>
          }
        >
          <p className="small muted">{t.accounts.setupNeeded.body}</p>
          {/* wizard §1: the one-time credential form lives HERE — exact
              Redirect URI (copy button), provider-console links, the known
              Google/Dropbox pitfalls. Saved once, it exists for life. */}
          <ProviderSetupCard onChanged={() => void reload()} />
        </Dialog>
      )}

      {editTarget && (
        <Dialog
          title={tf(t.accounts.edit.title, { label: editTarget.displayLabel })}
          onClose={() => setEditTarget(null)}
        >
          {editTarget.provider === 's3' || editTarget.provider === 'mega' ? (
            <form onSubmit={submitEdit} className="password-form">
              {editTarget.provider === 's3' ? (
                <>
                  <label htmlFor="edit-endpoint">{t.accounts.s3.endpoint}</label>
                  <input id="edit-endpoint" type="url" placeholder="https://acc123.r2.cloudflarestorage.com" value={editEndpoint} onChange={(e) => setEditEndpoint(e.target.value)} required />
                  <label htmlFor="edit-region">{t.accounts.s3.region}</label>
                  <input id="edit-region" type="text" placeholder="auto" value={editRegion} onChange={(e) => setEditRegion(e.target.value)} />
                  <label htmlFor="edit-access">{t.accounts.s3.accessKey}</label>
                  <input id="edit-access" type="text" value={editAccessKey} onChange={(e) => setEditAccessKey(e.target.value)} required autoComplete="off" />
                  <label htmlFor="edit-secret">{t.accounts.s3.secretKey}</label>
                  <input id="edit-secret" type="password" value={editSecret} onChange={(e) => setEditSecret(e.target.value)} required autoComplete="new-password" />
                  <label htmlFor="edit-bucket">{t.accounts.s3.bucket}</label>
                  <input id="edit-bucket" type="text" value={editBucket} onChange={(e) => setEditBucket(e.target.value)} required />
                  <label htmlFor="edit-prefix">{t.accounts.s3.prefix}</label>
                  <input id="edit-prefix" type="text" placeholder="cloudnest" value={editPrefix} onChange={(e) => setEditPrefix(e.target.value)} />
                  <label htmlFor="edit-name">{t.accounts.s3.providerName}</label>
                  <input id="edit-name" type="text" placeholder={t.accounts.s3.providerNamePlaceholder} value={editProviderName} onChange={(e) => setEditProviderName(e.target.value)} />
                </>
              ) : (
                <>
                  <label htmlFor="edit-email">{t.accounts.mega.email}</label>
                  <input id="edit-email" type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} required />
                  <label htmlFor="edit-password">{t.accounts.mega.password}</label>
                  <input id="edit-password" type="password" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} required autoComplete="new-password" />
                  <label htmlFor="edit-2fa">{t.accounts.mega.twoFactor}</label>
                  <input id="edit-2fa" type="text" inputMode="numeric" value={edit2fa} onChange={(e) => setEdit2fa(e.target.value)} />
                  <p className="muted small">{t.accounts.mega.twoFactorNote}</p>
                </>
              )}
              <button type="submit" className="btn-primary">{t.accounts.edit.submit}</button>
              <button type="button" className="btn-secondary" onClick={() => setEditTarget(null)}>{t.dialog.cancel}</button>
            </form>
          ) : (
            <p className="muted">{t.accounts.edit.oauthNote}</p>
          )}
        </Dialog>
      )}

      {megaOpen && (
        <section className="card">
          <h2>{t.accounts.mega.title} <span className="tag tag-warn">{t.accounts.mega.experimental}</span></h2>
          <p className="muted">{t.accounts.mega.note}</p>
          <form onSubmit={submitMega} noValidate className="password-form">
            <label htmlFor="mega-email">{t.accounts.mega.email}</label>
            <input id="mega-email" type="email" value={megaEmail} onChange={(e) => setMegaEmail(e.target.value)} required />
            <label htmlFor="mega-password">{t.accounts.mega.password}</label>
            <input id="mega-password" type="password" value={megaPassword} onChange={(e) => setMegaPassword(e.target.value)} required />
            {/* wizard §2: the optional TOTP field stays visible — a 2FA account
                can never connect without it, and hiding it would fail silently */}
            <label htmlFor="mega-2fa">{t.accounts.mega.twoFactor}</label>
            <input id="mega-2fa" type="text" inputMode="numeric" value={mega2fa} onChange={(e) => setMega2fa(e.target.value)} autoComplete="one-time-code" />
            <p className="muted small">{mega2faRevealed ? t.accounts.mega.twoFactorRequired : t.accounts.mega.twoFactorNote}</p>
            <button type="submit" className="btn-primary">{t.accounts.mega.submit}</button>
            <button type="button" className="btn-secondary" onClick={() => { setMegaOpen(false); setMegaPassword(''); }}>
              {t.dialog.cancel}
            </button>
          </form>
        </section>
      )}

      {s3Open && (
        <section className="card">
          <h2>{t.accounts.s3.title}</h2>
          <p className="muted">{t.accounts.s3.note}</p>
          <form onSubmit={submitS3} noValidate className="password-form">
            <label htmlFor="s3-endpoint">{t.accounts.s3.endpoint}</label>
            <input id="s3-endpoint" type="url" placeholder="https://acc123.r2.cloudflarestorage.com" value={s3Endpoint} onChange={(e) => setS3Endpoint(e.target.value)} required />
            <label htmlFor="s3-region">{t.accounts.s3.region}</label>
            <input id="s3-region" type="text" placeholder="auto" value={s3Region} onChange={(e) => setS3Region(e.target.value)} />
            <label htmlFor="s3-access-key">{t.accounts.s3.accessKey}</label>
            <input id="s3-access-key" type="text" value={s3AccessKey} onChange={(e) => setS3AccessKey(e.target.value)} required autoComplete="off" />
            <label htmlFor="s3-secret">{t.accounts.s3.secretKey}</label>
            <input id="s3-secret" type="password" value={s3Secret} onChange={(e) => setS3Secret(e.target.value)} required autoComplete="new-password" />
            <label htmlFor="s3-bucket">{t.accounts.s3.bucket}</label>
            <input id="s3-bucket" type="text" value={s3Bucket} onChange={(e) => setS3Bucket(e.target.value)} required />
            <label htmlFor="s3-prefix">{t.accounts.s3.prefix}</label>
            <input id="s3-prefix" type="text" placeholder="cloudnest" value={s3Prefix} onChange={(e) => setS3Prefix(e.target.value)} />
            <label htmlFor="s3-provider-name">{t.accounts.s3.providerName}</label>
            <input id="s3-provider-name" type="text" placeholder={t.accounts.s3.providerNamePlaceholder} value={s3ProviderName} onChange={(e) => setS3ProviderName(e.target.value)} />
            <p className="muted small">{t.accounts.s3.providerNameHint}</p>
            <label htmlFor="s3-cap">{t.accounts.s3.cap}</label>
            <input id="s3-cap" type="number" min="1" step="1" inputMode="numeric" value={s3Cap} onChange={(e) => setS3Cap(e.target.value)} />
            <p className="muted small">{t.accounts.s3.capHint}</p>
            <p className="muted small">{t.accounts.s3.testNote}</p>
            <button type="submit" className="btn-primary">{t.accounts.s3.submit}</button>
            <button type="button" className="btn-secondary" onClick={() => { setS3Open(false); setS3Secret(''); }}>
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
        <div className="tabs account-tier-tabs" role="tablist" aria-label={t.accounts.tabs.aria}>
          {(['personal', 'business'] as const)
            .filter((tier) => tier === uiMode)
            .map((tier) => (
            <button
              key={tier}
              type="button"
              role="tab"
              aria-selected={tierTab === tier}
              // session-26 F11: the count badge glued to the label made screen
              // readers say "Personal2" — the accessible name carries the count.
              aria-label={tf(t.accounts.tabs.countAria, {
                label: tier === 'personal' ? t.accounts.tabs.personal : t.accounts.tabs.business,
                count: accounts.filter((a) => (a.tier ?? 'personal') === tier).length,
              })}
              className={`tab${tierTab === tier ? ' active' : ''}`}
              onClick={() => setTierTab(tier)}
            >
              {tier === 'personal' ? t.accounts.tabs.personal : t.accounts.tabs.business}
              <span className="tier-count">{accounts.filter((a) => (a.tier ?? 'personal') === tier).length}</span>
            </button>
          ))}
        </div>
        {loading ? (
          <p className="muted">{t.common.loading}</p>
        ) : accounts.length === 0 ? (
          <p className="muted">{t.common.noAccountsYet}</p>
        ) : accounts.filter((a) => (a.tier ?? 'personal') === tierTab).length === 0 ? (
          // An empty tier tab is not the same as an empty account list — say
          // what the tab is for instead of showing a bare table skeleton.
          <p className="muted">{tierTab === 'business' ? t.accounts.emptyBusiness : t.common.noAccountsYet}</p>
        ) : (
          <div className="table-scroll-container">
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
              {accounts.filter((a) => (a.tier ?? 'personal') === tierTab).map((a) => {
                const s = accountStatus(a);
                return (
                  <tr key={a.id}>
                    <td>
                      <span className="file-name-cell">
                        <ProviderLogo provider={a.provider} size={20} />
                        {/* wizard §3: S3-compatible rows show the owner's
                            provider name (Wasabi, …) over the generic label */}
                        {a.provider === 's3' && a.providerDisplayName ? a.providerDisplayName : a.displayName}
                      </span>
                      {a.experimental && <span className="tag tag-warn">{t.accounts.picker.experimental}</span>}
                    </td>
                    <td className="ellipsis">{a.displayLabel}</td>
                    <td>
                      <span className={`state state-${s.tone}`}>{s.text}</span>
                      {!a.participatesInUploads && <div><span className="tag">{t.accounts.list.excludedBadge}</span></div>}
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
                      {a.quota.totalBytes === null && a.quota.status === 'current' && (
                        <div className="muted small">{t.accounts.sharedPool.unlimitedLabel}</div>
                      )}
                      {a.quotaScopeKey && <span className="tag">{t.accounts.sharedPool.badge}</span>}
                      {a.quota.lastCheckedAt && (
                        <div className="muted small">{tf(t.accounts.list.checked, { when: formatDateTime(a.quota.lastCheckedAt) })}</div>
                      )}
                      {a.quota.lastErrorCode && <div className="muted small">{a.quota.lastErrorCode}</div>}
                    </td>
                    <td className="actions">
                      {a.status === 'connected' ? (
                        <button type="button" className="btn-secondary" disabled={busyId === a.id} onClick={() => void verify(a)}>{t.accounts.list.test}</button>
                      ) : (
                        <button type="button" className="btn-secondary" disabled={busyId === a.id} onClick={() => void reconnect(a)}>{t.accounts.list.reconnect}</button>
                      )}
                      <RowMenu label={t.accounts.list.actions}>
                        {/* wizard §4: the whole management surface is this row —
                            Reconnect (token refresh → browser fallback), Edit/
                            Replace credentials, Test, Disconnect; S3 keeps its
                            capacity/participation powers. */}
                        <RowMenuItem disabled={busyId === a.id} onSelect={() => void reconnect(a)}>{t.accounts.list.reconnect}</RowMenuItem>
                        <RowMenuItem disabled={busyId === a.id} onSelect={() => (a.provider === 's3' || a.provider === 'mega' ? openEditDialog(a) : openWizardSetup(a))}>
                          {a.provider === 's3' || a.provider === 'mega' ? t.accounts.edit.menuItem : t.accounts.edit.appConfigItem}
                        </RowMenuItem>
                        <RowMenuItem disabled={busyId === a.id} onSelect={() => void refreshOne(a.id)}>{t.accounts.list.refreshQuota}</RowMenuItem>
                        <RowMenuItem disabled={busyId === a.id} onSelect={() => openRename(a)}>{t.accounts.list.rename}</RowMenuItem>
                        <RowMenuItem disabled={busyId === a.id} onSelect={() => void toggleParticipation(a)}>
                          {a.participatesInUploads ? t.accounts.list.excludeUploads : t.accounts.list.includeUploads}
                        </RowMenuItem>
                        <RowMenuItem disabled={busyId === a.id} onSelect={() => openScopeEditor(a)}>{t.accounts.sharedPool.manage}</RowMenuItem>
                        <RowMenuItem danger disabled={busyId === a.id} onSelect={() => void disconnect(a)}>{t.accounts.list.disconnect}</RowMenuItem>
                      </RowMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
        <p className="muted small">{t.accounts.list.footnote}</p>
      </section>

      {scopeTarget && (
        <Dialog title={t.accounts.sharedPool.title} onClose={() => setScopeTarget(null)}>
          <p className="muted">{t.accounts.sharedPool.description}</p>
          <p className="muted small">{t.accounts.sharedPool.current}</p>
          <div className="scope-member-list">
            {accounts
              .filter((a) => a.provider === scopeTarget.provider && a.status === 'connected')
              .map((a) => (
                <label key={a.id} className="scope-member">
                  <input
                    type="checkbox"
                    checked={scopeSelection.includes(a.id) || a.id === scopeTarget.id}
                    disabled={a.id === scopeTarget.id || busyId === '__scope__'}
                    onChange={() => toggleScopeMember(a.id)}
                  />
                  <span>{a.displayLabel}</span>
                  {a.quotaScopeKey && <span className="tag">{t.accounts.sharedPool.badge}</span>}
                </label>
              ))}
          </div>
          <div className="actions">
            <button type="button" className="btn-secondary" disabled={busyId === '__scope__'} onClick={() => void saveScope(true)}>
              {t.accounts.sharedPool.clear}
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busyId === '__scope__' || scopeSelection.length < 1}
              onClick={() => void saveScope(false)}
            >
              {t.accounts.sharedPool.save}
            </button>
          </div>
        </Dialog>
      )}

      {renameTarget && (
        <Dialog
          title={t.accounts.list.renameDialog.title}
          description={t.accounts.list.renameDialog.desc}
          onClose={() => { if (busyId === null) setRenameTarget(null); }}
          footer={
            <>
              <button type="button" className="btn-secondary" disabled={busyId === renameTarget.id} onClick={() => setRenameTarget(null)}>
                {t.dialog.cancel}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busyId === renameTarget.id || renameLabel.trim() === ''}
                onClick={() => void saveRename()}
              >
                {t.accounts.list.renameDialog.save}
              </button>
            </>
          }
        >
          <div className="upload-form">
            <label htmlFor="account-rename-input">{t.accounts.list.renameDialog.label}</label>
            <input
              id="account-rename-input"
              type="text"
              value={renameLabel}
              autoFocus
              onChange={(e) => setRenameLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveRename(); }}
            />
            {renameError && <p className="form-error" role="alert">{renameError}</p>}
          </div>
        </Dialog>
      )}
    </>
  );
}
