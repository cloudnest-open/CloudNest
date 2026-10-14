import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSingleRange,
  chunksForRange,
  RangeError_,
  contentDisposition,
  safeContentType,
  etagForManifest,
} from '../src/downloads/range.js';

const MIB = 1024 * 1024;

test('no range header means a full response', () => {
  assert.equal(parseSingleRange(undefined, 100), null);
  assert.equal(parseSingleRange('', 100), null);
});

test('start-end, start- and -suffix forms all resolve', () => {
  const fileSize = 1000;
  assert.deepEqual(parseSingleRange('bytes=0-99', fileSize), { start: 0, end: 99, length: 100 });
  assert.deepEqual(parseSingleRange('bytes=100-', fileSize), { start: 100, end: 999, length: 900 });
  assert.deepEqual(parseSingleRange('bytes=-100', fileSize), { start: 900, end: 999, length: 100 });
  // an end beyond the file is clamped, as HTTP requires
  assert.deepEqual(parseSingleRange('bytes=900-5000', fileSize), { start: 900, end: 999, length: 100 });
  // a suffix larger than the file yields the whole file
  assert.deepEqual(parseSingleRange('bytes=-5000', fileSize), { start: 0, end: 999, length: 1000 });
});

test('a well-formed but unsatisfiable range is 416, not 400', () => {
  try {
    parseSingleRange('bytes=1000-', 1000);
    assert.fail('expected an unsatisfiable range error');
  } catch (err) {
    assert.ok(err instanceof RangeError_);
    assert.equal((err as RangeError_).kind, 'unsatisfiable');
    assert.equal((err as RangeError_).status, 416);
  }
  // a zero-length file can satisfy no range at all
  assert.throws(() => parseSingleRange('bytes=0-0', 0), (e: unknown) => e instanceof RangeError_ && e.status === 416);
  assert.throws(() => parseSingleRange('bytes=-1', 0), (e: unknown) => e instanceof RangeError_ && e.status === 416);
});

test('malformed and multi-range requests are 400, never 416', () => {
  for (const bad of ['bytes=', 'bytes=abc', 'bytes=1-2-3', 'items=0-1', 'bytes=-', 'bytes=--5']) {
    assert.throws(
      () => parseSingleRange(bad, 1000),
      (e: unknown) => e instanceof RangeError_ && e.kind === 'malformed' && e.status === 400,
      `expected a malformed-range error for ${bad}`,
    );
  }
  // V1 never generates multipart/byteranges, so a multi-range is refused
  assert.throws(
    () => parseSingleRange('bytes=0-9,20-29', 1000),
    (e: unknown) => e instanceof RangeError_ && e.kind === 'malformed',
  );
  // an inverted interval is malformed, not unsatisfiable
  assert.throws(
    () => parseSingleRange('bytes=50-10', 1000),
    (e: unknown) => e instanceof RangeError_ && e.kind === 'malformed',
  );
});

test('unsafe or overflowing range values are rejected', () => {
  assert.throws(() => parseSingleRange(`bytes=${Number.MAX_SAFE_INTEGER + 10}-`, 1000), RangeError_);
  assert.throws(() => parseSingleRange('bytes=-99999999999999999999999', 1000), RangeError_);
});

test('range maps to only the overlapping chunks (no whole-file read)', () => {
  const chunkSize = 8 * MIB;
  const fileSize = 100 * MIB;
  // a 1 MiB range inside chunk 3 must touch exactly one chunk
  const slices = chunksForRange({ start: 3 * chunkSize, end: 3 * chunkSize + MIB - 1, length: MIB }, chunkSize, fileSize);
  assert.equal(slices.length, 1, 'a short range reads only one chunk');
  assert.equal(slices[0]!.chunkIndex, 3);
  assert.equal(slices[0]!.sliceStartInChunk, 0);
  assert.equal(slices[0]!.sliceLength, MIB);
});

