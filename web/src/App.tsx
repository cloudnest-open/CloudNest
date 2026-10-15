import { useEffect, useState } from 'react';
import {
  Cloud, House, Folder, CloudUpload, Download, Link, Settings as SettingsIcon,
  Sun, Moon, LogOut, Search, ChevronDown, Bell,
} from 'lucide-react';
import { api, refreshCsrfToken } from './api.js';
import { FirstRunPage, LoginPage } from './pages/EntryPage.js';
import { CloudAccountsPage } from './pages/CloudAccountsPage.js';
import { UploadsPage } from './pages/UploadsPage.js';
import { FilesPage } from './pages/FilesPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { DownloadsPage } from './pages/DownloadsPage.js';
import { SharedLinksPage } from './pages/SharedLinksPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { EmptyState, ToastProvider } from './components/ui.js';
import { FileActionsProvider } from './components/FileActionsProvider.js';
import { LanguageMenu } from './components/LanguageMenu.js';
import { useI18n } from './i18n-context.js';
import { formatBytes } from './i18n.js';
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

/** Internal nav identity → catalog key (labels are translated, keys are not). */
const NAV_KEYS: Record<NavItem, keyof import('./i18n.js').AppStrings['nav']> = {
  Dashboard: 'dashboard',
  Files: 'files',
  Uploads: 'uploads',
  Downloads: 'downloads',
  'Shared Links': 'sharedLinks',
  'Cloud Accounts': 'cloudAccounts',
  Settings: 'settings',
};

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
  const { t, tf } = useI18n();
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [active, setActive] = useState<NavItem>('Dashboard');
  const [health, setHealth] = useState<Health | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [theme, setTheme] = useState(currentTheme());
  // Real account identity from the backend drives the avatar initials.
  const [username, setUsername] = useState('admin');
  // Notification bell: a real toggle whose panel truthfully reports the
  // (currently empty) notification list — never a decorative icon.
  const [bellOpen, setBellOpen] = useState(false);
  // Global search over CloudNest-managed files (real data; never a fake index).
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  // FE-12: keyboard-highlighted result index for the combobox
  const [hitIndex, setHitIndex] = useState(-1);
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
        const meUsername = (me.data as { username?: string }).username;
        if (meUsername) setUsername(meUsername);
        setAuthState(authenticated ? 'ready' : 'login');
      } catch {
        setServerError(t.common.errorNetwork);
        setAuthState('login');
      }
    })();
    // The startup reachability check runs once; the message stays in the
    // language chosen at start (a later change is cosmetic only here).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authState !== 'ready') return;
    const params = new URLSearchParams(window.location.search);
    const connectResult = params.get('connect');
    if (connectResult) {
      setNotice(
        (t.connectResults as Record<string, string | undefined>)[connectResult] ?? t.connectResults.fallback,
      );
      setActive('Cloud Accounts');
      window.history.replaceState({}, '', '/');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the redirect cleanup must not re-run on a language change
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
          setHitIndex(-1);
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
    // The entry page renders the server-unreachable state itself (localized).
    return <LoginPage onDone={() => setAuthState('ready')} serverError={serverError} />;
  }
  if (authState === 'loading') {
    return <div className="auth-card">{t.shell.loading}</div>;
  }

  const navLabel = (item: NavItem): string => t.nav[NAV_KEYS[item]];

  return (
    <ToastProvider>
    <FileActionsProvider>
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><Cloud size={19} strokeWidth={2} /></span>
          <span className="brand-name">CloudNest</span>
        </div>
        <nav className="nav" aria-label={t.nav.aria}>
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
                <span>{navLabel(item)}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <span className="status-line">
            <span className={health ? 'status-dot status-ok' : 'status-dot status-down'} aria-hidden="true" />
            <span className="status-text">
              {health ? tf(t.shell.status.connected, { version: health.version }) : t.shell.status.down}
            </span>
          </span>
          <button
            type="button"
            className="btn-logout"
            aria-label={theme === 'dark' ? t.shell.theme.toLight : t.shell.theme.toDark}
            title={theme === 'dark' ? t.shell.theme.toLight : t.shell.theme.toDark}
            onClick={() => setTheme(toggleTheme())}
          >
            {theme === 'dark' ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
            <span>{theme === 'dark' ? t.shell.theme.light : t.shell.theme.dark}</span>
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
              placeholder={t.shell.search.placeholder}
              aria-label={t.shell.search.label}
              role="combobox"
              aria-expanded={searchOpen && hits.length > 0}
              aria-controls="header-search-listbox"
              aria-autocomplete="list"
              aria-activedescendant={hitIndex >= 0 ? `header-search-option-${hitIndex}` : undefined}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => { if (hits.length > 0) setSearchOpen(true); }}
              onKeyDown={(e) => {
                // FE-12: combobox keyboard support — arrows move through the
                // result options, Enter activates the highlighted one, Escape
                // dismisses. (aria-activedescendant tracks the highlight.)
                if (e.key === 'Escape') { setQuery(''); setSearchOpen(false); return; }
                if (!searchOpen || hits.length === 0) return;
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  setHitIndex((prev) => {
                    const count = hits.length;
                    if (count === 0) return -1;
                    const delta = e.key === 'ArrowDown' ? 1 : -1;
                    return ((prev < 0 ? (e.key === 'ArrowDown' ? -1 : count) : prev) + delta + count) % count;
                  });
                } else if (e.key === 'Enter') {
                  if (hitIndex >= 0 && hitIndex < hits.length) {
                    e.preventDefault();
                    openSearchHit(hits[hitIndex]!);
                    setHitIndex(-1);
                  }
                }
              }}
            />
            {searchOpen && (
              <div className="search-results" role="listbox" id="header-search-listbox" aria-label={t.shell.search.resultsLabel}>
                {hits.length === 0 ? (
                  <p className="muted small" style={{ padding: '8px 10px', margin: 0 }}>
                    {t.shell.search.noMatch}
                  </p>
                ) : (
                  hits.map((hit, i) => (
                    <button
                      key={hit.id}
                      type="button"
                      className={`search-result${i === hitIndex ? ' active' : ''}`}
                      role="option"
                      aria-selected={i === hitIndex}
                      id={`header-search-option-${i}`}
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
          <div className="shell-lang-wrap">
            <LanguageMenu variant="shell" />
          </div>
          <div className="bell-menu">
            <button
              type="button"
              className="bell-btn"
              aria-haspopup="dialog"
              aria-expanded={bellOpen}
              aria-label={t.shell.bell.label}
              title={t.shell.bell.label}
              onClick={() => setBellOpen((open) => !open)}
            >
              <Bell size={17} aria-hidden="true" />
            </button>
            {bellOpen && (
              <>
                <button
                  type="button"
                  className="account-scrim"
                  aria-label={t.shell.bell.close}
                  tabIndex={-1}
                  onClick={() => setBellOpen(false)}
                />
                <div className="account-dropdown bell-dropdown" role="dialog" aria-label={t.shell.bell.label}>
                  <EmptyState
                    icon={Bell}
                    title={t.shell.bell.emptyTitle}
                    body={t.shell.bell.emptyBody}
                  />
                </div>
              </>
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
              <span className="account-avatar" aria-hidden="true">{username.charAt(0).toUpperCase()}</span>
              <span className="account-text">
                <strong>{username}</strong>
                <span className="muted">{t.shell.account.role}</span>
              </span>
              <ChevronDown size={15} aria-hidden="true" className="muted" />
            </button>
            {accountOpen && (
              <>
                <button
                  type="button"
                  className="account-scrim"
                  aria-label={t.shell.account.close}
                  onClick={() => setAccountOpen(false)}
                  onKeyDown={(e) => {
                    // FE-12: Escape closes the menu and returns focus to the chip
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setAccountOpen(false);
                      document.querySelector<HTMLButtonElement>('.account-chip')?.focus();
                    }
                  }}
                  tabIndex={-1}
                />
                <div className="account-dropdown" role="menu" onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setAccountOpen(false);
                    document.querySelector<HTMLButtonElement>('.account-chip')?.focus();
                  }
                }}>
                  <button
                    type="button"
                    role="menuitem"
                    className="account-item"
                    onClick={() => { setAccountOpen(false); void logout(); }}
                  >
                    <LogOut size={15} aria-hidden="true" />
                    <span>{t.shell.account.signOut}</span>
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
            <SettingsPage onGoToCloudAccounts={() => setActive('Cloud Accounts')} />
          ) : active === 'Cloud Accounts' ? (
            <CloudAccountsPage onGoToSettings={() => setActive('Settings')} />
          ) : active === 'Uploads' ? (
            <UploadsPage />
          ) : active === 'Files' ? (
            <FilesPage key={fileSearch.seq} initialSearch={fileSearch.text} onGoToCloudAccounts={() => setActive('Cloud Accounts')} />
          ) : active === 'Downloads' ? (
            <DownloadsPage />
          ) : active === 'Shared Links' ? (
            <SharedLinksPage />
          ) : active === 'Dashboard' ? (
            <DashboardPage onNavigate={(page) => setActive(page)} />
          ) : (
            <section className="card placeholder-card">
              <h1>{navLabel(active)}</h1>
              <p>{t.shell.notImplemented}</p>
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
