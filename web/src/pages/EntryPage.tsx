/**
 * Entry page (login / first-run setup) — implements
 * CloudNest-LOGIN-PAGE-REFERENCE-SPEC.md with the owner-approved screenshot as
 * the visual target.
 *
 * Product truth over the mock: the server authenticates exactly one local
 * administrator (username fixed at setup to "admin"), so the form keeps a
 * read-only Username field; there is no remember-me session distinction, no
 * password-recovery flow, no second sign-in method, and no public signup — the
 * reference's "Remember me", "Forgot password?", "OR"/secondary action, and
 * "Create one" are therefore omitted instead of faked (spec §8.5–§8.8).
 *
 * Reuses the existing theme mechanism (theme.ts, no-flash bootstrap), the
 * existing CSRF-aware api client, the existing setup/login flows, and the
 * provider marks from ProviderLogo — only the entry layout itself is new and
 * scoped behind `entry-` CSS classes so the dashboard is untouched.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowRight, Check, ChevronDown, Cloud, Eye, EyeOff, Globe, Lock, Menu, Monitor,
  ShieldCheck, Sun, Moon, User, Zap,
} from 'lucide-react';
import { api, refreshCsrfToken } from '../api.js';
import { interpolate, type EntryStrings } from '../i18n.js';
import { useI18n } from '../i18n-context.js';
import { LanguageMenu } from '../components/LanguageMenu.js';
import { applyTheme, currentTheme, type Theme } from '../theme.js';

const REPO_URL = 'https://github.com/cloudnest-open/CloudNest';
const DOCS_URL = 'https://github.com/cloudnest-open/CloudNest#readme';
const SUPPORT_URL = 'https://github.com/cloudnest-open/CloudNest/issues';
const PRIVACY_URL = 'https://github.com/cloudnest-open/CloudNest/blob/main/SECURITY.md';

/** The approved CloudNest cloud mark, reused from the app's sidebar brand. */
function BrandLockup({ markSize, className }: { markSize: number; className: string }) {
  return (
    <span className={`entry-lockup ${className}`}>
      <Cloud size={markSize} strokeWidth={2.3} className="entry-lockup-mark" aria-hidden="true" />
      <span className="entry-wordmark">
        Cloud<span className="entry-wordmark-accent">Nest</span>
      </span>
    </span>
  );
}

function ThemePill({ theme, onSet, t }: { theme: Theme; onSet: (next: Theme) => void; t: EntryStrings }) {
  return (
    <div className="entry-theme-pill" role="group" aria-label={theme === 'light' ? t.theme.toDark : t.theme.toLight}>
      <button
        type="button"
        className={`entry-theme-seg${theme === 'light' ? ' active' : ''}`}
        aria-pressed={theme === 'light'}
        aria-label={t.theme.toLight}
        title={t.theme.toLight}
        onClick={() => onSet('light')}
      >
        <Sun size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`entry-theme-seg${theme === 'dark' ? ' active' : ''}`}
        aria-pressed={theme === 'dark'}
        aria-label={t.theme.toDark}
        title={t.theme.toDark}
        onClick={() => onSet('dark')}
      >
        <Moon size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

function EntryHeader({ e, theme, onSetTheme }: {
  e: EntryStrings;
  theme: Theme;
  onSetTheme: (next: Theme) => void;
}) {
  const navLinks = (
    <>
      <a className="entry-nav-link active" href="#entry-top" aria-current="page">{e.nav.home}</a>
      <a className="entry-nav-link" href="#entry-features">{e.nav.features}</a>
      <a className="entry-nav-link" href={DOCS_URL} target="_blank" rel="noreferrer">{e.nav.documentation}</a>
      <a className="entry-nav-link" href={SUPPORT_URL} target="_blank" rel="noreferrer">{e.nav.support}</a>
    </>
  );
  return (
    <header className="entry-header" id="entry-top">
      <a className="entry-brand" href="#entry-top" aria-label="CloudNest">
        <BrandLockup markSize={34} className="entry-lockup-header" />
      </a>
      <nav className="entry-nav" aria-label={e.nav.aria}>{navLinks}</nav>
      <details className="entry-mobile-nav">
        <summary aria-label={e.nav.aria}><Menu size={19} aria-hidden="true" /></summary>
        <div className="entry-mobile-nav-panel">{navLinks}</div>
      </details>
      <div className="entry-header-actions">
        <ThemePill theme={theme} onSet={onSetTheme} t={e} />
        <LanguageMenu variant="entry" />
      </div>
    </header>
  );
}

function FeatureRow({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) {
  return (
    <li className="entry-feature">
      <span className="entry-feature-icon" aria-hidden="true">{icon}</span>
      <span className="entry-feature-text">
        <strong>{title}</strong>
        <small>{desc}</small>
      </span>
    </li>
  );
}

function GitHubMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
      />
    </svg>
  );
}

