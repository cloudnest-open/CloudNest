/**
 * Capacity preflight and durable allocation (M9.b, storage-pool task §6–§7).
 *
 * Rules from the approved plan:
 * - Only CURRENT, valid quota observations are eligible. Unknown/stale quota is
 *   never treated as free space and is excluded from automatic placement.
 * - usableNow = max(0, reportedFree - userReserve - outstandingReservations - safetyMargin)
 * - A plan either reserves every chunk or rolls back entirely; capacity is never
 *   partially reserved.
 * - A provider-documented unlimited quota (§6.1) may satisfy a plan up to the
 *   requested bytes; it is never stored as an invented numeric total.
 * - Accounts the owner confirmed share one provider pool (§6.2) are counted and
 *   reserved once per shared scope, never once per login.
 */

import { planChunks, chunkBounds } from './chunk-math.js';

export const DEFAULT_SAFETY_MARGIN_BYTES = 0;

/**
 * Sentinel usable-bytes value for a provider-confirmed unlimited quota. It is
 * only ever an in-memory feasibility value: it satisfies any representable
 * chunk placement, and it is never persisted as a numeric quota.
 */
export const UNLIMITED_USABLE_BYTES = Number.MAX_SAFE_INTEGER;

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
  /** Provider-documented unlimited quota (never inferred from an API error). */
  quotaUnlimited?: boolean;
  /** Owner-confirmed shared-pool key; null/absent = independent quota scope. */
  quotaScopeKey?: string | null;
}

