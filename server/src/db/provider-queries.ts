import type Database from 'better-sqlite3';
import type { EncryptedBlob } from '../providers/encryption.js';

/** Prepared statements for provider accounts/config. No ORM, no dynamic SQL from user input. */

export interface ProviderAccountRow {
  id: string;
  provider: string;
  display_label: string;
  account_identifier: string | null;
  status: 'connected' | 'needs_reauth' | 'disconnected' | 'error';
  quota_total_bytes: number | null;
  used_bytes: number | null;
  quota_status: 'current' | 'stale' | 'unknown';
  /** Provider-documented unlimited quota (1) vs finite/unknown (0). */
  quota_unlimited: 0 | 1;
  /** Owner-confirmed shared-pool key; NULL = independent quota scope. */
  quota_scope: string | null;
  reserve_bytes: number;
  reserved_inflight_bytes: number;
  last_quota_check_at: string | null;
  last_quota_error_code: string | null;
  last_quota_error_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  credential_ciphertext: Buffer | null;
  credential_nonce: Buffer | null;
  credential_auth_tag: Buffer | null;
  credential_key_version: number | null;
  created_at: string;
  updated_at: string;
}

export function makeProviderQueries(db: Database.Database) {
  return {
    listAccounts: db.prepare('SELECT * FROM provider_accounts ORDER BY provider, created_at') as Database.Statement<[ ], ProviderAccountRow>,
    getAccount: db.prepare('SELECT * FROM provider_accounts WHERE id = ?') as Database.Statement<[string], ProviderAccountRow>,
    getByIdentity: db.prepare('SELECT * FROM provider_accounts WHERE provider = ? AND account_identifier = ?') as Database.Statement<[string, string], ProviderAccountRow>,
    insertAccount: db.prepare(
      `INSERT INTO provider_accounts
        (id, provider, display_label, account_identifier, status, quota_total_bytes, used_bytes, quota_status,
         quota_unlimited, reserve_bytes, reserved_inflight_bytes, last_quota_check_at, last_error_code, last_error_at,
         credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, created_at, updated_at)
       VALUES (@id, @provider, @display_label, @account_identifier, @status, @quota_total_bytes, @used_bytes, @quota_status,
         @quota_unlimited, 0, 0, @last_quota_check_at, @last_error_code, @last_error_at,
         @credential_ciphertext, @credential_nonce, @credential_auth_tag, @credential_key_version, @created_at, @updated_at)`,
    ),
    updateConnection: db.prepare(
      `UPDATE provider_accounts SET
        display_label = @display_label, status = @status, quota_total_bytes = @quota_total_bytes,
        used_bytes = @used_bytes, quota_status = @quota_status, quota_unlimited = @quota_unlimited,
        last_quota_check_at = @last_quota_check_at,
        last_error_code = @last_error_code, last_error_at = @last_error_at,
        credential_ciphertext = @credential_ciphertext, credential_nonce = @credential_nonce,
        credential_auth_tag = @credential_auth_tag, credential_key_version = @credential_key_version,
        updated_at = @updated_at
       WHERE id = @id`,
    ),
    updateQuota: db.prepare(
      `UPDATE provider_accounts SET
        quota_total_bytes = @quota_total_bytes, used_bytes = @used_bytes, quota_status = @quota_status,
        quota_unlimited = @quota_unlimited,
        last_quota_check_at = @last_quota_check_at, last_quota_error_code = @last_quota_error_code,
        last_quota_error_at = @last_quota_error_at, updated_at = @updated_at
       WHERE id = @id`,
    ),
    setQuotaScope: db.prepare(
      'UPDATE provider_accounts SET quota_scope = @scope, updated_at = @updated_at WHERE id = @id',
    ),
    clearQuotaScopeForProvider: db.prepare(
      'UPDATE provider_accounts SET quota_scope = NULL, updated_at = @updated_at WHERE provider = @provider',
    ),
    updateStatus: db.prepare(
      'UPDATE provider_accounts SET status = @status, last_error_code = @last_error_code, last_error_at = @last_error_at, updated_at = @updated_at WHERE id = @id',
    ),
    renameAccount: db.prepare(
      'UPDATE provider_accounts SET display_label = @display_label, updated_at = @updated_at WHERE id = @id',
    ),
    updateReserve: db.prepare(
      'UPDATE provider_accounts SET reserve_bytes = @reserve_bytes, updated_at = @updated_at WHERE id = @id',
    ),
    eraseCredentials: db.prepare(
      `UPDATE provider_accounts SET credential_ciphertext = NULL, credential_nonce = NULL,
        credential_auth_tag = NULL, credential_key_version = NULL, updated_at = @updated_at WHERE id = @id`,
    ),
    hasAnyEncryptedAccount: db.prepare('SELECT EXISTS(SELECT 1 FROM provider_accounts WHERE credential_ciphertext IS NOT NULL) AS n'),
    getConfig: db.prepare('SELECT * FROM provider_app_configs WHERE provider = ?'),
    listConfigs: db.prepare('SELECT provider, verification_status, last_verified_at, last_safe_error_code, last_error_at, created_at, updated_at FROM provider_app_configs'),
    insertConfig: db.prepare(
      `INSERT INTO provider_app_configs
        (provider, config_ciphertext, config_nonce, config_auth_tag, config_key_version, verification_status, created_at, updated_at)
       VALUES (@provider, @config_ciphertext, @config_nonce, @config_auth_tag, @config_key_version, @verification_status, @created_at, @updated_at)`,
    ),
    updateConfig: db.prepare(
      `UPDATE provider_app_configs SET
        config_ciphertext = @config_ciphertext, config_nonce = @config_nonce, config_auth_tag = @config_auth_tag,
        config_key_version = @config_key_version, verification_status = @verification_status,
        last_safe_error_code = @last_safe_error_code, last_error_at = @last_error_at, updated_at = @updated_at
       WHERE provider = @provider`,
    ),
    hasAnyEncryptedConfig: db.prepare('SELECT EXISTS(SELECT 1 FROM provider_app_configs) AS n'),
  };
}

export type ProviderQueries = ReturnType<typeof makeProviderQueries>;

export function blobToParams(blob: EncryptedBlob | null): {
  credential_ciphertext: Buffer | null;
  credential_nonce: Buffer | null;
  credential_auth_tag: Buffer | null;
  credential_key_version: number | null;
} {
  if (!blob) return { credential_ciphertext: null, credential_nonce: null, credential_auth_tag: null, credential_key_version: null };
  return {
    credential_ciphertext: blob.ciphertext,
    credential_nonce: blob.nonce,
    credential_auth_tag: blob.authTag,
    credential_key_version: blob.keyVersion,
  };
}
