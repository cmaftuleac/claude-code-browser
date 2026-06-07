import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildIceServers } from './turn';

describe('buildIceServers', () => {
  it('returns STUN-only when no TURN is configured', () => {
    expect(buildIceServers({ stunUrl: 'stun:example:3478' })).toEqual([{ urls: 'stun:example:3478' }]);
  });

  it('mints a coturn REST credential when TURN host + secret are set', () => {
    const now = 1_000_000;
    const servers = buildIceServers({ stunUrl: 'stun:s', turnHost: 'turn:t:3478', turnSecret: 'sekret', now, ttlSeconds: 600 });
    expect(servers).toHaveLength(2);
    const turn = servers[1];
    expect(turn.urls).toBe('turn:t:3478');
    expect(turn.username).toBe(String(now + 600));
    expect(turn.credential).toBe(createHmac('sha1', 'sekret').update(String(now + 600)).digest('base64'));
  });

  it('omits TURN when only the host or only the secret is set', () => {
    expect(buildIceServers({ stunUrl: 's', turnHost: 'turn:t' })).toHaveLength(1);
    expect(buildIceServers({ stunUrl: 's', turnSecret: 'x' })).toHaveLength(1);
  });

  it('is deterministic for a fixed (now, secret, ttl)', () => {
    const opts = { stunUrl: 's', turnHost: 't', turnSecret: 'k', now: 5, ttlSeconds: 10 };
    expect(buildIceServers(opts)[1].credential).toBe(buildIceServers(opts)[1].credential);
  });
});
