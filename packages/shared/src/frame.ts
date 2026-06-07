/**
 * Binary wire format for the `frame` channel (fallback video stream).
 *
 * Browser- and Node-safe (Uint8Array/DataView, no Buffer), so the server encoder
 * and the web client decoder share ONE implementation and can't drift. Layout:
 *
 *   [u8 version=1][u8 flags (bit0: keyframe)][u8 browserIdLen]
 *   [browserId utf8][u32 seq big-endian][...payload (JPEG or encoded chunk)]
 */
export const FRAME_VERSION = 1;

export interface DecodedFrame {
  version: number;
  keyframe: boolean;
  browserId: string;
  seq: number;
  payload: Uint8Array;
}

/** Frame the payload for `browserId`. Throws if browserId exceeds 255 UTF-8 bytes. */
export function encodeFrame(browserId: string, payload: Uint8Array, opts?: { keyframe?: boolean; seq?: number }): Uint8Array {
  const id = new TextEncoder().encode(browserId);
  if (id.length > 255) throw new Error('browserId too long for frame header (max 255 UTF-8 bytes)');
  const headLen = 3 + id.length + 4;
  const out = new Uint8Array(headLen + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, FRAME_VERSION);
  dv.setUint8(1, opts?.keyframe ? 1 : 0);
  dv.setUint8(2, id.length);
  out.set(id, 3);
  dv.setUint32(3 + id.length, (opts?.seq ?? 0) >>> 0, false); // big-endian
  out.set(payload, headLen);
  return out;
}

/** Parse a framed buffer. The returned payload is a view onto the input buffer. */
export function decodeFrame(buf: ArrayBuffer | Uint8Array): DecodedFrame {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 7) throw new Error('frame too short');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint8(0);
  const keyframe = (dv.getUint8(1) & 1) === 1;
  const idLen = dv.getUint8(2);
  if (u8.length < 3 + idLen + 4) throw new Error('frame header truncated');
  const browserId = new TextDecoder().decode(u8.subarray(3, 3 + idLen));
  const seq = dv.getUint32(3 + idLen, false);
  const payload = u8.subarray(3 + idLen + 4);
  return { version, keyframe, browserId, seq, payload };
}
