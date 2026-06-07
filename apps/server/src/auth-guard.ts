/**
 * Verify-only JWT gating for the web build.
 *
 * Tokens are ISSUED by the cloud API (apps/api); this server only VERIFIES them
 * with the shared CCB_JWT_SECRET — no DB, no user store here. Gating is active
 * only when CCB_REQUIRE_AUTH=true (the docker stack sets it); otherwise every
 * guard is a no-op so `npm run dev:web` and the desktop-bundled flow are unchanged.
 */
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'node:http';
import jwt from 'jsonwebtoken';

const SECRET = process.env.CCB_JWT_SECRET ?? '';
export const REQUIRE_AUTH = process.env.CCB_REQUIRE_AUTH === 'true';

interface JwtClaims {
  sub: string;
  email: string;
  tv: number;
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1] : null;
}

function verify(token: string | null | undefined): JwtClaims | null {
  if (!token || !SECRET) return null;
  try {
    return jwt.verify(token, SECRET, { algorithms: ['HS256'] }) as JwtClaims;
  } catch {
    return null;
  }
}

/** Express middleware: 401 unless a valid JWT is present (Bearer header or ?token=). */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!REQUIRE_AUTH) {
    next();
    return;
  }
  const token =
    bearer(req.headers.authorization) ??
    (typeof req.query.token === 'string' ? req.query.token : null);
  const claims = verify(token);
  if (!claims) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  (req as Request & { user?: JwtClaims }).user = claims;
  next();
}

/** ws verifyClient: reads ?token= from the upgrade URL; returning false aborts with 401. */
export function verifyWsClient(info: { req: IncomingMessage }): boolean {
  if (!REQUIRE_AUTH) return true;
  let token: string | null = null;
  try {
    token = new URL(info.req.url ?? '', 'http://localhost').searchParams.get('token');
  } catch {
    token = null;
  }
  token = token ?? bearer(info.req.headers.authorization);
  return verify(token) != null;
}

/** The authenticated user id (JWT `sub`) on a WS upgrade request, or null.
 *  Returns null when auth is off (local dev) — the registry treats null as a
 *  single shared account, so every host is visible. */
export function userIdFromRequest(req: IncomingMessage): string | null {
  if (!REQUIRE_AUTH) return null;
  let token: string | null = null;
  try {
    token = new URL(req.url ?? '', 'http://localhost').searchParams.get('token');
  } catch {
    token = null;
  }
  token = token ?? bearer(req.headers.authorization);
  return verify(token)?.sub ?? null;
}
