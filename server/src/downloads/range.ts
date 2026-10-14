/**
 * Single-range parsing and byte-range to logical-chunk mapping (M10.a).
 *
 * V1 supports exactly one HTTP Range spec. Malformed or multi-range requests
 * are a client error; a well-formed but unsatisfiable range is a 416.
 */

export class RangeError_ extends Error {
  readonly kind: 'malformed' | 'unsatisfiable';
  readonly status: number;
  readonly safeCode: string;
  constructor(kind: 'malformed' | 'unsatisfiable') {
    super(kind === 'malformed' ? 'invalid_range' : 'range_not_satisfiable');
    this.kind = kind;
    this.status = kind === 'malformed' ? 400 : 416;
    this.safeCode = kind === 'malformed' ? 'invalid_range' : 'range_not_satisfiable';
  }
}

export interface ResolvedRange {
  start: number;
  end: number;
  length: number;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * Parse a single `Range` header value.
 * Accepts `bytes=start-end`, `bytes=start-`, `bytes=-suffix`.
 * A comma (multi-range) is refused: V1 never generates multipart/byteranges.
 */
export function parseSingleRange(header: string | undefined, fileSize: number): ResolvedRange | null {
  if (!header) return null;
  const value = header.trim();
  if (!value.toLowerCase().startsWith('bytes=')) throw new RangeError_('malformed');
  const spec = value.slice(6).trim();
  if (spec === '') throw new RangeError_('malformed');
  if (spec.includes(',')) throw new RangeError_('malformed'); // multi-range unsupported in V1
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) throw new RangeError_('malformed');
  const [, startRaw, endRaw] = match;
  const hasStart = startRaw !== '';
  const hasEnd = endRaw !== '';
  if (!hasStart && !hasEnd) throw new RangeError_('malformed');

  const toSafe = (raw: string): number => {
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_SAFE) throw new RangeError_('malformed');
    return n;
  };

  // A zero-length file can never satisfy a range.
  if (fileSize === 0) throw new RangeError_('unsatisfiable');

  if (hasStart) {
    const start = toSafe(startRaw as string);
    if (start >= fileSize) throw new RangeError_('unsatisfiable');
    const end = hasEnd ? toSafe(endRaw as string) : fileSize - 1;
    if (end < start) throw new RangeError_('malformed');
    const clampedEnd = Math.min(end, fileSize - 1);
    return { start, end: clampedEnd, length: clampedEnd - start + 1 };
  }
  // suffix form: bytes=-N means the final N bytes
  const suffix = toSafe(endRaw as string);
  if (suffix === 0) throw new RangeError_('unsatisfiable');
  const start = Math.max(0, fileSize - suffix);
  return { start, end: fileSize - 1, length: fileSize - start };
}

export interface ChunkSlice {
  chunkIndex: number;
  /** Absolute offset of the chunk within the file. */
  chunkOffsetBytes: number;
  chunkSizeBytes: number;
  /** The sub-slice of the chunk that the client actually asked for. */
  sliceStartInChunk: number;
  sliceLength: number;
}

/**
 * The logical chunks that overlap a requested interval, with the exact
 * sub-slice needed from each. Never returns a chunk outside the request, so a
 * short range cannot cause a whole-file read.
 */
export function chunksForRange(
  range: ResolvedRange,
  chunkSizeBytes: number,
  fileSizeBytes: number,
): ChunkSlice[] {
  if (chunkSizeBytes <= 0) throw new RangeError_('malformed');
  const firstChunk = Math.floor(range.start / chunkSizeBytes);
  const lastChunk = Math.floor(range.end / chunkSizeBytes);
  const slices: ChunkSlice[] = [];
  for (let index = firstChunk; index <= lastChunk; index++) {
    const chunkOffsetBytes = index * chunkSizeBytes;
    if (chunkOffsetBytes >= fileSizeBytes) break;
    const chunkSizeBytesActual = Math.min(chunkSizeBytes, fileSizeBytes - chunkOffsetBytes);
    const overlapStart = Math.max(range.start, chunkOffsetBytes);
    const overlapEnd = Math.min(range.end, chunkOffsetBytes + chunkSizeBytesActual - 1);
    if (overlapEnd < overlapStart) continue;
    slices.push({
      chunkIndex: index,
      chunkOffsetBytes,
      chunkSizeBytes: chunkSizeBytesActual,
      sliceStartInChunk: overlapStart - chunkOffsetBytes,
      sliceLength: overlapEnd - overlapStart + 1,
    });
  }
  return slices;
}

/** A stable, quoted ETag derived from the versioned manifest hash. */
export function etagForManifest(manifestHash: string | null): string {
  if (!manifestHash) return '"cn-nomanifest"';
  return `"cn-${manifestHash.slice(0, 32)}"`;
}

/** RFC 5987-safe attachment disposition; CR/LF are stripped from both names. */
export function contentDisposition(filename: string): string {
  const asciiSafe = filename.replace(/[\u0000-\u001f\u007f"\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(filename.replace(/[\u0000-\u001f\u007f]/g, ''));
  return `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encoded}`;
}

/** Content-Type fallback: an unknown or unsafe type becomes octet-stream. */
export function safeContentType(mimeType: string | null): string {
  if (!mimeType) return 'application/octet-stream';
  // only a simple, well-formed type is honoured; anything odd falls back
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)
    ? mimeType
    : 'application/octet-stream';
}
