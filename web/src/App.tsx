import { useEffect, useState } from 'react';
import { api, refreshCsrfToken } from './api.js';
import { FirstRunPage, LoginPage, ChangePasswordPanel } from './pages/AuthPages.js';

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
    let cancelled = false;
    fetch('/api/health')
      .then((res) => res.json() as Promise<Health>)
      .then((data) => !cancelled && setHealth(data))
      .catch(() => !cancelled && setHealth(null));
    return () => {
      cancelled = true;
    };
  }, [authState]);

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
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">☁</span>
          <span className="brand-name">CloudNest</span>
        </div>
        <nav className="nav" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => (
            <button
              key={item}
              type="button"
              className={`nav-item${active === item ? ' active' : ''}`}
              aria-current={active === item ? 'page' : undefined}
              onClick={() => setActive(item)}
            >
              {item}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={health ? 'status-dot status-ok' : 'status-dot status-down'} aria-hidden="true" />
          <span className="status-text">
            {health ? `Local server: connected (v${health.version})` : 'Local server: not connected'}
          </span>
          <button type="button" className="btn-logout" onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <input
            className="search"
            type="search"
            placeholder="Search (available in a later step)"
            aria-label="Global search"
            disabled
          />
        </header>
        <main className="content">
          {notice && (
            <div className="card notice-card" role="status">
              <p>{notice}</p>
            </div>
          )}
          {active === 'Settings' ? (
            <>
              <h1 className="page-title">Settings</h1>
              <ChangePasswordPanel onDone={(message) => setNotice(message)} />
              <section className="card">
                <h2>Other settings</h2>
                <p className="muted">Not implemented yet. These controls will arrive in a later step.</p>
              </section>
            </>
          ) : active !== 'Dashboard' ? (
            <section className="card placeholder-card">
              <h1>{active}</h1>
              <p>Not implemented yet. This section will arrive in a later step.</p>
            </section>
          ) : (
            <>
              <h1 className="page-title">Dashboard</h1>
              <section className="card">
                <h2>Storage overview</h2>
                <p className="muted">No cloud accounts connected yet.</p>
                <p className="muted">Storage usage will appear here after you connect accounts in a later step.</p>
              </section>
              <section className="card">
                <h2>Uploads</h2>
                <p className="muted">Uploads will be available in a later step.</p>
              </section>
              <section className="card">
                <h2>Recent files</h2>
                <p className="muted">No files yet. Files you upload in a later step will appear here.</p>
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
