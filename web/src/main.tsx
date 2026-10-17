import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { AcceptInvitePage } from './pages/EntryPage.js';
import { I18nProvider } from './i18n-context.js';
import { UiModeProvider } from './ui-mode-context.js';
// Self-hosted Inter (OFL-licensed, no CDN) — the reference design's typeface.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

// Roadmap Phase 3: the one-time invite/reset URL is its own top-level route —
// it must render for a visitor with no session at all. Anything else is the
// app shell.
const isAcceptRoute = window.location.pathname === '/accept-invite';

createRoot(container).render(
  <StrictMode>
    {/* One i18n instance above everything: entry page, shell and all pages
        share a single language preference (persisted UI preference). The UI
        mode (personal vs business provider surfaces) is the same kind of
        per-browser preference, chosen once after login. */}
    <I18nProvider>
      <UiModeProvider>
        {isAcceptRoute ? (
          <AcceptInvitePage
            onDone={() => {
              window.history.replaceState({}, '', '/');
              window.location.assign('/');
            }}
          />
        ) : (
          <App />
        )}
      </UiModeProvider>
    </I18nProvider>
  </StrictMode>,
);
