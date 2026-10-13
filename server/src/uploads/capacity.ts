/**
 * Capacity preflight and durable allocation (M9.b).
 *
 * Rules from the approved plan:
 * - Only CURRENT, valid quota observations are eligible. Unknown/stale quota is
 *   never treated as free space and is excluded from automatic placement.
 * - usableNow = max(0, reportedFree - userReserve - outstandingReservations - safetyMargin)
 * - A plan either reserves every chunk or rolls back entirely; capacity is never
 *   partially reserved.
 */

export const DEFAULT_SAFETY_MARGIN_BYTES = 0;

export interface AccountCapacityInput {
  accountId: string;
  provider: string;
  displayLabel: string;
  status: string;
  quotaStatus: 'current' | 'stale' | 'unknown';
  quotaTotalBytes: number | null;
  quotaUsedBytes: number | null;
  reserveBytes: number;
  /** Outstanding CloudNest reservations for this account (bytes). */
  outstandingReservationBytes: number;
  safetyMarginBytes?: number;
}

export interface AccountCapacity {
  accountId: string;
  provider: string;
  displayLabel: string;
  eligible: boolean;
  /** Reason the account is not eligible (stable safe code). */
  reasonCode: string | null;
  usableBytes: number;
}

export interface CapacityAssessment {
  accounts: AccountCapacity[];
  eligible: AccountCapacity[];
  totalUsableBytes: number;
}

function safeNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Compute usable bytes for one account, or explain precisely why it is
 * ineligible. Never invents free space.
 */
export function assessAccountCapacity(input: AccountCapacityInput): AccountCapacity {
  const base = {
    accountId: input.accountId,
    provider: input.provider,
    displayLabel: input.displayLabel,
    usableBytes: 0,
  };
  if (input.status === 'disconnected') {
    return { ...base, eligible: false, reasonCode: 'account_disconnected' };
  }
  if (input.status === 'needs_reauth') {
    return { ...base, eligible: false, reasonCode: 'account_needs_reauth' };
  }
  if (input.status === 'error') {
    return { ...base, eligible: false, reasonCode: 'account_error' };
  }
  if (input.quotaStatus !== 'current') {
    // unknown and stale quota are NOT free space
    return { ...base, eligible: false, reasonCode: 'quota_unknown' };
  }
  if (input.quotaTotalBytes === null || input.quotaUsedBytes === null) {
    return { ...base, eligible: false, reasonCode: 'quota_unknown' };
  }
  const reportedFree = Math.max(0, input.quotaTotalBytes - input.quotaUsedBytes);
  const usableNow = Math.max(
    0,
    reportedFree -
      safeNonNegative(input.reserveBytes) -
      safeNonNegative(input.outstandingReservationBytes) -
      safeNonNegative(input.safetyMarginBytes ?? DEFAULT_SAFETY_MARGIN_BYTES),
  );
  if (usableNow <= 0) {
    return { ...base, eligible: false, reasonCode: 'no_usable_space' };
  }
  return { ...base, eligible: true, reasonCode: null, usableBytes: usableNow };
}

export function assessCapacity(inputs: AccountCapacityInput[]): CapacityAssessment {
  const accounts = inputs.map(assessAccountCapacity);
  const eligible = accounts.filter((a) => a.eligible);
  return {
    accounts,
    eligible,
    totalUsableBytes: eligible.reduce((sum, a) => sum + a.usableBytes, 0),
  };
}

export interface PreflightResult {
  canProceed: boolean;
  totalUsableBytes: number;
  shortfallBytes: number;
  assessment: CapacityAssessment;
}

/** Compare total eligible capacity with the requested file size. */
export function preflight(inputs: AccountCapacityInput[], fileSizeBytes: number): PreflightResult {
  const assessment = assessCapacity(inputs);
  const shortfall = Math.max(0, fileSizeBytes - assessment.totalUsableBytes);
  return {
    canProceed: shortfall === 0 && fileSizeBytes >= 0,
    totalUsableBytes: assessment.totalUsableBytes,
    shortfallBytes: shortfall,
    assessment,
  };
}

export interface AllocationAssignment {
  chunkIndex: number;
  accountId: string;
  sizeBytes: number;
  offsetBytes: number;
}

/**
 * Capacity-aware assignment. Deterministic given the same inputs: chunks are
 * filled from accounts in descending usable-space order, always allocating a
 * whole chunk to a single account.
 */
export function allocateChunks(
  chunkSizes: Array<{ chunkIndex: number; offsetBytes: number; sizeBytes: number }>,
  eligible: AccountCapacity[],
): AllocationAssignment[] | null {
  if (eligible.length === 0 && chunkSizes.length > 0) return null;
  // deterministic ordering: most free space first, then stable account id
  const pools = [...eligible]
    .sort((a, b) => (b.usableBytes - a.usableBytes) || a.accountId.localeCompare(b.accountId))
    .map((a) => ({ accountId: a.accountId, remaining: a.usableBytes }));
  const assignments: AllocationAssignment[] = [];
  for (const chunk of chunkSizes) {
    const pool = pools.find((p) => p.remaining >= chunk.sizeBytes);
    if (!pool) return null; // cannot place this chunk: the whole plan must fail
    pool.remaining -= chunk.sizeBytes;
    assignments.push({
      chunkIndex: chunk.chunkIndex,
      accountId: pool.accountId,
      sizeBytes: chunk.sizeBytes,
      offsetBytes: chunk.offsetBytes,
    });
  }
  return assignments;
}

/** Sum of bytes currently reserved for an account's unfinished chunks. */
export function outstandingReservationBytes(
  rows: Array<{ provider_account_id: string; size_bytes: number; state: string }>,
  accountId: string,
): number {
  let total = 0;
  for (const row of rows) {
    if (row.provider_account_id !== accountId) continue;
    // reserved and uploading keep their reservation; uploaded_pending_quota
    // stays reserved until a valid quota refresh is saved
    if (row.state === 'reserved' || row.state === 'uploading' || row.state === 'uploaded_pending_quota') {
      total += row.size_bytes;
    }
  }
  return total;
}
