import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { makeUploadQueries, type JobRow, type FileRow, type AllocationRow } from '../db/upload-queries.js';
import { makeProviderQueries } from '../db/provider-queries.js';
import { planChunks, chunkBounds, sanitizeDisplayName, generateObjectKey, ChunkMathError, type ChunkSizeMiB } from './chunk-math.js';
// Small files go out as one whole-file object on a single account (with a
// chunk-split fallback when no account can hold the whole file).
const SINGLE_OBJECT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
import { preflight, allocateChunks, assessAccountCapacity, outstandingReservationBytes, suggestSmallerChunkSizeMiB, UNLIMITED_USABLE_BYTES, type AccountCapacityInput, type AccountCapacity, type RoutingStrategy } from './capacity.js';
import type { CredentialsStore } from '../providers/credentials-store.js';
import { getAdapter } from '../providers/registry.js';
import { ProviderError, type AccountTier } from '../providers/types.js';
import { drainAndHash, HashingCounter } from './streaming.js';
import { ADMIN_USER_ID } from '../middleware/require-admin.js';

/**
 * Upload planning, allocation, chunk commit, resume and cancellation (M9).
 * All SQLite writes live here; provider adapters never touch the database.
 */

export class UploadError extends Error {
  readonly safeCode: string;
  readonly httpStatus: number;
  constructor(safeCode: string, httpStatus = 400) {
    super(safeCode);
    this.safeCode = safeCode;
    this.httpStatus = httpStatus;
  }
}

/** Detail payload for a refused plan: truthful, admin-facing, JSON-safe. */
export interface CapacityInsufficientDetail {
  /** null = the pool contains a provider-confirmed unlimited quota. */
  totalUsableBytes: number | null;
  shortfallBytes: number;
  /** Why each considered account cannot take work right now (safe codes only). */
  accounts: Array<{ label: string; reasonCode: string | null; usableBytes: number | null }>;
  /** Largest supported smaller chunk size that would place the whole file. */
  suggestedChunkSizeMiB: number | null;
}

/**
 * A plan that cannot reserve every chunk. §7.1(5)/§7.1(7): the client gets the
 * shortfall and, on pure placement fragmentation, the largest feasible smaller
 * chunk size as a one-click suggestion — never a silent settings change and
 * never a bare "capacity_insufficient" with no reason.
 */
export class CapacityInsufficientError extends UploadError {
  readonly detail: CapacityInsufficientDetail;
  constructor(detail: CapacityInsufficientDetail) {
    super('capacity_insufficient', 409);
    this.detail = detail;
  }
}

/** Providers whose connector can stream uploads (Phase 5: mirror targets draw from the same set). */
export const PROVIDER_UPLOAD_READY = new Set(['google_drive', 'dropbox', 'onedrive', 'pcloud', 's3']);

/** §9: approved Step-4 per-account cap for chunks in flight (global cap is client-side). */
export const MAX_PER_ACCOUNT_INFLIGHT = 2;

/**
 * Roadmap Phase 2: S3-compatible accounts receive browser-direct presigned
 * PUTs — plain single-object writes with none of the consumer-provider rate
 * budgets — so the same durable in-flight gate allows the roadmap's direct
 * window (8–32) for them and keeps the polite cap of 2 for OAuth accounts.
 */
export const MAX_PER_ACCOUNT_INFLIGHT_S3 = 32;

/**
 * Provider checksum algorithms that are the SAME function as our own SHA-256,
 * so a provider value may be compared byte-for-byte. A provider checksum with a
 * DIFFERENT algorithm (Dropbox content_hash, OneDrive quickXorHash) is never
 * compared against SHA-256 — that would be a false verification claim.
 */
const SHA256_COMPARABLE_CHECKSUM_TYPES = new Set(['sha256', 'sha-256', 'gdrive_sha256']);

/**
 * Compare a provider checksum against our own digest, but only when the
 * algorithm is genuinely the same. Returns 'match' | 'mismatch' | 'not-comparable'.
 */
export function compareProviderChecksum(
  provider: { type?: string; value?: string } | undefined | null,
  ourSha256: string,
): 'match' | 'mismatch' | 'not-comparable' {
  if (!provider?.type || !provider.value) return 'not-comparable';
  if (!SHA256_COMPARABLE_CHECKSUM_TYPES.has(provider.type.toLowerCase())) return 'not-comparable';
  return provider.value.toLowerCase() === ourSha256.toLowerCase() ? 'match' : 'mismatch';
}

export interface PlanRequest {
  originalName: string;
  sizeBytes: number;
  chunkSizeMiB: ChunkSizeMiB;
  mimeType?: string | null;
  idempotencyKey: string;
  /**
   * Roadmap Phase 3: the requesting principal's users-table id. The file is
   * owned by this account and the per-user allowance is checked against it;
   * part of the idempotency fingerprint so two accounts can never share one
   * idempotency key. HTTP routes ALWAYS pass the authenticated principal's id
   * explicitly; the service-level default is the built-in admin's attribution
   * row ('usr_admin'), which is what direct service callers (tests, recovery
   * tooling) mean.
   */
  userId?: string;
  /**
   * Storage tier (roadmap Phase 1). A file may only draw capacity from its own
   * tier's pool: personal files never land on business (S3) accounts and
   * business files never land on personal OAuth accounts. Defaults to
   * 'personal'; part of the idempotency fingerprint so the same key cannot
   * silently switch tiers.
   */
  tier?: AccountTier;
  /**
   * M12.a `upload.spaceAwareRouting`. Defaults to 'capacity-aware', which is the
   * exact V1 behaviour, so a caller that does not pass it is unaffected.
   */
  routingStrategy?: RoutingStrategy;
  /**
   * Roadmap Phase 4: the folder the upload lands in (null = the owner's root).
   * The folder must belong to the SAME principal (tree purity); part of the
   * idempotency fingerprint like every other placement decision.
   */
  parentId?: string | null;
}

/** Why a plan was refused: the user's own allowance, plainly stated. */
export interface AllowanceExceededDetail {
  allowanceBytes: number;
  usedBytes: number;
  requestedBytes: number;
}

/**
 * Roadmap Phase 3: the plan would push this user past their own storage
 * allowance. This is independent of pool capacity — the pool may be half
 * empty and the refusal still stands. 403: the request is authenticated and
 * well-formed, but this principal may not store that much.
 */
export class AllowanceExceededError extends UploadError {
  readonly detail: AllowanceExceededDetail;
  constructor(detail: AllowanceExceededDetail) {
    super('allowance_exceeded', 403);
    this.detail = detail;
  }
}

/**
 * Task §5.B — account-aware file availability. A file whose chunk placements
 * reference a disconnected/errored/needs-reauth account is NOT fully usable
 * right now; the affected accounts are named so the UI can offer a reconnect
 * path. This is derived from live rows on every read, never a stale flag, and
 * it never marks a file corrupted merely because an account is offline.
 */
export interface FileStorageHealth {
  status: 'ok' | 'account_unavailable';
  unavailable: Array<{ accountId: string; label: string; accountStatus: string }>;
}

function storageHealthOf(unavailable: Map<string, { accountId: string; label: string; accountStatus: string }>): FileStorageHealth {
  return {
    status: unavailable.size > 0 ? 'account_unavailable' : 'ok',
    unavailable: [...unavailable.values()],
  };
}


export interface PlanResult {
  jobId: string;
  fileId: string;
  chunkCount: number;
  chunkSizeBytes: number;
  sizeBytes: number;
  allocations: Array<{ chunkIndex: number; offsetBytes: number; sizeBytes: number; accountId: string }>;
  reused: boolean;
}

export class UploadService {
  private readonly q;
  private readonly providerQ;
  constructor(
    private readonly db: Database.Database,
    private readonly store: CredentialsStore,
    private readonly notify?: (kind: 'upload_completed' | 'share_used' | 'quota_stale', userId: string | null, payload: Record<string, unknown>, tier?: string | null) => void,
  ) {
    this.q = makeUploadQueries(db);
    this.providerQ = makeProviderQueries(db);
  }