/**
 * Decorative hero illustration, recreated as vector art (no screenshot crop,
 * no remote asset). Purely decorative: aria-hidden, no interactive parts, and
 * the mini file-manager is artwork — never live status. The sync badge text is
 * localized; the tiny mock sidebar labels stay as reference artwork.
 */
function HeroIllustration({ synced, secure }: { synced: string; secure: string }) {
  const CLOUD_PATH = 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z';
  const tiles: Array<{ key: string; x: number; y: number; rot: number; mark: ReactNode }> = [
    {
      key: 'drive', x: 88, y: 44, rot: -8,
      mark: (
        <g transform="translate(17 20) scale(0.44)">
          <path fill="#0066da" d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" />
          <path fill="#00ac47" d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0-1.2 4.5h27.5z" />
          <path fill="#ea4335" d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.5l5.85 11.5z" />
          <path fill="#00832d" d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" />
          <path fill="#2684fc" d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" />
          <path fill="#ffba00" d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" />
        </g>
      ),
    },
    {
      key: 'dropbox', x: 178, y: 8, rot: 6,
      mark: (
        <g transform="translate(18 18) scale(1.5)">
          <path
            fill="#0061FF"
            d="M6 1.807 0 5.629l6 3.822 6.001-3.822L6 1.807zM18 1.807l-6 3.822 6 3.822 6-3.822-6-3.822zM0 13.274l6 3.822 6.001-3.822L6 9.452l-6 3.822zM18 9.452l-6 3.822 6 3.822 6-3.822-6-3.822zM6 18.371l6.001 3.822 6-3.822-6-3.822L6 18.371z"
          />
        </g>
      ),
    },
    {
      key: 'onedrive', x: 300, y: 36, rot: -5,
      mark: (
        <g transform="translate(15 19) scale(1.75)">
          <path fill="#0364B8" d="M14.5 6.5a5.5 5.5 0 0 0-10.36 2.03A4.25 4.25 0 0 0 4.75 17h13.5a3.75 3.75 0 0 0 .87-7.4 5.5 5.5 0 0 0-4.62-3.1z" />
        </g>
      ),
    },
    {
      key: 'pcloud', x: 352, y: 128, rot: 7,
      mark: (
        <g transform="translate(16 16) scale(1.667)">
          <circle cx="12" cy="12" r="11" fill="#14A5E5" />
          <path fill="#fff" d="M10 6.6h3.1a4.1 4.1 0 0 1 0 8.2H12.1v2.6H10V6.6zm2.1 2.2v3.8h1a1.9 1.9 0 0 0 0-3.8h-1z" />
        </g>
      ),
    },
    {
      key: 'mega', x: 378, y: 222, rot: -6,
      mark: (
        <g transform="translate(16 16) scale(1.667)">
          <circle cx="12" cy="12" r="11" fill="#D9272E" />
          <path fill="#fff" d="M6.4 16.5v-8l3.3 3.9 2.3-2.7 2.3 2.7 3.3-3.9v8h-2.2v-3.4l-3.4 3.8-3.4-3.8v3.4H6.4z" />
        </g>
      ),
    },
  ];
  const navRows = ['Dashboard', 'Files', 'Cloud Accounts', 'Uploads', 'Settings'];
  return (
    <svg className="entry-illu" viewBox="0 0 460 590" aria-hidden="true" focusable="false">
      <defs>
        <filter id="cnillu-shadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="10" stdDeviation="14" floodColor="#2E6FD8" floodOpacity="0.16" />
        </filter>
        <filter id="cnillu-shadow-soft" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="6" stdDeviation="9" floodColor="#2E6FD8" floodOpacity="0.12" />
        </filter>
      </defs>

      {/* dotted orbit + soft background clouds */}
      <circle className="entry-illu-orbit" cx="225" cy="185" r="148" fill="none" strokeWidth="1.6" strokeDasharray="2 7" />
      <g className="entry-illu-blobs">
        <ellipse cx="66" cy="118" rx="56" ry="24" opacity="0.85" />
        <ellipse cx="416" cy="76" rx="48" ry="20" opacity="0.7" />
        <ellipse cx="38" cy="430" rx="58" ry="26" opacity="0.7" />
        <ellipse cx="428" cy="492" rx="50" ry="22" opacity="0.7" />
      </g>

      {/* central upload cloud */}
      <g transform="translate(136 100) scale(8)" filter="url(#cnillu-shadow)">
        <path className="entry-illu-cloud" d={CLOUD_PATH} strokeWidth="0.42" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <path
        className="entry-illu-arrow"
        d="M228 140 l21 23 h-12 v25 a4.5 4.5 0 0 1 -4.5 4.5 h-9 a4.5 4.5 0 0 1 -4.5 -4.5 v-25 h-12 z"
      />

      {/* tilted file-manager card (decorative) */}
      <g transform="rotate(-8 230 414)" filter="url(#cnillu-shadow)">
        <rect className="entry-illu-card" x="28" y="268" width="404" height="292" rx="18" />
        <g transform="translate(46 278) scale(1.3)">
          <path className="entry-illu-minicloud" d={CLOUD_PATH} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </g>
        <text className="entry-illu-ink" x="84" y="297" fontSize="13" fontWeight="700">
          Cloud<tspan className="entry-illu-accent">Nest</tspan>
        </text>
        <circle className="entry-illu-dot" cx="404" cy="291" r="3.4" />
        <circle className="entry-illu-dot" cx="416" cy="291" r="3.4" />
        <circle className="entry-illu-dot" cx="428" cy="291" r="3.4" />
        <line className="entry-illu-line-soft" x1="28" y1="314" x2="432" y2="314" />
        <rect className="entry-illu-panel" x="44" y="326" width="106" height="222" rx="12" />
        {navRows.map((label, i) => (
          <g key={label}>
            {i === 0 && <rect className="entry-illu-active" x="52" y={336 + i * 27} width="90" height="20" rx="6" />}
            <rect className={i === 0 ? 'entry-illu-accent' : 'entry-illu-dot'} x={58} y={342 + i * 27} width="8" height="8" rx="2" />
            <text
              className={i === 0 ? 'entry-illu-accent' : 'entry-illu-ink-muted'}
              x={72}
              y={350 + i * 27}
              fontSize="8.5"
              fontWeight={i === 0 ? 600 : 500}
            >
              {label}
            </text>
          </g>
        ))}
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <g key={i} transform={`translate(0 ${318 + i * 42})`}>
            <path
              className="entry-illu-folder"
              d={`M176 ${i === 0 ? 14 : 16} h8 l3 4 h11 a3 3 0 0 1 3 3 v8 a3 3 0 0 1 -3 3 h-22 a3 3 0 0 1 -3 -3 v-12 a3 3 0 0 1 3 -3 z`}
            />
            <rect className="entry-illu-row1" x="214" y={i === 0 ? 16 : 18} width="118" height="6" rx="3" />
            <rect className="entry-illu-row2" x="214" y={i === 0 ? 27 : 29} width="82" height="5" rx="2.5" />
            <rect className="entry-illu-dot" x="396" y={i === 0 ? 18 : 20} width="16" height="9" rx="4.5" />
          </g>
        ))}
      </g>

      {/* floating provider identity tiles */}
      {tiles.map((tile) => (
        <g key={tile.key} transform={`translate(${tile.x} ${tile.y}) rotate(${tile.rot} 36 36)`} filter="url(#cnillu-shadow-soft)">
          <rect className="entry-illu-card" width="72" height="72" rx="18" />
          {tile.mark}
        </g>
      ))}

      {/* sync/security badge (translated, still decorative) */}
      <g transform="rotate(-8 230 414)">
        <rect className="entry-illu-card" x="268" y="496" width="184" height="54" rx="14" filter="url(#cnillu-shadow-soft)" />
        <g transform="translate(284 510) scale(1.1)">
          <path
            className="entry-illu-shield"
            d="M12 2 4.5 5v6c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V5L12 2z"
          />
          <path d="m9 11.5 2.2 2.2 4-4.4" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </g>
        <text className="entry-illu-success" x="308" y="521" fontSize="11" fontWeight="600">{synced}</text>
        <text className="entry-illu-ink-muted" x="308" y="538" fontSize="9.5">{secure}</text>
      </g>
    </svg>
  );
}

