# Authentication

How accounts, login, and the web auth-gate work across the IDE (desktop app + self-hosted web app). For running the stack, see [DEPLOYMENT.md](DEPLOYMENT.md).

## TL;DR

- **Desktop app:** works **without login and without a backend**. Login is optional (a cloud account for future "personal space"); the local files/agent never touch `apps/server` or `apps/api`.
- **Web build:** **auth-gated by design.** The browser has no local FS/agent — it proxies everything through `apps/server`, which requires a valid token when `CCB_REQUIRE_AUTH=true`.
- **Offline-tolerant:** a saved/logged-in session is **never** dropped by a network error or a backend being down at startup. Only an explicit **401/403** logs you out.
- **Opt-in:** with `CCB_REQUIRE_AUTH` unset (the default for plain `npm run dev:web` and the desktop app), there is no gate and no token — behaviour is exactly as before auth existed.

## Two backends, one token

```
                    issues JWT (HS256, CCB_JWT_SECRET)
        ┌───────────────────────────────────────────────┐
        │                                                │
   ┌────▼─────┐   verify JWT (same secret)          ┌────┴────┐
   │ apps/api │◄───────── shared secret ───────────►│apps/srv │
   │ NestJS   │                                     │ Express │
   │ Postgres │  owns users + /auth/*               │ +ws     │ verify-only:
   │ (Prisma) │                                     │ no DB   │ gates /fs,/ws,/recents
   └──────────┘                                     └─────────┘
```

- **`apps/api`** (NestJS + Fastify + Prisma + Postgres) **issues** tokens and owns the user store. This is where account/personal-space logic lives.
- **`apps/server`** (Express + ws) **verifies** tokens with the *same* `CCB_JWT_SECRET` to gate `/fs`, `/ws`, `/recents`. It has **no database** and no `/auth` routes. It also reports `requireAuth: true|false` on `/health` so the web client knows whether to show the gate.

