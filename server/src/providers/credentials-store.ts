import type Database from 'better-sqlite3';
import { CredentialKey, encrypt, decrypt, type EncryptedBlob } from './encryption.js';
import type { ProviderCredentialBundle, DecryptedProviderAppConfig } from './types.js';
import { makeProviderQueries, blobToParams, type ProviderAccountRow } from '../db/provider-queries.js';

/**
 * Encrypted persistence for provider-app configs and account credential
 * bundles. All SQLite writes stay here/outside adapters. Associated data
 * binds every blob to its purpose + provider (+ account id) so ciphertext
 * cannot be moved between rows or providers.
 */

export class CredentialsStore {
  private readonly queries: ReturnType<typeof makeProviderQueries>;
  private key: CredentialKey | null = null;

  constructor(private readonly db: Database.Database, private readonly dataDir: string) {
    this.queries = makeProviderQueries(db);
  }

  /** Lazily loads or creates the key (creation only when no encrypted records exist). */
  getKey(): CredentialKey {
    if (this.key) return this.key;
    const hasAccounts = (this.queries.hasAnyEncryptedAccount.get() as { n: number }).n === 1;
    const hasConfigs = (this.queries.hasAnyEncryptedConfig.get() as { n: number }).n === 1;
    this.key = CredentialKey.loadOrCreate(this.dataDir, hasAccounts || hasConfigs);
    return this.key;
  }

  /** True when the key file exists (or is loaded). */
  hasKey(): boolean {
    if (this.key) return true;
    try {
      this.getKey();
      return true;
    } catch {
      return false;
    }
  }

  // ---- provider app configs ----

  saveAppConfig(provider: DecryptedProviderAppConfig['provider'], config: DecryptedProviderAppConfig, status: 'saved' | 'needs_correction', safeErrorCode: string | null): void {
    const key = this.getKey();
    const blob = encrypt(JSON.stringify(config), key, `provider_app_config:${provider}`);
    const now = new Date().toISOString();
    const existing = this.queries.getConfig.get(provider) as Record<string, unknown> | undefined;
    const params = {
      provider,
      config_ciphertext: blob.ciphertext,
      config_nonce: blob.nonce,
      config_auth_tag: blob.authTag,
      config_key_version: blob.keyVersion,
      verification_status: status,
      last_safe_error_code: safeErrorCode,
      last_error_at: safeErrorCode ? now : null,
      updated_at: now,
    };
    if (existing) this.queries.updateConfig.run(params);
    else this.queries.insertConfig.run({ ...params, created_at: now });
  }

  markConfigVerified(provider: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE provider_app_configs SET verification_status = 'verified', last_verified_at = ?, last_safe_error_code = NULL, last_error_at = NULL, updated_at = ? WHERE provider = ?`,
    ).run(now, now, provider);
  }

  getConfig(provider: string): { config: DecryptedProviderAppConfig; verificationStatus: string } | null {
    const row = this.queries.getConfig.get(provider) as
      | { provider: string; config_ciphertext: Buffer; config_nonce: Buffer; config_auth_tag: Buffer; config_key_version: number; verification_status: string }
      | undefined;
    if (!row) return null;
    const blob: EncryptedBlob = {
      ciphertext: row.config_ciphertext,
      nonce: row.config_nonce,
      authTag: row.config_auth_tag,
      keyVersion: row.config_key_version,
    };
    const config = JSON.parse(decrypt(blob, this.getKey(), `provider_app_config:${provider}`)) as DecryptedProviderAppConfig;
    return { config, verificationStatus: row.verification_status };
  }

  /** Config summaries for the API (never any secret material). */
  listConfigSummaries(): Array<{ provider: string; verificationStatus: string; lastVerifiedAt: string | null; lastSafeErrorCode: string | null }> {
    const rows = this.queries.listConfigs.all() as Array<{
      provider: string;
      verification_status: string;
      last_verified_at: string | null;
      last_safe_error_code: string | null;
    }>;
    return rows.map((r) => ({
      provider: r.provider,
      verificationStatus: r.verification_status,
      lastVerifiedAt: r.last_verified_at,
      lastSafeErrorCode: r.last_safe_error_code,
    }));
  }

  getConfigSummary(provider: string): { provider: string; verificationStatus: string } | null {
    const row = this.queries.getConfig.get(provider) as { provider: string; verification_status: string } | undefined;
    return row ? { provider: row.provider, verificationStatus: row.verification_status } : null;
  }

  // ---- account credential bundles ----

  saveAccountBundle(accountId: string, provider: string, bundle: ProviderCredentialBundle): void {
    const key = this.getKey();
    const blob = encrypt(JSON.stringify(bundle), key, `account_credentials:${provider}:${accountId}`);
    this.db.prepare(
      `UPDATE provider_accounts SET credential_ciphertext = ?, credential_nonce = ?, credential_auth_tag = ?, credential_key_version = ?, updated_at = ? WHERE id = ?`,
    ).run(blob.ciphertext, blob.nonce, blob.authTag, blob.keyVersion, new Date().toISOString(), accountId);
  }

  loadAccountBundle(row: ProviderAccountRow): ProviderCredentialBundle | null {
    if (!row.credential_ciphertext || !row.credential_nonce || !row.credential_auth_tag || !row.credential_key_version) return null;
    const blob: EncryptedBlob = {
      ciphertext: row.credential_ciphertext,
      nonce: row.credential_nonce,
      authTag: row.credential_auth_tag,
      keyVersion: row.credential_key_version,
    };
    const bundle = JSON.parse(decrypt(blob, this.getKey(), `account_credentials:${row.provider}:${row.id}`)) as ProviderCredentialBundle;
    if (bundle.schemaVersion !== 1 || bundle.provider !== row.provider) {
      throw new Error('credential bundle failed schema/provider validation');
    }
    return bundle;
  }
}

export { blobToParams };