function EntryHero({ e }: { e: EntryStrings }) {
  return (
    <section className="entry-hero" aria-labelledby="entry-headline">
      <div className="entry-hero-copy">
        <p className="entry-badge">
          <Cloud size={14} strokeWidth={2.4} aria-hidden="true" />
          {e.badge}
        </p>
        <h1 className="entry-headline" id="entry-headline">
          {e.headline.line1}
          <br />
          <span className="entry-headline-accent">{e.headline.accent}</span> {e.headline.rest}
        </h1>
        <p className="entry-paragraph">{e.paragraph}</p>
        <ul className="entry-features" id="entry-features" aria-label={e.features.aria}>
          <FeatureRow icon={<Cloud size={24} strokeWidth={1.9} />} title={e.features.providers.title} desc={e.features.providers.desc} />
          <FeatureRow icon={<ShieldCheck size={24} strokeWidth={1.9} />} title={e.features.secure.title} desc={e.features.secure.desc} />
          <FeatureRow icon={<Zap size={24} strokeWidth={1.9} />} title={e.features.fast.title} desc={e.features.fast.desc} />
          <FeatureRow icon={<Monitor size={24} strokeWidth={1.9} />} title={e.features.anywhere.title} desc={e.features.anywhere.desc} />
        </ul>
        <a className="entry-oss" href={REPO_URL} target="_blank" rel="noreferrer">
          <span className="entry-oss-mark" aria-hidden="true"><GitHubMark size={22} /></span>
          <span className="entry-oss-text">
            <strong>{e.oss.title}</strong>
            <small>{e.oss.desc}</small>
          </span>
          <ArrowRight size={18} className="entry-oss-arrow" aria-hidden="true" />
          <span className="visually-hidden">{e.oss.cta}</span>
        </a>
      </div>
      <div className="entry-hero-art" aria-hidden="true">
        <HeroIllustration synced={e.illu.synced} secure={e.illu.secure} />
      </div>
    </section>
  );
}

