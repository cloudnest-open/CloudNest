import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { ChangePasswordPanel } from './AuthPages.js';
import { ProviderSetupCard } from '../components/ProviderSetupCard.js';
import { applyTheme, currentTheme, type Theme } from '../theme.js';
import { setConfirmDestructivePreference } from '../confirm.js';
import { formatBytes, formatDateTime } from '../components/ui.js';
import { useI18n } from '../i18n-context.js';
import { LOCALES, LOCALE_NAMES, type Locale } from '../i18n.js';

/**
 * Settings (M12.a).
 *
 * Every control either works or is explicitly disabled with a reason. No
 * placeholder is shown as if it worked, and no status is invented. All copy
 * resolves through the app-wide i18n context. The Language select shares the
 * single app-wide preference/instance: changing it updates the entire
 * interface immediately and persists across navigation, refresh and logout.
 */

type SectionKey =
  | 'general' | 'upload' | 'downloads' | 'sharing' | 'domain' | 'security' | 'system' | 'diagnostics' | 'providerSetup';

const SECTION_KEYS: SectionKey[] = [
  'general', 'upload', 'downloads', 'sharing', 'domain', 'security', 'system', 'diagnostics', 'providerSetup',
];

type NumericDrafts = { workers: string; downloadConcurrency: string; expiryDays: string; downloadLimit: string };

interface Settings {
  'upload.chunkSizeMiB': number;
  'upload.workerLimit': number;
  'upload.spaceAwareRouting': boolean;
  'upload.verifyIntegrity': boolean;
  'download.concurrency': number;
  'share.defaultExpiryDays': number | null;
  'share.requirePassword': boolean;
  'share.defaultDownloadLimit': number | null;
  'security.confirmDestructive': boolean;
  'domain.publicBaseUrl': string | null;
}

interface SystemInfo {
  appVersion: string;
  dataDir: string;
  port: number;
  appBaseUrl: string;
  bindMode: string;
}

interface TunnelInfo {
  enabled: boolean;
  state: string;
  hostname: string | null;
  cloudflaredAvailable: boolean;
  safeErrorCode: string | null;
}

interface BackupInfo {
  directory: string;
  createdAt: string;
  databaseBytes: number;
  appVersion: string;
}