  /** Deterministic fingerprint: the same request must never reserve twice. */
  static fingerprint(req: PlanRequest): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify({
        n: req.originalName,
        s: req.sizeBytes,
        c: req.chunkSizeMiB,
        m: req.mimeType ?? null,
        // tier is part of the plan contract: the same key must not silently
        // move an upload to a different storage pool (roadmap Phase 1)
        t: req.tier ?? 'personal',
        // the owner is part of the contract too (roadmap Phase 3): two
        // accounts must never share one idempotency key's reservation
        u: req.userId ?? ADMIN_USER_ID,
        // and the routing strategy is part of it (roadmap Phase 4): the
        // auto-spread toggle changes WHERE chunks are planned, so the same
        // key cannot silently switch placement behaviour
        r: req.routingStrategy ?? 'capacity-aware',
        // the target folder is part of the contract too (Phase 4): a retried
        // plan must never quietly relocate the file to another folder
        p: req.parentId ?? null,
      }))
      .digest('hex');
  }

  /** Eligible capacity per connected account, from real quota + reservations. */
  /**
   * CloudNest-tracked bytes per S3-compatible account: the sum of bytes in
   * active placements. S3 exposes no quota API, so this local sum plus the
   * owner-set cap is the account's only truthful usage number — and because
   * it is derived live from placements, a committed chunk is accounted for
   * immediately (no refresh step can lag the truth).
   */
  private s3QuotaOverrides(): Map<string, { totalBytes: number | null; usedBytes: number | null }> {
    const rows = this.db.prepare(
      `SELECT p.provider_account_id AS accountId, COALESCE(SUM(fc.size_bytes), 0) AS bytes
       FROM chunk_placements p
       JOIN file_chunks fc ON fc.id = p.chunk_id
       WHERE p.is_active = 1
       GROUP BY p.provider_account_id`,
    ).all() as Array<{ accountId: string; bytes: number }>;
    const tracked = new Map(rows.map((r) => [r.accountId, r.bytes]));
    const accounts = this.providerQ.listAccounts.all() as Array<{
      id: string; provider: string; capacity_cap_bytes: number | null;
    }>;
    const map = new Map<string, { totalBytes: number | null; usedBytes: number | null }>();
    for (const a of accounts) {
      if (a.provider !== 's3') continue;
      map.set(a.id, {
        totalBytes: a.capacity_cap_bytes !== null && a.capacity_cap_bytes > 0 ? a.capacity_cap_bytes : null,
        usedBytes: tracked.get(a.id) ?? 0,
      });
    }
    return map;
  }

  /** Public since Phase 5: the mirror engine reuses the exact same capacity inputs. */
  capacityInputs(tier: AccountTier): AccountCapacityInput[] {
    const accounts = this.providerQ.listAccounts.all() as Array<{
      id: string; provider: string; display_label: string; status: string; tier: AccountTier;
      quota_status: string; quota_total_bytes: number | null; used_bytes: number | null;
      quota_unlimited: 0 | 1; quota_scope: string | null; reserve_bytes: number;
      participates_in_uploads: 0 | 1;
    }>;
    const active = this.q.listAllActiveAllocations.all() as Array<{ provider_account_id: string; size_bytes: number; state: string }>;
    // roadmap Phase 1: a file draws capacity ONLY from its own tier's pool —
    // business files never land on personal OAuth accounts, nor the reverse.
    // M0016: an account the owner marked out of upload participation takes no
    // NEW placements (plan/reassign/mirror); its existing chunks stay readable.
    const tierAccounts = accounts.filter((a) => (a.tier ?? 'personal') === tier && a.participates_in_uploads !== 0);
    const s3Quotas = this.s3QuotaOverrides();
    return tierAccounts
      .filter((a) => PROVIDER_UPLOAD_READY.has(a.provider))
      .map((a) => {
        // S3-compatible accounts have no provider quota API: the owner-set cap
        // plus CloudNest-tracked placement bytes is the only honest accounting.
        const s3 = s3Quotas.get(a.id);
        const quotaTotalBytes = a.provider === 's3' ? (s3?.totalBytes ?? null) : a.quota_total_bytes;
        const quotaUsedBytes = a.provider === 's3' ? (s3?.usedBytes ?? null) : a.used_bytes;
        // uploaded_pending_quota bytes are already inside the tracked placement
        // sum for S3, so they must not ALSO count as outstanding reservations
        const pendingQuotaBytes = a.provider === 's3'
          ? active
            .filter((row) => row.provider_account_id === a.id && row.state === 'uploaded_pending_quota')
            .reduce((sum, row) => sum + row.size_bytes, 0)
          : 0;
        return {
          accountId: a.id,
          provider: a.provider,
          displayLabel: a.display_label,
          status: a.status,
          quotaStatus: a.provider === 's3'
            ? (quotaTotalBytes !== null ? 'current' as const : 'unknown' as const)
            : a.quota_status as 'current' | 'stale' | 'unknown',
          quotaTotalBytes,
          quotaUsedBytes,
          quotaUnlimited: a.quota_unlimited === 1,
          quotaScopeKey: a.quota_scope,
          reserveBytes: a.reserve_bytes,
          outstandingReservationBytes: outstandingReservationBytes(active, a.id) - pendingQuotaBytes,
        };
      });
  }

  /**
   * Metadata-only plan. Reserves the whole file atomically or not at all.
   * Idempotent on the client key: a retried request returns the same job.
   */
  plan(req: PlanRequest): PlanResult {
    // mode = complete context: a tier-mismatched folder is a request-shape
    // error and must answer 400 BEFORE any capacity/plan state is consulted
    if (req.parentId != null && req.parentId !== '') {
      const folder = this.db.prepare('SELECT user_id, tier FROM folders WHERE id = ?')
        .get(req.parentId) as { user_id: string; tier: string } | undefined;
      if (!folder || folder.user_id !== (req.userId ?? ADMIN_USER_ID)) {
        throw new UploadError('folder_not_found', 404);
      }
      if (folder.tier !== (req.tier ?? 'personal')) throw new UploadError('folder_tier_mismatch', 400);
    }
    let name: string;
    let plan;
    try {
      name = sanitizeDisplayName(req.originalName);
      plan = planChunks(req.sizeBytes, req.chunkSizeMiB * 1024 * 1024);
    } catch (err) {
      if (err instanceof ChunkMathError) throw new UploadError(err.safeCode, 400);
      throw err;
    }

    const fingerprint = UploadService.fingerprint({ ...req, originalName: name });

    // idempotency: same key + same fingerprint returns the existing job
    const existing = this.q.getJobByIdempotencyKey.get(req.idempotencyKey) as JobRow | undefined;
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) {
        throw new UploadError('idempotency_key_reused', 409);
      }
      const allocations = this.q.listAllocations.all(existing.id) as AllocationRow[];
      return {
        jobId: existing.id,
        fileId: existing.file_id ?? '',
        chunkCount: existing.chunks_total,
        chunkSizeBytes: plan.chunkSizeBytes,
        sizeBytes: plan.fileSizeBytes,
        allocations: allocations.map((a) => ({
          chunkIndex: a.chunk_index,
          offsetBytes: a.offset_bytes,
          sizeBytes: a.size_bytes,
          accountId: a.provider_account_id,
        })),
        reused: true,
      };
    }

    // an empty file needs no capacity and creates no remote object
    if (plan.chunkCount === 0) {
      return this.createEmptyFile(name, req, fingerprint, plan.chunkSizeBytes);
    }

    // Small files prefer a whole-file object on one good account: splitting a
    // small file buys nothing (extra objects and per-chunk bookkeeping
    // outweigh any spread benefit) and one object is the simpler, more honest
    // layout. If no single eligible account can actually hold the whole file
    // (a fragmented pool), fall back to the regular chunk split so a small
    // upload is never made impossible — the pool, not the threshold, decides.
    if (plan.fileSizeBytes <= SINGLE_OBJECT_UPLOAD_MAX_BYTES) {
      const whole = planChunks(plan.fileSizeBytes, plan.fileSizeBytes);
      const wholeCapacity = preflight(this.capacityInputs(req.tier ?? 'personal'), whole.fileSizeBytes);
      if (wholeCapacity.assessment.eligible.some((a) => a.usableBytes >= whole.fileSizeBytes)) {
        plan = whole;
      }
    }

    const capacity = preflight(this.capacityInputs(req.tier ?? 'personal'), plan.fileSizeBytes);
    const chunkDescriptors: Array<{ chunkIndex: number; offsetBytes: number; sizeBytes: number }> = [];
    for (let i = 0; i < plan.chunkCount; i++) {
      const b = chunkBounds(plan, i);
      chunkDescriptors.push({ chunkIndex: b.chunkIndex, offsetBytes: b.offsetBytes, sizeBytes: b.sizeBytes });
    }
    const assignments = capacity.canProceed
      ? allocateChunks(chunkDescriptors, capacity.assessment.eligible, req.routingStrategy ?? 'capacity-aware')
      : null;
    if (!capacity.canProceed || !assignments) {
      // §7.1(5): suggest the largest supported smaller chunk size ONLY when the
      // total pool is sufficient but this chunk size cannot be placed (pure
      // fragmentation). A real shortfall is not helped by smaller chunks.
      const suggested = capacity.canProceed && !assignments
        ? suggestSmallerChunkSizeMiB(plan.fileSizeBytes, req.chunkSizeMiB, this.capacityInputs(req.tier ?? 'personal'), req.routingStrategy ?? 'capacity-aware')
        : null;
      throw new CapacityInsufficientError({
        totalUsableBytes: capacity.totalUsableBytes === UNLIMITED_USABLE_BYTES ? null : capacity.totalUsableBytes,
        shortfallBytes: capacity.shortfallBytes,
        accounts: capacity.assessment.accounts.map((a: AccountCapacity) => ({
          label: a.displayLabel,
          reasonCode: a.reasonCode,
          usableBytes: a.usableBytes === UNLIMITED_USABLE_BYTES ? null : a.usableBytes,
        })),
        suggestedChunkSizeMiB: suggested,
      });
    }

    // one transaction: allowance check + file + job + every allocation, or
    // nothing at all. The check lives INSIDE the transaction so two concurrent
    // plans from the same user cannot both pass against the same old usage.
    const ownerUserId = req.userId ?? ADMIN_USER_ID;
    const now = new Date().toISOString();
    const fileId = this.q.newId();
    const jobId = this.q.newId();
    // Roadmap Phase 4: the target folder must belong to the SAME principal —
    // an upload may only land in the caller's own tree. Mode = complete
    // context: the folder's tier must also match the planned tier, or a
    // business upload could land inside the personal tree by folder.
    let parentId: string | null = null;
    if (req.parentId != null && req.parentId !== '') {
      const folder = this.db.prepare('SELECT user_id, tier FROM folders WHERE id = ?')
        .get(req.parentId) as { user_id: string; tier: string } | undefined;
      if (!folder) throw new UploadError('folder_not_found', 404);
      if (folder.user_id !== ownerUserId) throw new UploadError('folder_not_found', 404);
      if (folder.tier !== (req.tier ?? 'personal')) throw new UploadError('folder_tier_mismatch', 400);
      parentId = req.parentId;
    }
    const txn = this.db.transaction(() => {
      const allowanceRow = this.db.prepare('SELECT allowance_bytes FROM users WHERE id = ?')
        .get(ownerUserId) as { allowance_bytes: number | null } | undefined;
      if (allowanceRow === undefined) {
        // the principal vanished between auth and plan; refuse rather than
        // attach a file to a nonexistent owner
        throw new UploadError('user_not_found', 403);
      }
      if (allowanceRow.allowance_bytes !== null) {
        const used = (this.db.prepare(
          "SELECT COALESCE(SUM(size_bytes), 0) AS n FROM files WHERE user_id = ? AND state <> 'deleted'",
        ).get(ownerUserId) as { n: number }).n;
        if (used + plan.fileSizeBytes > allowanceRow.allowance_bytes) {
          throw new AllowanceExceededError({
            allowanceBytes: allowanceRow.allowance_bytes,
            usedBytes: used,
            requestedBytes: plan.fileSizeBytes,
          });
        }
      }
      this.q.insertFile.run({
        id: fileId,
        user_id: ownerUserId,
        original_name: name,
        size_bytes: plan.fileSizeBytes,
        mime_type: req.mimeType ?? null,
        chunk_size_bytes: plan.chunkSizeBytes,
        chunk_count: plan.chunkCount,
        state: 'uploading',
        tier: req.tier ?? 'personal',
        created_at: now,
        parent_id: parentId,
      });
      this.q.insertJob.run({
        id: jobId,
        file_id: fileId,
        state: 'queued',
        chunks_total: plan.chunkCount,
        idempotency_key: req.idempotencyKey,
        request_fingerprint: fingerprint,
        created_at: now,
        updated_at: now,
      });
      for (const a of assignments) {
        this.q.insertAllocation.run({
          id: this.q.newId(),
          job_id: jobId,
          chunk_index: a.chunkIndex,
          provider_account_id: a.accountId,
          size_bytes: a.sizeBytes,
          offset_bytes: a.offsetBytes,
          created_at: now,
          updated_at: now,
        });
      }
      this.recomputeReservedInflight(jobId);
    });
    txn();

    return {
      jobId,
      fileId,
      chunkCount: plan.chunkCount,
      chunkSizeBytes: plan.chunkSizeBytes,
      sizeBytes: plan.fileSizeBytes,
      allocations: assignments.map((a) => ({
        chunkIndex: a.chunkIndex,
        offsetBytes: a.offsetBytes,
        sizeBytes: a.sizeBytes,
        accountId: a.accountId,
      })),
      reused: false,
    };
  }

  private createEmptyFile(name: string, req: PlanRequest, fingerprint: string, chunkSizeBytes: number): PlanResult {
    const now = new Date().toISOString();
    const fileId = this.q.newId();
    const jobId = this.q.newId();
    // the empty-file path honours the same folder contract as the chunked one
    let parentId: string | null = null;
    if (req.parentId != null && req.parentId !== '') {
      const folder = this.db.prepare('SELECT user_id, tier FROM folders WHERE id = ?')
        .get(req.parentId) as { user_id: string; tier: string } | undefined;
      if (!folder || folder.user_id !== (req.userId ?? ADMIN_USER_ID)) {
        throw new UploadError('folder_not_found', 404);
      }
      if (folder.tier !== (req.tier ?? 'personal')) throw new UploadError('folder_tier_mismatch', 400);
      parentId = req.parentId;
    }
    const txn = this.db.transaction(() => {
      this.q.insertFile.run({
        id: fileId, user_id: req.userId ?? ADMIN_USER_ID, original_name: name, size_bytes: 0, mime_type: req.mimeType ?? null,
        chunk_size_bytes: chunkSizeBytes, chunk_count: 0, state: 'completed', tier: req.tier ?? 'personal', created_at: now,
        parent_id: parentId,
      });
      this.q.insertJob.run({
        id: jobId, file_id: fileId, state: 'completed', chunks_total: 0,
        idempotency_key: req.idempotencyKey, request_fingerprint: fingerprint, created_at: now, updated_at: now,
      });
      this.q.completeFile.run({ id: fileId, manifest_hash: manifestHash([]), completed_at: now });
    });
    txn();
    return {
      jobId, fileId, chunkCount: 0, chunkSizeBytes, sizeBytes: 0, allocations: [], reused: false,
    };
  }

  getJob(jobId: string): JobRow | undefined {
    return this.q.getJob.get(jobId) as JobRow | undefined;
  }

  /**
   * Phase 3 ownership check: the users-table id that owns a transfer job's
   * file, or null when the job (or its file) does not exist. Routes use this
   * so a member naming a foreign job gets the same 404 as a missing one.
   */
  jobOwnerUserId(jobId: string): string | null {
    const row = this.q.getJobOwnerUserId.get(jobId) as { user_id: string } | undefined;
    return row?.user_id ?? null;
  }

  getFile(fileId: string): FileRow | undefined {
    return this.q.getFile.get(fileId) as FileRow | undefined;
  }

  /** `userId: string | null` — null lists everything (the admin view).
   * `tier: string | null` — null lists every tier; otherwise only that tier's
   * rows (the approved mode = complete context design). */
  listJobs(limit = 50, userId: string | null = null, tier: string | null = null): JobRow[] {
    if (userId === null) return this.q.listJobs.all(tier, tier, limit) as unknown as JobRow[];
    return this.q.listJobsForUser.all(userId, tier, tier, limit) as unknown as JobRow[];
  }

  listFiles(limit: number, offset: number, userId: string | null = null, tier: string | null = null): FileRow[] {
    if (userId === null) return this.q.listFiles.all(tier, tier, limit, offset) as unknown as FileRow[];
    return this.q.listFilesForUser.all(userId, tier, tier, limit, offset) as unknown as FileRow[];
  }

  /**
   * FE-02: search the whole library in SQL before pagination. An empty term
   * degenerates to the plain paginated listing. A member's "whole library" is
   * their own files only; the admin sees everything.
   */
  searchFiles(search: string, limit: number, offset: number, userId: string | null = null, tier: string | null = null): FileRow[] {
    const term = search.trim().toLowerCase();
    if (userId !== null) {
      if (term === '') return this.listFiles(limit, offset, userId, tier);
      return this.q.searchFilesForUser.all(userId, tier, tier, term, limit, offset) as unknown as FileRow[];
    }
    if (term === '') return this.listFiles(limit, offset, null, tier);
    return this.q.searchFiles.all(tier, tier, term, limit, offset) as unknown as FileRow[];
  }

  countSearchedFiles(search: string, userId: string | null = null, tier: string | null = null): number {
    const term = search.trim().toLowerCase();
    if (userId !== null) {
      if (term === '') return this.countFiles(userId, tier);
      return (this.q.countSearchedFilesForUser.get(userId, tier, tier, term) as { n: number }).n;
    }
    if (term === '') return this.countFiles(null, tier);
    return (this.q.countSearchedFiles.get(tier, tier, term) as { n: number }).n;
  }

  countFiles(userId: string | null = null, tier: string | null = null): number {
    if (userId === null) return (this.q.countFiles.get(tier, tier) as { n: number }).n;
    return (this.q.countFilesForUser.get(userId, tier, tier) as { n: number }).n;
  }

  /**
   * Roadmap Phase 4: folder-scoped listing (root = parent_id IS NULL). The
   * same ownership scope as the flat lists: a member sees only their own
   * folder's files, the admin sees the whole tree.
   */
  listFilesInFolder(folderId: string | null, limit: number, offset: number, userId: string | null = null, tier: string | null = null): FileRow[] {
    if (folderId === null) return this.q.listFilesInRoot.all(userId, userId, tier, tier, limit, offset) as unknown as FileRow[];
    return this.q.listFilesInFolder.all(folderId, userId, userId, tier, tier, limit, offset) as unknown as FileRow[];
  }

  countFilesInFolder(folderId: string | null, userId: string | null = null, tier: string | null = null): number {
    if (folderId === null) return (this.q.countFilesInRoot.get(userId, userId, tier, tier) as { n: number }).n;
    return (this.q.countFilesInFolder.get(folderId, userId, userId, tier, tier) as { n: number }).n;
  }

  listAllocations(jobId: string): AllocationRow[] {
    return this.q.listAllocations.all(jobId) as unknown as AllocationRow[];
  }

  getResumeManifest(jobId: string, offset: number, limit: number): {
    chunks: Array<{ chunkIndex: number; offsetBytes: number; sizeBytes: number; sha256: string }>;
    total: number;
  } {
    const job = this.q.getJob.get(jobId) as JobRow | undefined;
    if (!job?.file_id) throw new UploadError('job_not_found', 404);
    const rows = this.q.listChunks.all(job.file_id) as Array<{
      chunk_index: number; offset_bytes: number; size_bytes: number; sha256: string;
    }>;
    return {
      chunks: rows.slice(offset, offset + limit).map((r) => ({
        chunkIndex: r.chunk_index, offsetBytes: r.offset_bytes, sizeBytes: r.size_bytes, sha256: r.sha256,
      })),
      total: rows.length,
    };
  }

  /** Start or continue a job; refuses when a source identity check is needed. */
  markRunning(jobId: string): void {
    const job = this.q.getJob.get(jobId) as JobRow | undefined;
    if (!job) throw new UploadError('job_not_found', 404);
    if (job.state === 'completed') throw new UploadError('job_not_resumable', 409);
    if (job.state === 'cancelled') throw new UploadError('job_not_resumable', 409);
    this.q.updateJobState.run({
      id: jobId, state: 'running', last_safe_error_code: job.last_safe_error_code, updated_at: new Date().toISOString(),
    });
  }

  /**
   * §9 per-account concurrency bound: at most two of one account's chunks may
   * be in flight at once (the approved Step-4 plan's per-account cap). The
   * check happens BEFORE the attempt row exists, so a 429 here is pure
   * contention — it creates no attempt, releases nothing, and the client must
   * simply back off and retry the same chunk later.
   */
  private assertAccountCanAccept(accountId: string, allocationId: string): void {
    const row = this.q.countUploadingForAccount.get(accountId, allocationId) as { n: number };
    const account = this.providerQ.getAccount.get(accountId) as { provider: string } | undefined;
    // OAuth accounts keep the polite 2-in-flight cap; S3-compatible accounts
    // take browser-direct presigned PUTs and get the wider Phase-2 window.
    const cap = account?.provider === 's3' ? MAX_PER_ACCOUNT_INFLIGHT_S3 : MAX_PER_ACCOUNT_INFLIGHT;
    if (row.n >= cap) {
      throw new UploadError('account_busy', 429);
    }
  }

  private recomputeReservedInflight(jobId: string): void {
    const allocs = this.q.listAllAllocationsForJob.all(jobId) as Array<{ provider_account_id: string; size_bytes: number; state: string }>;
    const perAccount = new Map<string, number>();
    for (const a of allocs) {
      if (a.state === 'reserved' || a.state === 'uploading' || a.state === 'uploaded_pending_quota') {
        perAccount.set(a.provider_account_id, (perAccount.get(a.provider_account_id) ?? 0) + a.size_bytes);
      }
    }
    const now = new Date().toISOString();
    for (const [accountId, bytes] of perAccount) {
      this.db.prepare('UPDATE provider_accounts SET reserved_inflight_bytes = ?, updated_at = ? WHERE id = ?')
        .run(bytes, now, accountId);
    }
  }

  /** Recompute every account's reserved_inflight_bytes from durable rows. */
  recomputeAllReservations(): void {
    const active = this.q.listAllActiveAllocations.all() as Array<{ provider_account_id: string; size_bytes: number; state: string }>;
    const accounts = this.providerQ.listAccounts.all() as Array<{ id: string }>;
    const now = new Date().toISOString();
    for (const account of accounts) {
      const bytes = outstandingReservationBytes(active, account.id);
      this.db.prepare('UPDATE provider_accounts SET reserved_inflight_bytes = ?, updated_at = ? WHERE id = ?')
        .run(bytes, now, account.id);
    }
  }

  /**
   * Commit one successfully uploaded chunk: attempt -> chunk -> placement,
   * all inside one transaction, then update progress counters.
   */
  commitChunk(input: {
    jobId: string;
    chunkIndex: number;
    accountId: string;
    objectKey: string;
    remoteObjectId: string;
    sha256: string;
    sizeBytes: number;
    providerChecksumType?: string;
    /** Raw provider checksum value; only a SHA-256-comparable match earns 'verified'. */
    providerChecksumValue?: string;
  }): { chunksCompleted: number; bytesCompleted: number; fileCompleted: boolean } {
    const job = this.q.getJob.get(input.jobId) as JobRow | undefined;
    if (!job?.file_id) throw new UploadError('job_not_found', 404);
    const file = this.q.getFile.get(job.file_id) as FileRow | undefined;
    if (!file) throw new UploadError('job_not_found', 404);
    const allocation = this.q.getAllocation.get(input.jobId, input.chunkIndex) as AllocationRow | undefined;
    if (!allocation) throw new UploadError('invalid_upload_metadata', 400);

    const now = new Date().toISOString();
    const attempt = this.q.getAttemptByObjectKey.get(input.objectKey) as { id: string } | undefined;
    // §6.1 reconciliation evidence: the provider-observed usage at commit time.
    // A later CURRENT observation must show usage grown by at least the chunk
    // size before this reservation may release. Unknown quota at commit stores
    // NULL, which keeps the reservation forever (conservative).
    const accountAtCommit = this.providerQ.getAccount.get(input.accountId) as
      | { used_bytes: number | null }
      | undefined;
    const usedAtCommit = accountAtCommit?.used_bytes ?? null;
    const txn = this.db.transaction(() => {
      if (attempt) {
        this.q.markAttemptUploadedUncommitted.run({
          id: attempt.id, bytes_received: input.sizeBytes, sha256: input.sha256,
          remote_object_id: input.remoteObjectId, updated_at: now,
        });
      }
      // an existing chunk for this index is a re-upload: deactivate old placements
      const existingChunk = this.q.getChunk.get(file.id, input.chunkIndex) as { id: string } | undefined;
      const chunkId = existingChunk?.id ?? this.q.newId();
      if (existingChunk) {
        // UL-3 for re-uploads: every superseded active placement still owns a
        // live remote object. Record its cleanup obligation BEFORE the
        // deactivation so a crash cannot leak the bytes; retryPendingCleanups
        // and cancel() both sweep cleanup_pending attempts.
        const superseded = this.db.prepare(
          `SELECT id, provider_account_id, remote_object_id, remote_object_key
             FROM chunk_placements WHERE chunk_id = ? AND is_active = 1`,
        ).all(chunkId) as Array<{
          id: string; provider_account_id: string; remote_object_id: string | null; remote_object_key: string | null;
        }>;
        for (const old of superseded) {
          if (!old.remote_object_id || !old.remote_object_key) continue;
          const oldAttempt = this.q.getAttemptByObjectKey.get(old.remote_object_key) as { id: string } | undefined;
          if (oldAttempt) {
            this.q.markAttemptCleanupPending.run({
              id: oldAttempt.id, safe_error_code: 'superseded_by_reupload', updated_at: now,
            });
          } else {
            // no attempt row (e.g. a mirror-created placement): record the
            // object under this job so the cleanup sweep can still find it
            this.q.insertAttempt.run({
              id: this.q.newId(), job_id: input.jobId, chunk_index: input.chunkIndex,
              provider_account_id: old.provider_account_id, object_key: old.remote_object_key,
              resume_ciphertext: null, resume_nonce: null, resume_auth_tag: null, resume_key_version: null,
              created_at: now, updated_at: now,
            });
            const fresh = this.q.getAttemptByObjectKey.get(old.remote_object_key) as { id: string } | undefined;
            if (fresh) {
              this.q.markAttemptCleanupPending.run({
                id: fresh.id, safe_error_code: 'superseded_by_reupload', updated_at: now,
              });
            }
          }
        }
        this.q.deactivatePlacements.run(now, chunkId);
        // UL-2: the re-uploaded bytes are now the truth for this index; the
        // stored digest must follow, or later verification would compare the
        // new placement against a stale hash and brick the file.
        this.db.prepare(
          'UPDATE file_chunks SET sha256 = ?, size_bytes = ?, updated_at = ? WHERE id = ?',
        ).run(input.sha256, input.sizeBytes, now, chunkId);
      } else {
        this.q.insertChunk.run({
          id: chunkId, file_id: file.id, chunk_index: input.chunkIndex,
          offset_bytes: allocation.offset_bytes, size_bytes: input.sizeBytes,
          sha256: input.sha256, created_at: now, updated_at: now,
        });
      }
      this.q.insertPlacement.run({
        id: this.q.newId(), chunk_id: chunkId, provider_account_id: input.accountId,
        remote_object_id: input.remoteObjectId, remote_object_key: input.objectKey,
        provider_checksum_type: input.providerChecksumType ?? null,
        confirmed_size_bytes: input.sizeBytes, created_at: now, updated_at: now,
        // B6 honesty: 'verified' only when the provider returned a checksum
        // whose algorithm is genuinely SHA-256 AND it matches our digest. An
        // opaque S3 ETag or a digest the server never observed (the Phase-2
        // direct path stores the client-reported SHA-256) stays 'uploaded'.
        state:
          compareProviderChecksum(
            input.providerChecksumType && input.providerChecksumValue
              ? { type: input.providerChecksumType, value: input.providerChecksumValue }
              : null,
            input.sha256,
          ) === 'match'
            ? 'verified'
            : 'uploaded',
      });
      if (attempt) this.q.markAttemptCommitted.run(now, attempt.id);
      this.q.markAllocationUploadedPendingQuota.run(now, allocation.id);
      this.q.setAllocationCommitBaseline.run(usedAtCommit, allocation.id);
    });
    txn();

    // progress counters from durable rows
    const chunks = this.q.listChunks.all(file.id) as Array<{ size_bytes: number }>;
    const bytesCompleted = chunks.reduce((n, c) => n + c.size_bytes, 0);
    const chunksCompleted = chunks.length;
    const fileCompleted = chunksCompleted === file.chunk_count;
    this.q.updateJobProgress.run({
      id: input.jobId, chunks_completed: chunksCompleted, bytes_completed: bytesCompleted,
      last_safe_error_code: null, updated_at: now,
    });
    this.recomputeReservedInflight(input.jobId);

    if (fileCompleted) {
      const mh = manifestHash(chunks);
      this.q.completeFile.run({ id: file.id, manifest_hash: mh, completed_at: now });
      this.q.updateJobState.run({ id: input.jobId, state: 'completed', last_safe_error_code: null, updated_at: now });
      // Roadmap Phase 4: the bell's feed is real — the owner learns their
      // upload finished at the moment the durable state says so.
      this.notify?.('upload_completed', file.user_id, { fileName: file.original_name, fileId: file.id }, file.tier);
    }
    return { chunksCompleted, bytesCompleted, fileCompleted };
  }

  /** Record a failed attempt without destroying any durable history. */
  recordFailure(input: {
    jobId: string; chunkIndex: number; accountId: string; objectKey: string;
    safeCode: string; bytesReceived: number; remoteObjectId?: string | null;
  }): void {
    const now = new Date().toISOString();
    const attempt = this.q.getAttemptByObjectKey.get(input.objectKey) as { id: string } | undefined;
    if (attempt) {
      this.q.markAttemptUploadedUncommitted.run({
        id: attempt.id, bytes_received: input.bytesReceived, sha256: null,
        remote_object_id: input.remoteObjectId ?? null, updated_at: now,
      });
      if (input.remoteObjectId) {
        // UL-3: a live remote object must not leak. The obligation is recorded
        // before anything else so a crash cannot forget it; retryPendingCleanups
        // and cancel() both sweep cleanup_pending rows.
        this.q.markAttemptCleanupPending.run({
          id: attempt.id, safe_error_code: input.safeCode, updated_at: now,
        });
      } else {
        this.q.markAttemptFailed.run({
          id: attempt.id, safe_error_code: input.safeCode, bytes_received: input.bytesReceived, updated_at: now,
        });
      }
    } else {
      // no attempt row (validation failed before any remote work)
      this.q.insertAttempt.run({
        id: this.q.newId(), job_id: input.jobId, chunk_index: input.chunkIndex,
        provider_account_id: input.accountId, object_key: input.objectKey,
        resume_ciphertext: null, resume_nonce: null, resume_auth_tag: null, resume_key_version: null,
        created_at: now, updated_at: now,
      });
      const fresh = this.q.getAttemptByObjectKey.get(input.objectKey) as { id: string } | undefined;
      if (fresh) {
        if (input.remoteObjectId) {
          // UL-3: same obligation as above for the freshly-inserted attempt row
          this.q.markAttemptCleanupPending.run({
            id: fresh.id, safe_error_code: input.safeCode, updated_at: now,
          });
        } else {
          this.q.markAttemptFailed.run({
            id: fresh.id, safe_error_code: input.safeCode, bytes_received: input.bytesReceived, updated_at: now,
          });
        }
      }
    }
    const allocation = this.q.getAllocation.get(input.jobId, input.chunkIndex) as AllocationRow | undefined;
    if (allocation && allocation.state === 'uploading') {
      this.q.markAllocationReleased.run(now, allocation.id);
      this.recomputeReservedInflight(input.jobId);
    }
    // UL-4: bytes_completed must reflect the durable chunk rows. Zeroing it
    // after any single chunk failure made real progress vanish from the UI.
    const failJob = this.q.getJob.get(input.jobId) as JobRow | undefined;
    const durableChunks = failJob?.file_id
      ? (this.q.listChunks.all(failJob.file_id) as Array<{ size_bytes: number }>)
      : [];
    this.q.updateJobProgress.run({
      id: input.jobId,
      chunks_completed: durableChunks.length,
      bytes_completed: durableChunks.reduce((n, c) => n + c.size_bytes, 0),
      last_safe_error_code: input.safeCode,
      updated_at: now,
    });
    this.q.bumpJobRetry.run({ id: input.jobId, updated_at: now });
  }

  /**
   * §7.3: a provider "insufficient storage" rejection proves the quota
   * observation is stale. The account's quota is marked stale immediately so
   * no NEW chunk is planned onto it until a fresh observation arrives.
   */
  markQuotaStale(accountId: string, safeCode: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE provider_accounts SET quota_status = 'stale', last_quota_error_code = ?,
        last_quota_error_at = ?, updated_at = ? WHERE id = ?`,
    ).run(safeCode, now, now, accountId);
    // Roadmap Phase 4: quota events belong in the feed, not only in the table.
    // Every active admin is notified — accounts are admin knowledge (Phase 3).
    const account = this.providerQ.getAccount.get(accountId) as
      | { display_label: string; account_identifier: string | null; tier: string } | undefined;
    if (account && this.notify) {
      // null user = every active admin (the wiring decides how that maps)
      this.notify('quota_stale', null, {
        accountLabel: account.display_label,
        accountIdentifier: account.account_identifier,
        reasonCode: safeCode,
      }, account.tier);
    }
  }

  /** Create the attempt row before any bytes are sent (crash recovery anchor). */
  beginAttempt(input: { jobId: string; chunkIndex: number; accountId: string }): { attemptId: string; objectKey: string } {
    const job = this.q.getJob.get(input.jobId) as JobRow | undefined;
    if (!job?.file_id) throw new UploadError('job_not_found', 404);
    const allocation = this.q.getAllocation.get(input.jobId, input.chunkIndex) as AllocationRow | undefined;
    if (!allocation) throw new UploadError('invalid_upload_metadata', 400);
    // contention gate BEFORE any durable state changes: a 429 here leaves no
    // attempt row and no state transition to undo
    this.assertAccountCanAccept(input.accountId, allocation.id);
    const attemptId = this.q.newId();
    const objectKey = generateObjectKey(job.file_id, input.chunkIndex, attemptId);
    const now = new Date().toISOString();
    const txn = this.db.transaction(() => {
      this.q.insertAttempt.run({
        id: attemptId, job_id: input.jobId, chunk_index: input.chunkIndex,
        provider_account_id: input.accountId, object_key: objectKey,
        resume_ciphertext: null, resume_nonce: null, resume_auth_tag: null, resume_key_version: null,
        created_at: now, updated_at: now,
      });
      this.q.markAllocationUploading.run(now, allocation.id);
    });
    txn();
    return { attemptId, objectKey };
  }

  /**
   * The attempt a Phase-2 direct-transfer receipt refers to: it must exist and
   * belong to exactly this job and chunk. The direct begin/complete/fail
   * routes validate their client-supplied attemptId through this gate, so a
   * client can never name a foreign job's attempt, an object key, or an
   * account — those all come from durable rows.
   */
  getAttemptForChunk(jobId: string, chunkIndex: number, attemptId: string): {
    id: string; job_id: string; chunk_index: number; provider_account_id: string; object_key: string; state: string;
  } | undefined {
    const attempt = this.q.getAttempt.get(attemptId) as
      | { id: string; job_id: string; chunk_index: number; provider_account_id: string; object_key: string; state: string }
      | undefined;
    if (!attempt || attempt.job_id !== jobId || attempt.chunk_index !== chunkIndex) return undefined;
    return attempt;
  }

  /**
   * Reassign an unfinished chunk to another account, transactionally,
   * preserving the audit trail and never creating two active placements.
   */
  reassignChunk(jobId: string, chunkIndex: number): { accountId: string } | null {
    const allocation = this.q.getAllocation.get(jobId, chunkIndex) as AllocationRow | undefined;
    if (!allocation) return null;
    // re-routing stays inside the file's own tier: a business file can only
    // move to another business account, a personal file to another personal one
    const job = this.q.getJob.get(jobId) as { file_id: string | null } | undefined;
    const fileRow = job?.file_id ? (this.q.getFile.get(job.file_id) as FileRow | undefined) : undefined;
    const fileTier = fileRow?.tier ?? 'personal';
    const capacity = this.capacityInputs(fileTier).filter((a) => a.accountId !== allocation.provider_account_id);
    const assessed = preflight(capacity, allocation.size_bytes);
    const target = assessed.assessment.eligible.find((a) => a.usableBytes >= allocation.size_bytes);
    if (!target) return null;
    const now = new Date().toISOString();
    const txn = this.db.transaction(() => {
      this.q.reassignAllocation.run({ id: allocation.id, provider_account_id: target.accountId, updated_at: now });
      this.q.updateJobState.run({ id: jobId, state: 'running', last_safe_error_code: 'rerouted', updated_at: now });
    });
    txn();
    this.recomputeReservedInflight(jobId);
    return { accountId: target.accountId };
  }

  /** Pause: no new chunks are scheduled; already-claimed chunks may finish. */
  pause(jobId: string): void {
    const job = this.q.getJob.get(jobId) as JobRow | undefined;
    if (!job) throw new UploadError('job_not_found', 404);
    // UL-1: a cancelled job is terminal; pausing it would let resume()
    // resurrect work the user explicitly discarded.
    if (job.state === 'completed' || job.state === 'cancelled') {
      throw new UploadError('job_not_resumable', 409);
    }
    this.q.updateJobState.run({
      id: jobId, state: 'paused', last_safe_error_code: job.last_safe_error_code, updated_at: new Date().toISOString(),
    });
  }

  /**
   * Mode = complete context: switching the UI mode pauses (never cancels) the
   * leaving tier's live uploads. One transactional bulk pause — the durable
   * 'paused' state means dispatch stops immediately, already-claimed chunks
   * may finish, resume() re-computes missing chunks, and background server
   * work (mirror/cleanup/quota refresh) is untouched. Mirrors pause()'s own
   * state rule: only queued/running jobs are eligible.
   */
  pauseAllActive(tier: string, userId: string | null): number {
    const now = new Date().toISOString();
    const ownerGuard = userId === null ? '' : 'AND f.user_id = ?';
    const txn = this.db.transaction(() => {
      const info = this.db.prepare(
        `UPDATE transfer_jobs SET state = 'paused',
           last_safe_error_code = 'paused_by_mode_switch', updated_at = ?
         WHERE job_type = 'upload' AND state IN ('queued','running')
           AND id IN (SELECT j.id FROM transfer_jobs j JOIN files f ON f.id = j.file_id
                      WHERE f.tier = ? ${ownerGuard})`,
      ).run(...(userId === null ? [now, tier] : [now, tier, userId]));
      return info.changes;
    });
    return txn();
  }

  /** Honest count of live (queued/running) uploads for one tier + owner —
   * what the switch-warning modal shows before pausing anything. */
  countActiveUploadJobs(tier: string, userId: string | null): number {
    const ownerGuard = userId === null ? '' : 'AND f.user_id = ?';
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM transfer_jobs j JOIN files f ON f.id = j.file_id
       WHERE j.job_type = 'upload' AND j.state IN ('queued','running') AND f.tier = ? ${ownerGuard}`,
    ).get(...(userId === null ? [tier] : [tier, userId])) as { n: number };
    return row.n;
  }

  /** Resume: continue only the chunks that are still missing. */
  resume(jobId: string): { missingChunks: number[] } {    const job = this.q.getJob.get(jobId) as JobRow | undefined;
    if (!job?.file_id) throw new UploadError('job_not_found', 404);
    // UL-1: both terminal states refuse; retry on a completed job would flip
    // it to running with zero missing chunks, cancel on a cancelled job would
    // silently resurrect discarded work.
    if (job.state === 'cancelled' || job.state === 'completed') {
      throw new UploadError('job_not_resumable', 409);
    }
    const done = new Set(
      (this.q.listChunks.all(job.file_id) as Array<{ chunk_index: number }>).map((c) => c.chunk_index),
    );
    const missing: number[] = [];
    for (let i = 0; i < job.chunks_total; i++) if (!done.has(i)) missing.push(i);
    this.q.updateJobState.run({
      id: jobId, state: 'running', last_safe_error_code: job.last_safe_error_code, updated_at: new Date().toISOString(),
    });
    return { missingChunks: missing };
  }

  /**
   * Cancel: stop dispatch, release unused reservations, and clean up partial
   * remote objects. Reservations are only freed once cleanup has reached a
   * safe state, and cleanup that cannot be confirmed stays recorded.
   */
  async cancel(jobId: string): Promise<{ cleanupPending: boolean; cleaned: number }> {
    const job = this.q.getJob.get(jobId) as JobRow | undefined;
    if (!job) throw new UploadError('job_not_found', 404);
    const allocations = this.q.listAllocations.all(jobId) as AllocationRow[];
    // UL-3: every superseded attempt may hold a live remote object; sweeping
    // only the newest one leaked permanent provider orphans.
    const attempts = allocations.flatMap((a) =>
      this.q.listAttemptsForChunk.all(jobId, a.chunk_index) as Array<{
        id: string; object_key: string; state: string; remote_object_id: string | null; provider_account_id: string;
      }>,
    );

    let cleaned = 0;
    let cleanupPending = false;
    const now = new Date().toISOString();

    for (const attempt of attempts) {
      if (attempt.state === 'committed' || attempt.state === 'cleaned') continue;
      const adapter = getAdapter(this.providerQAccountProvider(attempt.provider_account_id));
      // mark cleanup pending first so a crash cannot lose the obligation
      this.q.markAttemptCleanupPending.run({
        id: attempt.id, safe_error_code: 'cleanup_pending', updated_at: now,
      });
      if (!adapter?.deleteAppObject) {
        // no cleanup capability: keep the obligation recorded rather than pretend
        cleanupPending = true;
        continue;
      }
      try {
        if (attempt.remote_object_id) {
          await this.deleteRemoteObject(attempt.provider_account_id, attempt.remote_object_id);
          this.q.markAttemptCleaned.run(now, attempt.id);
          cleaned++;
        } else {
          // the object id was never learned; the attempt stays a durable obligation
          cleanupPending = true;
        }
      } catch {
        cleanupPending = true;
      }
    }

    const txn = this.db.transaction(() => {
      for (const a of allocations) {
        if (a.state === 'reserved' || a.state === 'uploading') {
          this.q.markAllocationReleased.run(now, a.id);
        }
      }
      this.q.updateJobState.run({
        id: jobId,
        state: cleanupPending ? 'deletion_pending' : 'cancelled',
        last_safe_error_code: cleanupPending ? 'cleanup_pending' : null,
        updated_at: now,
      });
      const remaining = this.q.listChunks.all(job.file_id ?? '') as Array<{ size_bytes: number }>;
      this.q.updateJobProgress.run({
        id: jobId, chunks_completed: remaining.length,
        bytes_completed: remaining.reduce((n, c) => n + c.size_bytes, 0),
        last_safe_error_code: cleanupPending ? 'cleanup_pending' : null, updated_at: now,
      });
    });
    txn();
    this.recomputeReservedInflight(jobId);
    return { cleanupPending, cleaned };
  }

  private providerQAccountProvider(accountId: string): string {
    const row = this.providerQ.getAccount.get(accountId) as { provider: string } | undefined;
    return row?.provider ?? '';
  }

  private async deleteRemoteObject(accountId: string, remoteObjectId: string): Promise<void> {
    const account = this.providerQ.getAccount.get(accountId) as
      | { id: string; provider: string; credential_ciphertext: Buffer | null }
      | undefined;
    if (!account) throw new ProviderError('provider_object_missing', 404);
    const remoteRoot = this.db
      .prepare('SELECT remote_root_id FROM provider_account_roots WHERE provider_account_id = ?')
      .get(accountId) as { remote_root_id: string } | undefined;
    const adapter = getAdapter(account.provider);
    if (!adapter?.deleteAppObject) throw new ProviderError('provider_unavailable', 502);
    const bundle = this.store.loadAccountBundle(account as unknown as Parameters<CredentialsStore['loadAccountBundle']>[0]);
    if (!bundle) throw new ProviderError('needs_reauth', 401);
    const appConfig = account.provider === 'mega' || account.provider === 'pcloud'
      ? undefined
      : this.store.getConfig(account.provider)?.config;
    await adapter.deleteAppObject(bundle, remoteRoot?.remote_root_id ?? '', remoteObjectId, appConfig);
  }

  /**
   * Startup recovery: running jobs become safely paused; reconcile reservations
   * and in-flight attempts. §10: after a restart, an attempt that was mid-flight
   * must not linger as "uploading" forever — without a known remote object it
   * becomes a plain failure; with one, it may hold a live remote object and
   * becomes a durable cleanup obligation that retryPendingCleanups closes.
   */
  recoverOnStartup(): { recovered: number; reservationsRecomputed: number; attemptsReconciled: number } {
    const running = this.q.runningJobs.all() as unknown as JobRow[];
    const now = new Date().toISOString();
    const txn = this.db.transaction(() => {
      for (const job of running) {
        this.q.updateJobState.run({
          id: job.id, state: 'paused', last_safe_error_code: 'recovered_after_restart', updated_at: now,
        });
      }
    });
    txn();
    const inFlight = this.db.prepare(
      "SELECT id, remote_object_id FROM upload_attempts WHERE state IN ('uploading','uploaded_uncommitted')",
    ).all() as Array<{ id: string; remote_object_id: string | null }>;
    const reconcile = this.db.transaction(() => {
      for (const attempt of inFlight) {
        if (attempt.remote_object_id) {
          // a remote object may exist that CloudNest never confirmed: the
          // obligation is recorded before anything else so a crash cannot
          // forget it (same rule as UL-3)
          this.q.markAttemptCleanupPending.run({
            id: attempt.id, safe_error_code: 'recovered_after_restart', updated_at: now,
          });
        } else {
          this.q.markAttemptFailed.run({
            id: attempt.id, safe_error_code: 'recovered_after_restart', bytes_received: 0, updated_at: now,
          });
        }
      }
    });
    reconcile();
    this.recomputeAllReservations();
    const accounts = this.providerQ.listAccounts.all() as Array<{ id: string }>;
    return { recovered: running.length, reservationsRecomputed: accounts.length, attemptsReconciled: inFlight.length };
  }

  /**
   * Retry every durable cleanup obligation. Objects whose id is still unknown
   * stay pending: the connector must never guess that a remote object is gone.
   */
  async retryPendingCleanups(): Promise<{ retried: number; cleaned: number; stillPending: number }> {
    const pending = this.pendingCleanups();
    let cleaned = 0;
    let stillPending = 0;
    const now = new Date().toISOString();
    for (const attempt of pending) {
      const row = this.db.prepare('SELECT provider_account_id FROM upload_attempts WHERE id = ?')
        .get(attempt.id) as { provider_account_id: string } | undefined;
      if (!row) { stillPending++; continue; }
      if (!attempt.remote_object_id) {
        // the remote id was never confirmed, so the obligation cannot be closed
        stillPending++;
        continue;
      }
      try {
        await this.deleteRemoteObject(row.provider_account_id, attempt.remote_object_id);
        this.q.markAttemptCleaned.run(now, attempt.id);
        cleaned++;
      } catch {
        stillPending++;
      }
    }
    return { retried: pending.length, cleaned, stillPending };
  }

  /**
   * Verify a reselected source before skipping already-completed chunks.
   * Returns the chunks that still need uploading, and refuses (source_changed)
   * when a previously completed slice no longer hashes to its saved digest.
   */
  async verifyReselectedSource(
    jobId: string,
    chunkSizeBytes: number,
    readSlice: (offsetBytes: number, sizeBytes: number) => Promise<Buffer>,
  ): Promise<{ missingChunks: number[]; verifiedChunks: number }> {
    const job = this.q.getJob.get(jobId) as JobRow | undefined;
    if (!job?.file_id) throw new UploadError('job_not_found', 404);
    const file = this.q.getFile.get(job.file_id) as FileRow | undefined;
    if (!file) throw new UploadError('job_not_found', 404);
    if (file.chunk_size_bytes !== chunkSizeBytes) {
      throw new UploadError('source_changed', 409);
    }
    const done = new Map(
      (this.q.listChunks.all(file.id) as Array<{ chunk_index: number; offset_bytes: number; size_bytes: number; sha256: string }>)
        .map((c) => [c.chunk_index, c]),
    );
    const missing: number[] = [];
    let verified = 0;
    for (let i = 0; i < job.chunks_total; i++) {
      const saved = done.get(i);
      if (!saved) { missing.push(i); continue; }
      const slice = await readSlice(saved.offset_bytes, saved.size_bytes);
      const digest = crypto.createHash('sha256').update(slice).digest('hex');
      if (digest !== saved.sha256) {
        // do not overwrite: the source is not the file this job was planned for
        throw new UploadError('source_changed', 409);
      }
      verified++;
    }
    return { missingChunks: missing, verifiedChunks: verified };
  }

  /** Durable cleanup obligations that must be retried later. */
  pendingCleanups(): Array<{ id: string; object_key: string; remote_object_id: string | null }> {
    return this.q.cleanupPendingAttempts.all() as Array<{ id: string; object_key: string; remote_object_id: string | null }>;
  }

  // ---- route bridge helpers: keep provider/DB detail out of the router ----

  /** Account row needed to talk to a provider for this upload. */
  getAccountForUpload(accountId: string): { id: string; provider: string } | undefined {
    const row = this.providerQ.getAccount.get(accountId) as { id: string; provider: string } | undefined;
    if (!row) return undefined;
    const adapter = getAdapter(row.provider);
    // an adapter that cannot upload must never be used for a chunk
    if (!adapter?.capabilities.upload || !adapter.uploadObjectStream) return undefined;
    return row;
  }

  /** Decrypted credential bundle for the account. */
  loadBundleFor(accountId: string) {
    const row = this.providerQ.getAccount.get(accountId) as Parameters<CredentialsStore['loadAccountBundle']>[0] | undefined;
    if (!row) throw new UploadError('account_needs_reauth', 409);
    const bundle = this.store.loadAccountBundle(row);
    if (!bundle) throw new UploadError('account_needs_reauth', 409);
    return bundle;
  }

  /**
   * The CloudNest-managed remote root for this account, created lazily on the
   * first upload and persisted before any bytes are sent.
   */
  ensureRootFor(accountId: string): string {
    const existing = this.db
      .prepare('SELECT remote_root_id, status FROM provider_account_roots WHERE provider_account_id = ?')
      .get(accountId) as { remote_root_id: string; status: string } | undefined;
    if (existing && existing.status === 'ready') return existing.remote_root_id;
    throw new UploadError('provider_root_missing', 409);
  }

  /**
   * Ensure the account has a CloudNest-managed remote root, creating it lazily
   * on first use and persisting the id before any chunk bytes are sent.
   */
  async ensureOrCreateRoot(accountId: string): Promise<string> {
    const existing = this.db
      .prepare("SELECT remote_root_id, status FROM provider_account_roots WHERE provider_account_id = ?")
      .get(accountId) as { remote_root_id: string; status: string } | undefined;
    if (existing && existing.status === 'ready') return existing.remote_root_id;

    const account = this.providerQ.getAccount.get(accountId) as
      | { id: string; provider: string }
      | undefined;
    if (!account) throw new UploadError('account_needs_reauth', 409);
    const adapter = getAdapter(account.provider);
    if (!adapter?.ensureAppRoot) throw new UploadError('provider_unavailable', 502);
    const bundle = this.loadBundleFor(accountId);
    const appConfig = account.provider === 'mega' || account.provider === 'pcloud'
      ? undefined
      : this.store.getConfig(account.provider)?.config ?? undefined;
    try {
      const root = await adapter.ensureAppRoot(bundle, appConfig);
      this.saveRootFor(accountId, root.remoteRootId);
      return root.remoteRootId;
    } catch (err) {
      const now = new Date().toISOString();
      this.db.prepare(
        `INSERT INTO provider_account_roots (provider_account_id, remote_root_id, status, created_at, updated_at)
         VALUES (?, '', ?, ?, ?)
         ON CONFLICT(provider_account_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
      ).run(accountId, err instanceof ProviderError && err.safeCode === 'needs_reauth' ? 'needs_reauth' : 'error', now, now);
      if (err instanceof ProviderError) throw new UploadError(err.safeCode, err.httpStatus);
      throw new UploadError('provider_unavailable', 502);
    }
  }

  /** Persist a verified remote root id for later uploads. */
  saveRootFor(accountId: string, remoteRootId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO provider_account_roots (provider_account_id, remote_root_id, status, created_at, updated_at)
       VALUES (?, ?, 'ready', ?, ?)
       ON CONFLICT(provider_account_id) DO UPDATE SET remote_root_id = excluded.remote_root_id,
         status = 'ready', updated_at = excluded.updated_at`,
    ).run(accountId, remoteRootId, now, now);
  }

  hashingTransform(): HashingCounter {
    return new HashingCounter();
  }

  finalizeHash(counter: HashingCounter): { sha256: string; bytes: number } {
    return { sha256: counter.digest(), bytes: counter.bytes };
  }

  /** Public job shape: no credentials, no provider session URLs. */
  publicJob(jobId: string): {
    jobId: string; fileId: string | null; originalName: string | null; state: string;
    chunksCompleted: number; chunksTotal: number; bytesCompleted: number; sizeBytes: number;
    retryCount: number; safeErrorCode: string | null; resumable: boolean; cancellable: boolean;
    createdAt: string; updatedAt: string;
  } | null {
    const job = this.q.getJob.get(jobId) as JobRow | undefined;
    if (!job) return null;
    const file = job.file_id ? (this.q.getFile.get(job.file_id) as FileRow | undefined) : undefined;
    const resumable = job.state === 'queued' || job.state === 'running' || job.state === 'paused'
      || job.state === 'failed' || job.state === 'deletion_pending';
    return {
      jobId: job.id,
      fileId: job.file_id,
      originalName: file?.original_name ?? null,
      state: job.state,
      chunksCompleted: job.chunks_completed,
      chunksTotal: job.chunks_total,
      bytesCompleted: job.bytes_completed,
      sizeBytes: file?.size_bytes ?? 0,
      retryCount: job.retry_count,
      safeErrorCode: job.last_safe_error_code,
      resumable,
      cancellable: job.state !== 'completed' && job.state !== 'cancelled',
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    };
  }

  /** Public file shape with a stored-across summary from active placements. */
  publicFile(fileId: string): {
    id: string; originalName: string; sizeBytes: number; mimeType: string | null;
    chunkCount: number; chunkSizeBytes: number; state: string; storedAcross: string[];
    storageHealth: FileStorageHealth;
    tier: 'personal' | 'business';
    createdAt: string; completedAt: string | null;
  } | null {
    return this.publicFiles([fileId]).get(fileId) ?? null;
  }

  /**
   * Batched publicFile shapes for a page of files. The original per-file loop
   * issued queries per chunk × placement × account (measured: the dominant
   * files-list cost, super-linear in practice); this resolves the whole page
   * with TWO queries total and groups the rows in memory.
   */
  publicFiles(fileIds: string[]): Map<string, {
    id: string; originalName: string; sizeBytes: number; mimeType: string | null;
    chunkCount: number; chunkSizeBytes: number; state: string; storedAcross: string[];
    storageHealth: FileStorageHealth;
    tier: 'personal' | 'business';
    createdAt: string; completedAt: string | null;
  }> {
    const out = new Map<string, {
      id: string; originalName: string; sizeBytes: number; mimeType: string | null;
      chunkCount: number; chunkSizeBytes: number; state: string; storedAcross: string[];
      storageHealth: FileStorageHealth;
      tier: 'personal' | 'business';
      createdAt: string; completedAt: string | null;
    }>();
    if (fileIds.length === 0) return out;
    // Pages are ≤100 ids, comfortably inside SQLite's variable limit.
    const placeholders = fileIds.map(() => '?').join(',');
    const fileRows = this.db.prepare(
      `SELECT * FROM files WHERE id IN (${placeholders})`,
    ).all(...fileIds) as unknown as FileRow[];
    const placementRows = this.db.prepare(
      `SELECT c.file_id AS fileId, p.is_active AS isActive,
              a.id AS accountId, a.provider AS provider, a.status AS accountStatus, a.display_label AS label
       FROM chunk_placements p
       JOIN file_chunks c ON c.id = p.chunk_id
       JOIN provider_accounts a ON a.id = p.provider_account_id
       WHERE c.file_id IN (${placeholders})`,
    ).all(...fileIds) as Array<{
      fileId: string; isActive: number; accountId: string; provider: string; accountStatus: string; label: string;
    }>;

    const perFile = new Map<string, { storedAcross: string[]; unavailable: Map<string, { accountId: string; label: string; accountStatus: string }> }>();
    for (const row of placementRows) {
      let entry = perFile.get(row.fileId);
      if (!entry) {
        entry = { storedAcross: [], unavailable: new Map() };
        perFile.set(row.fileId, entry);
      }
      if (row.isActive !== 1) continue;
      if (!entry.storedAcross.includes(row.provider)) entry.storedAcross.push(row.provider);
      if (row.accountStatus !== 'connected') {
        entry.unavailable.set(row.accountId, { accountId: row.accountId, label: row.label, accountStatus: row.accountStatus });
      }
    }

    for (const file of fileRows) {
      const entry = perFile.get(file.id) ?? { storedAcross: [], unavailable: new Map<string, { accountId: string; label: string; accountStatus: string }>() };
      out.set(file.id, {
        id: file.id,
        originalName: file.original_name,
        sizeBytes: file.size_bytes,
        mimeType: file.mime_type,
        chunkCount: file.chunk_count,
        chunkSizeBytes: file.chunk_size_bytes,
        state: file.state,
        storedAcross: entry.storedAcross,
        storageHealth: storageHealthOf(entry.unavailable),
        tier: file.tier ?? 'personal',
        createdAt: file.created_at,
        completedAt: file.completed_at,
      });
    }
    return out;
  }

  /**
   * Account-aware availability for ONE file (task §5.B): whether every account
   * holding its active placements is currently connected. Used by the file
   * details route; the list route gets the same data through publicFile.
   */
  storageHealthForFile(fileId: string): FileStorageHealth {
    const unavailable = new Map<string, { accountId: string; label: string; accountStatus: string }>();
    const rows = this.db.prepare(
      `SELECT a.id, a.display_label, a.status
       FROM chunk_placements p
       JOIN file_chunks c ON c.id = p.chunk_id
       JOIN provider_accounts a ON a.id = p.provider_account_id
       WHERE p.is_active = 1 AND c.file_id = ? AND a.status <> 'connected'`,
    ).all(fileId) as Array<{ id: string; display_label: string; status: string }>;
    for (const row of rows) {
      unavailable.set(row.id, { accountId: row.id, label: row.display_label, accountStatus: row.status });
    }
    return storageHealthOf(unavailable);
  }

  /** Live dashboard summary: real rows only, unknown quota stays unknown.
   * `userId` scopes the file/job counts and the recent list to one account's
   * own data (Phase 3); when set, `userUsage` carries that account's honest
   * used-vs-allowance numbers. Pool-level fields are unchanged — the ROUTE
   * omits them for members, because provider accounts are admin knowledge.
   * `tier` (mode = complete context) scopes every section — accounts, storage
   * math, file/job/share counts — to one storage tier; null keeps the legacy
   * whole-pool view. */
  dashboardSummary(userId: string | null = null, tier: string | null = null): {
    accounts: Array<{ id: string; provider: string; displayLabel: string; status: string; quotaStatus: string; tier: string }>;
    activeJobs: number;
    recentFiles: number;
    totalFiles: number;
    accountsDetailed: Array<{
      id: string; provider: string; displayLabel: string; status: string; quotaStatus: string; tier: string;
      quotaTotalBytes: number | null; quotaUsedBytes: number | null;
      quotaUnlimited: boolean; quotaScopeKey: string | null;
      reserveBytes: number; outstandingBytes: number;
      usableBytes: number | null; lastQuotaCheckAt: string | null;
    }>;
    storage: {
      knownAccounts: number; unknownAccounts: number;
      totalBytes: number | null; usedBytes: number | null; reservedBytes: number;
      usableBytes: number | null; lastCheckedAt: string | null;
    };
    activeShareLinks: number;
    recentFileList: Array<ReturnType<UploadService['publicFile']>>;
    userUsage: { usedBytes: number; allowanceBytes: number | null } | null;
  } {
    const rows = (this.providerQ.listAccounts.all() as Array<{
      id: string; provider: string; display_label: string; status: string; quota_status: string; tier: string;
      quota_total_bytes: number | null; used_bytes: number | null;
      quota_unlimited: 0 | 1; quota_scope: string | null; reserve_bytes: number;
      last_quota_check_at: string | null;
    }>).filter((a) => tier === null || a.tier === tier);
    const activeAllocations = this.q.listAllActiveAllocations.all() as Array<{
      provider_account_id: string; size_bytes: number; state: string;
    }>;
    const s3Quotas = this.s3QuotaOverrides();
    const accountsDetailed = rows.map((a) => {
      const pendingQuotaBytes = a.provider === 's3'
        ? activeAllocations
          .filter((row) => row.provider_account_id === a.id && row.state === 'uploaded_pending_quota')
          .reduce((sum, row) => sum + row.size_bytes, 0)
        : 0;
      const outstandingBytes = outstandingReservationBytes(activeAllocations, a.id) - pendingQuotaBytes;
      const s3 = s3Quotas.get(a.id);
      const quotaTotalBytes = a.provider === 's3' ? (s3?.totalBytes ?? null) : a.quota_total_bytes;
      const quotaUsedBytes = a.provider === 's3' ? (s3?.usedBytes ?? null) : a.used_bytes;
      const quotaKnown =
        a.status === 'connected' &&
        (a.provider === 's3'
          ? quotaTotalBytes !== null // S3: owner-set cap + tracked bytes is the honest evidence
          : a.quota_status === 'current') &&
        // an experimental/not-ready provider must never be presented as usable
        // space, even when its quota is current
        PROVIDER_UPLOAD_READY.has(a.provider);
      const assessed = assessAccountCapacity({
        accountId: a.id,
        provider: a.provider,
        displayLabel: a.display_label,
        status: a.status,
        quotaStatus: a.provider === 's3'
          ? (quotaTotalBytes !== null ? 'current' as const : 'unknown' as const)
          : a.quota_status as 'current' | 'stale' | 'unknown',
        quotaTotalBytes,
        quotaUsedBytes,
        quotaUnlimited: a.quota_unlimited === 1,
        quotaScopeKey: a.quota_scope,
        reserveBytes: a.reserve_bytes,
        outstandingReservationBytes: outstandingBytes,
      });
      return {
        id: a.id,
        provider: a.provider,
        displayLabel: a.display_label,
        status: a.status,
        tier: a.tier,
        quotaStatus: a.provider === 's3' ? (quotaTotalBytes !== null ? 'current' : 'unknown') : a.quota_status,
        quotaTotalBytes,
        quotaUsedBytes,
        quotaUnlimited: a.quota_unlimited === 1,
        quotaScopeKey: a.quota_scope,
        reserveBytes: a.reserve_bytes,
        outstandingBytes,
        // usable is claimed only where the uploader's own preflight can vouch
        // for it; otherwise null and the UI shows "Unknown", never 0. An
        // unlimited quota is real evidence but never a numeric value: the UI
        // labels it "Unlimited" instead of summing an invented total.
        usableBytes: quotaKnown && a.quota_unlimited !== 1 ? assessed.usableBytes : null,
        lastQuotaCheckAt: a.last_quota_check_at,
      };
    });
    const known = accountsDetailed.filter((a) => a.usableBytes !== null);
    const sumOf = (pick: (a: (typeof known)[number]) => number | null): number | null =>
      known.length === 0 ? null : known.reduce((acc, a) => acc + (pick(a) ?? 0), 0);
    const storage = {
      knownAccounts: known.length,
      unknownAccounts: accountsDetailed.length - known.length,
      totalBytes: sumOf((a) => a.quotaTotalBytes),
      usedBytes: sumOf((a) => a.quotaUsedBytes),
      reservedBytes: accountsDetailed.reduce((acc, a) => acc + a.reserveBytes, 0),
      usableBytes: sumOf((a) => a.usableBytes),
      lastCheckedAt: known
        .map((a) => a.lastQuotaCheckAt)
        .filter((v): v is string => typeof v === 'string')
        .sort()
        .pop() ?? null,
    };

    const accounts = rows.map((a) => ({
      id: a.id, provider: a.provider, displayLabel: a.display_label,
      status: a.status, quotaStatus: a.quota_status, tier: a.tier,
    }));
    const jobs = this.listJobs(200, userId, tier);
    // honest active-job count: the 200-row listing page above must not bound
    // this number, so it is its own COUNT (same upload-job scope as the list)
    const activeJobs = userId === null
      ? (this.db.prepare(
          `SELECT COUNT(*) AS n FROM transfer_jobs j LEFT JOIN files f ON f.id = j.file_id
           WHERE j.job_type = 'upload' AND j.state IN ('running','queued','paused') AND (? IS NULL OR f.tier = ?)`,
        ).get(tier, tier) as { n: number }).n
      : (this.db.prepare(
          `SELECT COUNT(*) AS n FROM transfer_jobs j JOIN files f ON f.id = j.file_id
           WHERE f.user_id = ? AND j.job_type = 'upload' AND j.state IN ('running','queued','paused') AND (? IS NULL OR f.tier = ?)`,
        ).get(userId, tier, tier) as { n: number }).n;
    const files = this.listFiles(5, 0, userId, tier);
    const shareTierGuard = tier === null
      ? ''
      : ' AND EXISTS (SELECT 1 FROM share_link_items i JOIN files fi ON fi.id = i.file_id WHERE i.share_link_id = l.id AND fi.tier = ?)';
    const activeShareLinks = userId === null
      ? (this.db.prepare(
          `SELECT COUNT(*) AS n FROM share_links l WHERE l.state = 'active'${shareTierGuard}`,
        ).get(...(tier === null ? [] : [tier])) as { n: number }).n
      : (this.db.prepare(
          `SELECT COUNT(*) AS n FROM share_links l WHERE l.state = 'active' AND l.created_by = ?${shareTierGuard}`,
        ).get(...(tier === null ? [userId] : [userId, tier])) as { n: number }).n;
    const userUsage = userId === null ? null : (() => {
      const row = this.db.prepare('SELECT allowance_bytes FROM users WHERE id = ?').get(userId) as
        | { allowance_bytes: number | null }
        | undefined;
      return {
        usedBytes: (this.db.prepare(
          "SELECT COALESCE(SUM(size_bytes), 0) AS n FROM files WHERE user_id = ? AND state <> 'deleted' AND (? IS NULL OR tier = ?)",
        ).get(userId, tier, tier) as { n: number }).n,
        allowanceBytes: row?.allowance_bytes ?? null,
      };
    })();
    return {
      accounts,
      activeJobs,
      recentFiles: files.length,
      totalFiles: this.countFiles(userId, tier),
      accountsDetailed,
      storage,
      activeShareLinks,
      recentFileList: (() => {
        // keep listFiles order: the batch Map is keyed, not ordered
        const recent = this.publicFiles(files.map((f) => f.id));
        return files.map((f) => recent.get(f.id)!);
      })(),
      userUsage,
    };
  }

  /** Hash a chunk stream while forwarding it, verifying the exact byte count. */
  static async hashChunkStream(
    stream: NodeJS.ReadableStream,
    expectedBytes: number,
  ): Promise<{ sha256: string; bytes: number }> {
    const result = await drainAndHash(stream);
    if (result.bytes !== expectedBytes) {
      throw new UploadError('chunk_size_mismatch', 400);
    }
    return result;
  }
}

/** Versioned, deterministic manifest hash over ordered chunk descriptors. */
export function manifestHash(chunks: Array<{ size_bytes: number; sha256?: string | null }>): string {
  const canonical = chunks.map((c, i) => `${i}:${c.size_bytes}:${c.sha256 ?? ''}`).join('|');
  return crypto.createHash('sha256').update(`v1|${canonical}`).digest('hex');
}