export interface AccountCapacity {
  accountId: string;
  provider: string;
  displayLabel: string;
  eligible: boolean;
  /** Reason the account is not eligible (stable safe code). */
  reasonCode: string | null;
  usableBytes: number;
  quotaScopeKey: string | null;
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
    quotaScopeKey: input.quotaScopeKey ?? null,
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
  // A provider-documented unlimited quota is current evidence even without a
  // numeric total; it may satisfy a plan up to the requested bytes.
  if (input.quotaUnlimited === true) {
    return { ...base, eligible: true, reasonCode: null, usableBytes: UNLIMITED_USABLE_BYTES };
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
  // usableNow === 0 is NOT usable space: a fully reserved or exactly-full
  // account must never be offered as a placement target.
  if (usableNow <= 0) {
    return { ...base, eligible: false, reasonCode: 'no_usable_space' };
  }
  return { ...base, eligible: true, reasonCode: null, usableBytes: usableNow };
}

/**
 * Shared-scope budget (§6.2). Members of one owner-confirmed pool draw from a
 * single budget:
 * - free bytes: the MINIMUM fresh observation across current-quota members —
 *   when the pool reports one shared number every member agrees; when members
 *   disagree the smallest sample is the conservative choice;
 * - owner reserve: applied ONCE per scope (the largest member reserve);
 * - safety margin: the largest member margin;
 * - outstanding reservations: the SUM over every scope member, connected or
 *   not — committed-but-unreconciled bytes still occupy the shared pool.
 * Unlimited members cannot be merged into a numeric scope budget; a scope
 * holding an unlimited member is bounded only by that member's sentinel.
 */
function scopeBudgetFor(scopeInputs: AccountCapacityInput[], members: AccountCapacity[]): number {
  if (members.some((m) => m.usableBytes === UNLIMITED_USABLE_BYTES)) {
    return UNLIMITED_USABLE_BYTES;
  }
  const finiteMembers = scopeInputs.filter(
    (i) => i.quotaUnlimited !== true && i.quotaTotalBytes !== null && i.quotaUsedBytes !== null,
  );
  if (finiteMembers.length === 0) return 0;
  const minFree = Math.min(...finiteMembers.map((i) => Math.max(0, i.quotaTotalBytes! - i.quotaUsedBytes!)));
  const scopeReserve = Math.max(0, ...scopeInputs.map((i) => safeNonNegative(i.reserveBytes)));
  const scopeMargin = Math.max(0, ...scopeInputs.map((i) => safeNonNegative(i.safetyMarginBytes ?? 0)));
  const scopeOutstanding = scopeInputs.reduce((sum, i) => sum + safeNonNegative(i.outstandingReservationBytes), 0);
  return Math.max(0, minFree - scopeReserve - scopeOutstanding - scopeMargin);
}

export function assessCapacity(inputs: AccountCapacityInput[]): CapacityAssessment {
  const accounts = inputs.map(assessAccountCapacity);
  // apply shared-scope budgets on top of the per-account assessment
  const scopeKeys = new Set(
    accounts.map((a) => a.quotaScopeKey).filter((k): k is string => k !== null),
  );
  const scopeBudgets = new Map<string, number>();
  for (const scopeKey of scopeKeys) {
    const scopeInputs = inputs.filter((i) => (i.quotaScopeKey ?? null) === scopeKey);
    const members = accounts.filter((a) => a.quotaScopeKey === scopeKey && a.eligible);
    if (members.length === 0) continue;
    const budget = scopeBudgetFor(scopeInputs, members);
    scopeBudgets.set(scopeKey, budget);
    for (const member of members) {
      if (budget <= 0) {
        member.eligible = false;
        member.reasonCode = 'no_usable_space';
        member.usableBytes = 0;
      } else {
        member.usableBytes = budget;
      }
    }
  }
  const eligible = accounts.filter((a) => a.eligible);
  // §6.2: a shared scope contributes its budget ONCE to the pool total, no
  // matter how many logins report it; independent accounts contribute each.
  const independentSum = eligible
    .filter((a) => a.quotaScopeKey === null)
    .reduce((sum, a) => sum + a.usableBytes, 0);
  const scopedSum = [...scopeBudgets.values()].reduce((sum, n) => sum + n, 0);
  const totalUsableBytes = eligible.some((a) => a.usableBytes === UNLIMITED_USABLE_BYTES)
    ? UNLIMITED_USABLE_BYTES
    : independentSum + scopedSum;
  return { accounts, eligible, totalUsableBytes };
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
 * Routing policy for a plan (M12.a `upload.spaceAwareRouting`).
 *
 * - `capacity-aware` (default, and the V1 behaviour): chunks are placed into
 *   the pool with the most usable space first.
 * - `balanced`: chunks are spread round-robin across the pools so no single
 *   provider fills up first, while EVERY pool still stays within its own
 *   usable byte budget.
 *
 * Both strategies obey the same hard rules: a chunk is a whole unit placed in a
 * single account, and a pool is never assigned more than its usable bytes.
 */
export type RoutingStrategy = 'capacity-aware' | 'balanced';

/**
 * One placement pool: an independent account, or an owner-confirmed shared
 * quota scope whose members all draw from the same byte budget.
 */
interface PlacementPool {
  remaining: number;
  /** Member account ids in stable, deterministic order. */
  members: string[];
}

function placementPools(eligible: AccountCapacity[]): PlacementPool[] {
  const independent = eligible.filter((a) => a.quotaScopeKey === null);
  const grouped = eligible.filter((a) => a.quotaScopeKey !== null);
  const pools: PlacementPool[] = independent.map((a) => ({
    remaining: a.usableBytes,
    members: [a.accountId],
  }));
  const byScope = new Map<string, AccountCapacity[]>();
  for (const a of grouped) {
    const key = a.quotaScopeKey;
    if (key === null) continue; // unreachable: grouped only holds non-null keys
    const list = byScope.get(key) ?? [];
    list.push(a);
    byScope.set(key, list);
  }
  for (const [scopeKey, members] of byScope) {
    // all members carry the same scope budget; the min keeps it honest if a
    // caller ever hands us members assessed with differing values
    const budget = Math.min(...members.map((m) => m.usableBytes));
    const memberIds = [...members]
      .sort((a, b) => (b.usableBytes - a.usableBytes) || a.accountId.localeCompare(b.accountId))
      .map((m) => m.accountId);
    pools.push({ remaining: budget, members: memberIds });
  }
  // deterministic ordering: most room first, then stable first-member id
  return pools.sort(
    (a, b) => (b.remaining - a.remaining) || a.members[0]!.localeCompare(b.members[0]!),
  );
}

/**
 * Capacity-aware assignment. Deterministic given the same inputs: chunks are
 * filled from pools in descending usable-space order, always allocating a
 * whole chunk to a single account.
 *
 * The fail-closed rule is unchanged: if no pool can hold the chunk, the whole
 * plan fails rather than partially reserving capacity.
 */
export function allocateChunks(
  chunkSizes: Array<{ chunkIndex: number; offsetBytes: number; sizeBytes: number }>,
  eligible: AccountCapacity[],
  strategy: RoutingStrategy = 'capacity-aware',
): AllocationAssignment[] | null {
  if (eligible.length === 0 && chunkSizes.length > 0) return null;
  const ordered = placementPools(eligible);

  const assignments: AllocationAssignment[] = [];
  if (strategy === 'balanced') {
    let cursor = 0;
    for (const chunk of chunkSizes) {
      let chosen: PlacementPool | null = null;
      let usedStep = 0;
      for (let step = 0; step < ordered.length; step++) {
        const pool = ordered[(cursor + step) % ordered.length]!;
        if (pool.remaining >= chunk.sizeBytes) {
          chosen = pool;
          usedStep = step;
          break;
        }
      }
      if (!chosen) return null; // cannot place this chunk: the whole plan must fail
      chosen.remaining -= chunk.sizeBytes;
      cursor = (cursor + usedStep + 1) % ordered.length;
      assignments.push({
        chunkIndex: chunk.chunkIndex,
        accountId: chosen.members[0]!,
        sizeBytes: chunk.sizeBytes,
        offsetBytes: chunk.offsetBytes,
      });
    }
    return assignments;
  }

  for (const chunk of chunkSizes) {
    const pool = ordered.find((p) => p.remaining >= chunk.sizeBytes);
    if (!pool) return null; // cannot place this chunk: the whole plan must fail
    pool.remaining -= chunk.sizeBytes;
    assignments.push({
      chunkIndex: chunk.chunkIndex,
      accountId: pool.members[0]!,
      sizeBytes: chunk.sizeBytes,
      offsetBytes: chunk.offsetBytes,
    });
  }
  return assignments;
}

const CHUNK_SIZE_ORDER_MIB = [64, 32, 16, 8] as const;

/**
 * §7.1(5): when the selected chunk size cannot be placed on the current pool,
 * find the LARGEST supported smaller size that yields a feasible full plan.
 * The suggestion never changes the user's persisted setting — the caller only
 * offers it as a one-click alternative.
 */
export function suggestSmallerChunkSizeMiB(
  fileSizeBytes: number,
  selectedChunkSizeMiB: number,
  inputs: AccountCapacityInput[],
  strategy: RoutingStrategy = 'capacity-aware',
): number | null {
  const assessment = assessCapacity(inputs);
  for (const sizeMiB of CHUNK_SIZE_ORDER_MIB) {
    if (sizeMiB >= selectedChunkSizeMiB) continue;
    try {
      const plan = planChunks(fileSizeBytes, sizeMiB * 1024 * 1024);
      if (plan.chunkCount === 0) return sizeMiB; // an empty file fits any size
      const descriptors: Array<{ chunkIndex: number; offsetBytes: number; sizeBytes: number }> = [];
      for (let i = 0; i < plan.chunkCount; i++) {
        const b = chunkBounds(plan, i);
        descriptors.push({ chunkIndex: b.chunkIndex, offsetBytes: b.offsetBytes, sizeBytes: b.sizeBytes });
      }
      if (allocateChunks(descriptors, assessment.eligible, strategy)) return sizeMiB;
    } catch {
      // not representable at this size — keep looking at smaller sizes
    }
  }
  return null;
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
    // stays reserved until a valid quota refresh proves it is accounted for
    if (row.state === 'reserved' || row.state === 'uploading' || row.state === 'uploaded_pending_quota') {
      total += row.size_bytes;
    }
  }
  return total;
}