export function SettingsPage({ onGoToCloudAccounts }: { onGoToCloudAccounts?: () => void } = {}) {
  const { t, tf, locale, setLocale } = useI18n();
  const [section, setSection] = useState<SectionKey>('general');
  const [focusProviderSetup, setFocusProviderSetup] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [tunnel, setTunnel] = useState<TunnelInfo | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  // ST-03: restore flow state — which backup, which target directory, and the
  // explicit two-step confirmation the destructive action requires.
  const [restoreSource, setRestoreSource] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState('');
  const [restoreConfirm, setRestoreConfirm] = useState('');
  const [restoreOverwrite, setRestoreOverwrite] = useState(false);
  const [keyWarning, setKeyWarning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'saving' | 'saved' | null>(null);
  const [numericDrafts, setNumericDrafts] = useState<NumericDrafts>({ workers: '', downloadConcurrency: '', expiryDays: '', downloadLimit: '' });
  const [diagnostics, setDiagnostics] = useState<string>('');
  const [tunnelHost, setTunnelHost] = useState('');
  const [tunnelToken, setTunnelToken] = useState('');
  const [cloudflareToken, setCloudflareToken] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [dnsResult, setDnsResult] = useState<{ record: string | null; actions: string[] } | null>(null);
  const [theme, setTheme] = useState<Theme>(currentTheme());

  const load = useCallback(async () => {
    // FE-04: a network failure must not leave the Settings page on "Loading…"
    try {
      const [s, b] = await Promise.all([api.getSettings(), api.listBackups()]);
      if (s.status === 200) {
        const data = s.data as { settings: Settings; system: SystemInfo; tunnel: TunnelInfo };
        setSettings(data.settings);
        setSystem(data.system);
        setTunnel(data.tunnel);
      } else {
        setError(t.settings.errorLoad);
      }
      if (b.status === 200) {
        const data = b.data as { backups: BackupInfo[]; key: { warning: string | null } };
        setBackups(data.backups ?? []);
        setKeyWarning(data.key?.warning ?? null);
      }
    } catch {
      setError(t.common.errorNetwork);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loads are mount-driven; a language change must not re-fetch
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!settings) return;
    setNumericDrafts({
      workers: String(settings['upload.workerLimit']),
      downloadConcurrency: String(settings['download.concurrency']),
      expiryDays: settings['share.defaultExpiryDays'] === null ? '' : String(settings['share.defaultExpiryDays']),
      downloadLimit: settings['share.defaultDownloadLimit'] === null ? '' : String(settings['share.defaultDownloadLimit']),
    });
  }, [settings]);

  // Arriving via “Configure Provider” from Cloud Accounts opens the dedicated
  // Provider Setup section and places keyboard focus in the form.
  useEffect(() => {
    let pending: string | null = null;
    try { pending = sessionStorage.getItem('cloudnest.pendingConnect'); } catch { /* private mode */ }
    if (!pending) return;
    setFocusProviderSetup(true);
    setSection('providerSetup');
  }, []);

  useEffect(() => {
    if (!focusProviderSetup || section !== 'providerSetup' || !settings) return;
    window.setTimeout(() => {
      const panel = document.getElementById('provider-setup');
      panel?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      panel?.querySelector<HTMLElement>('input, button, select')?.focus();
      setFocusProviderSetup(false);
    }, 100);
  }, [focusProviderSetup, section, settings]);

  async function save(patch: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    setSaveStatus('saving');
    try {
      const res = await api.saveSettings(patch);
      if (res.status === 200) {
        setSettings((res.data as { settings: Settings }).settings);
        // keep the confirmation gate in sync with what was just saved, so the
        // change applies to the next destructive action without a reload
        if (typeof patch['security.confirmDestructive'] === 'boolean') {
          setConfirmDestructivePreference(patch['security.confirmDestructive']);
        }
        setSaveStatus('saved');
      } else {
        const body = res.data as { message?: string; code?: string };
        setError(body.message ?? (body.code ? tf(t.settings.saveFailed, { code: body.code }) : t.settings.saveRejected));
        setSaveStatus(null);
      }
    } catch {
      setError(t.common.errorNetwork);
      setSaveStatus(null);
    } finally {
      setBusy(false);
    }
  }

  function commitNumber<K extends keyof Settings>(
    inputId: string,
    key: K,
    value: string,
  ): void {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    if (!input?.checkValidity()) {
      input?.reportValidity();
      return;
    }
    const next = value.trim() === '' ? null : Number(value);
    if (next !== null && !Number.isFinite(next)) return;
    void save({ [key]: next });
  }

  async function makeBackup(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await api.createBackup();
      if (res.status === 201) {
        setNotice(t.settings.backup.created);
        await load();
      } else {
        setError(t.settings.backup.failed);
      }
    } finally {
      setBusy(false);
    }
  }

  async function verify(databasePath: string): Promise<void> {
    const res = await api.verifyBackup(databasePath);
    if (res.status === 200) {
      const v = (res.data as { verification: { readable: boolean; chunksWithoutPlacement: number; integrityCheck: string } }).verification;
      setNotice(
        v.readable
          ? tf(t.settings.backup.verified, { integrity: v.integrityCheck, count: v.chunksWithoutPlacement })
          : t.settings.backup.unreadable,
      );
    } else {
      setError(t.settings.backup.verifyFailed);
    }
  }

  async function runRestore(): Promise<void> {
    if (!restoreSource) return;
    if (restoreConfirm !== 'RESTORE') {
      setError(t.settings.restore.confirmMismatch);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const overwriteConfirmed = restoreOverwrite && restoreConfirm === 'RESTORE';
      const res = await api.restoreBackup(restoreSource, restoreTarget.trim(), overwriteConfirmed);
      if (res.status === 200) {
        const body = res.data as { restoredPath: string; notice: string };
        setNotice(`${body.notice} ${tf(t.settings.restore.pathNotice, { path: body.restoredPath })}`);
        setRestoreSource(null);
        setRestoreTarget('');
        setRestoreConfirm('');
      } else {
        const body = res.data as { code?: string };
        setError(body.code === 'restore_target_invalid'
          ? t.settings.restore.targetInvalid
          : body.code === 'restore_target_exists'
            ? t.settings.restore.targetExists
            : t.settings.restore.failed);
      }
    } catch {
      setError(t.settings.restore.reachFailed);
    } finally {
      setBusy(false);
    }
  }

  async function copyDiagnostics(): Promise<void> {
    const res = await api.getDiagnostics();
    if (res.status === 200) {
      const text = (res.data as { text: string }).text;
      setDiagnostics(text);
      try {
        await navigator.clipboard.writeText(text);
        setNotice(t.settings.diagnostics.copied);
      } catch {
        setNotice(t.settings.diagnostics.copyFailed);
      }
    } else {
      setError(t.settings.diagnostics.failed);
    }
  }

  if (!settings || !system) {
    return (
      <section className="card">
        <h1 className="page-title">{t.settings.title}</h1>
        <p className="muted">{error ?? t.common.loading}</p>
      </section>
    );
  }

  return (
    <>
      <div className="settings-heading">
        <h1 className="page-title">{t.settings.title}</h1>
        {saveStatus && (
          <span className="settings-save-status small muted" role="status">
            {saveStatus === 'saving' ? t.common.working : t.settings.saved}
          </span>
        )}
      </div>
      {notice && <div className="card notice-card" role="status"><p>{notice}</p></div>}
      {error && <div className="card error-card" role="alert"><p>{error}</p></div>}

      <div className="tabs" role="tablist" aria-label={t.settings.tabsAria}>
        {SECTION_KEYS.map((key) => (
          <button
            key={key}
            id={`settings-tab-${key}`}
            type="button"
            role="tab"
            aria-selected={section === key}
            aria-controls={`settings-panel-${key}`}
            tabIndex={section === key ? 0 : -1}
            className={`tab${section === key ? ' active' : ''}`}
            onClick={() => setSection(key)}
            onKeyDown={(e) => {
              // FE-12: WAI-ARIA tabs keyboard interaction — Left/Right move
              // selection and focus together, Home/End jump to the ends.
              const idx = SECTION_KEYS.findIndex((x) => x === key);
              let next: number | null = null;
              if (e.key === 'ArrowRight') next = (idx + 1) % SECTION_KEYS.length;
              else if (e.key === 'ArrowLeft') next = (idx - 1 + SECTION_KEYS.length) % SECTION_KEYS.length;
              else if (e.key === 'Home') next = 0;
              else if (e.key === 'End') next = SECTION_KEYS.length - 1;
              if (next !== null) {
                e.preventDefault();
                setSection(SECTION_KEYS[next]!);
                document.getElementById(`settings-tab-${SECTION_KEYS[next]!}`)?.focus();
              }
            }}
          >
            {key === 'providerSetup' ? t.settings.providerSetup.title : t.settings.tab[key]}
          </button>
        ))}
      </div>

      {section === 'general' && (
        <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general">
        <section className="card">
          <h2>{t.settings.general.title}</h2>
          <p className="muted small">{tf(t.settings.general.version, { version: system.appVersion })}</p>
          <div className="upload-form">
            <label htmlFor="theme">{t.settings.general.theme}</label>
            <select
              id="theme"
              value={theme}
              onChange={(e) => {
                const next = e.target.value as Theme;
                // client-side per the design contract: applied and persisted at
                // once, with no server round-trip
                applyTheme(next);
                setTheme(next);
              }}
            >
              <option value="light">{t.settings.general.light}</option>
              <option value="dark">{t.settings.general.dark}</option>
            </select>
            <p className="muted small">{t.settings.general.themeNote}</p>
            <label htmlFor="language">{t.settings.general.language}</label>
            <select
              id="language"
              value={locale}
              onChange={(e) => {
                // the shared preference/instance: applies app-wide instantly
                // and persists for later visits
                setLocale(e.target.value as Locale);
              }}
            >
              {LOCALES.map((id) => <option key={id} value={id}>{LOCALE_NAMES[id]}</option>)}
            </select>
            <p className="muted small">{t.settings.general.languageNote}</p>
          </div>
        </section>
        </div>
      )}

      {section === 'upload' && (
        <div role="tabpanel" id="settings-panel-upload" aria-labelledby="settings-tab-upload">
        <section className="card">
          <h2>{t.settings.upload.title}</h2>
          <div className="upload-form">
            <label htmlFor="chunk-size">{t.settings.upload.chunkSize}</label>
            <select
              id="chunk-size"
              value={settings['upload.chunkSizeMiB']}
              onChange={(e) => void save({ 'upload.chunkSizeMiB': Number(e.target.value) })}
              disabled={busy}
            >
              {[8, 16, 32, 64].map((size) => <option key={size} value={size}>{size} MiB</option>)}
            </select>
            <p className="muted small">{t.settings.upload.chunkNote}</p>
            <label htmlFor="workers">{t.settings.upload.workers}</label>
            <input
              id="workers"
              type="number"
              min={1}
              max={8}
              required
              value={numericDrafts.workers}
              onChange={(e) => setNumericDrafts((drafts) => ({ ...drafts, workers: e.target.value }))}
              onBlur={(e) => commitNumber('workers', 'upload.workerLimit', e.currentTarget.value)}
              disabled={busy}
            />
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings['upload.spaceAwareRouting']}
              disabled={busy}
              onChange={(e) => void save({ 'upload.spaceAwareRouting': e.target.checked })}
            />
            {t.settings.upload.spaceRouting}
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings['upload.verifyIntegrity']}
              disabled={busy}
              onChange={(e) => void save({ 'upload.verifyIntegrity': e.target.checked })}
            />
            {t.settings.upload.verify}
          </label>
          <p className="muted small">{t.settings.upload.note}</p>
        </section>
        </div>
      )}

      {section === 'downloads' && (
        <div role="tabpanel" id="settings-panel-downloads" aria-labelledby="settings-tab-downloads">
        <section className="card">
          <h2>{t.settings.downloads.title}</h2>
          <div className="upload-form">
            <label htmlFor="dl-concurrency">{t.settings.downloads.concurrency}</label>
            <input
              id="dl-concurrency"
              type="number"
              min={1}
              max={8}
              required
              value={numericDrafts.downloadConcurrency}
              onChange={(e) => setNumericDrafts((drafts) => ({ ...drafts, downloadConcurrency: e.target.value }))}
              onBlur={(e) => commitNumber('dl-concurrency', 'download.concurrency', e.currentTarget.value)}
              disabled={busy}
            />
          </div>
          <p className="muted small">{t.settings.downloads.note}</p>
        </section>
        </div>
      )}

      {section === 'sharing' && (
        <div role="tabpanel" id="settings-panel-sharing" aria-labelledby="settings-tab-sharing">
        <section className="card">
          <h2>{t.settings.sharing.title}</h2>
          <div className="upload-form">
            <label htmlFor="expiry">{t.settings.sharing.expiry}</label>
            <input
              id="expiry"
              type="number"
              min={1}
              value={numericDrafts.expiryDays}
              onChange={(e) => setNumericDrafts((drafts) => ({ ...drafts, expiryDays: e.target.value }))}
              onBlur={(e) => commitNumber('expiry', 'share.defaultExpiryDays', e.currentTarget.value)}
              disabled={busy}
            />
            <label htmlFor="dl-limit">{t.settings.sharing.limit}</label>
            <input
              id="dl-limit"
              type="number"
              min={1}
              value={numericDrafts.downloadLimit}
              onChange={(e) => setNumericDrafts((drafts) => ({ ...drafts, downloadLimit: e.target.value }))}
              onBlur={(e) => commitNumber('dl-limit', 'share.defaultDownloadLimit', e.currentTarget.value)}
              disabled={busy}
            />
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings['share.requirePassword']}
              disabled={busy}
              onChange={(e) => void save({ 'share.requirePassword': e.target.checked })}
            />
            {t.settings.sharing.requirePassword}
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings['security.confirmDestructive']}
              disabled={busy}
              onChange={(e) => void save({ 'security.confirmDestructive': e.target.checked })}
            />
            {t.settings.sharing.confirmDestructive}
          </label>
          <p className="muted small">
            <strong>{t.settings.sharing.note}</strong>
          </p>
        </section>
        </div>
      )}

      {section === 'domain' && (
        <div role="tabpanel" id="settings-panel-domain" aria-labelledby="settings-tab-domain">
        <section className="card">
          <h2>{t.settings.domain.title}</h2>
          <p className="muted small">{tf(t.settings.domain.bind, { mode: system.bindMode, port: system.port })}</p>
          <div className="upload-form">
            <label htmlFor="public-url">{t.settings.domain.publicUrl}</label>
            <input
              id="public-url"
              type="text"
              placeholder="https://files.example.com"
              defaultValue={settings['domain.publicBaseUrl'] ?? ''}
              onBlur={(e) => void save({ 'domain.publicBaseUrl': e.target.value || null })}
              disabled={busy}
            />
          </div>
          <h3>{t.settings.domain.tunnelTitle}</h3>
          <p className="muted small">
            {t.settings.domain.tunnelIntro}{' '}
            <strong>{tunnel?.state ?? t.settings.domain.unknownState}</strong>
            {tunnel?.hostname ? ` ${tf(t.settings.domain.tunnelHostSuffix, { hostname: tunnel.hostname })}` : ''}
            {tunnel?.cloudflaredAvailable ? '' : ` ${t.settings.domain.tunnelNotInstalled}`}
          </p>
          <p className="muted small">{t.settings.domain.tokenIntro}</p>
          <ul className="plain-list">
            <li>{t.settings.domain.permTunnel}</li>
            <li>{t.settings.domain.permDns}</li>
          </ul>
          <div className="upload-form">
            <label htmlFor="tunnel-host">{t.settings.domain.host}</label>
            <input id="tunnel-host" type="text" value={tunnelHost} onChange={(e) => setTunnelHost(e.target.value)} />
            <label htmlFor="tunnel-token">{t.settings.domain.runtimeToken}</label>
            <input id="tunnel-token" type="password" value={tunnelToken} onChange={(e) => setTunnelToken(e.target.value)} />
            <label htmlFor="cf-token">{t.settings.domain.cfToken}</label>
            <input id="cf-token" type="password" value={cloudflareToken} onChange={(e) => setCloudflareToken(e.target.value)} />
            <label htmlFor="cf-zone">{t.settings.domain.zoneId}</label>
            <input id="cf-zone" type="text" value={zoneId} onChange={(e) => setZoneId(e.target.value)} />
          </div>
          {cloudflareToken === '' && (
            <p className="muted small">{t.settings.domain.noTokenNote}</p>
          )}
          <div className="actions">
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !tunnelHost || !tunnelToken}
              onClick={async () => {
                setBusy(true);
                setError(null);
                setDnsResult(null);
                const res = await api.startTunnel({
                  hostname: tunnelHost,
                  runtimeToken: tunnelToken,
                  ...(cloudflareToken ? { cloudflareToken } : {}),
                  ...(zoneId ? { zoneId } : {}),
                });
                setTunnelToken('');
                setCloudflareToken('');
                setZoneId('');
                if (res.status === 200) {
                  const data = res.data as {
                    status: TunnelInfo;
                    dnsRecord: { id: string; name: string; content: string } | null;
                    dnsActions: string[];
                  };
                  setTunnel(data.status);
                  setDnsResult({
                    record: data.dnsRecord ? `${data.dnsRecord.name} → ${data.dnsRecord.content}` : null,
                    actions: data.dnsActions ?? [],
                  });
                  setNotice(t.settings.domain.startNotice);
                } else {
                  const body = res.data as { code?: string };
                  setError(tf(t.settings.domain.startFailed, { code: body.code ?? 'unknown' }));
                }
                setBusy(false);
              }}
            >
              {t.settings.domain.start}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={async () => {
                const res = await api.stopTunnel();
                if (res.status === 200) {
                  setTunnel((res.data as { status: TunnelInfo }).status);
                  setDnsResult(null);
                  setNotice((res.data as { notice: string }).notice);
                } else {
                  setError(t.settings.domain.stopFailed);
                }
              }}
            >
              {t.settings.domain.disconnect}
            </button>
          </div>
          {dnsResult && (
            <div className="notice-card" role="status">
              <p>
                {dnsResult.record
                  ? <>{t.settings.domain.dnsRoute} <strong>{dnsResult.record}</strong></>
                  : t.settings.domain.noDns}
              </p>
              {dnsResult.actions.length > 0 && (
                <ul className="plain-list">
                  {dnsResult.actions.map((action) => <li key={action} className="muted small">{action}</li>)}
                </ul>
              )}
              <p className="muted small">{t.settings.domain.dnsNote}</p>
            </div>
          )}
        </section>
        </div>
      )}

      {section === 'security' && (
        <div role="tabpanel" id="settings-panel-security" aria-labelledby="settings-tab-security">
        <>
          <ChangePasswordPanel onDone={(message) => setNotice(message)} />
          {keyWarning && (
            <section className="card error-card">
              <p>{keyWarning}</p>
            </section>
          )}
          <section className="card">
            <h2>{t.settings.security.providerStatus}</h2>
            <p className="muted small">{t.settings.security.providerStatusNote}</p>
          </section>
        </>
        </div>
      )}

      {section === 'system' && (
        <div role="tabpanel" id="settings-panel-system" aria-labelledby="settings-tab-system">
        <>
          <section className="card">
            <h2>{t.settings.system.title}</h2>
            <ul className="plain-list">
              <li><strong>{t.settings.system.version}</strong> {system.appVersion}</li>
              <li><strong>{t.settings.system.hostPort}</strong> 127.0.0.1 : {system.port}</li>
              <li><strong>{t.settings.system.baseUrl}</strong> {system.appBaseUrl}</li>
              <li><strong>{t.settings.system.dataDir}</strong> {system.dataDir}</li>
            </ul>
          </section>
          <section className="card">
            <h2>{t.settings.backup.title}</h2>
            <p className="muted small">{t.settings.backup.note}</p>
            <div className="actions">
              <button type="button" className="btn-primary" disabled={busy} onClick={() => void makeBackup()}>
                {busy ? t.common.working : t.settings.backup.create}
              </button>
            </div>
            {backups.length === 0 ? (
              <p className="muted">{t.settings.backup.none}</p>
            ) : (
              <table className="accounts-table">
                <thead><tr><th>{t.settings.backup.created_}</th><th>{t.settings.backup.size}</th><th>{t.settings.backup.version}</th><th>{t.settings.backup.actions}</th></tr></thead>
                <tbody>
                  {backups.map((b) => (
                    <tr key={b.directory}>
                      <td className="muted small">{formatDateTime(b.createdAt)}</td>
                      <td>{formatBytes(b.databaseBytes)}</td>
                      <td className="muted small">{b.appVersion}</td>
                      <td className="actions">
                        <button type="button" className="btn-secondary" onClick={() => void verify(`${b.directory}/cloudnest.db`)}>
                          {t.settings.backup.verify}
                        </button>{' '}
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={busy}
                          onClick={() => {
                            // ST-03: start the restore flow from this backup
                            setRestoreSource(`${b.directory}/cloudnest.db`);
                            setRestoreTarget('');
                            setRestoreConfirm('');
                            setRestoreOverwrite(false);
                            setError(null);
                            setNotice(null);
                          }}
                        >
                          {t.settings.backup.restore}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {restoreSource && (
              <div className="upload-form" style={{ marginTop: 12 }} role="group" aria-label={t.settings.restore.groupAria}>
                <h3>{t.settings.restore.title}</h3>
                <p className="muted small">{t.settings.restore.source} <code>{restoreSource}</code></p>
                <label htmlFor="restore-target">{t.settings.restore.target}</label>
                <input
                  id="restore-target"
                  type="text"
                  value={restoreTarget}
                  onChange={(e) => setRestoreTarget(e.target.value)}
                  placeholder="/absolute/path/to/restore-into"
                />
                <p className="muted small">{t.settings.restore.note}</p>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={restoreOverwrite}
                    onChange={(e) => setRestoreOverwrite(e.target.checked)}
                  />
                  {t.settings.restore.allowOverwrite}
                </label>
                <label htmlFor="restore-confirm">{t.settings.restore.confirmLabel}</label>
                <input
                  id="restore-confirm"
                  type="text"
                  value={restoreConfirm}
                  onChange={(e) => setRestoreConfirm(e.target.value)}
                  autoComplete="off"
                />
                <div className="actions">
                  <button type="button" className="btn-danger" disabled={busy || restoreConfirm !== 'RESTORE' || restoreTarget.trim() === ''} onClick={() => void runRestore()}>
                    {busy ? t.common.working : t.settings.restore.now}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy}
                    onClick={() => { setRestoreSource(null); setRestoreTarget(''); setRestoreConfirm(''); }}
                  >
                    {t.dialog.cancel}
                  </button>
                </div>
              </div>
            )}
            {!restoreSource && (
              <p className="muted small">{t.settings.restore.hint}</p>
            )}
          </section>
        </>
        </div>
      )}

      {section === 'diagnostics' && (
        <div role="tabpanel" id="settings-panel-diagnostics" aria-labelledby="settings-tab-diagnostics">
        <section className="card">
          <h2>{t.settings.diagnostics.title}</h2>
          <p className="muted small">{t.settings.diagnostics.note}</p>
          <div className="actions">
            <button type="button" className="btn-primary" onClick={() => void copyDiagnostics()}>
              {t.settings.diagnostics.copy}
            </button>
          </div>
          {diagnostics && <pre className="diagnostics-output">{diagnostics}</pre>}
        </section>
        </div>
      )}

      {section === 'providerSetup' && (
        <div role="tabpanel" id="settings-panel-providerSetup" aria-labelledby="settings-tab-providerSetup">
          <section className="card" id="provider-setup">
            <h2>{t.settings.providerSetup.title}</h2>
            <ProviderSetupCard onChanged={() => void load()} onGoToCloudAccounts={onGoToCloudAccounts} />
          </section>
        </div>
      )}
    </>
  );
}
