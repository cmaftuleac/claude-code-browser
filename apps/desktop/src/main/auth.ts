/**
 * Desktop account auth against the fineguide.ai parent platform (its /api/core).
 *
 * - Google sign-in: opens the system browser (so the user's existing Google logins
 *   + password managers are available) and captures the redirected `code` on a fixed
 *   127.0.0.1:8765 loopback, then POSTs it to fineguide's /auth/google (it holds the
 *   client secret + does the exchange). The external browser can't tell us when it's
 *   closed, so the flow is CANCELLABLE from the UI (cancelGoogle) with a backstop timeout.
 * - fineguide is cookie-less from our side: we store { token, refreshToken,
 *   refreshTokenId } (safeStorage, userData/auth.bin) and send `Authorization:
 *   Bearer <token>`. On 401 we refresh once via /auth/refresh-token.
 * - Offline-tolerant: authMe() only clears the session on an explicit 401/403
 *   (after a refresh attempt); any network/other error keeps the cached user.
 *
 * Config (all overridable via env):
 *   CCB_FINEGUIDE_API              base API (default https://fineguide.ai/api/core)
 *   CCB_FINEGUIDE_GOOGLE_CLIENT_ID public Google web client id (from fineguide sources)
 *   CCB_FINEGUIDE_LOOPBACK_PORT    fixed loopback port (default 8765) — MUST be a
 *                                  registered redirect URI on the Google client.
 *
 * The local agent/fs IPC is untouched — this module only talks to the remote API.
 * CCB_BACKEND_ORIGIN stays SEPARATE (the Mode-B host daemon's agent relay).
 */
import { app, safeStorage, shell, BrowserWindow } from 'electron';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { User, AuthResult, ProfilePayload, PlanPayload } from '@fineguide-tesseract/shared';

const FG_API = (process.env.CCB_FINEGUIDE_API ?? 'https://fineguide.ai/api/core').replace(/\/$/, '');
const FG_GOOGLE_CLIENT_ID =
  process.env.CCB_FINEGUIDE_GOOGLE_CLIENT_ID ??
  '489501668916-jcpfhbaer99e4078tind9r4rg989v8i3.apps.googleusercontent.com';
const LOOPBACK_PORT = Number(process.env.CCB_FINEGUIDE_LOOPBACK_PORT ?? 8765);
const LOOPBACK_REDIRECT = `http://127.0.0.1:${LOOPBACK_PORT}`;

// Agent-relay origin for the Mode-B host daemon — unchanged, NOT the identity origin.
export const BACKEND_ORIGIN = (process.env.CCB_BACKEND_ORIGIN ?? 'http://localhost:8080').replace(/\/$/, '');

interface Stored {
  token: string;
  refreshToken?: string;
  refreshTokenId?: string;
  user: User;
}

// ── fineguide response shapes (minimal) ──────────────────────────────────────
interface FgOrg { id: string; name?: string | null; logoUrl?: string | null }
interface FgUserView {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  ownerOrganizations?: FgOrg[];
}
interface FgLoginResponse {
  token: string;
  refreshToken?: string;
  refreshTokenId?: string;
  session?: { id: string; email: string };
}

function storeFile(): string {
  return join(app.getPath('userData'), 'auth.bin');
}

function read(): Stored | null {
  try {
    if (!existsSync(storeFile())) return null;
    const buf = readFileSync(storeFile());
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf-8');
    return JSON.parse(json) as Stored;
  } catch {
    return null;
  }
}

function write(value: Stored | null): void {
  try {
    if (value == null) {
      if (existsSync(storeFile())) rmSync(storeFile());
      return;
    }
    const dir = dirname(storeFile());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const json = JSON.stringify(value);
    const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf-8');
    writeFileSync(storeFile(), data);
  } catch {
    /* best-effort */
  }
}

/** The stored account token (or null) — used by the Mode B host daemon. */
export function getToken(): string | null {
  return read()?.token ?? null;
}

function broadcast(user: User | null): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('auth:onChange', user);
  }
}

/** fineguide fetch with the stored Bearer token; throws `Error & {status}` on !ok.
 *  A FormData body is sent as multipart (Content-Type set by fetch). */
