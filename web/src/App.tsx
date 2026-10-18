import { useEffect, useState } from 'react';
import {
  AlertTriangle, Bell, CheckCircle2, ChevronDown, Cloud, CloudUpload, Download, Folder, House,
  Link, LogOut, Menu, Moon, Search, Settings as SettingsIcon, Sun, UserRound, UsersRound, X,
} from 'lucide-react';
import { api, refreshCsrfToken } from './api.js';
import { TransferDock, type DownloadDockJob, type UploadDockJob } from './components/TransferDock.js';
import { FirstRunPage, LoginPage } from './pages/EntryPage.js';
import { ChangePasswordPanel } from './pages/AuthPages.js';
import { CloudAccountsPage } from './pages/CloudAccountsPage.js';
import { UploadsPage } from './pages/UploadsPage.js';
import { FilesPage } from './pages/FilesPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { DownloadsPage } from './pages/DownloadsPage.js';
import { SharedLinksPage } from './pages/SharedLinksPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { Dialog, EmptyState, ToastProvider, formatDateTime, feedItemLine } from './components/ui.js';
import { FileActionsProvider } from './components/FileActionsProvider.js';
import { LanguageMenu } from './components/LanguageMenu.js';
import { ModeChooser } from './components/ModeChooser.js';
import { useI18n } from './i18n-context.js';
import { useUiMode } from './ui-mode-context.js';
import { readStoredDockCollapsed, storeDockCollapsed } from './dock-state.js';
import { formatBytes, plural } from './i18n.js';
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

/** The authenticated principal, from /api/auth/me (roadmap Phase 3). */
interface PrincipalInfo {
  role: 'admin' | 'member';
  username: string;
  displayName: string;
  email: string | null;
}

interface Health {
  status: string;
  version: string;
}

