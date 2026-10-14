import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { ChangePasswordPanel } from './AuthPages.js';
import { ProviderSetupCard } from '../components/ProviderSetupCard.js';
import { applyTheme, currentTheme, type Theme } from '../theme.js';
import { setConfirmDestructivePreference } from '../confirm.js';

/**
 * Settings (M12.a).
 *
 * Every control either works or is explicitly disabled with a reason. No
 * placeholder is shown as if it worked, and no status is invented.
 */

type SectionKey =
  | 'general' | 'upload' | 'downloads' | 'sharing' | 'domain' | 'security' | 'system' | 'diagnostics';

const SECTIONS: Array<{ key: SectionKey; label: string }> = [
  { key: 'general', label: 'General' },
  { key: 'upload', label: 'Upload & Storage' },
  { key: 'downloads', label: 'Downloads' },
  { key: 'sharing', label: 'Sharing & Deletion' },
  { key: 'domain', label: 'Domain & Remote Access' },
  { key: 'security', label: 'Security' },
  { key: 'system', label: 'System' },
  { key: 'diagnostics', label: 'Diagnostics' },
];

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(1)}\u00A0${units[i]}`;
}

export function SettingsPage() {
  const [section, setSection] = useState<SectionKey>('general');
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
        setError('Could not load settings.');
      }
      if (b.status === 200) {
        const data = b.data as { backups: BackupInfo[]; key: { warning: string | null } };
        setBackups(data.backups ?? []);
        setKeyWarning(data.key?.warning ?? null);
      }
    } catch {
      setError('Could not reach the server. Check that CloudNest is running, then retry.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(patch: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.saveSettings(patch);
      if (res.status === 200) {
        setSettings((res.data as { settings: Settings }).settings);
        // keep the confirmation gate in sync with what was just saved, so the
        // change applies to the next destructive action without a reload
        if (typeof patch['security.confirmDestructive'] === 'boolean') {
          setConfirmDestructivePreference(patch['security.confirmDestructive']);
        }
        setNotice('Setting saved.');
      } else {
        const body = res.data as { message?: string; code?: string };
        setError(body.message ?? `Could not save that setting (${body.code ?? 'unknown'}).`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function makeBackup(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await api.createBackup();
      if (res.status === 201) {
        setNotice((res.data as { notice: string }).notice);
        await load();
      } else {
        setError('The backup could not be created.');
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
          ? `Backup verified (integrity: ${v.integrityCheck}). Chunks without an active placement: ${v.chunksWithoutPlacement}.`
          : 'The backup could not be read.',
      );
    } else {
      setError('Verification failed.');
    }
  }

  async function runRestore(): Promise<void> {
    if (!restoreSource) return;
    if (restoreConfirm !== 'RESTORE') {
      setError('Type RESTORE to confirm the restore.');
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
        setNotice(`${body.notice} Restored database path: ${body.restoredPath}`);
        setRestoreSource(null);
        setRestoreTarget('');
        setRestoreConfirm('');
      } else {
        const body = res.data as { code?: string };
        setError(body.code === 'restore_target_invalid'
          ? 'The target directory must be an absolute path.'
          : body.code === 'restore_target_exists'
            ? 'The target directory already exists. Tick the overwrite confirmation to use it anyway.'
            : 'The restore failed.');
      }
    } catch {
      setError('Could not reach the server for the restore.');
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
        setNotice('Redacted diagnostics copied to the clipboard.');
      } catch {
        setNotice('Copy failed; select the text below and copy it manually.');
      }
    } else {
      setError('Could not build diagnostics.');
    }
  }

  if (!settings || !system) {
    return (
      <section className="card">
        <h1 className="page-title">Settings</h1>
        <p className="muted">{error ?? 'Loading…'}</p>
      </section>
    );
  }

  return (
    <>
      <h1 className="page-title">Settings</h1>
      {notice && <div className="card notice-card" role="status"><p>{notice}</p></div>}
      {error && <div className="card error-card" role="alert"><p>{error}</p></div>}

      <div className="tabs" role="tablist" aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            id={`settings-tab-${s.key}`}
            type="button"
            role="tab"
            aria-selected={section === s.key}
            aria-controls={`settings-panel-${s.key}`}
            tabIndex={section === s.key ? 0 : -1}
            className={`tab${section === s.key ? ' active' : ''}`}
            onClick={() => setSection(s.key)}
            onKeyDown={(e) => {
              // FE-12: WAI-ARIA tabs keyboard interaction — Left/Right move
              // selection and focus together, Home/End jump to the ends.
              const idx = SECTIONS.findIndex((x) => x.key === s.key);
              let next: number | null = null;
              if (e.key === 'ArrowRight') next = (idx + 1) % SECTIONS.length;
              else if (e.key === 'ArrowLeft') next = (idx - 1 + SECTIONS.length) % SECTIONS.length;
              else if (e.key === 'Home') next = 0;
              else if (e.key === 'End') next = SECTIONS.length - 1;
              if (next !== null) {
                e.preventDefault();
                setSection(SECTIONS[next]!.key);
                document.getElementById(`settings-tab-${SECTIONS[next]!.key}`)?.focus();
              }
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {section === 'general' && (
        <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general">
        <section className="card">
          <h2>General</h2>
          <p className="muted small">Application version <strong>{system.appVersion}</strong></p>
          <div className="upload-form">
            <label htmlFor="theme">Theme</label>
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
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
            <p className="muted small">
              The choice is stored in this browser and applies before the first paint, so the wrong theme never
              flashes on reload. A Light/Dark toggle is also in the sidebar footer.
            </p>
          </div>
          <p className="muted small">
            Language selection is not available yet. The interface is currently English only.
          </p>
        </section>
        </div>
      )}

      {section === 'upload' && (
        <div role="tabpanel" id="settings-panel-upload" aria-labelledby="settings-tab-upload">
        <section className="card">
          <h2>Upload &amp; Storage</h2>
          <div className="upload-form">
            <label htmlFor="chunk-size">Logical chunk size (new uploads only)</label>
            <select
              id="chunk-size"
              value={settings['upload.chunkSizeMiB']}
              onChange={(e) => void save({ 'upload.chunkSizeMiB': Number(e.target.value) })}
              disabled={busy}
            >
              {[8, 16, 32, 64].map((size) => <option key={size} value={size}>{size} MiB</option>)}
            </select>
            <p className="muted small">
              Already-uploaded files keep the chunk size they were stored with; changing this never rewrites them.
            </p>
            <label htmlFor="workers">Concurrent chunk uploads (1–8; default 4)</label>
            <input
              id="workers"
              type="number"
              min={1}
              max={8}
              value={settings['upload.workerLimit']}
              onChange={(e) => void save({ 'upload.workerLimit': Number(e.target.value) })}
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
            Space-aware routing (exclude accounts with unknown or stale quota)
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings['upload.verifyIntegrity']}
              disabled={busy}
              onChange={(e) => void save({ 'upload.verifyIntegrity': e.target.checked })}
            />
            Verify each chunk checksum (strongly recommended)
          </label>
          <p className="muted small">
            Per-account reserved space is set on each account in Cloud Accounts. A per-file reserved-space
            override is not available yet.
          </p>
        </section>
        </div>
      )}

      {section === 'downloads' && (
        <div role="tabpanel" id="settings-panel-downloads" aria-labelledby="settings-tab-downloads">
        <section className="card">
          <h2>Downloads</h2>
          <div className="upload-form">
            <label htmlFor="dl-concurrency">Concurrent chunk reads during reconstruction</label>
            <input
              id="dl-concurrency"
              type="number"
              min={1}
              max={8}
              value={settings['download.concurrency']}
              onChange={(e) => void save({ 'download.concurrency': Number(e.target.value) })}
              disabled={busy}
            />
          </div>
          <p className="muted small">
            Every chunk is checksum-verified before any byte is sent. Pause/resume is handled by your browser's own
            download manager, so no in-app pause button is offered. The verification buffer is capped at 128 MiB
            in total, regardless of this setting.
          </p>
        </section>
        </div>
      )}

      {section === 'sharing' && (
        <div role="tabpanel" id="settings-panel-sharing" aria-labelledby="settings-tab-sharing">
        <section className="card">
          <h2>Sharing &amp; Deletion</h2>
          <div className="upload-form">
            <label htmlFor="expiry">Default link expiry (days; blank = never)</label>
            <input
              id="expiry"
              type="number"
              min={1}
              value={settings['share.defaultExpiryDays'] ?? ''}
              onChange={(e) => void save({ 'share.defaultExpiryDays': e.target.value === '' ? null : Number(e.target.value) })}
              disabled={busy}
            />
            <label htmlFor="dl-limit">Default download limit (blank = unlimited)</label>
            <input
              id="dl-limit"
              type="number"
              min={1}
              value={settings['share.defaultDownloadLimit'] ?? ''}
              onChange={(e) => void save({ 'share.defaultDownloadLimit': e.target.value === '' ? null : Number(e.target.value) })}
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
            Require a password for new links by default
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings['security.confirmDestructive']}
              disabled={busy}
              onChange={(e) => void save({ 'security.confirmDestructive': e.target.checked })}
            />
            Ask for confirmation before destructive actions
          </label>
          <p className="muted small">
            <strong>Deleting a share link never deletes storage.</strong> Deleting a file does start deletion of the
            CloudNest-owned chunk objects for that file, and revokes its links first.
          </p>
        </section>
        </div>
      )}

      {section === 'domain' && (
        <div role="tabpanel" id="settings-panel-domain" aria-labelledby="settings-tab-domain">
        <section className="card">
          <h2>Domain &amp; Remote Access</h2>
          <p className="muted small">
            Current bind: <strong>{system.bindMode}</strong> on port {system.port}. CloudNest always keeps the origin
            on 127.0.0.1 — enabling a tunnel does not change that.
          </p>
          <div className="upload-form">
            <label htmlFor="public-url">Configured public base URL (used to build share URLs)</label>
            <input
              id="public-url"
              type="text"
              placeholder="https://files.example.com"
              defaultValue={settings['domain.publicBaseUrl'] ?? ''}
              onBlur={(e) => void save({ 'domain.publicBaseUrl': e.target.value || null })}
              disabled={busy}
            />
          </div>
          <h3>Cloudflare Tunnel</h3>
          <p className="muted small">
            Optional. CloudNest works fully locally without Cloudflare. Status:{' '}
            <strong>{tunnel?.state ?? 'unknown'}</strong>
            {tunnel?.hostname ? ` (${tunnel.hostname})` : ''}
            {tunnel?.cloudflaredAvailable ? '' : ' — cloudflared is not installed at a known path.'}
          </p>
          <p className="muted small">
            CloudNest has no registered Cloudflare OAuth app, so this wizard uses a narrowly scoped API token you
            create yourself. A <strong>Global API Key is never requested</strong>. Required permissions:
          </p>
          <ul className="plain-list">
            <li>Account → Cloudflare Tunnel → Edit</li>
            <li>Zone → DNS → Edit</li>
          </ul>
          <div className="upload-form">
            <label htmlFor="tunnel-host">Public hostname (e.g. files.example.com)</label>
            <input id="tunnel-host" type="text" value={tunnelHost} onChange={(e) => setTunnelHost(e.target.value)} />
            <label htmlFor="tunnel-token">Tunnel runtime token (stored encrypted; written to a 0600 file, never to a command line)</label>
            <input id="tunnel-token" type="password" value={tunnelToken} onChange={(e) => setTunnelToken(e.target.value)} />
            <label htmlFor="cf-token">Cloudflare API token — optional; required for the DNS route (scoped, not stored, never a Global API Key)</label>
            <input id="cf-token" type="password" value={cloudflareToken} onChange={(e) => setCloudflareToken(e.target.value)} />
            <label htmlFor="cf-zone">Zone ID — optional; used as a hint when the token sees several zones</label>
            <input id="cf-zone" type="text" value={zoneId} onChange={(e) => setZoneId(e.target.value)} />
          </div>
          {cloudflareToken === '' && (
            <p className="muted small">
              Without a scoped Cloudflare API token CloudNest starts the connector only: no DNS record is created or
              checked, and you must point your own CNAME at the tunnel yourself. The token is used for this check and
              is not stored.
            </p>
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
                  setNotice('Connector start requested. Status refreshes on the next settings load.');
                } else {
                  const body = res.data as { code?: string };
                  setError(`The tunnel could not be started (${body.code ?? 'unknown'}).`);
                }
                setBusy(false);
              }}
            >
              Start tunnel
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
                  setError('Could not stop the tunnel.');
                }
              }}
            >
              Disconnect
            </button>
          </div>
          {dnsResult && (
            <div className="notice-card" role="status">
              <p>
                {dnsResult.record
                  ? <>DNS route: <strong>{dnsResult.record}</strong></>
                  : 'No DNS record was created or reused (no scoped API token was supplied).'}
              </p>
              {dnsResult.actions.length > 0 && (
                <ul className="plain-list">
                  {dnsResult.actions.map((action) => <li key={action} className="muted small">{action}</li>)}
                </ul>
              )}
              <p className="muted small">
                A Cloudflare-side tunnel and DNS record are never deleted from here; remove them in Cloudflare if you
                no longer need them.
              </p>
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
            <h2>Connected provider status</h2>
            <p className="muted small">
              Account connectivity and token state are shown in Cloud Accounts. Token values are never displayed
              anywhere in CloudNest.
            </p>
          </section>
        </>
        </div>
      )}

      {section === 'system' && (
        <div role="tabpanel" id="settings-panel-system" aria-labelledby="settings-tab-system">
        <>
          <section className="card">
            <h2>System</h2>
            <ul className="plain-list">
              <li><strong>Version:</strong> {system.appVersion}</li>
              <li><strong>Host / port:</strong> 127.0.0.1 : {system.port}</li>
              <li><strong>Base URL:</strong> {system.appBaseUrl}</li>
              <li><strong>Data directory:</strong> {system.dataDir}</li>
            </ul>
          </section>
          <section className="card">
            <h2>Database backup</h2>
            <p className="muted small">
              Backups use SQLite's own online backup, so they are consistent while CloudNest is running. A backup is a
              <strong> metadata/configuration</strong> backup: it holds manifests, jobs, shares and account references —
              not the file bytes, and not the credential-encryption key.
            </p>
            <div className="actions">
              <button type="button" className="btn-primary" disabled={busy} onClick={() => void makeBackup()}>
                {busy ? 'Working…' : 'Create backup'}
              </button>
            </div>
            {backups.length === 0 ? (
              <p className="muted">No backups yet.</p>
            ) : (
              <table className="accounts-table">
                <thead><tr><th>Created</th><th>Size</th><th>Version</th><th>Actions</th></tr></thead>
                <tbody>
                  {backups.map((b) => (
                    <tr key={b.directory}>
                      <td className="muted small">{new Date(b.createdAt).toLocaleString()}</td>
                      <td>{formatBytes(b.databaseBytes)}</td>
                      <td className="muted small">{b.appVersion}</td>
                      <td className="actions">
                        <button type="button" className="btn-secondary" onClick={() => void verify(`${b.directory}/cloudnest.db`)}>
                          Verify
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
                          Restore…
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {restoreSource && (
              <div className="upload-form" style={{ marginTop: 12 }} role="group" aria-label="Restore a backup">
                <h3>Restore backup</h3>
                <p className="muted small">Source: <code>{restoreSource}</code></p>
                <label htmlFor="restore-target">Target directory (absolute path; created fresh)</label>
                <input
                  id="restore-target"
                  type="text"
                  value={restoreTarget}
                  onChange={(e) => setRestoreTarget(e.target.value)}
                  placeholder="/absolute/path/to/restore-into"
                />
                <p className="muted small">
                  Restoring writes into a <strong>new directory</strong> and never overwrites the live data directory.
                  A restore does not bring back provider objects, and provider accounts need the credential-encryption
                  key; without it they must be reconnected. Pointing the target at an existing directory requires the
                  overwrite confirmation below.
                </p>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={restoreOverwrite}
                    onChange={(e) => setRestoreOverwrite(e.target.checked)}
                  />
                  Allow writing into an existing directory (overwrite its database)
                </label>
                <label htmlFor="restore-confirm">Type RESTORE to confirm</label>
                <input
                  id="restore-confirm"
                  type="text"
                  value={restoreConfirm}
                  onChange={(e) => setRestoreConfirm(e.target.value)}
                  autoComplete="off"
                />
                <div className="actions">
                  <button type="button" className="btn-danger" disabled={busy || restoreConfirm !== 'RESTORE' || restoreTarget.trim() === ''} onClick={() => void runRestore()}>
                    {busy ? 'Working…' : 'Restore now'}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy}
                    onClick={() => { setRestoreSource(null); setRestoreTarget(''); setRestoreConfirm(''); }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {!restoreSource && (
              <p className="muted small">
                Restoring writes into a <strong>new directory</strong> and never overwrites the live data directory.
                A restore does not bring back provider objects, and provider accounts need the credential key. Use
                <strong> Restore…</strong> on a backup row to start.
              </p>
            )}
          </section>
        </>
        </div>
      )}

      {section === 'diagnostics' && (
        <div role="tabpanel" id="settings-panel-diagnostics" aria-labelledby="settings-tab-diagnostics">
        <section className="card">
          <h2>Diagnostics</h2>
          <p className="muted small">
            The report is redacted before it leaves the server: tokens, passwords, session identifiers and
            secret-bearing URLs are replaced, and local paths are shortened.
          </p>
          <div className="actions">
            <button type="button" className="btn-primary" onClick={() => void copyDiagnostics()}>
              Copy redacted diagnostics
            </button>
          </div>
          {diagnostics && <pre className="diagnostics-output">{diagnostics}</pre>}
        </section>
        </div>
      )}

      <section className="card">
        <h2>Provider Setup</h2>
        <ProviderSetupCard onChanged={() => void load()} />
      </section>
    </>
  );
}
