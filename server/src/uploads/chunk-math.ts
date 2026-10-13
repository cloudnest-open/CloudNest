/**
 * Exact chunk arithmetic (M9.a).
 *
 * All values are integer bytes; floating-point MB/GB values are never used.
 * Everything is validated as a safe integer before it reaches SQLite.
 */

export const ALLOWED_CHUNK_SIZES = [8, 16, 32, 64] as const;
export type ChunkSizeMiB = (typeof ALLOWED_CHUNK_SIZES)[number];
export const DEFAULT_CHUNK_SIZE_MIB: ChunkSizeMiB = 64;

const MIB = 1024 * 1024;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export class ChunkMathError extends Error {
  readonly safeCode: string;
  constructor(safeCode: string, message?: string) {
    super(message ?? safeCode);
    this.safeCode = safeCode;
  }
}

export function mibToBytes(mib: ChunkSizeMiB): number {
  return mib * MIB;
}

/** Only the approved chunk sizes are accepted. */
export function assertAllowedChunkSizeMiB(value: unknown): ChunkSizeMiB {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || !(ALLOWED_CHUNK_SIZES as readonly number[]).includes(n)) {
    throw new ChunkMathError('invalid_upload_metadata', `chunk size must be one of ${ALLOWED_CHUNK_SIZES.join(', ')} MiB`);
  }
  return n as ChunkSizeMiB;
}

/** Byte sizes must be safe, non-negative integers inside the safe range. */
export function assertValidByteSize(value: unknown, label = 'size'): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_SAFE) {
    throw new ChunkMathError('invalid_upload_metadata', `${label} must be a non-negative safe integer byte count`);
  }
  return n;
}

export function assertValidOffset(value: unknown): number {
  return assertValidByteSize(value, 'offset');
}

export interface ChunkPlan {
  fileSizeBytes: number;
  chunkSizeBytes: number;
  chunkCount: number;
}

/**
 * chunkCount = 0 for an empty file, otherwise ceil(size / chunkSize).
 * An empty file therefore produces no chunk and no remote object.
 */
export function planChunks(fileSizeBytes: number, chunkSizeBytes: number): ChunkPlan {
  const size = assertValidByteSize(fileSizeBytes, 'file size');
  const chunkSize = assertValidByteSize(chunkSizeBytes, 'chunk size');
  if (chunkSize <= 0) {
    throw new ChunkMathError('invalid_upload_metadata', 'chunk size must be greater than zero');
  }
  if (size === 0) return { fileSizeBytes: 0, chunkSizeBytes: chunkSize, chunkCount: 0 };
  const chunkCount = Math.ceil(size / chunkSize);
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 0) {
    throw new ChunkMathError('invalid_upload_metadata', 'chunk count is not representable');
  }
  // rounding guard: the last chunk must not overshoot the file
  if ((chunkCount - 1) * chunkSize >= size) {
    throw new ChunkMathError('invalid_upload_metadata', 'chunk arithmetic is inconsistent');
  }
  return { fileSizeBytes: size, chunkSizeBytes: chunkSize, chunkCount };
}

export interface ChunkBounds {
  chunkIndex: number;
  offsetBytes: number;
  sizeBytes: number;
}

/** Expected offset/size for a zero-based chunk index. */
export function chunkBounds(plan: ChunkPlan, chunkIndex: number): ChunkBounds {
  const index = assertValidByteSize(chunkIndex, 'chunk index');
  if (index >= plan.chunkCount) {
    throw new ChunkMathError('invalid_upload_metadata', 'chunk index is outside the plan');
  }
  const offsetBytes = index * plan.chunkSizeBytes;
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0) {
    throw new ChunkMathError('invalid_upload_metadata', 'chunk offset is not representable');
  }
  const sizeBytes = Math.min(plan.chunkSizeBytes, plan.fileSizeBytes - offsetBytes);
  if (sizeBytes <= 0) {
    throw new ChunkMathError('invalid_upload_metadata', 'chunk size must be greater than zero');
  }
  return { chunkIndex: index, offsetBytes, sizeBytes };
}

/** Verify a byte count received for a given chunk against the plan. */
export function assertReceivedBytes(plan: ChunkPlan, chunkIndex: number, receivedBytes: number): void {
  const expected = chunkBounds(plan, chunkIndex);
  if (receivedBytes !== expected.sizeBytes) {
    throw new ChunkMathError('chunk_size_mismatch', 'received byte count does not match the planned chunk size');
  }
}

/** Estimated logical chunk / remote object count for preflight display. */
export function estimateObjectCount(fileSizeBytes: number, chunkSizeBytes: number): number {
  return planChunks(fileSizeBytes, chunkSizeBytes).chunkCount;
}

const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Filename rules: control characters (CR/LF/NUL etc.) are stripped for the
 * stored display name, and remote names are never derived from user input.
 */
export function sanitizeDisplayName(rawName: unknown): string {
  if (typeof rawName !== 'string') {
    throw new ChunkMathError('invalid_upload_metadata', 'file name must be a string');
  }
  const stripped = rawName.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (stripped === '') {
    throw new ChunkMathError('invalid_upload_metadata', 'file name must not be empty');
  }
  if (stripped.length > 255) {
    throw new ChunkMathError('invalid_upload_metadata', 'file name is too long');
  }
  if (UNSAFE_NAME_CHARS.test(stripped)) {
    throw new ChunkMathError('invalid_upload_metadata', 'file name contains unsafe characters');
  }
  return stripped;
}

/** Remote object names are generated by CloudNest, never from a user path. */
export function generateObjectKey(fileId: string, chunkIndex: number, attemptId: string): string {
  const safeId = fileId.replace(/[^A-Za-z0-9-]/g, '');
  const safeAttempt = attemptId.replace(/[^A-Za-z0-9-]/g, '');
  return `cn-${safeId}-c${chunkIndex}-${safeAttempt}`;
}
