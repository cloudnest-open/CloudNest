/**
 * Post-login mode chooser — the one-time "how will you use CloudNest?" screen.
 * Shown when no UI mode is stored yet (first login on this browser); the mode
 * is a UI preference (which provider surfaces show), changeable anytime from
 * the sidebar, never a security boundary. Visual language follows the entry
 * page (entry-lockup-style brand mark + two large cards), scoped behind
 * `mode-` CSS classes so nothing else moves.
 */
import { Building2, Cloud } from 'lucide-react';
import { useI18n } from '../i18n-context.js';
import type { UiMode } from '../ui-mode.js';

export function ModeChooser({ onChoose }: { onChoose: (mode: UiMode) => void }) {
  const { t } = useI18n();
  return (
    <div className="mode-page">
      <div className="mode-panel">
        <div className="mode-brand" aria-hidden="true">
          <Cloud size={30} strokeWidth={2.2} />
        </div>
        <h1 className="mode-title">{t.uiMode.chooserTitle}</h1>
        <p className="mode-desc">{t.uiMode.chooserDesc}</p>
        <div className="mode-cards" role="group" aria-label={t.uiMode.switchAria}>
          <button type="button" className="mode-card" onClick={() => onChoose('personal')}>
            <Cloud size={30} strokeWidth={1.8} aria-hidden="true" />
            <strong>{t.uiMode.personal}</strong>
            <small>{t.uiMode.personalDesc}</small>
          </button>
          <button type="button" className="mode-card" onClick={() => onChoose('business')}>
            <Building2 size={30} strokeWidth={1.8} aria-hidden="true" />
            <strong>{t.uiMode.business}</strong>
            <small>{t.uiMode.businessDesc}</small>
          </button>
        </div>
      </div>
    </div>
  );
}