> The two **must** share `CCB_JWT_SECRET`. If they differ (or it's empty while gating is on), every gated request 401s.

## Endpoints (`apps/api`, mounted at `/auth`, always open)

| Method & path | Body / query | Returns |
|---|---|---|
| `POST /auth/signup` | `{ email, password, name? }` | `{ token, user }` · `400` weak/invalid · `409` exists |
| `POST /auth/login` | `{ email, password }` | `{ token, user }` · `401` bad creds |
| `POST /auth/logout` | — | `204` (stateless; client discards the token) |
| `GET  /auth/me` | `Authorization: Bearer <jwt>` | `{ user }` · `401` |
| `GET  /auth/google/start` | `?mode=web\|loopback&redirect=<loopback>` | `302` → Google |
| `GET  /auth/google/callback` | `?code&state` | `302` → SPA `/#token=…` (web) or `http://127.0.0.1:<port>/cb?token=…` (desktop loopback) |

`User` = `{ id, email, name? }` (never the password hash). Types live in `packages/shared/src/auth.ts`.

### Implementation notes
- **Passwords:** `node:crypto` `scryptSync` (`scrypt$<salt>$<hash>`), constant-time compare. No native bcrypt (keeps the Docker image toolchain-free).
- **JWT:** `@nestjs/jwt`, HS256, claims `{ sub, email, tv }`. `tv` (= `users.token_version`) is reserved for future revocation; not enforced per-request yet.
- **OAuth state:** a short-lived (10 min) **signed JWT** carrying `{ mode, redirect, nonce }` — CSRF defence + carries the loopback target statelessly.
- **Loopback safety:** `redirect` is validated to `http://127.0.0.1|localhost|[::1]` only, at both `/start` and `/callback`.
- **Schema:** Prisma `User` + `OAuthAccount` (`apps/api/prisma/schema.prisma`). Currently synced with `prisma db push` (no migration history yet — a follow-up).

## Client: one `ccb.auth` namespace, two implementations

The renderer only ever calls `window.ccb.auth.*` — identical shape in both builds (typed in `apps/desktop/src/renderer/env.d.ts`):

```ts
ccb.auth.requireAuth(): Promise<boolean>   // web: probes /health; desktop: always false
ccb.auth.me(): Promise<User | null>        // offline-tolerant (see below)
ccb.auth.login(email, password)
ccb.auth.signup(email, password, name?)
ccb.auth.loginWithGoogle()
ccb.auth.logout()
ccb.auth.onChange(cb)                       // out-of-band changes (401 bounce, OAuth, other windows)
```

- **Web** (`apps/desktop/src/renderer/lib/web-transport.ts`): token + cached user in `localStorage` (`ccb.authToken`, `ccb.authUser`). Adds `Authorization: Bearer` to `/fs`+`/recents` fetches and `?token=` to the `/ws` URL. The WS connect is **deferred** until `requireAuth` is known (a gated server rejects a tokenless socket); `reconnect()` re-dials with the token after login. Google returns to `/#token=…`, which is captured on boot and stripped via `replaceState`.
- **Desktop** (`apps/desktop/src/main/auth.ts` + preload): token + cached user persisted **encrypted** via Electron `safeStorage` in `userData/auth.bin`. Calls the remote `CCB_BACKEND_ORIGIN` (default `http://localhost:8080`). Google uses an ephemeral `127.0.0.1` HTTP server + `shell.openExternal` (the native-app loopback flow). The local agent/fs IPC is untouched and ungated.

### State & gate
- `stores/auth-store.ts` (`status: 'unknown'|'anon'|'authed'`, `user`, `requireAuth`, …). `init()` runs once: detect `requireAuth`, optimistically restore the cached user, then refresh via `me()` in the background.
- `components/AuthGate.tsx` wraps `<App/>` in `main.tsx`. Web + gated → splash, then full-screen `LoginView`, then the app. Desktop (`requireAuth=false`) → transparent pass-through (never blocks).
- `components/LoginView.tsx` — shared login/signup UI; `mode="gate"` (web full-screen) or `mode="push"` (desktop pushed view from `HomeScreen`, with back chevron). Custom controls + framer-motion throughout (no native dialogs/popups).

## Offline tolerance (the contract)

`ccb.auth.me()` in **both** transports:
- **success** → returns the `User` and refreshes the cache;
- **explicit `401`/`403`** → clears token + cached user, returns `null` (logged out);
- **network error / 5xx / offline** → returns the **cached** user (stays logged in).

So a desktop restart with no internet, or a web reload while the backend is down, keeps a logged-in user signed in; only the server actively rejecting the token signs them out.

## Configure Google OAuth

1. In Google Cloud console, create an OAuth 2.0 Client (Web application).
2. Add Authorized redirect URI: **`${CCB_PUBLIC_URL}/auth/google/callback`** (default `http://localhost:8080/auth/google/callback`).
3. Set `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (and `CCB_PUBLIC_URL` if not `:8080`) in `.env`.

Until configured, `/auth/google/start` returns `400` and the "Continue with Google" button surfaces an error — email+password is unaffected.

## Env vars

| Var | Where | Default | Purpose |
|---|---|---|---|
| `CCB_REQUIRE_AUTH` | server | `false` | Master gate switch for the web build. |
| `CCB_JWT_SECRET` | api + server | — | HS256 signing/verification secret. **Required when gating.** `openssl rand -hex 32`. Must match across both. |
| `CCB_JWT_TTL` | api | `7d` | Access-token lifetime. |
| `DATABASE_URL` | api | `postgres://ccb:ccb@db:5432/ccb` | Postgres connection. |
| `CCB_PUBLIC_URL` | api | `http://localhost:8080` | Public origin; builds the Google `redirect_uri`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | api | — | Google OAuth client. Blank → Google disabled. |
| `CCB_BACKEND_ORIGIN` | desktop (main) | `http://localhost:8080` | Remote backend the desktop app logs into. |

## Not done yet (deliberate)

- Per-user data isolation / "personal space" — today auth is a **login wall over the single shared `CCB_ROOT`**; all authed users see the same workspace.
- Prisma migrations (uses `db push`), email verification, password reset, refresh-token rotation / hard revocation.
