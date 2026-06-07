/**
 * HTTP Range resolution for the media-file:// handler (pure; unit-testable).
 * Clamps the end to the last byte so an over-range request never advertises a
 * Content-Length longer than the bytes streamed (which stalls the client), and
 * rejects inverted/out-of-bounds ranges with 416 instead of passing a backwards
 * range to createReadStream (which throws).
 */
export type RangeResult =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

export function resolveRange(rangeHeader: string | null, size: number): RangeResult {
  if (!rangeHeader || size <= 0) return { kind: 'full' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!m) return { kind: 'full' };
  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : size - 1;
  if (!Number.isFinite(start)) start = 0;
  if (!Number.isFinite(end)) end = size - 1;
  end = Math.min(end, size - 1);
  if (start < 0 || start > end) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end };
}
