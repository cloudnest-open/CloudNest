import { useEffect, useState } from 'react';

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

interface Health {
  status: string;
  version: string;
}

export default function App() {
  const [active, setActive] = useState<NavItem>('Dashboard');
  const [health, setHealth] = useState<Health | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/health')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<Health>;
      })
      .then((data) => {
        if (!cancelled) {
          setHealth(data);
          setServerError(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHealth(null);
          setServerError('Cannot reach the local server. Is CloudNest running?');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
          <span
            className={
              health ? 'status-dot status-ok' : 'status-dot status-down'
            }
            aria-hidden="true"
          />
          <span className="status-text">
            {health
              ? `Local server: connected (v${health.version})`
              : 'Local server: not connected'}
          </span>
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
          {active !== 'Dashboard' ? (
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
              {serverError && (
                <section className="card error-card" role="alert">
                  <p>{serverError}</p>
                </section>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