export default function App() {
  const { t, tf, locale } = useI18n();
  const { uiMode, setUiMode } = useUiMode();
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [active, setActive] = useState<NavItem>('Dashboard');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  // session-26 F14: a notice belongs to the page it was raised on — rendering
  // it on every later page (and forever) made one-off messages read like
  // permanent app errors.
  const [notice, setNotice] = useState<{ text: string; page: NavItem } | null>(null);
  const [theme, setTheme] = useState(currentTheme());
  // Real account identity from the backend drives the avatar initials.
  const [username, setUsername] = useState('admin');
  // Roadmap Phase 3: the full principal (role decides nav + admin surfaces).
  const [principal, setPrincipal] = useState<PrincipalInfo | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'general' | 'users'>('general');
  // Notification bell: a real toggle whose panel shows the server's real
  // per-principal feed (roadmap Phase 4) — never a decorative icon.
  const [bellOpen, setBellOpen] = useState(false);
  interface FeedItem { id: string; kind: string; payload: Record<string, unknown>; readAt: string | null; createdAt: string }
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  // Roadmap Phase 4: live transfer snapshot for the topbar icon and the dock —
  // durable server rows only.
  const [dockUploads, setDockUploads] = useState<UploadDockJob[]>([]);
  const [dockDownloads, setDockDownloads] = useState<DownloadDockJob[]>([]);
  // Session-21 batch-B: the dock starts as a collapsed pill; expanding it
  // reserves content space so the panel stops eating the page corner.
  const [dockCollapsed, setDockCollapsed] = useState<boolean>(readStoredDockCollapsed);
  // Mode = complete context: switching modes PAUSES (never cancels) the
  // leaving tier's live uploads. The warning modal shows the honest count.
  const [modeSwitch, setModeSwitch] = useState<{ target: 'personal' | 'business'; count: number } | null>(null);
  const [switchingMode, setSwitchingMode] = useState(false);
  function toggleDockCollapsed(): void {
    setDockCollapsed((prev) => {
      storeDockCollapsed(!prev);
      return !prev;
    });
  }
  // Mode switch entry: live uploads in the leaving tier first raise the
  // pause-warning modal; an empty tier switches instantly. The server keeps
  // running background work either way — only the UI context changes.
  async function requestModeSwitch(target: 'personal' | 'business'): Promise<void> {
    if (!uiMode || target === uiMode) return;
    try {
      const res = await api.activeUploadJobsCount(uiMode);
      const count = res.status === 200 ? (res.data as { count?: number }).count ?? 0 : 0;
      if (count > 0) {
        setModeSwitch({ target, count });
        return;
      }
    } catch {
      // a failed count must not trap the user in the current mode
    }
    setUiMode(target);
  }
  async function confirmModeSwitch(): Promise<void> {
    if (!modeSwitch || !uiMode) return;
    setSwitchingMode(true);
    let paused = 0;
    try {
      const res = await api.pauseActiveUploads(uiMode);
      paused = res.status === 200 ? (res.data as { paused?: number }).paused ?? 0 : 0;
    } catch {
      // the switch proceeds; the Uploads page shows the durable job states
    }
    setSwitchingMode(false);
    setModeSwitch(null);
    setNotice({ text: plural(locale, t.uiMode.uploadsPaused, paused), page: active });
    setUiMode(modeSwitch.target);
  }
  // Global search over CloudNest-managed files (real data; never a fake index).
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  // FE-12: keyboard-highlighted result index for the combobox
  const [hitIndex, setHitIndex] = useState(-1);
  const [searchOpen, setSearchOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [fileSearch, setFileSearch] = useState<{ text: string; seq: number }>({ text: '', seq: 0 });
  // Escape must close the bell panel and the account menu from anywhere: the
  // per-element handlers only fire when focus sits inside them, which is not
  // where a click-opened menu leaves focus.
  useEffect(() => {
    function onEscape(ev: KeyboardEvent) {
      if (ev.key !== 'Escape') return;
      if (bellOpen) {
        setBellOpen(false);
        return;
      }
      if (accountOpen) {
        setAccountOpen(false);
        document.querySelector<HTMLButtonElement>('.account-chip')?.focus();
      }
    }
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [bellOpen, accountOpen]);

  /** Load the authenticated principal; decides role-aware nav and menus. */
  const refreshMe = async (): Promise<void> => {
    const me = await api.me();
    const data = me.data as {
      authenticated?: boolean;
      role?: 'admin' | 'member';
      username?: string;
      displayName?: string;
      email?: string | null;
    };
    if (data.authenticated === true) {
      setPrincipal({
        role: data.role ?? 'admin',
        username: data.username ?? 'admin',
        displayName: data.displayName ?? data.username ?? 'admin',
        email: data.email ?? null,
      });
      setUsername(data.username ?? 'admin');
    } else {
      setPrincipal(null);
    }
  };

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
        await refreshMe();
        const me = await api.me();
        const authenticated = (me.data as { authenticated?: boolean })?.authenticated === true;
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
      setNotice({
        text: (t.connectResults as Record<string, string | undefined>)[connectResult] ?? t.connectResults.fallback,
        page: 'Cloud Accounts',
      });
      setActive('Cloud Accounts');
      window.history.replaceState({}, '', '/');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the redirect cleanup must not re-run on a language change
  }, [authState]);

  // session-26 F14: a notice never follows the user around — leaving the page
  // it belongs to retires it (the connect-result stays until then, so the
  // honest outcome is actually seen on the page it speaks about).
  useEffect(() => {
    setNotice((current) => (current && current.page !== active ? null : current));
  }, [active]);

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

  // Roadmap Phase 4: the bell's feed — fetched on sign-in, then every minute
  // and whenever the panel opens. Only the principal's own rows exist.
  // Mode = complete context: the bell shows the active tier's events.
  useEffect(() => {
    if (authState !== 'ready' || !uiMode) return;
    let cancelled = false;
    const loadFeed = async (): Promise<void> => {
      try {
        const res = await api.listNotifications(30, 0, uiMode);
        if (cancelled || res.status !== 200) return;
        const data = res.data as { notifications?: FeedItem[]; unreadCount?: number };
        setFeed(data.notifications ?? []);
        setUnreadCount(data.unreadCount ?? 0);
      } catch {
        // the panel keeps its last honest state; the next poll retries
      }
    };
    void loadFeed();
    const timer = window.setInterval(() => void loadFeed(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [authState, bellOpen, uiMode]);

  // Roadmap Phase 4: live transfer snapshot for the topbar icon and the dock —
  // durable rows only, polled modestly. Mode = complete context: the dock
  // shows the active tier's transfers only.
  useEffect(() => {
    if (authState !== 'ready' || !uiMode) return;
    let cancelled = false;
    const loadTransfers = async (): Promise<void> => {
      try {
        const [uploadsRes, downloadsRes] = await Promise.all([
          api.listUploads(uiMode),
          api.listDownloads(50, 0, uiMode),
        ]);
        if (cancelled) return;
        if (uploadsRes.status === 200) {
          const jobs = (uploadsRes.data as { jobs?: Array<{ jobId: string; originalName: string | null; state: string; bytesCompleted: number; sizeBytes: number }> }).jobs ?? [];
          setDockUploads(jobs
            .filter((j) => j.state === 'queued' || j.state === 'running' || j.state === 'paused')
            .map((j) => ({ jobId: j.jobId, fileName: j.originalName, state: j.state, bytesCompleted: j.bytesCompleted, sizeBytes: j.sizeBytes })));
        }
        if (downloadsRes.status === 200) {
          const jobs = (downloadsRes.data as { jobs?: Array<{ jobId: string; fileId: string | null; state: string; requestedBytes: number | null; bytesCompleted: number }> }).jobs ?? [];
          setDockDownloads(jobs
            .filter((j) => j.state === 'queued' || j.state === 'running' || j.state === 'paused')
            .map((j) => ({ jobId: j.jobId, fileId: j.fileId, state: j.state, requestedBytes: j.requestedBytes, bytesCompleted: j.bytesCompleted })));
        }
      } catch {
        // a missed poll keeps the last snapshot; the next one retries
      }
    };
    void loadTransfers();
    const timer = window.setInterval(() => void loadTransfers(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [authState, uiMode]);

  // OAuth callback return (wizard §1): the server redirects to
  // /cloud-accounts?connect=<result>; open that page so the honest result
  // notice is actually seen (today the SPA would silently stay on Dashboard).
  useEffect(() => {
    if (authState !== 'ready') return;
    const result = new URLSearchParams(window.location.search).get('connect');
    if (result) setActive('Cloud Accounts');
  }, [authState]);

  // Search the CloudNest-managed file index server-side (the same list the
  // Files page shows). No cross-provider content search is implied, and
  // nothing is shown before the server answers.
  useEffect(() => {
    const text = query.trim();
    if (authState !== 'ready' || !uiMode || text.length < 2) {
      setHits([]);
      setSearchOpen(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      // mode = complete context: search never surfaces the other tier's files
      api.listFiles(8, 0, text, undefined, uiMode)
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
  }, [query, authState, uiMode]);

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
    setPrincipal(null);
    setProfileOpen(false);
    setAuthState('login');
  }

  // Roadmap Phase 3: members work with their own files only; Cloud Accounts
  // and Settings are admin surfaces and stay out of their navigation.
  const isAdmin = principal?.role === 'admin';
  const visibleNav = NAV_ITEMS.filter((item) => isAdmin || (item !== 'Cloud Accounts' && item !== 'Settings'));

  function goToUsers(): void {
    setSettingsSection('users');
    setActive('Settings');
    setAccountOpen(false);
  }

  if (authState === 'setup') {
    return (
      <FirstRunPage
        onDone={async () => {
          // the form just authenticated this session: load the principal
          // before the shell renders, so role-aware nav is correct at once
          try { await refreshMe(); } catch { /* fall back to defaults */ }
          setAuthState('ready');
        }}
      />
    );
  }
  if (authState === 'login') {
    // The entry page renders the server-unreachable state itself (localized).
    return (
      <LoginPage
        onDone={async () => {
          // same as first-run: the principal decides nav, menus and scopes
          try { await refreshMe(); } catch { /* fall back to defaults */ }
          setAuthState('ready');
        }}
        serverError={serverError}
      />
    );
  }
  if (authState === 'loading') {
    return <div className="auth-card">{t.shell.loading}</div>;
  }
  // First login on this browser: ask once how the person will use the app.
  // A UI preference, not a security boundary — switchable from the sidebar.
  if (!uiMode) {
    return <ModeChooser onChoose={setUiMode} />;
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
          <button
            type="button"
            className="mobile-nav-toggle"
            aria-label={mobileNavOpen ? t.common.close : t.nav.aria}
            aria-expanded={mobileNavOpen}
            aria-controls="primary-navigation"
            onClick={() => setMobileNavOpen((open) => !open)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && mobileNavOpen) {
                setMobileNavOpen(false);
              }
            }}
          >
            {mobileNavOpen ? <X size={19} aria-hidden="true" /> : <Menu size={19} aria-hidden="true" />}
          </button>
        </div>
        <nav
          id="primary-navigation"
          className={`nav${mobileNavOpen ? ' is-open' : ''}`}
          aria-label={t.nav.aria}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && mobileNavOpen) {
              setMobileNavOpen(false);
              document.querySelector<HTMLButtonElement>('.mobile-nav-toggle')?.focus();
            }
          }}
        >
          {visibleNav.map((item) => {
            const Icon = NAV_ICONS[item];
            return (
              <button
                key={item}
                type="button"
                className={`nav-item${active === item ? ' active' : ''}`}
                aria-current={active === item ? 'page' : undefined}
                onClick={() => {
                  setActive(item);
                  setMobileNavOpen(false);
                  if (window.matchMedia('(max-width: 767px)').matches) {
                    document.querySelector<HTMLButtonElement>('.mobile-nav-toggle')?.focus();
                  }
                }}
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
          {/* UI mode switch: personal vs business provider surfaces — the same
              preference the post-login chooser sets, changeable anytime. */}
          <div className="mode-pill" role="group" aria-label={t.uiMode.switchAria}>
            <button
              type="button"
              className={`mode-seg${uiMode === 'personal' ? ' active' : ''}`}
              aria-pressed={uiMode === 'personal'}
              onClick={() => void requestModeSwitch('personal')}
            >
              {t.uiMode.personal}
            </button>
            <button
              type="button"
              className={`mode-seg${uiMode === 'business' ? ' active' : ''}`}
              aria-pressed={uiMode === 'business'}
              onClick={() => void requestModeSwitch('business')}
            >
              {t.uiMode.business}
            </button>
          </div>
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
          {/* Roadmap Phase 4 (§4.2): a small live-transfer indicator next to
              the bell, fed by the same durable rows as the dock. */}
          {(dockUploads.length > 0 || dockDownloads.length > 0) && (
            <button
              type="button"
              className="transfer-indicator"
              aria-label={tf(t.shell.transfers.activeAria, { count: dockUploads.length + dockDownloads.length })}
              title={tf(t.shell.transfers.activeAria, { count: dockUploads.length + dockDownloads.length })}
              onClick={() => setActive('Uploads')}
            >
              <CloudUpload size={15} aria-hidden="true" />
              <span className="transfer-count">{dockUploads.length + dockDownloads.length}</span>
            </button>
          )}
          <div className="bell-menu">
            <button
              type="button"
              className="bell-btn"
              aria-haspopup="dialog"
              aria-expanded={bellOpen}
              aria-label={unreadCount > 0 ? tf(t.shell.bell.unreadAria, { count: unreadCount }) : t.shell.bell.label}
              title={t.shell.bell.label}
              onClick={() => setBellOpen((open) => !open)}
            >
              <Bell size={17} aria-hidden="true" />
              {unreadCount > 0 && (
                <span className="bell-badge" aria-hidden="true">{unreadCount > 9 ? '9+' : unreadCount}</span>
              )}
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
                  {feed.length === 0 ? (
                    <EmptyState
                      icon={Bell}
                      title={t.shell.bell.emptyTitle}
                      body={t.shell.bell.emptyBody}
                    />
                  ) : (
                    <>
                      <div className="bell-head">
                        <span className="muted small">{t.shell.bell.title}</span>
                        {unreadCount > 0 && (
                          <button
                            type="button"
                            className="btn-inline"
                            onClick={() => {
                              void api.markAllNotificationsRead().then(() => {
                                setUnreadCount(0);
                                setFeed((prev) => prev.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
                              }).catch(() => undefined);
                            }}
                          >
                            {t.shell.bell.markAllRead}
                          </button>
                        )}
                      </div>
                      <ul className="bell-feed">
                        {feed.map((item) => (
                          <li key={item.id} className={`bell-item${item.readAt === null ? ' unread' : ''}`}>
                            <span className="bell-item-icon" aria-hidden="true">
                              {item.kind === 'upload_completed' && <CheckCircle2 size={15} />}
                              {item.kind === 'share_used' && <Link size={15} />}
                              {item.kind === 'quota_stale' && <AlertTriangle size={15} />}
                            </span>
                            <span className="bell-item-text">
                              {feedItemLine(t, tf, item)}
                              <span className="muted small">{formatDateTime(item.createdAt)}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
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
                <span className="muted">
                  {principal?.role === 'member' ? t.shell.account.roleMember : t.shell.account.role}
                </span>
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
                  {/* Roadmap Phase 3 (§4.3): Profile for every principal,
                      Users for admins only, then Sign out. */}
                  <button
                    type="button"
                    role="menuitem"
                    className="account-item"
                    onClick={() => { setAccountOpen(false); setProfileOpen(true); }}
                  >
                    <UserRound size={15} aria-hidden="true" />
                    <span>{t.shell.account.profile}</span>
                  </button>
                  {isAdmin && (
                    <button
                      type="button"
                      role="menuitem"
                      className="account-item"
                      onClick={goToUsers}
                    >
                      <UsersRound size={15} aria-hidden="true" />
                      <span>{t.shell.account.users}</span>
                    </button>
                  )}
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
        <main className={`content${dockCollapsed ? '' : ' content-dock-reserve'}`}>
          {notice && notice.page === active && (
            <div className="card notice-card" role="status">
              <p>{notice.text}</p>
            </div>
          )}
          {active === 'Settings' ? (
            <SettingsPage
              key={settingsSection}
              initialSection={settingsSection}
              onGoToCloudAccounts={() => setActive('Cloud Accounts')}
            />
          ) : active === 'Cloud Accounts' ? (
            <CloudAccountsPage onGoToSettings={() => setActive('Settings')} />
          ) : active === 'Uploads' ? (
            <UploadsPage />
          ) : active === 'Files' ? (
            <FilesPage
              key={fileSearch.seq}
              initialSearch={fileSearch.text}
              {...(isAdmin ? { onGoToCloudAccounts: () => setActive('Cloud Accounts') } : {})}
              onGoToUploads={() => setActive('Uploads')}
            />
          ) : active === 'Downloads' ? (
            <DownloadsPage />
          ) : active === 'Shared Links' ? (
            <SharedLinksPage />
          ) : active === 'Dashboard' ? (
            <DashboardPage isMember={!isAdmin} onNavigate={(page) => setActive(page)} />
          ) : (
            <section className="card placeholder-card">
              <h1>{navLabel(active)}</h1>
              <p>{t.shell.notImplemented}</p>
            </section>
          )}
        </main>
      </div>
    </div>
    {profileOpen && principal && (
      <Dialog title={t.profile.title} onClose={() => setProfileOpen(false)}>
        <div className="upload-form">
          <p><strong>{t.profile.account}:</strong> {principal.role === 'member' ? principal.email : principal.username}</p>
          <p>
            <strong>{t.profile.role}:</strong>{' '}
            {principal.role === 'member' ? t.shell.account.roleMember : t.shell.account.role}
          </p>
        </div>
        {/* Real, working password change for every principal kind: the
            endpoint serves the root admin and users-table accounts alike;
            it re-authenticates the current session, so no logout is needed. */}
        <ChangePasswordPanel onDone={() => setProfileOpen(false)} />
      </Dialog>
    )}
    <ConfirmHost />
    {/* Mode = complete context: the switch warning — Pause (never cancel) the
        leaving tier's live uploads; background server work keeps running. */}
    {modeSwitch && (
      <Dialog
        title={t.uiMode.switchConfirmTitle}
        role="alertdialog"
        onClose={() => { if (!switchingMode) setModeSwitch(null); }}
        footer={
          <>
            <button
              type="button"
              className="btn-secondary"
              disabled={switchingMode}
              onClick={() => setModeSwitch(null)}
            >
              {t.uiMode.switchStay}
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={switchingMode}
              onClick={() => void confirmModeSwitch()}
            >
              {t.uiMode.switchPauseAndSwitch}
            </button>
          </>
        }
      >
        <div className="upload-form">
          <p><strong>{plural(locale, t.uiMode.activeUploads, modeSwitch.count)}</strong></p>
          <p>{t.uiMode.switchConfirmBody}</p>
        </div>
      </Dialog>
    )}
    {/* Roadmap Phase 4 (§4.2): the transfer dock follows every page. */}
    <TransferDock
      uploads={dockUploads}
      downloads={dockDownloads}
      onOpenUploads={() => setActive('Uploads')}
      onOpenDownloads={() => setActive('Downloads')}
      collapsed={dockCollapsed}
      onToggleCollapsed={toggleDockCollapsed}
    />
    </FileActionsProvider>
    </ToastProvider>
  );
}
