# Fineguide Tesseract — project notes for Claude

## Published identifiers

These are stable, canonical values. Do not invent or guess these — always use the values below.

| Thing | Value |
|---|---|
| Chrome Web Store extension ID | `mnibceaaapcppokpnnljohdlmojjgbkf` |
| Chrome Web Store listing URL | https://chromewebstore.google.com/detail/claude-code-browser/mnibceaaapcppokpnnljohdlmojjgbkf |
| Chrome Web Store reviews URL | https://chromewebstore.google.com/detail/claude-code-browser/mnibceaaapcppokpnnljohdlmojjgbkf/reviews |
| Native messaging host name | `com.claude_code_browser` |
| npm package | `claude-code-browser` ([npmjs.com](https://www.npmjs.com/package/claude-code-browser)) |
| GitHub repo | https://github.com/cmaftuleac/claude-code-browser |
| Desktop auto-update repo | `opentech-dev/tesseract-release` — **PUBLIC, releases only** (signed binaries + `latest*.yml`). The code repo stays private; this is the electron-updater feed. |
| Publisher / copyright | Fineguide.AI (Corneliu Maftuleac) |

When loaded as an unpacked extension for development, `chrome.runtime.id` is a generated value (NOT the store ID). For anything that needs to point to the live listing (review URLs, install instructions, etc.), use the hardcoded store ID above — not `chrome.runtime.id` — so it works in both dev and production.

## Repository layout

This is an npm workspace monorepo (npm workspaces + Turborepo):

- `apps/extension` — the Chrome extension (React + Vite, MV3, side panel UI). Private, not published to npm.
- `apps/host` — the Node.js native messaging host. **Published to npm as `claude-code-browser`**. Bridges the Chrome extension to the user's local Claude Code CLI.
- `apps/desktop` — the Electron desktop app (the "Photoshop for HTML" IDE) **and** the browser/web build. One React renderer, two transports: the Electron `preload` (`window.ccb`, `isElectron:true`) and a web polyfill (`lib/web-transport.ts`, `isElectron:false`) that talks to `apps/server`. Private.
- `apps/server` — the **agent/file gateway** for the web build: Express + `ws`, bridges the browser to the local Claude CLI (via `agent-core`) and the filesystem. Auth here is **verify-only** (no DB). Private.
- `apps/api` — the **cloud backend**: NestJS (Fastify adapter) + Prisma + Postgres. Owns accounts/auth (`/auth/*`) and future "personal space". Private.
- `packages/agent-core` — Claude Agent SDK orchestration shared by `apps/server` and `apps/desktop` (also re-implemented in `apps/host` — published-npm constraint; edit both). Private.
- `packages/shared` — shared TypeScript types (`ws-protocol`, `auth`). Private.

Two products live here: (1) the **Chrome extension + npm `claude-code-browser`** package, and (2) the standalone **IDE** — `apps/desktop` shipped as the Electron app and as a **self-hostable web app** (`apps/server` + `apps/api` behind an nginx gateway, see Docker below). The npm package is *not* a standalone Claude Code — it requires the user's Claude Code CLI installed and authenticated; the installer auto-installs it if missing.

**Desktop vs web — the load-bearing distinction:** the **desktop app is fully local and backend-optional** (Electron IPC + `agent-core` in the main process; it never needs `apps/server`/`apps/api`, works offline, login is optional). The **web build is the opposite by design** — it has no local FS/agent, proxies everything through `apps/server`, and is **auth-gated**. Talking to Claude needs internet either way (it reaches Anthropic), but local browse/edit on desktop is fully offline.

## Common operations

- Build extension: `npm run build -w apps/extension`
- Build host: `npm run build -w apps/host`
- Build everything: `npm run build` (turbo)
- Reload extension in Chrome: `chrome://extensions` → ↻ on the Fineguide Tesseract tile
- Open side panel for inspection: right-click *inside* the side panel → Inspect (NOT the page console — `chrome.storage` is undefined there)

IDE (apps/desktop + backends):
- Desktop app (Electron, local): `npm run dev -w apps/desktop` (unset `ELECTRON_RUN_AS_NODE` first or it crashes).
- Web app, no Docker (server :9315 + Vite :5173): `npm run dev:web` from the repo root.
- Full stack in Docker (prod): `cp .env.example .env` → set `CCB_JWT_SECRET` → `docker compose up -d --build` → open `http://localhost:8080`.
- Full stack hot-reload: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up`.
- Cloud API: `npm run build -w apps/api` (= `prisma generate && nest build`); `npm run prisma:push -w apps/api` to sync the schema.
- Typecheck the renderer + main/preload: `npm run typecheck -w apps/desktop`.

## Backend architecture & auth

Two backends, kept **separate on purpose** (full reference: [docs/AUTH.md](docs/AUTH.md)):

- **`apps/api` (NestJS + Prisma + Postgres)** — the cloud backend. *Issues* HS256 JWTs, owns the `users`/`oauth_accounts` tables and `/auth/*`. New SaaS features ("personal space", teams, billing) go **here**, not in `apps/server`.
- **`apps/server` (Express + ws)** — thin agent/file gateway. No DB, no `/auth`. It only *verifies* JWTs (shared `CCB_JWT_SECRET`) to gate `/fs` + `/ws` + `/recents` when `CCB_REQUIRE_AUTH=true`, and advertises `requireAuth` on `/health`.

Sign-in: **email+password** (`node:crypto` scrypt, no native bcrypt) **and Google OAuth** (web redirect + desktop system-browser loopback). Client uses one uniform `window.ccb.auth` namespace (web-transport for browser, preload→main for desktop). **Web is gated; desktop is optional** — desktop persists the token via Electron `safeStorage`, targets `CCB_BACKEND_ORIGIN` (default `http://localhost:8080`), and is **offline-tolerant: only an explicit 401/403 logs you out — never a network error.** Auth is opt-in: with `CCB_REQUIRE_AUTH` unset, `npm run dev:web` and the desktop app behave exactly as before (no gate).

## Docker stack (self-hosted web app)

Four services behind an nginx gateway (full reference: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)). Files: `docker-compose.yml` (prod), `docker-compose.dev.yml` (hot-reload override), `docker/*.Dockerfile`, `docker/nginx/*.conf`, `.env.example`.

- Gateway is the **only published port** (`:8080`). It routes `/auth/*` → `api`, `/ws` `/fs` `/recents` `/health` → `server`, `/` → `frontend`.
- **All persistent data is directory bind-mounted under `./data/<service>`** (`./data/postgres`, `./data/ccb_home`) — **no named volumes** — so data is trivial to copy/back up. `./workspace` is the agent's `CCB_ROOT` sandbox.
- Backend image is `node:22-bookworm-slim` (glibc — the agent SDK's vendored ripgrep is glibc-linked, so **not** alpine). The api image adds `openssl` for Prisma's engine. Frontend is `nginx:alpine` serving the built SPA.
- Run: `mkdir -p data/postgres data/ccb_home workspace && cp .env.example .env` (set `CCB_JWT_SECRET`), then `docker compose up -d --build`.

## Releases

- npm publishes are manual: `npm publish -w apps/host --access public` after bumping `apps/host/package.json:version`. The package is public and immutable per published version — bump and re-publish, never try to re-use a version number.
- Chrome Web Store uploads are done through the developer dashboard at https://chrome.google.com/webstore/devconsole — paste new ZIP, update store listing, submit for review.
- After every release, tag in git: `git tag v<version> && git push origin v<version>`.

### Desktop app (Electron) — auto-update

The desktop app silently auto-updates via `electron-updater` against the **public** `opentech-dev/tesseract-release` repo (the code repo stays private). Flow: bump `apps/desktop/package.json:version` → `git tag v<version> && git push origin v<version>` → the `release-desktop.yml` workflow builds on macOS + Windows runners, **code-signs + notarizes** (Apple) / signs (Windows), and publishes binaries + `latest*.yml` to the releases repo. Running apps check on launch (30s) + every 3h, download in the background, and apply on next quit (a subtle "Update ready · Relaunch" pill lets users apply immediately).

- **Signing is mandatory** — macOS auto-update is impossible for an unsigned app (Squirrel verifies the signature). Hardened runtime + `build/entitlements.mac.plist` (allow-jit, disable-library-validation for vendored ripgrep) + notarization are configured in `electron-builder.yml`.
- The `release-desktop.yml` workflow needs these repo secrets: `APPLE_CSC_LINK`/`APPLE_CSC_KEY_PASSWORD`, `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`, `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`, and `RELEASES_REPO_TOKEN` (fine-grained PAT, `Contents:write` on the **releases repo only** — the default `GITHUB_TOKEN` can't write to a different repo).
- The mac `zip` target is **required** alongside `dmg` (Squirrel.Mac can't apply a dmg). Don't remove it.
- The first hop **to** `0.2.0` is manual (older builds have no updater); everything after is seamless.

## UI rules (apps/desktop, and any future user-facing surface)

**Animations are mandatory.** Every show/hide, mount/unmount, open/close, surface switch, panel collapse/expand, list add/remove — must be **properly animated**, never snap. This is part of the "industrial-grade, modern, sleek" quality bar for the product.

- Use **framer-motion** (`AnimatePresence` for mount/unmount; `motion.*` for transitions; `layout` for layout shifts). CSS-only transitions are fine for hover/focus but cannot handle React unmount gracefully.
- Sensible defaults: 140–220ms `cubic-bezier(0.4, 0, 0.2, 1)`; opacity + small scale/translate combo on entrance; never zero-duration.
- Apply to: task list items, surface (ModePills) switching, collapsible cards (tool/thinking), Composer command dropdown, StateRail sections, code-surface tab swaps, Browser inspector mount, toasts, modals.

## Things that have bitten this project before

- **Pasting npm tokens into chat.** Treat any token shared in a transcript as compromised; rotate immediately at https://www.npmjs.com/settings/~/tokens.
- **Hardcoded paths.** Avoid them — use relative or runtime-resolved paths. The extension and host both run on multiple platforms (macOS, Linux, Windows).
- **Service worker vs page console confusion.** `chrome.storage`, `chrome.tabs`, etc. are only available in extension contexts. The regular page console (F12 on a normal tab) cannot access them.
- **JWT secret must match.** `apps/api` signs and `apps/server` verifies with the **same** `CCB_JWT_SECRET`. If they differ (or it's empty while `CCB_REQUIRE_AUTH=true`), every gated request 401s and you can't log in.
- **Never gate `/auth` or `/health`.** Gating those makes login impossible and fails the compose healthcheck → the whole stack won't come up. The gateway must also route `/auth/` → `api` (it's easy to forget — `/auth` would otherwise hit the SPA and 404).
- **Don't log the user out on network errors.** `ccb.auth.me()` (both transports) clears the session only on an explicit 401/403; any network/5xx error returns the cached user. Preserve this when touching auth.
- **alpine breaks two things.** The backend's bundled ripgrep needs glibc (use `bookworm-slim`, not alpine). Prisma on `bookworm-slim` needs `openssl` installed in the image.
- **Web Google OAuth returns the token via URL `#fragment`**, not a query param (kept out of server logs); the web transport strips it with `history.replaceState`. Desktop uses a `127.0.0.1` loopback capture (validated loopback-only).
