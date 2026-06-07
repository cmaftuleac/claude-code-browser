import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrame, FRAME_VERSION } from './frame';

describe('frame codec', () => {
  it('round-trips browserId, keyframe, seq, and payload', () => {
    const payload = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const d = decodeFrame(encodeFrame('browser-1', payload, { keyframe: true, seq: 42 }));
    expect(d.version).toBe(FRAME_VERSION);
    expect(d.keyframe).toBe(true);
    expect(d.browserId).toBe('browser-1');
    expect(d.seq).toBe(42);
    expect(Array.from(d.payload)).toEqual(Array.from(payload));
  });

  it('defaults keyframe=false and seq=0', () => {
    const d = decodeFrame(encodeFrame('b', new Uint8Array([1])));
    expect(d.keyframe).toBe(false);
    expect(d.seq).toBe(0);
  });

  it('handles multi-byte UTF-8 ids, empty payloads, and u32 seq wraparound', () => {
    const d = decodeFrame(encodeFrame('🦊-tab', new Uint8Array(0), { seq: 0xffffffff }));
    expect(d.browserId).toBe('🦊-tab');
    expect(d.seq).toBe(0xffffffff);
    expect(d.payload.length).toBe(0);
  });

  it('decodes from a raw ArrayBuffer too', () => {
    const enc = encodeFrame('b1', new Uint8Array([9]), { seq: 7 });
    const ab = enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength);
    const d = decodeFrame(ab);
    expect(d.browserId).toBe('b1');
    expect(d.seq).toBe(7);
    expect(d.payload[0]).toBe(9);
  });

  it('throws on a browserId longer than 255 UTF-8 bytes', () => {
    expect(() => encodeFrame('x'.repeat(256), new Uint8Array(0))).toThrow();
  });

  it('throws on truncated input', () => {
    expect(() => decodeFrame(new Uint8Array([1, 0, 5]))).toThrow();
  });
});
