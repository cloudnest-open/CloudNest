import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessAccountCapacity,
  assessCapacity,
  preflight,
  allocateChunks,
  outstandingReservationBytes,
  type AccountCapacityInput,
} from '../src/uploads/capacity.js';

const MIB = 1024 * 1024;

function acct(over: Partial<AccountCapacityInput> = {}): AccountCapacityInput {
  return {
    accountId: 'acc-1',
    provider: 'google_drive',
    displayLabel: 'a@example.com',
    status: 'connected',
    quotaStatus: 'current',
    quotaTotalBytes: 100 * MIB,
    quotaUsedBytes: 10 * MIB,
    reserveBytes: 0,
    outstandingReservationBytes: 0,
    ...over,
  };
}

test('usable bytes subtract reserve, outstanding reservations and safety margin', () => {
  const result = assessAccountCapacity(
    acct({
      quotaTotalBytes: 100 * MIB,
      quotaUsedBytes: 10 * MIB,
      reserveBytes: 5 * MIB,
      outstandingReservationBytes: 20 * MIB,
      safetyMarginBytes: 1 * MIB,
    }),
  );
  // 90 - 5 - 20 - 1 = 64 MiB
  assert.equal(result.usableBytes, 64 * MIB);
  assert.equal(result.eligible, true);
});

test('unknown and stale quota are never treated as free space', () => {
  const unknown = assessAccountCapacity(acct({ quotaStatus: 'unknown', quotaTotalBytes: null, quotaUsedBytes: null }));
  assert.equal(unknown.eligible, false);
  assert.equal(unknown.reasonCode, 'quota_unknown');
  assert.equal(unknown.usableBytes, 0);

  const stale = assessAccountCapacity(acct({ quotaStatus: 'stale' }));
  assert.equal(stale.eligible, false);
  assert.equal(stale.reasonCode, 'quota_unknown');
  assert.equal(stale.usableBytes, 0, 'a stale observation is not free space');
});

test('missing quota numbers are unknown, never zero-capacity-but-eligible', () => {
  const res = assessAccountCapacity(acct({ quotaTotalBytes: null }));
  assert.equal(res.eligible, false);
  assert.equal(res.reasonCode, 'quota_unknown');
});

test('account states explain themselves precisely', () => {
  assert.equal(assessAccountCapacity(acct({ status: 'disconnected' })).reasonCode, 'account_disconnected');
  assert.equal(assessAccountCapacity(acct({ status: 'needs_reauth' })).reasonCode, 'account_needs_reauth');
  assert.equal(assessAccountCapacity(acct({ status: 'error' })).reasonCode, 'account_error');
});

test('a fully reserved or full account reports no usable space', () => {
  const full = assessAccountCapacity(acct({ quotaTotalBytes: 100 * MIB, quotaUsedBytes: 100 * MIB }));
  assert.equal(full.eligible, false);
  assert.equal(full.reasonCode, 'no_usable_space');

  const reserved = assessAccountCapacity(acct({ outstandingReservationBytes: 90 * MIB }));
  assert.equal(reserved.eligible, false);
  assert.equal(reserved.reasonCode, 'no_usable_space');
});

test('negative inputs can never inflate usable space', () => {
  const res = assessAccountCapacity(
    acct({ reserveBytes: -1000, outstandingReservationBytes: -1000, safetyMarginBytes: -1000 }),
  );
  assert.equal(res.usableBytes, 90 * MIB, 'negative reserves are clamped to zero, not added back');
});

test('preflight stops the upload with an exact shortfall when capacity is insufficient', () => {
  const result = preflight([acct({ quotaTotalBytes: 100 * MIB, quotaUsedBytes: 90 * MIB })], 50 * MIB);
  assert.equal(result.canProceed, false);
  assert.equal(result.totalUsableBytes, 10 * MIB);
  assert.equal(result.shortfallBytes, 40 * MIB);
  // the per-account reason is available for the UI
  const assessment = result.assessment.accounts[0]!;
  assert.equal(assessment.eligible, true);
});

test('preflight proceeds when eligible capacity covers the file exactly', () => {
  const result = preflight([acct({ quotaTotalBytes: 100 * MIB, quotaUsedBytes: 0 })], 100 * MIB);
  assert.equal(result.canProceed, true);
  assert.equal(result.shortfallBytes, 0);
});

test('a file larger than every eligible account cannot be allocated at all', () => {
  const inputs = [
    acct({ accountId: 'a', quotaTotalBytes: 10 * MIB, quotaUsedBytes: 0 }),
    acct({ accountId: 'b', quotaTotalBytes: 10 * MIB, quotaUsedBytes: 0 }),
  ];
  const chunks = [
    { chunkIndex: 0, offsetBytes: 0, sizeBytes: 20 * MIB },
  ];
  // total capacity is 20 MiB but no single account can hold a 20 MiB chunk
  const assignments = allocateChunks(chunks, assessCapacity(inputs).eligible);
  assert.equal(assignments, null, 'allocation fails instead of splitting a chunk across accounts');
});

