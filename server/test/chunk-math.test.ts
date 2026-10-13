import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_CHUNK_SIZES,
  DEFAULT_CHUNK_SIZE_MIB,
  mibToBytes,
  planChunks,
  chunkBounds,
  assertReceivedBytes,
  estimateObjectCount,
  sanitizeDisplayName,
  generateObjectKey,
  assertValidByteSize,
  assertAllowedChunkSizeMiB,
  ChunkMathError,
} from '../src/uploads/chunk-math.js';

const MIB = 1024 * 1024;

/** Assert a ChunkMathError carrying the given safe code. */
function assertSafeCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ChunkMathError, `expected a ChunkMathError, got ${String(err)}`);
    assert.equal((err as ChunkMathError).safeCode, code);
    return;
  }
  assert.fail(`expected a ChunkMathError with code ${code}`);
}


test('default chunk size is 64 MiB and only approved sizes are allowed', () => {
  assert.equal(DEFAULT_CHUNK_SIZE_MIB, 64);
  assert.deepEqual([...ALLOWED_CHUNK_SIZES], [8, 16, 32, 64]);
  assert.equal(assertAllowedChunkSizeMiB(8), 8);
  assert.equal(assertAllowedChunkSizeMiB('32'), 32);
  for (const bad of [0, 1, 7, 100, 128, -8, 1.5, NaN, 'x', null]) {
    assertSafeCode(() => assertAllowedChunkSizeMiB(bad), 'invalid_upload_metadata');
  }
});

test('the plan document reference case: 200,000,000,000 bytes at 64 MiB = 2,981 chunks', () => {
  const fileSize = 200_000_000_000;
  const plan = planChunks(fileSize, mibToBytes(64));
  assert.equal(plan.chunkCount, 2981);
  assert.equal(estimateObjectCount(fileSize, mibToBytes(64)), 2981);
});

test('the plan document reference case: 200 GiB at 64 MiB = 3,200 chunks', () => {
  const fileSize = 200 * 1024 * 1024 * 1024; // 200 GiB
  const plan = planChunks(fileSize, mibToBytes(64));
  assert.equal(plan.chunkCount, 3200);
});

test('smaller chunks create more objects (the warning the UI must show)', () => {
  const fileSize = 200_000_000_000;
  const at64 = estimateObjectCount(fileSize, mibToBytes(64));
  const at8 = estimateObjectCount(fileSize, mibToBytes(8));
  // 200e9 / 8 MiB = 23,841.86 -> 23,842 objects
  assert.equal(at8, 23842);
  // ceiling rounding makes the ratio approximate; 8x smaller chunks mean ~8x
  // more objects, which is the warning the UI must surface
  assert.ok(at8 > at64 * 7, `expected ~8x more objects, got ${at8} vs ${at64}`);
  assert.ok(at8 < at64 * 9, 'the ratio stays near 8x');
});

test('an empty file has zero chunks and no remote object', () => {
  const plan = planChunks(0, mibToBytes(64));
  assert.equal(plan.chunkCount, 0);
  assert.equal(estimateObjectCount(0, mibToBytes(64)), 0);
});

test('chunk boundaries are exact, with a short final chunk', () => {
  const chunkSize = mibToBytes(8);
  // 8 MiB + 1 byte => 2 chunks, the second one byte long
  const plan = planChunks(chunkSize + 1, chunkSize);
  assert.equal(plan.chunkCount, 2);
  assert.deepEqual(chunkBounds(plan, 0), { chunkIndex: 0, offsetBytes: 0, sizeBytes: chunkSize });
  assert.deepEqual(chunkBounds(plan, 1), { chunkIndex: 1, offsetBytes: chunkSize, sizeBytes: 1 });
});

