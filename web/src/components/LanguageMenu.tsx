/**
 * The one accessible language selector, used by the entry page (variant
 * "entry", entry-page tokens) and the authenticated shell (variant "shell",
 * shell tokens). Both share ONE preference/instance through useI18n, so a
 * change here updates the entire interface instantly and persists.
 *
 * Keyboard support matches the entry page's approved pattern: open focuses
 * the selected option, ArrowUp/Down move, Home/End jump, Escape closes and
 * restores focus to the trigger. Every option shows the native language name
 * (never translated).
 */
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Globe } from 'lucide-react';
import { LOCALES, LOCALE_NAMES, type Locale } from '../i18n.js';
import { useI18n } from '../i18n-context.js';

export function LanguageMenu({ variant }: { variant: 'entry' | 'shell' }) {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const label = t.shell.lang.label;
  const cls = variant === 'entry' ? 'entry-lang' : 'shell-lang';
  const menuCls = variant === 'entry' ? 'entry-lang-menu' : 'shell-lang-menu';
  const btnCls = variant === 'entry' ? 'entry-lang-btn' : 'shell-lang-btn';
  const optCls = variant === 'entry' ? 'entry-lang-option' : 'shell-lang-option';

  useEffect(() => {
    if (!open) return;
    function onDocPointer(event: MouseEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocPointer);
    return () => document.removeEventListener('mousedown', onDocPointer);
  }, [open]);

  // Open → focus the selected option so keyboard users land inside the listbox.
  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLButtonElement>(`.${optCls}.selected`)?.focus();
  }, [open, optCls]);

  function onMenuKeyDown(ev: React.KeyboardEvent): void {
    const options = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>(`.${optCls}`) ?? []);
    const index = options.findIndex((el) => el === document.activeElement);
    if (ev.key === 'Escape') {
      ev.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const delta = ev.key === 'ArrowDown' ? 1 : -1;
      const next = ((index < 0 ? 0 : index) + delta + options.length) % options.length;
      options[next]?.focus();
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      options[0]?.focus();
    } else if (ev.key === 'End') {
      ev.preventDefault();
      options[options.length - 1]?.focus();
    }
  }

  return (
    <div className={cls} ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className={btnCls}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${LOCALE_NAMES[locale]}`}
        onClick={() => setOpen((value) => !value)}
      >
        <Globe size={16} aria-hidden="true" />
        <span className={variant === 'entry' ? 'entry-lang-current' : 'shell-lang-current'}>
          {LOCALE_NAMES[locale]}
        </span>
        <ChevronDown size={14} className={variant === 'entry' ? 'entry-lang-chevron' : 'shell-lang-chevron'} aria-hidden="true" />
      </button>
      {open && (
        <ul className={menuCls} role="listbox" aria-label={label} onKeyDown={onMenuKeyDown}>
          {LOCALES.map((id: Locale) => (
            <li key={id} role="option" aria-selected={id === locale}>
              <button
                type="button"
                className={`${optCls}${id === locale ? ' selected' : ''}`}
                onClick={() => {
                  setLocale(id);
                  setOpen(false);
                  buttonRef.current?.focus();
                }}
              >
                <span>{LOCALE_NAMES[id]}</span>
                {id === locale && <Check size={14} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