function PasswordField({ id, label, value, onChange, autoComplete, minLength, e }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  minLength?: number;
  e: EntryStrings;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="entry-field">
      <Lock size={17} className="entry-field-icon" aria-hidden="true" />
      <input
        id={id}
        className="entry-input entry-input-password"
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={label}
        aria-label={label}
        autoComplete={autoComplete}
        minLength={minLength}
        required
      />
      <button
        type="button"
        className="entry-field-trail"
        aria-label={show ? e.login.eyeHide : e.login.eyeShow}
        aria-pressed={show}
        onClick={() => setShow((current) => !current)}
      >
        {show ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
      </button>
    </div>
  );
}

function LoginForm({ e, serverUnreachable, onDone }: { e: EntryStrings; serverUnreachable: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { status, data } = await api.login(password);
      if (status === 200) {
        setPassword('');
        await refreshCsrfToken();
        onDone();
        return;
      }
      setError(
        status === 401
          ? e.login.errorInvalid
          : status === 429
            ? e.login.errorTooMany
            : (data as { error?: string })?.error ?? e.login.errorInvalid,
      );
    } catch {
      setError(e.login.errorNetwork);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="entry-form" onSubmit={submit}>
      <div className="entry-field">
        <User size={17} className="entry-field-icon" aria-hidden="true" />
        <input
          id="login-username"
          className="entry-input"
          type="text"
          value="admin"
          readOnly
          aria-label={e.login.username}
          autoComplete="username"
        />
      </div>
      <PasswordField
        id="login-password"
        label={e.login.password}
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        e={e}
      />
      {serverUnreachable && (
        <p className="entry-error" role="alert">{e.login.errorNetwork}</p>
      )}
      {error && (
        <p className="entry-error" role="alert">{error}</p>
      )}
      <button type="submit" className="entry-submit" disabled={busy}>
        {busy ? <span className="entry-spinner" aria-hidden="true" /> : <ArrowRight size={17} aria-hidden="true" />}
        <span>{busy ? e.login.submitting : e.login.submit}</span>
      </button>
    </form>
  );
}

function SetupForm({ e, serverUnreachable, onDone }: { e: EntryStrings; serverUnreachable: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { status, data } = await api.setup(password);
      if (status === 201) {
        setPassword('');
        setConfirm('');
        await refreshCsrfToken();
        onDone();
        return;
      }
      setError((data as { error?: string })?.error ?? e.setup.errorFallback);
    } catch {
      setError(e.login.errorNetwork);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="entry-form" onSubmit={submit}>
      <PasswordField
        id="setup-password"
        label={e.setup.password}
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        minLength={12}
        e={e}
      />
      <PasswordField
        id="setup-confirm"
        label={e.setup.confirm}
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        minLength={12}
        e={e}
      />
      {serverUnreachable && (
        <p className="entry-error" role="alert">{e.login.errorNetwork}</p>
      )}
      {error && (
        <p className="entry-error" role="alert">{error}</p>
      )}
      <button type="submit" className="entry-submit" disabled={busy}>
        {busy ? <span className="entry-spinner" aria-hidden="true" /> : <ArrowRight size={17} aria-hidden="true" />}
        <span>{busy ? e.setup.submitting : e.setup.submit}</span>
      </button>
    </form>
  );
}

