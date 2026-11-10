import { useEffect, useState, type FormEvent } from 'react';
import { Download, File as FileIcon, ArrowRight } from 'lucide-react';
import { api, refreshCsrfToken } from '../api.js';
import { useI18n } from '../i18n-context.js';
import { interpolate, formatBytes } from '../i18n.js';
import { applyTheme, currentTheme, type Theme } from '../theme.js';
import { BrandLockup, EntryHeader, EntryFooter, PasswordField } from './EntryPage.js';

interface ShareFileInfo {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string | null;
}

interface ShareData {
  requiresPassword: boolean;
  expiresAt: string | null;
  downloadLimit: number | null;
  downloadCount: number;
  files: ShareFileInfo[];
}

export function PublicSharePage() {
  const { e } = useI18n();
  const [theme, setThemeState] = useState<Theme>(() => currentTheme());
  const [token] = useState(() => {
    const segments = window.location.pathname.replace(/^\/s\//, '').split('/');
    return segments[0] || '';
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlockGrant, setUnlockGrant] = useState<string | null>(null);
  const [shareData, setShareData] = useState<ShareData | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadingAll, setDownloadingAll] = useState(false);

  useEffect(() => {
    void refreshCsrfToken();
  }, []);

  function setTheme(next: Theme): void {
    applyTheme(next);
    setThemeState(next);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!token) {
        setError(e.share.expiredOrNotFound);
        setLoading(false);
        return;
      }
      try {
        const { status, data } = await api.getPublicShare(token);
        if (cancelled) return;
        if (status === 200) {
          const res = data as ShareData;
          if (res.requiresPassword) {
            setRequiresPassword(true);
          } else {
            setShareData(res);
          }
        } else {
          const code = (data as { code?: string })?.code;
          if (code === 'share_download_limit_reached') {
            setError(e.share.limitReached);
          } else {
            setError(e.share.expiredOrNotFound);
          }
        }
      } catch {
        if (!cancelled) setError(e.share.expiredOrNotFound);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [token, e]);

  async function handleUnlock(ev: FormEvent) {
    ev.preventDefault();
    if (unlocking || !password) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      const { status, data } = await api.unlockPublicShare(token, password);
      if (status === 200) {
        const res = data as ShareData & { unlockGrant?: string | null };
        setUnlockGrant(res.unlockGrant ?? null);
        setShareData(res);
        setRequiresPassword(false);
      } else if (status === 401) {
        setUnlockError(e.share.errorInvalidPassword);
      } else {
        const code = (data as { code?: string })?.code;
        if (code === 'share_download_limit_reached') {
          setError(e.share.limitReached);
          setRequiresPassword(false);
        } else {
          setUnlockError(e.share.errorInvalidPassword);
        }
      }
    } catch {
      setUnlockError(e.share.errorInvalidPassword);
    } finally {
      setUnlocking(false);
    }
  }

  async function downloadFile(file: ShareFileInfo) {
    setDownloadingId(file.id);
    try {
      const { status, data } = await api.createPublicDownloadSession(token, file.id, unlockGrant);
      if (status === 200) {
        const session = data as { downloadPath: string };
        const a = document.createElement('a');
        a.href = session.downloadPath;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } else {
        const code = (data as { code?: string })?.code;
        if (code === 'share_download_limit_reached') {
          setError(e.share.limitReached);
        } else {
          setError(e.share.expiredOrNotFound);
        }
      }
    } catch {
      setError(e.share.expiredOrNotFound);
    } finally {
      setDownloadingId(null);
    }
  }

  async function downloadAll() {
    if (!shareData?.files.length || downloadingAll) return;
    setDownloadingAll(true);
    try {
      for (const file of shareData.files) {
        await downloadFile(file);
        // Small stagger to prevent browser pop-up blocks
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    } finally {
      setDownloadingAll(false);
    }
  }

  return (
    <div className="entry-page">
      <EntryHeader e={e} theme={theme} onSetTheme={setTheme} />
      <main className="entry-main">
        <section className="entry-auth" aria-labelledby="share-title">
          <div className={`entry-auth-content${shareData ? ' share-visitor-card' : ''}`}>
            <BrandLockup markSize={52} className="entry-lockup-panel" />

            {loading ? (
              <div className="entry-spinner" style={{ margin: '32px auto' }} aria-hidden="true" />
            ) : error ? (
              <>
                <h2 className="entry-auth-title" id="share-title">{e.share.title}</h2>
                <p className="entry-error" role="alert">{error}</p>
              </>
            ) : requiresPassword ? (
              <>
                <h2 className="entry-auth-title" id="share-title">{e.share.title}</h2>
                <p className="entry-auth-subtitle">{e.share.passwordRequired}</p>
                <form className="entry-form" onSubmit={handleUnlock}>
                  <PasswordField
                    id="share-password"
                    label={e.share.passwordPlaceholder}
                    value={password}
                    onChange={setPassword}
                    autoComplete="current-password"
                    e={e}
                  />
                  {unlockError && <p className="entry-error" role="alert">{unlockError}</p>}
                  <button type="submit" className="entry-submit" disabled={unlocking || !password}>
                    {unlocking ? (
                      <span className="entry-spinner" aria-hidden="true" />
                    ) : (
                      <ArrowRight size={17} aria-hidden="true" />
                    )}
                    <span>{unlocking ? e.share.unlocking : e.share.unlock}</span>
                  </button>
                </form>
              </>
            ) : shareData ? (
              <>
                <h2 className="entry-auth-title" id="share-title">{e.share.title}</h2>
                <p className="entry-auth-subtitle">{e.share.subtitle}</p>

                {shareData.files.length === 0 ? (
                  <p className="share-visitor-meta-row">{e.share.empty}</p>
                ) : (
                  <>
                    <p className="share-visitor-meta-row">
                      {interpolate(e.share.filesCount, { count: shareData.files.length })}
                    </p>

                    <div className="share-visitor-files">
                      {shareData.files.map((file) => (
                        <div key={file.id} className="share-visitor-file-item">
                          <div className="share-visitor-file-info">
                            <FileIcon size={20} className="share-visitor-file-icon" aria-hidden="true" />
                            <div className="share-visitor-file-meta">
                              <span className="share-visitor-file-name" title={file.name}>
                                {file.name}
                              </span>
                              <span className="share-visitor-file-size">
                                {formatBytes(file.sizeBytes)}
                              </span>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="share-visitor-dl-btn"
                            onClick={() => void downloadFile(file)}
                            disabled={downloadingId === file.id || downloadingAll}
                          >
                            <Download size={14} aria-hidden="true" />
                            <span>
                              {downloadingId === file.id ? e.share.preparing : e.share.download}
                            </span>
                          </button>
                        </div>
                      ))}
                    </div>

                    {shareData.files.length > 1 && (
                      <div className="share-visitor-actions">
                        <button
                          type="button"
                          className="share-visitor-dl-btn"
                          onClick={() => void downloadAll()}
                          disabled={downloadingAll || downloadingId !== null}
                        >
                          <Download size={14} aria-hidden="true" />
                          <span>
                            {downloadingAll ? e.share.preparing : e.share.downloadAll}
                          </span>
                        </button>
                      </div>
                    )}
                  </>
                )}
              </>
            ) : null}
          </div>
        </section>
      </main>
      <EntryFooter e={e} theme={theme} onSetTheme={setTheme} />
    </div>
  );
}
