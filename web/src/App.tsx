import { useEffect, useState } from 'react';
import {
  Cloud, House, Folder, CloudUpload, Download, Link, Settings as SettingsIcon,
  Sun, Moon, LogOut, Search, ChevronDown, UserRound,
} from 'lucide-react';
import { api, refreshCsrfToken } from './api.js';
import { FirstRunPage, LoginPage } from './pages/AuthPages.js';
import { CloudAccountsPage } from './pages/CloudAccountsPage.js';
import { UploadsPage } from './pages/UploadsPage.js';
import { FilesPage } from './pages/FilesPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { DownloadsPage } from './pages/DownloadsPage.js';
import { SharedLinksPage } from './pages/SharedLinksPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { ToastProvider } from './components/ui.js';
import { FileActionsProvider } from './components/FileActionsProvider.js';
import { currentTheme, toggleTheme } from './theme.js';
import { setConfirmDestructivePreference, ConfirmHost } from './confirm.js';

const NAV_ITEMS = [
  'Dashboard',
  'Files',
  'Uploads',
  'Downloads',
  'Shared Links',
  'Cloud Accounts',
  'Settings',
] as const;

type NavItem = (typeof NAV_ITEMS)[number];

/** One consistent outline icon per navigation entry (design pack §3.1). */
const NAV_ICONS: Record<NavItem, typeof Cloud> = {
  Dashboard: House,
  Files: Folder,
  Uploads: CloudUpload,
  Downloads: Download,
  'Shared Links': Link,
  'Cloud Accounts': Cloud,
  Settings: SettingsIcon,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

interface SearchHit {
  id: string;
  originalName: string;
  sizeBytes: number;
}
type AuthState = 'loading' | 'setup' | 'login' | 'ready';

interface Health {
  status: string;
  version: string;
}

export default function App() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [active, setActive] = useState<NavItem>('Dashboard');
  const [health, setHealth] = useState<Health | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [theme, setTheme] = useState(currentTheme());
  // Global search over CloudNest-managed files (real data; never a fake index).
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [fileSearch, setFileSearch] = useState<{ text: string; seq: number }>({ text: '', seq: 0 });

  useEffect(() => {
    (async () => {
      try {
        await refreshCsrfToken();
        const setup = await api.setupStatus();
        const setupRequired = (setup.data as { setupRequired?: boolean })?.setupRequired === true;
        if (setupRequired) {
          setAuthState('setup');
          return;
        }
        const me = await api.me();
        const authenticated = (me.data as { authenticated?: boolean })?.authenticated === true;
        setAuthState(authenticated ? 'ready' : 'login');
      } catch {
        setServerError('Cannot reach the local server. Is CloudNest running?');
        setAuthState('login');
      }
    })();
  }, []);

  useEffect(() => {
    if (authState !== 'ready') return;
    const params = new URLSearchParams(window.location.search);
    const connectResult = params.get('connect');
    if (connectResult) {
      const messages: Record<string, string> = {
        connected: 'Account connected successfully.',
        refresh_token_missing: 'Connected, but the provider did not return a durable refresh token. Reconnect and grant offline access to keep this account usable unattended.',
        oauth_state_invalid: 'The authorization request could not be validated. Start the connection again.',
        oauth_denied: 'Authorization was declined at the provider. No account was created.',
        token_exchange_failed: 'The provider rejected the authorization code. Start the connection again.',
        provider_not_configured: 'Provider setup is missing. Configure it in Settings → Provider Setup.',
        provider_unavailable: 'The provider is temporarily unavailable. Try again later.',
        provider_rate_limited: 'The provider rate-limited the request. Try again shortly.',
        needs_reauth: 'The provider requires you to sign in again.',
      };
      setNotice(messages[connectResult] ?? 'The connection could not be completed.');
      setActive('Cloud Accounts');
      window.history.replaceState({}, '', '/');
    }
  }, [authState]);

  useEffect(() => {
    if (authState !== 'ready') return;
    let cancelled = false;
    fetch('/api/health')
      .then((res) => res.json() as Promise<Health>)
      .then((data) => !cancelled && setHealth(data))
      .catch(() => !cancelled && setHealth(null));
    return () => {
      cancelled = true;
    };
  }, [authState]);

  // Seed the destructive-action confirmation gate from the saved preference.
  // The theme needs no such bootstrap: theme.ts resolves it from local storage
  // before the first paint.
  useEffect(() => {
    if (authState !== 'ready') return;
    let cancelled = false;
    api.getSettings()
      .then((res) => {
        if (cancelled || res.status !== 200) return;
        const saved = (res.data as { settings?: Record<string, unknown> }).settings;
        const confirmDestructive = saved?.['security.confirmDestructive'];
        if (typeof confirmDestructive === 'boolean') setConfirmDestructivePreference(confirmDestructive);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [authState]);

  // Search the CloudNest-managed file index server-side (the same list the
  // Files page shows). No cross-provider content search is implied, and
  // nothing is shown before the server answers.
  useEffect(() => {
    const text = query.trim();
    if (authState !== 'ready' || text.length < 2) {
      setHits([]);
      setSearchOpen(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.listFiles(8, 0, text)
        .then((res) => {
          if (cancelled || res.status !== 200) return;
          setHits((res.data as { files?: SearchHit[] }).files ?? []);
          setSearchOpen(true);
        })
        .catch(() => undefined);
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, authState]);

  function openSearchHit(hit: SearchHit): void {
    setFileSearch((prev) => ({ text: hit.originalName, seq: prev.seq + 1 }));
    setActive('Files');
    setQuery('');
    setHits([]);
    setSearchOpen(false);
  }

  async function logout() {
    await api.logout();
    await refreshCsrfToken();
    setNotice(null);
    setAuthState('login');
  }

  if (authState === 'setup') {
    return <FirstRunPage onDone={() => setAuthState('ready')} />;
  }
  if (authState === 'login') {
    return (
      <>
        {serverError && (
          <div className="auth-server-error" role="alert">
            {serverError}
          </div>
        )}
        <LoginPage onDone={() => setAuthState('ready')} />
      </>
    );
  }
  if (authState === 'loading') {
    return <div className="auth-card">Loading…</div>;
  }

  return (
    <ToastProvider>
    <FileActionsProvider>
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><Cloud size={19} strokeWidth={2} /></span>
          <span className="brand-name">CloudNest</span>
        </div>
        <nav className="nav" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = NAV_ICONS[item];
            return (
              <button
                key={item}
                type="button"
                className={`nav-item${active === item ? ' active' : ''}`}
                aria-current={active === item ? 'page' : undefined}
                onClick={() => setActive(item)}
              >
                <Icon className="nav-icon" size={20} strokeWidth={1.9} aria-hidden="true" />
                <span>{item}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <span className={health ? 'status-dot status-ok' : 'status-dot status-down'} aria-hidden="true" />
          <span className="status-text">
            {health ? `Local server: connected (v${health.version})` : 'Local server: not connected'}
          </span>
          <button
            type="button"
            className="btn-logout"
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            onClick={() => setTheme(toggleTheme())}
          >
            {theme === 'dark' ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
            <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="search-wrap">
            <Search className="search-icon" size={16} aria-hidden="true" />
            <input
              className="search"
              type="search"
              placeholder="Search files and folders..."
              aria-label="Search files and folders"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => { if (hits.length > 0) setSearchOpen(true); }}
              onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); setSearchOpen(false); } }}
            />
            {searchOpen && (
              <div className="search-results" role="listbox" aria-label="Search results">
                {hits.length === 0 ? (
                  <p className="muted small" style={{ padding: '8px 10px', margin: 0 }}>
                    No CloudNest-managed files match.
                  </p>
                ) : (
                  hits.map((hit) => (
                    <button
                      key={hit.id}
                      type="button"
                      className="search-result"
                      role="option"
                      aria-selected={false}
                      onClick={() => openSearchHit(hit)}
                    >
                      <Folder size={15} aria-hidden="true" />
                      <span className="ellipsis">{hit.originalName}</span>
                      <span className="muted small">{formatBytes(hit.sizeBytes)}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <div className="account-menu">
            <button
              type="button"
              className="account-chip"
              aria-haspopup="menu"
              aria-expanded={accountOpen}
              onClick={() => setAccountOpen((open) => !open)}
            >
              <span className="account-avatar" aria-hidden="true">
                <UserRound size={16} />
              </span>
              <span className="account-text">
                <strong>admin</strong>
                <span className="muted">CloudNest administrator</span>
              </span>
              <ChevronDown size={15} aria-hidden="true" className="muted" />
            </button>
            {accountOpen && (
              <>
                <button
                  type="button"
                  className="account-scrim"
                  aria-label="Close account menu"
                  onClick={() => setAccountOpen(false)}
                />
                <div className="account-dropdown" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="account-item"
                    onClick={() => { setAccountOpen(false); void logout(); }}
                  >
                    <LogOut size={15} aria-hidden="true" />
                    <span>Sign out</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </header>
        <main className="content">
          {notice && (
            <div className="card notice-card" role="status">
              <p>{notice}</p>
            </div>
          )}
          {active === 'Settings' ? (
            <SettingsPage />
          ) : active === 'Cloud Accounts' ? (
            <CloudAccountsPage onGoToSettings={() => setActive('Settings')} />
          ) : active === 'Uploads' ? (
            <UploadsPage />
          ) : active === 'Files' ? (
            <FilesPage key={fileSearch.seq} initialSearch={fileSearch.text} />
          ) : active === 'Downloads' ? (
            <DownloadsPage />
          ) : active === 'Shared Links' ? (
            <SharedLinksPage />
          ) : active === 'Dashboard' ? (
            <DashboardPage onNavigate={(page) => setActive(page)} />
          ) : (
            <section className="card placeholder-card">
              <h1>{active}</h1>
              <p>Not implemented yet. This section will arrive in a later step.</p>
            </section>
          )}
        </main>
      </div>
    </div>
    <ConfirmHost />
    </FileActionsProvider>
    </ToastProvider>
  );
}
