import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { I18nProvider } from './i18n-context.js';
// Self-hosted Inter (OFL-licensed, no CDN) — the reference design's typeface.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');
createRoot(container).render(
  <StrictMode>
    {/* One i18n instance above everything: entry page, shell and all pages
        share a single language preference (persisted UI preference). */}
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
