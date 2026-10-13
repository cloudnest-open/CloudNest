import { Storage } from 'megajs';

/** Minimal structural view of the megajs Storage we actually use. */
interface MegaStorageLike {
  user?: string;
  email?: string;
  once(event: 'ready', listener: () => void): void;
  once(event: 'error', listener: (err: Error) => void): void;
  getAccountInfo(): Promise<unknown>;
  close(cb?: () => void): Promise<void>;
}
import { ProviderError, type ProviderAdapter, type ProviderCredentialBundle, type NormalizedAccount, type NormalizedQuota } from './types.js';

/**
 * MEGA adapter — explicitly EXPERIMENTAL (unofficial megajs library).
 * One temporary Storage instance per operation, always closed in finally.
 * The password lives only in the encrypted credential bundle; never logged.
 * megajs 1.3.10 documents `secondFactorCode` (never persisted).
 */

function isMegaBundle(b: ProviderCredentialBundle): b is Extract<ProviderCredentialBundle, { provider: 'mega' }> {
  return b.provider === 'mega';
}

interface MegaAccountInfo {
  spaceUsed?: number;
  spaceTotal?: number;
  type?: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new ProviderError('provider_unavailable', 504)), ms)),
  ]);
}

async function withTemporaryStorage<T>(bundle: Extract<ProviderCredentialBundle, { provider: 'mega' }>, fn: (storage: MegaStorageLike) => Promise<T>): Promise<T> {
  const storage = new Storage({
    email: bundle.email,
    password: bundle.password,
  } as unknown as ConstructorParameters<typeof Storage>[0]) as unknown as MegaStorageLike;
  try {
    await withTimeout(new Promise<void>((resolve, reject) => {
      storage.once('ready', () => resolve());
      storage.once('error', (err: Error) => reject(err));
    }), 20000);
    return await withTimeout(fn(storage), 20000);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('ENOTFOUND') || message.includes('ECONNREFUSED') || message.includes('timeout')) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('provider_unavailable', 502);
    }
    if (message.includes('EARGS') || message.includes('email or password')) {
      throw new ProviderError('invalid_credentials', 401);
    }
    if (message.includes('two-factor') || message.includes('2FA') || message.includes('FA')) {
      throw new ProviderError('invalid_credentials', 401);
    }
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('provider_unavailable', 502);
  } finally {
    try {
      void storage.close();
    } catch {
      // closing a failed/unopened storage may throw; safe to ignore
    }
  }
}

export const megaAdapter: ProviderAdapter = {
  id: 'mega',
  experimental: true,
  displayName: 'MEGA',
  requiresAppConfig: false,

  async connectAndReadAccount(bundle): Promise<NormalizedAccount> {
    if (!isMegaBundle(bundle)) throw new ProviderError('identity_validation_failed', 400);
    return withTemporaryStorage(bundle, async (storage) => {
      const info = (await storage.getAccountInfo()) as unknown as MegaAccountInfo;
      const accountId = (storage.user ?? bundle.email) as string | undefined;
      if (!accountId) throw new ProviderError('identity_validation_failed', 502);
      return {
        providerAccountId: accountId,
        displayLabel: bundle.email,
        quota: {
          totalBytes: typeof info.spaceTotal === 'number' ? info.spaceTotal : null,
          usedBytes: typeof info.spaceUsed === 'number' ? info.spaceUsed : null,
          status: typeof info.spaceTotal === 'number' || typeof info.spaceUsed === 'number' ? 'current' : 'unknown',
          safeErrorCode: typeof info.spaceTotal === 'number' ? undefined : 'quota_unavailable',
        },
      };
    });
  },

  async getQuota(bundle): Promise<NormalizedQuota> {
    if (!isMegaBundle(bundle)) throw new ProviderError('invalid_credentials', 401);
    try {
      return await withTemporaryStorage(bundle, async (storage) => {
        const info = (await storage.getAccountInfo()) as MegaAccountInfo;
        return {
          totalBytes: typeof info.spaceTotal === 'number' ? info.spaceTotal : null,
          usedBytes: typeof info.spaceUsed === 'number' ? info.spaceUsed : null,
          status: typeof info.spaceTotal === 'number' || typeof info.spaceUsed === 'number' ? 'current' : 'unknown',
          safeErrorCode: typeof info.spaceTotal === 'number' ? undefined : 'quota_unavailable',
        };
      });
    } catch (err) {
      if (err instanceof ProviderError && (err.safeCode === 'invalid_credentials' || err.safeCode === 'provider_rate_limited')) throw err;
      return { totalBytes: null, usedBytes: null, status: 'unknown', safeErrorCode: 'quota_unavailable' };
    }
  },

  async ensureValidCredentials(bundle) {
    if (!isMegaBundle(bundle)) throw new ProviderError('invalid_credentials', 401);
    return bundle;
  },
};
