/**
 * WebRTC ICE-server construction (signaling-only; media stays peer-to-peer).
 *
 * Pure + dependency-injected (no env/clock at module scope) so it's unit-testable.
 * When a TURN host + shared secret are configured, mints a short-lived coturn
 * REST credential: username = <unix-expiry>, password = base64(HMAC-SHA1(secret, username)).
 */
import { createHmac } from 'node:crypto';
import type { IceServerConfig } from '@fineguide-tesseract/shared';

export interface TurnOptions {
  stunUrl: string;
  turnHost?: string;
  turnSecret?: string;
  /** Credential lifetime in seconds (default 600). */
  ttlSeconds?: number;
  /** Unix seconds "now" (injected for tests; defaults to the real clock). */
  now?: number;
}

export function buildIceServers(opts: TurnOptions): IceServerConfig[] {
  const servers: IceServerConfig[] = [{ urls: opts.stunUrl }];
  if (opts.turnHost && opts.turnSecret) {
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    const username = String(now + (opts.ttlSeconds ?? 600));
    const credential = createHmac('sha1', opts.turnSecret).update(username).digest('base64');
    servers.push({ urls: opts.turnHost, username, credential });
  }
  return servers;
}