test('a range that spans chunk boundaries maps to each chunk with exact sub-slices', () => {
  const chunkSize = 8 * MIB;
  const fileSize = 100 * MIB;
  const start = chunkSize - 100;
  const end = chunkSize + 500;
  const slices = chunksForRange({ start, end, length: end - start + 1 }, chunkSize, fileSize);
  assert.equal(slices.length, 2);
  assert.equal(slices[0]!.chunkIndex, 0);
  assert.equal(slices[0]!.sliceStartInChunk, chunkSize - 100);
  assert.equal(slices[0]!.sliceLength, 100);
  assert.equal(slices[1]!.chunkIndex, 1);
  assert.equal(slices[1]!.sliceStartInChunk, 0);
  assert.equal(slices[1]!.sliceLength, 501);
  // the sub-slices sum exactly to the requested length
  assert.equal(slices.reduce((n, s) => n + s.sliceLength, 0), end - start + 1);
});

test('a range inside the short final chunk is handled exactly', () => {
  const chunkSize = 8 * MIB;
  // 8 MiB + 8 MiB + 123 bytes: three chunks, the last one 123 bytes long
  const fileSize = 16 * MIB + 123;
  const start = fileSize - 50;
  const slices = chunksForRange({ start, end: fileSize - 1, length: 50 }, chunkSize, fileSize);
  assert.equal(slices.length, 1, 'only the final chunk is touched');
  assert.equal(slices[0]!.chunkIndex, 2);
  assert.equal(slices[0]!.chunkSizeBytes, 123, 'the final chunk keeps its real, shorter size');
  assert.equal(slices[0]!.sliceStartInChunk, 73);
  assert.equal(slices[0]!.sliceLength, 50);

  // and the final chunk is never asked for more bytes than it holds
  const whole = chunksForRange({ start: 0, end: fileSize - 1, length: fileSize }, chunkSize, fileSize);
  assert.equal(whole.length, 3);
  assert.deepEqual(whole.map((c) => c.chunkSizeBytes), [chunkSize, chunkSize, 123]);
});

test('never maps a chunk beyond the file', () => {
  const chunkSize = 8 * MIB;
  const fileSize = 10 * MIB;
  const slices = chunksForRange({ start: 0, end: fileSize - 1, length: fileSize }, chunkSize, fileSize);
  assert.equal(slices.length, 2);
  assert.ok(slices.every((s) => s.chunkOffsetBytes + s.chunkSizeBytes <= fileSize));
});

test('the ETag is quoted and derived from the manifest hash, not the filename', () => {
  const etag = etagForManifest('a'.repeat(64));
  assert.ok(etag.startsWith('"') && etag.endsWith('"'));
  assert.ok(etag.includes('a'.repeat(32)));
  assert.equal(etagForManifest(null), '"cn-nomanifest"');
});

test('Content-Disposition strips CR/LF and always carries a UTF-8 form', () => {
  const evil = contentDisposition('report\r\ninjected: header.pdf');
  assert.ok(!evil.includes('\r'), 'no CR can reach the header');
  assert.ok(!evil.includes('\n'), 'no LF can reach the header');
  assert.ok(evil.startsWith('attachment;'));
  assert.ok(evil.includes("filename*=UTF-8''"), 'a UTF-8 form is always present');
  // a unicode name survives in the encoded form
  const unicode = contentDisposition('বাংলা ফাইল.txt');
  assert.ok(unicode.includes("filename*=UTF-8''"));
});

test('an unsafe or missing Content-Type falls back to octet-stream', () => {
  assert.equal(safeContentType(null), 'application/octet-stream');
  assert.equal(safeContentType('text/plain'), 'text/plain');
  assert.equal(safeContentType('image/png'), 'image/png');
  // anything that is not a clean type/subtype is not echoed
  assert.equal(safeContentType('text/plain; charset=utf-8\r\nX-Evil: 1'), 'application/octet-stream');
  assert.equal(safeContentType('nonsense'), 'application/octet-stream');
});
