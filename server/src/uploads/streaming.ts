import { Transform, type TransformCallback } from 'node:stream';
import crypto from 'node:crypto';

/**
 * Bounded streaming primitives for chunk transfer (M9.c).
 *
 * The incoming chunk bytes are hashed and forwarded in a single pass: the
 * server never reads a chunk twice, never buffers a whole chunk, and never
 * stages a temporary file.
 */

export class ChunkMathErrorLike extends Error {}

/** Pass-through transform that counts bytes and computes SHA-256 as they flow. */
export class HashingCounter extends Transform {
  readonly hash = crypto.createHash('sha256');
  bytes = 0;
  private finalized = false;

  constructor() {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      if (this.finalized) {
        callback(new Error('hash already finalized'));
        return;
      }
      this.hash.update(buf);
      this.bytes += buf.length;
      callback(null, buf);
    } catch (err) {
      callback(err as Error);
    }
  }

  /** Digest is only valid after the upstream stream has fully ended. */
  digest(): string {
    this.finalized = true;
    return this.hash.digest('hex');
  }
}

export interface StreamHashResult {
  sha256: string;
  bytes: number;
}

/**
 * Read a stream fully, hashing it, without retaining the bytes.
 * Used where the bytes are consumed by the adapter rather than by us.
 */
export async function drainAndHash(stream: NodeJS.ReadableStream): Promise<StreamHashResult> {
  const counter = new HashingCounter();
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as unknown as Uint8Array);
    counter.hash.update(buf);
    counter.bytes += buf.length;
  }
  return { sha256: counter.digest(), bytes: counter.bytes };
}

export class ByteCountMismatchError extends Error {
  readonly expected: number;
  readonly actual: number;
  constructor(expected: number, actual: number) {
    super(`chunk_size_mismatch: expected ${expected} bytes, received ${actual}`);
    this.expected = expected;
    this.actual = actual;
  }
}

/** Confirm the received byte count matches the planned chunk exactly. */
export function assertByteCount(expected: number, actual: number): void {
  if (expected !== actual) throw new ByteCountMismatchError(expected, actual);
}