async function api<T>(path: string, init?: RequestInit, withAuth = true): Promise<T> {
  const tok = withAuth ? getToken() : null;
  const isForm = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  const r = await fetch(`${FG_API}${path}`, {
    ...init,
    headers: {
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
    const err = new Error(body?.message ?? body?.error ?? `Request failed (${r.status})`) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return (await r.json().catch(() => ({}))) as T;
}

/** Map fineguide's /users/@me view to the renderer User. Stage 1 leaves
 *  onboardingComplete=true so the onboarding gate passes through (Stage 2 wires
 *  the real Organization.isSetupCompleted signal + the onboarding writes). */
function mapUser(v: FgUserView): User {
  const name = [v.firstName, v.lastName].filter(Boolean).join(' ').trim() || undefined;
  const org = v.ownerOrganizations?.[0];
  return {
    id: v.id,
    email: v.email,
    name,
    orgId: org?.id,
    orgName: org?.name ?? undefined,
    onboardingComplete: true,
  };
}

async function tryRefresh(stored: Stored): Promise<boolean> {
  if (!stored.refreshToken || !stored.refreshTokenId) return false;
  try {
    const res = await api<FgLoginResponse>(
      '/auth/refresh-token',
      { method: 'POST', body: JSON.stringify({ refreshToken: stored.refreshToken, refreshTokenId: stored.refreshTokenId }) },
      false,
    );
    write({
      token: res.token,
      refreshToken: res.refreshToken ?? stored.refreshToken,
      refreshTokenId: res.refreshTokenId ?? stored.refreshTokenId,
      user: stored.user,
    });
    return true;
  } catch {
    return false;
  }
}

/** Hydrate the current user from /users/@me. Offline-tolerant: only a 401/403
 *  (after a failed refresh) logs out; network/other errors keep the cached user. */
export async function authMe(): Promise<User | null> {
  const stored = read();
  if (!stored) return null;
  try {
    const v = await api<FgUserView>('/users/@me');
    const user = mapUser(v);
    write({ ...stored, user });
    return user;
  } catch (e) {
    const status = (e as Error & { status?: number }).status;
    // ONLY a 401 (fineguide's JwtGuard rejecting the token) is a real auth-expiry.
    // Try a refresh first; only if that also fails do we clear the session.
    if (status === 401) {
      if (await tryRefresh(stored)) {
        try {
          const v = await api<FgUserView>('/users/@me');
          const cur = read();
          const user = mapUser(v);
          if (cur) write({ ...cur, user });
          return user;
        } catch {
          /* fall through to logout */
        }
      }
      write(null);
      return null;
    }
    // 403 (infra/Cloudflare/policy) + network/server-down → keep the cached session
    // so the user stays signed in across restarts and transient failures.
    return stored.user;
  }
}

/** Exchange a Google auth code at fineguide → store the session → hydrate profile. */
async function completeGoogle(code: string): Promise<AuthResult> {
  const login = await api<FgLoginResponse>(
    '/auth/google',
    { method: 'POST', body: JSON.stringify({ code, redirectUri: LOOPBACK_REDIRECT }) },
    false,
  );
  // Provisional store so authMe() can use the Bearer; me() fills the full profile.
  write({
    token: login.token,
    refreshToken: login.refreshToken,
    refreshTokenId: login.refreshTokenId,
    user: { id: login.session?.id ?? '', email: login.session?.email ?? '' },
  });
  const user = await authMe();
  if (!user) { write(null); throw new Error('Sign-in succeeded but loading your profile failed.'); }
  broadcast(user);
  return { token: login.token, user };
}

// The in-flight Google sign-in (system-browser flow), so the UI can cancel it.
let pendingGoogle: { srv: Server; cancel: (e: Error) => void } | null = null;

/** Abort an in-flight Google sign-in — the user clicked Cancel, or closed/abandoned
 *  the external browser (which we can't detect ourselves). Clears the loading state. */
export function cancelGoogle(): void {
  const p = pendingGoogle;
  pendingGoogle = null;
  if (p) {
    try { p.srv.close(); } catch { /* ignore */ }
    p.cancel(new Error('Sign-in was cancelled.'));
  }
}

/** Google sign-in via the system browser (so existing Google logins + password
 *  managers are available). A fixed 127.0.0.1:8765 loopback captures the redirected
 *  code; cancellable from the UI, with a 5-minute backstop timeout. */
export function authGoogle(): Promise<AuthResult> {
  cancelGoogle(); // supersede any prior attempt
  return new Promise<AuthResult>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      if (pendingGoogle?.srv === srv) pendingGoogle = null;
      try { srv.close(); } catch { /* ignore */ }
      fn();
    };

    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', LOOPBACK_REDIRECT);
      const code = url.searchParams.get('code');
      const oauthErr = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:3rem;text-align:center">Signed in — you can close this tab and return to the app.</body>',
      );
      if (oauthErr) { finish(() => reject(new Error(`Google sign-in failed: ${oauthErr}`))); return; }
      if (!code) { finish(() => reject(new Error('Google sign-in returned no code.'))); return; }
      finish(() => { completeGoogle(code).then(resolve, (e) => { write(null); reject(e as Error); }); });
    });
    srv.on('error', (e) =>
      finish(() => reject(new Error(`Could not start the sign-in listener on 127.0.0.1:${LOOPBACK_PORT} (${(e as Error).message}).`))),
    );
    srv.listen(LOOPBACK_PORT, '127.0.0.1', () => {
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', FG_GOOGLE_CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', LOOPBACK_REDIRECT);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'openid email profile');
      authUrl.searchParams.set('prompt', 'select_account');
      void shell.openExternal(authUrl.toString());
    });
    pendingGoogle = { srv, cancel: (e) => finish(() => reject(e)) };
    setTimeout(() => finish(() => reject(new Error('Sign-in timed out.'))), 300_000);
  });
}

