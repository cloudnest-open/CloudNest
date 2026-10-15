import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CredentialsStore } from '../providers/credentials-store.js';
import type { ProviderQueries, ProviderAccountRow } from '../db/provider-queries.js';
import { getAdapter } from '../providers/registry.js';
import { ProviderError, type ProviderCredentialBundle, type NormalizedAccount, type ProviderId } from '../providers/types.js';
import { encrypt } from '../providers/encryption.js';

/**
 * Account lifecycle service. All SQLite writes happen here; adapters never
 * touch the database. Quota failures never change authentication state.
 */

export interface UpsertConnectionInput {
  provider: ProviderId;
  account: NormalizedAccount;
  bundle: ProviderCredentialBundle;
}

export class ProviderAccountService {
  constructor(
    private readonly db: Database.Database,
    private readonly queries: ProviderQueries,
    private readonly store: CredentialsStore,
  ) {}

  /** Connect or reconnect: identity-keyed upsert, user label preserved on reconnect. */
  upsertConnection(input: UpsertConnectionInput): { row: ProviderAccountRow; reconnected: boolean } {
    const now = new Date().toISOString();
    const existing = input.account.providerAccountId
      ? (this.queries.getByIdentity.get(input.provider, input.account.providerAccountId) as ProviderAccountRow | undefined)
      : undefined;

    if (existing) {
      const blobParams = this.blobParamsFor(input.provider, existing.id, input.bundle);
      // preserve user-edited label unless it was auto-generated
      const label = existing.display_label || input.account.displayLabel;
      this.queries.updateConnection.run({
        id: existing.id,
        display_label: label,
        status: 'connected',
        quota_total_bytes: input.account.quota.totalBytes,
        used_bytes: input.account.quota.usedBytes,
        quota_status: input.account.quota.status,
        last_quota_check_at: input.account.quota.status === 'unknown' ? existing.last_quota_check_at : now,
        last_error_code: input.account.safeErrorCode ?? null,
        last_error_at: input.account.safeErrorCode ? now : null,
        ...blobParams,
        updated_at: now,
      });
      return { row: this.queries.getAccount.get(existing.id) as ProviderAccountRow, reconnected: true };
    }

    const id = crypto.randomUUID();
    const blobParams = this.blobParamsFor(input.provider, id, input.bundle);
    this.queries.insertAccount.run({
      id,
      provider: input.provider,
      display_label: input.account.displayLabel,
      account_identifier: input.account.providerAccountId,
      status: input.account.safeErrorCode === 'refresh_token_missing' ? 'needs_reauth' : 'connected',
      quota_total_bytes: input.account.quota.totalBytes,
      used_bytes: input.account.quota.usedBytes,
      quota_status: input.account.quota.status,
      last_quota_check_at: input.account.quota.status === 'unknown' ? null : now,
      last_error_code: input.account.safeErrorCode ?? null,
      last_error_at: input.account.safeErrorCode ? now : null,
      ...blobParams,
      created_at: now,
      updated_at: now,
    });
    return { row: this.queries.getAccount.get(id) as ProviderAccountRow, reconnected: false };
  }

  private blobParamsFor(provider: string, accountId: string, bundle: ProviderCredentialBundle) {
    const key = this.store.getKey();
    const blob = encrypt(JSON.stringify(bundle), key, `account_credentials:${provider}:${accountId}`);
    return {
      credential_ciphertext: blob.ciphertext,
      credential_nonce: blob.nonce,
      credential_auth_tag: blob.authTag,
      credential_key_version: blob.keyVersion,
    };
  }

  /** Persist a refreshed bundle immediately after refresh succeeds. */
  saveRefreshedBundle(row: ProviderAccountRow, bundle: ProviderCredentialBundle): void {
    this.store.saveAccountBundle(row.id, row.provider, bundle);
  }

