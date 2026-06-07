import { describe, it, expect } from 'vitest';
import { envelope, isEnvelope } from './ws-protocol';

describe('envelope()', () => {
  it('wraps a payload on a channel', () => {
    expect(envelope('agent', { type: 'ping' })).toEqual({ channel: 'agent', payload: { type: 'ping' } });
  });

  it('attaches route fields when provided', () => {
    expect(envelope('browser', { x: 1 }, { hostId: 'h1', browserId: 'b1' })).toEqual({
      channel: 'browser', payload: { x: 1 }, hostId: 'h1', browserId: 'b1',
    });
  });

  it('omits route keys that are not provided', () => {
    const e = envelope('signal', {}, { browserId: 'b1' });
    expect(e.browserId).toBe('b1');
    expect('hostId' in e).toBe(false);
    expect('sessionId' in e).toBe(false);
  });
});

describe('isEnvelope()', () => {
  it('accepts a well-formed envelope', () => {
    expect(isEnvelope({ channel: 'agent', payload: {} })).toBe(true);
    expect(isEnvelope({ channel: 'frame', payload: null })).toBe(true);
  });

  it('rejects raw messages and non-objects', () => {
    expect(isEnvelope({ type: 'ping' })).toBe(false);     // raw ClientMessage
    expect(isEnvelope({ channel: 'agent' })).toBe(false); // no payload key
    expect(isEnvelope({ payload: {} })).toBe(false);      // no channel
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope('agent')).toBe(false);
    expect(isEnvelope(42)).toBe(false);
  });
});
