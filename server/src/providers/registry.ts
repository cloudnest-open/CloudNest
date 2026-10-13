import type { ProviderAdapter, ProviderId } from './types.js';
import { googleDriveAdapter } from './google-drive.js';
import { dropboxAdapter } from './dropbox.js';
import { pcloudAdapter } from './pcloud.js';
import { onedriveAdapter } from './onedrive.js';
import { megaAdapter } from './mega.js';

/** Small static map of five known provider adapters. No dynamic plugin loader. */
export const providerRegistry: Readonly<Record<ProviderId, ProviderAdapter>> = Object.freeze({
  google_drive: googleDriveAdapter,
  dropbox: dropboxAdapter,
  pcloud: pcloudAdapter,
  onedrive: onedriveAdapter,
  mega: megaAdapter,
});

export function getAdapter(provider: string): ProviderAdapter | null {
  return (providerRegistry as Record<string, ProviderAdapter>)[provider] ?? null;
}