  /** Quota-only refresh; never touches authentication state. */
  applyQuotaResult(id: string, quota: { totalBytes: number | null; usedBytes: number | null; status: string; safeErrorCode?: string }): ProviderAccountRow {
    const row = this.queries.getAccount.get(id) as ProviderAccountRow | undefined;
    if (!row) throw new ProviderError('identity_validation_failed', 404, 'account not found');
    const now = new Date().toISOString();
    if (quota.status === 'current' || quota.status === 'stale' && quota.usedBytes !== null) {
      this.queries.updateQuota.run({
        id,
        quota_total_bytes: quota.totalBytes,
        used_bytes: quota.usedBytes,
        quota_status: quota.status === 'current' ? 'current' : 'stale',
        last_quota_check_at: now,
        last_quota_error_code: null,
        last_quota_error_at: null,
        updated_at: now,
      });
    } else {
      const priorData = row.quota_total_bytes !== null || row.used_bytes !== null;
      this.queries.updateQuota.run({
        id,
        quota_total_bytes: row.quota_total_bytes,
        used_bytes: row.used_bytes,
        quota_status: priorData ? 'stale' : 'unknown',
        last_quota_check_at: row.last_quota_check_at,
        last_quota_error_code: quota.safeErrorCode ?? 'quota_unavailable',
        last_quota_error_at: now,
        updated_at: now,
      });
    }
    return this.queries.getAccount.get(id) as ProviderAccountRow;
  }

  markNeedsReauth(id: string, safeCode: string): void {
    const now = new Date().toISOString();
    this.queries.updateStatus.run({ id, status: 'needs_reauth', last_error_code: safeCode, last_error_at: now, updated_at: now });
  }

  markError(id: string, safeCode: string): void {
    const now = new Date().toISOString();
    this.queries.updateStatus.run({ id, status: 'error', last_error_code: safeCode, last_error_at: now, updated_at: now });
  }

  rename(id: string, label: string): ProviderAccountRow {
    this.queries.renameAccount.run({ id, display_label: label, updated_at: new Date().toISOString() });
    return this.queries.getAccount.get(id) as ProviderAccountRow;
  }

  updateReserve(id: string, reserveBytes: number): ProviderAccountRow {
    this.queries.updateReserve.run({ id, reserve_bytes: reserveBytes, updated_at: new Date().toISOString() });
    return this.queries.getAccount.get(id) as ProviderAccountRow;
  }

  /** Best-effort revoke, then erase local credentials; row + metadata preserved. */
  async disconnect(id: string): Promise<{ revokedRemotely: boolean; safeErrorCode: string | null }> {
    const row = this.queries.getAccount.get(id) as ProviderAccountRow | undefined;
    if (!row) throw new ProviderError('identity_validation_failed', 404, 'account not found');
    let revokedRemotely = false;
    let safeErrorCode: string | null = null;
    const adapter = getAdapter(row.provider);
    if (adapter?.revokeOrClose) {
      try {
        const bundle = this.store.loadAccountBundle(row);
        if (bundle) {
          const result = await adapter.revokeOrClose(bundle);
          revokedRemotely = result.revoked;
          if (!result.revoked) safeErrorCode = result.safeErrorCode ?? 'provider_unavailable';
        }
      } catch {
        revokedRemotely = false;
        safeErrorCode = 'provider_unavailable';
      }
    }
    this.queries.eraseCredentials.run({ id, updated_at: new Date().toISOString() });
    this.queries.updateStatus.run({ id, status: 'disconnected', last_error_code: safeErrorCode, last_error_at: safeErrorCode ? new Date().toISOString() : null, updated_at: new Date().toISOString() });
    return { revokedRemotely, safeErrorCode };
  }

  list(): ProviderAccountRow[] {
    return this.queries.listAccounts.all() as unknown as ProviderAccountRow[];
  }

  get(id: string): ProviderAccountRow | undefined {
    return this.queries.getAccount.get(id) as ProviderAccountRow | undefined;
  }

  /**
   * One grouped query: how many live logical files and chunk placements point
   * at each account. This is the disconnect-warning data — an account that
   * holds placements can take files with it until it is reconnected. Zero
   * means nothing currently depends on the account.
   */
  trackedUsage(): Map<string, { trackedFiles: number; trackedChunks: number }> {
    const rows = this.db.prepare(
      `SELECT p.provider_account_id AS accountId,
              COUNT(DISTINCT c.file_id) AS trackedFiles,
              COUNT(*) AS trackedChunks
       FROM chunk_placements p
       JOIN file_chunks c ON c.id = p.chunk_id
       WHERE p.is_active = 1
       GROUP BY p.provider_account_id`,
    ).all() as Array<{ accountId: string; trackedFiles: number; trackedChunks: number }>;
    const map = new Map<string, { trackedFiles: number; trackedChunks: number }>();
    for (const row of rows) {
      map.set(row.accountId, { trackedFiles: row.trackedFiles, trackedChunks: row.trackedChunks });
    }
    return map;
  }
}