function EntryFooter({ e, theme, onSetTheme }: { e: EntryStrings; theme: Theme; onSetTheme: (next: Theme) => void }) {
  const [health, setHealth] = useState<'ok' | 'unverified'>('unverified');
  useEffect(() => {
    let cancelled = false;
    // Truthful status: the footer's green dot only appears when this instance's
    // own health endpoint reports ok; otherwise a neutral fallback is shown.
    fetch('/api/health')
      .then((res) => res.json())
      .then((data: { status?: string }) => {
        if (!cancelled) setHealth(data?.status === 'ok' ? 'ok' : 'unverified');
      })
      .catch(() => {
        if (!cancelled) setHealth('unverified');
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <footer className="entry-footer">
      <div className="entry-footer-brand">
        <BrandLockup markSize={26} className="entry-lockup-footer" />
        <p className="entry-footer-tagline">{e.footer.tagline}</p>
      </div>
      <nav className="entry-footer-links" aria-label={e.nav.aria}>
        <a href={REPO_URL} target="_blank" rel="noreferrer">{e.footer.about}</a>
        <a href={DOCS_URL} target="_blank" rel="noreferrer">{e.footer.documentation}</a>
        <a href={SUPPORT_URL} target="_blank" rel="noreferrer">{e.footer.support}</a>
        <a href={PRIVACY_URL} target="_blank" rel="noreferrer">{e.footer.privacy}</a>
      </nav>
      <div className="entry-footer-status">
        <span className={`entry-status${health === 'ok' ? ' ok' : ''}`}>
          <span className="entry-status-dot" aria-hidden="true" />
          {health === 'ok' ? e.footer.operational : e.footer.selfHosted}
        </span>
        <ThemePill theme={theme} onSet={onSetTheme} t={e} />
        <span className="entry-footer-rights">{interpolate(e.footer.rights, { year: new Date().getFullYear() })}</span>
      </div>
    </footer>
  );
}

export function LoginPage({ onDone, serverError }: { onDone: () => void; serverError?: string | null }) {
  // One shared language preference/instance — the same the shell and every
  // page use, so the login choice simply continues after authentication.
  const { e } = useI18n();
  const [theme, setThemeState] = useState<Theme>(() => currentTheme());
  function setTheme(next: Theme): void {
    applyTheme(next);
    setThemeState(next);
  }
  return (
    <div className="entry-page">
      <EntryHeader e={e} theme={theme} onSetTheme={setTheme} />
      <main className="entry-main">
        <section className="entry-auth" aria-labelledby="entry-auth-title">
          <div className="entry-auth-content">
            <BrandLockup markSize={52} className="entry-lockup-panel" />
            <h2 className="entry-auth-title" id="entry-auth-title">{e.login.welcome}</h2>
            <p className="entry-auth-subtitle">{e.login.subtitle}</p>
            <LoginForm e={e} serverUnreachable={serverError != null} onDone={onDone} />
          </div>
        </section>
        <EntryHero e={e} />
      </main>
      <EntryFooter e={e} theme={theme} onSetTheme={setTheme} />
    </div>
  );
}

export function FirstRunPage({ onDone, serverError }: { onDone: () => void; serverError?: string | null }) {
  const { e } = useI18n();
  const [theme, setThemeState] = useState<Theme>(() => currentTheme());
  function setTheme(next: Theme): void {
    applyTheme(next);
    setThemeState(next);
  }
  return (
    <div className="entry-page">
      <EntryHeader e={e} theme={theme} onSetTheme={setTheme} />
      <main className="entry-main">
        <section className="entry-auth" aria-labelledby="entry-auth-title">
          <div className="entry-auth-content">
            <BrandLockup markSize={52} className="entry-lockup-panel" />
            <h2 className="entry-auth-title" id="entry-auth-title">{e.setup.title}</h2>
            <p className="entry-auth-subtitle">{e.setup.subtitle}</p>
            <SetupForm e={e} serverUnreachable={serverError != null} onDone={onDone} />
          </div>
        </section>
        <EntryHero e={e} />
      </main>
      <EntryFooter e={e} theme={theme} onSetTheme={setTheme} />
    </div>
  );
}
