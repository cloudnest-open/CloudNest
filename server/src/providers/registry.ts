import type { ProviderAdapter, ProviderId } from './types.js';
import { googleDriveAdapter } from './google-drive.js';
import { dropboxAdapter } from './dropbox.js';
import { pcloudAdapter } from './pcloud.js';
import { onedriveAdapter } from './onedrive.js';
import { megaAdapter } from './mega.js';
import { s3Adapter } from './s3.js';

/** Small static map of six known provider adapters. No dynamic plugin loader. */
export const providerRegistry: Readonly<Record<ProviderId, ProviderAdapter>> = Object.freeze({
  google_drive: googleDriveAdapter,
  dropbox: dropboxAdapter,
  pcloud: pcloudAdapter,
  onedrive: onedriveAdapter,
  mega: megaAdapter,
  s3: s3Adapter,
});

/**
 * TEST-ONLY override seam. Deterministic regression tests (same-provider
 * multi-account coverage) install in-memory adapters here so the full
 * connect/plan/upload/download/delete paths run without network access.
 * Production code never calls these two functions, and node:test runs each
 * file in its own process, so an override cannot leak across suites.
 */
const testAdapters = new Map<string, ProviderAdapter>();

export function installTestAdapter(id: string, adapter: ProviderAdapter): void {
  testAdapters.set(id, adapter);
}

export function clearTestAdapters(): void {
  testAdapters.clear();
}

export function getAdapter(provider: string): ProviderAdapter | null {
  return testAdapters.get(provider) ?? (providerRegistry as Record<string, ProviderAdapter>)[provider] ?? null;
}