test('chunks never overshoot the file and always reconstruct the exact size', () => {
  for (const size of [1, 2, MIB - 1, MIB, 2 * MIB + 7, 100 * MIB + 1, 200_000_000_000]) {
    const plan = planChunks(size, mibToBytes(16));
    let total = 0;
    for (let i = 0; i < plan.chunkCount; i++) {
      const b = chunkBounds(plan, i);
      assert.equal(b.offsetBytes, total, 'offsets are contiguous with no gaps');
      assert.ok(b.sizeBytes > 0, 'no zero-length chunk is created');
      assert.ok(b.offsetBytes + b.sizeBytes <= size, 'no chunk overshoots the file');
      total += b.sizeBytes;
    }
    assert.equal(total, size, 'chunks sum exactly to the file size');
  }
});

test('an out-of-range chunk index is rejected', () => {
  const plan = planChunks(100, mibToBytes(8));
  assertSafeCode(() => chunkBounds(plan, 1), 'invalid_upload_metadata');
  assertSafeCode(() => chunkBounds(plan, 99), 'invalid_upload_metadata');
});

test('received bytes are validated against the plan, not client headers', () => {
  const chunkSize = mibToBytes(8);
  const plan = planChunks(chunkSize * 2, chunkSize);
  assert.doesNotThrow(() => assertReceivedBytes(plan, 0, chunkSize));
  assertSafeCode(() => assertReceivedBytes(plan, 0, chunkSize - 1), 'chunk_size_mismatch');
  assertSafeCode(() => assertReceivedBytes(plan, 0, chunkSize + 1), 'chunk_size_mismatch');
  // a short final chunk is validated with its own expected size
  const plan2 = planChunks(chunkSize + 5, chunkSize);
  assert.doesNotThrow(() => assertReceivedBytes(plan2, 1, 5));
  assertSafeCode(() => assertReceivedBytes(plan2, 1, 6), 'chunk_size_mismatch');
});

test('unsafe byte sizes are rejected before they reach SQLite', () => {
  for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 10, 'abc', null, {}]) {
    assertSafeCode(() => assertValidByteSize(bad), 'invalid_upload_metadata');
  }
  assert.equal(assertValidByteSize('0'), 0);
  assert.equal(assertValidByteSize(200_000_000_000), 200_000_000_000);
});

test('filenames have CR/LF/NUL and other control characters stripped', () => {
  assert.equal(sanitizeDisplayName('report\r\nfinal.pdf'), 'reportfinal.pdf');
  assert.equal(sanitizeDisplayName('a\u0000b.txt'), 'ab.txt');
  assert.equal(sanitizeDisplayName('  spaced  .txt  '), 'spaced  .txt');
  assert.equal(sanitizeDisplayName('normal file.txt'), 'normal file.txt');
  assertSafeCode(() => sanitizeDisplayName('\r\n\u0000'), 'invalid_upload_metadata');
  assertSafeCode(() => sanitizeDisplayName(''), 'invalid_upload_metadata');
  assertSafeCode(() => sanitizeDisplayName('x'.repeat(256)), 'invalid_upload_metadata');
  assertSafeCode(() => sanitizeDisplayName(42), 'invalid_upload_metadata');
});

test('remote object keys are generated by CloudNest and never from a user path', () => {
  const key = generateObjectKey('file-uuid-1234', 7, 'attempt-uuid-9876');
  // hyphens are preserved (they are path-safe), so the key is fully deterministic
  assert.equal(key, 'cn-file-uuid-1234-c7-attempt-uuid-9876');
  // a traversal attempt in any component cannot survive key generation
  const evil = generateObjectKey('../../etc', 0, '../../passwd');
  assert.equal(evil, 'cn-etc-c0-passwd', 'slashes and dots are stripped entirely');
  assert.ok(!evil.includes('/'));
  assert.ok(!evil.includes('.'));
});

test('the error type carries a stable safe code', () => {
  const err = new ChunkMathError('invalid_upload_metadata');
  assert.equal(err.safeCode, 'invalid_upload_metadata');
  assert.ok(err instanceof Error);
});
