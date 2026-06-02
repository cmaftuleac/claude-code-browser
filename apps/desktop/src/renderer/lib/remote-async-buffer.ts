/**
 * Build an `AsyncBuffer` (hyparquet's lazy file interface) over our chunked
 * `fs:readChunk` IPC. hyparquet only fetches the slices it needs — typically
 * the file footer + a couple of row groups — so a 390 MB parquet pages in
 * under a megabyte of actual bytes for a 10 k-row preview.
 *
 * `fs:readChunk` is capped at 1 MB per call; this wrapper stitches multiple
 * chunks into one ArrayBuffer when hyparquet asks for a larger span.
 */
const READ_CAP = 1024 * 1024;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface RemoteAsyncBuffer {
  byteLength: number;
  slice(start: number, end?: number): Promise<ArrayBuffer>;
}

export function createRemoteAsyncBuffer(path: string, byteLength: number): RemoteAsyncBuffer {
  return {
    byteLength,
    async slice(start: number, end?: number): Promise<ArrayBuffer> {
      const stop = Math.min(byteLength, end ?? byteLength);
      const want = Math.max(0, stop - start);
      if (want === 0) return new ArrayBuffer(0);

      if (want <= READ_CAP) {
        const res = await window.ccb.fs.readChunk(path, start, want);
        if (res.error || res.base64 == null) throw new Error(res.error ?? 'read failed');
        const bytes = base64ToBytes(res.base64);
        // Return a freshly-allocated ArrayBuffer aligned at offset 0.
        const out = new Uint8Array(bytes.length);
        out.set(bytes);
        return out.buffer;
      }

      // Multi-chunk: stitch them together.
      const out = new Uint8Array(want);
      let cur = start;
      let written = 0;
      while (cur < stop) {
        const slice = Math.min(READ_CAP, stop - cur);
        const res = await window.ccb.fs.readChunk(path, cur, slice);
        if (res.error || res.base64 == null) throw new Error(res.error ?? 'read failed');
        const b = base64ToBytes(res.base64);
        if (b.length === 0) break;
        out.set(b, written);
        written += b.length;
        cur += b.length;
      }
      return out.buffer.slice(0, written);
    },
  };
}
