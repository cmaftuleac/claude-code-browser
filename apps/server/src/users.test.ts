import { describe, it, expect } from 'vitest';
import { sanitizeUserId, resolveUserRoot, scopeBrowserId } from './users';

describe('sanitizeUserId', () => {
  it('keeps [A-Za-z0-9_-] unchanged', () => {
    expect(sanitizeUserId('abc-DEF_123')).toBe('abc-DEF_123');
  });

  it('replaces path separators and traversal with underscores', () => {
    expect(sanitizeUserId('../../etc/passwd')).toBe('______etc_passwd');
    expect(sanitizeUserId('a/b\\c')).toBe('a_b_c');
    expect(sanitizeUserId('.')).toBe('_');
  });

  it('caps the length at 64', () => {
    expect(sanitizeUserId('x'.repeat(200))).toHaveLength(64);
  });
});

describe('resolveUserRoot', () => {
  it('returns the shared root when auth is off', () => {
    expect(resolveUserRoot('/work', 'user1', false)).toBe('/work');
  });

  it('returns the shared root when there is no userId', () => {
    expect(resolveUserRoot('/work', null, true)).toBe('/work');
  });

  it('returns a per-user subtree when auth is on and a userId is present', () => {
    expect(resolveUserRoot('/work', 'user1', true)).toBe('/work/user1');
  });

  it('cannot escape the root via a malicious userId', () => {
    const r = resolveUserRoot('/work', '../../etc', true);
    expect(r).toBe('/work/______etc');
    expect(r.startsWith('/work/')).toBe(true);
  });
});

describe('scopeBrowserId', () => {
  it('returns the raw id when there is no user (single-tenant)', () => {
    expect(scopeBrowserId(null, 'b1')).toBe('b1');
    expect(scopeBrowserId(null, 'default')).toBe('default');
  });

  it('namespaces by sanitized user id', () => {
    expect(scopeBrowserId('user1', 'default')).toBe('user1::default');
    expect(scopeBrowserId('a/b', 'tab-7')).toBe('a_b::tab-7');
  });

  it('keeps two users isolated on the same browserId', () => {
    expect(scopeBrowserId('alice', 'default')).not.toBe(scopeBrowserId('bob', 'default'));
  });
});
