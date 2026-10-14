/**
 * Small provider identity marks (design pack §16): official-style marks are
 * permitted for provider identity where licensing permits — these are compact
 * inline glyphs used only as small identity accents, never as card covers.
 * Unknown providers fall back to the neutral letter tile.
 */
import type { ComponentType } from 'react';
import { PROVIDER_LABELS, ProviderTile } from './ui.js';

function GoogleDriveMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size * 0.89} viewBox="0 0 87.3 78" aria-hidden="true">
      <path fill="#0066da" d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" />
      <path fill="#00ac47" d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0-1.2 4.5h27.5z" />
      <path fill="#ea4335" d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.5l5.85 11.5z" />
      <path fill="#00832d" d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" />
      <path fill="#2684fc" d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" />
      <path fill="#ffba00" d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" />
    </svg>
  );
}

function DropboxMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#0061FF"
        d="M6 1.807 0 5.629l6 3.822 6.001-3.822L6 1.807zM18 1.807l-6 3.822 6 3.822 6-3.822-6-3.822zM0 13.274l6 3.822 6.001-3.822L6 9.452l-6 3.822zM18 9.452l-6 3.822 6 3.822 6-3.822-6-3.822zM6 18.371l6.001 3.822 6-3.822-6-3.822L6 18.371z"
      />
    </svg>
  );
}

function OneDriveMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#0364B8"
        d="M14.5 6.5a5.5 5.5 0 0 0-10.36 2.03A4.25 4.25 0 0 0 4.75 17h13.5a3.75 3.75 0 0 0 .87-7.4 5.5 5.5 0 0 0-4.62-3.1z"
      />
    </svg>
  );
}

function PCloudMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="#14A5E5" />
      <path
        fill="#fff"
        d="M10 6.6h3.1a4.1 4.1 0 0 1 0 8.2H12.1v2.6H10V6.6zm2.1 2.2v3.8h1a1.9 1.9 0 0 0 0-3.8h-1z"
      />
    </svg>
  );
}

function MegaMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="#D9272E" />
      <path fill="#fff" d="M6.4 16.5v-8l3.3 3.9 2.3-2.7 2.3 2.7 3.3-3.9v8h-2.2v-3.4l-3.4 3.8-3.4-3.8v3.4H6.4z" />
    </svg>
  );
}

const MARKS: Record<string, ComponentType<{ size: number }>> = {
  google_drive: GoogleDriveMark,
  dropbox: DropboxMark,
  onedrive: OneDriveMark,
  pcloud: PCloudMark,
  mega: MegaMark,
};

export function ProviderLogo({ provider, size = 24 }: { provider: string; size?: number }) {
  const Mark = MARKS[provider];
  if (!Mark) return <ProviderTile provider={provider} size={size} />;
  const label = PROVIDER_LABELS[provider] ?? provider;
  return (
    <span
      className="provider-logo"
      style={{ width: size, height: size }}
      role="img"
      aria-label={label}
      title={label}
    >
      <Mark size={size} />
    </span>
  );
}