/** Email/password sign-in through fineguide (POST /auth/login → token + refresh).
 *  Seamless: stores the session and hydrates the profile, exactly like Google. */
export async function authLogin(email: string, password: string): Promise<AuthResult> {
  const res = await api<FgLoginResponse>(
    '/auth/login',
    { method: 'POST', body: JSON.stringify({ email, password }) },
    false,
  );
  write({
    token: res.token,
    refreshToken: res.refreshToken,
    refreshTokenId: res.refreshTokenId,
    user: { id: res.session?.id ?? '', email: res.session?.email ?? email },
  });
  const user = await authMe();
  if (!user) { write(null); throw new Error('Signed in but loading your profile failed.'); }
  broadcast(user);
  return { token: res.token, user };
}

/** Account creation through fineguide (POST /auth/register). fineguide verifies by
 *  email — it returns no session — so we surface the "confirm your email" step rather
 *  than auto-signing-in (the user signs in once they've confirmed). */
export async function authSignup(email: string, password: string, name?: string): Promise<AuthResult> {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const firstName = parts.shift();
  const lastName = parts.length ? parts.join(' ') : undefined;
  await api('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, firstName, lastName }) }, false);
  throw new Error('Account created — check your email to confirm, then sign in.');
}

export async function authLogout(): Promise<void> {
  const stored = read();
  try {
    if (stored?.refreshTokenId) {
      await api('/auth/logout-token', { method: 'POST', body: JSON.stringify({ refreshTokenId: stored.refreshTokenId }) });
    }
  } catch {
    /* best-effort */
  }
  write(null);
  broadcast(null);
}

/** Onboarding step 1 (Stage 2 will drive the org name + isSetupCompleted writes).
 *  Stage 1: persist the display name via PATCH /users/@me (JwtGuard, safe). */
export async function authUpdateProfile(payload: ProfilePayload): Promise<AuthResult> {
  const parts = (payload.name ?? '').trim().split(/\s+/);
  const firstName = parts.shift() ?? '';
  const lastName = parts.join(' ');
  await api('/users/@me', { method: 'PATCH', body: JSON.stringify({ firstName, lastName }) });
  const user = await authMe();
  broadcast(user);
  return { token: getToken() ?? '', user: user ?? { id: '', email: '' } };
}

/** Plan changes go through fineguide's Stripe-backed subscription flow (Stage 2).
 *  Not used by the desktop UI yet — the Settings plan controls are hidden until then. */
export async function authSetPlan(_payload: PlanPayload): Promise<AuthResult> {
  throw new Error('Plan changes are managed on fineguide.ai.');
}