test('allocation is deterministic and fills from the most free account first', () => {
  const inputs = [
    acct({ accountId: 'small', quotaTotalBytes: 10 * MIB, quotaUsedBytes: 0 }),
    acct({ accountId: 'big', quotaTotalBytes: 100 * MIB, quotaUsedBytes: 0 }),
  ];
  const eligible = assessCapacity(inputs).eligible;
  const chunks = [
    { chunkIndex: 0, offsetBytes: 0, sizeBytes: 10 * MIB },
    { chunkIndex: 1, offsetBytes: 10 * MIB, sizeBytes: 10 * MIB },
    { chunkIndex: 2, offsetBytes: 20 * MIB, sizeBytes: 10 * MIB },
  ];
  const first = allocateChunks(chunks, eligible)!;
  const second = allocateChunks(chunks, eligible)!;
  assert.deepEqual(first, second, 'the same inputs always produce the same plan');
  // the plan explicitly does NOT promise an equal split: the most free account
  // absorbs everything it can hold, and the smaller one is used only when needed
  assert.deepEqual(first.map((a) => a.accountId), ['big', 'big', 'big']);
  assert.equal(chunks.reduce((n, c) => n + c.sizeBytes, 0) <= (100 * MIB), true);
});

test('the smaller account is used once the larger one is filled', () => {
  const inputs = [
    acct({ accountId: 'small', quotaTotalBytes: 10 * MIB, quotaUsedBytes: 0 }),
    acct({ accountId: 'big', quotaTotalBytes: 20 * MIB, quotaUsedBytes: 0 }),
  ];
  const eligible = assessCapacity(inputs).eligible;
  const chunks = [0, 1, 2].map((i) => ({ chunkIndex: i, offsetBytes: i * 10 * MIB, sizeBytes: 10 * MIB }));
  const assignments = allocateChunks(chunks, eligible)!;
  assert.deepEqual(assignments.map((a) => a.accountId), ['big', 'big', 'small'], 'the overflow chunk moves to the next account');
  // each account respects its own usable ceiling
  const byAccount = assignments.reduce<Record<string, number>>((acc, a) => {
    acc[a.accountId] = (acc[a.accountId] ?? 0) + a.sizeBytes;
    return acc;
  }, {});
  assert.equal(byAccount['big'], 20 * MIB);
  assert.equal(byAccount['small'], 10 * MIB);
});

test('allocation rolls back entirely when one chunk cannot be placed', () => {
  const inputs = [acct({ accountId: 'only', quotaTotalBytes: 15 * MIB, quotaUsedBytes: 0 })];
  const eligible = assessCapacity(inputs).eligible;
  const chunks = [
    { chunkIndex: 0, offsetBytes: 0, sizeBytes: 10 * MIB },
    { chunkIndex: 1, offsetBytes: 10 * MIB, sizeBytes: 10 * MIB },
  ];
  assert.equal(allocateChunks(chunks, eligible), null, 'never a partial reservation');
});

test('an empty file needs no capacity and produces no assignment', () => {
  assert.deepEqual(allocateChunks([], assessCapacity([acct()]).eligible), []);
});

test('outstanding reservations count only unfinished chunk bytes', () => {
  const rows = [
    { provider_account_id: 'a', size_bytes: 100, state: 'reserved' },
    { provider_account_id: 'a', size_bytes: 200, state: 'uploading' },
    { provider_account_id: 'a', size_bytes: 300, state: 'uploaded_pending_quota' },
    { provider_account_id: 'a', size_bytes: 400, state: 'released' },
    { provider_account_id: 'a', size_bytes: 500, state: 'needs_replan' },
    { provider_account_id: 'b', size_bytes: 999, state: 'reserved' },
  ];
  // reserved + uploading + uploaded_pending_quota stay reserved (600)
  assert.equal(outstandingReservationBytes(rows, 'a'), 600);
  assert.equal(outstandingReservationBytes(rows, 'b'), 999);
  assert.equal(outstandingReservationBytes(rows, 'missing'), 0);
});

test('multiple accounts are summed for the preflight total', () => {
  const inputs = [
    acct({ accountId: 'a', quotaTotalBytes: 100 * MIB, quotaUsedBytes: 50 * MIB }),
    acct({ accountId: 'b', provider: 'dropbox', quotaTotalBytes: 100 * MIB, quotaUsedBytes: 75 * MIB }),
    acct({ accountId: 'c', provider: 'pcloud', quotaStatus: 'unknown', quotaTotalBytes: null, quotaUsedBytes: null }),
  ];
  const assessment = assessCapacity(inputs);
  assert.equal(assessment.eligible.length, 2, 'the unknown-quota account is excluded');
  assert.equal(assessment.totalUsableBytes, 75 * MIB, '50 + 25 only');
  assert.equal(preflight(inputs, 75 * MIB).canProceed, true);
  assert.equal(preflight(inputs, 75 * MIB + 1).canProceed, false);
});
