# Deployment — self-hosted web app (Docker)

Runs the IDE's **web build** as a full stack behind an nginx gateway. For the auth model, see [AUTH.md](AUTH.md). (The Electron desktop app is separate and needs none of this — it runs fully locally.)

## Services

| Service | Image / build | Role | Internal port |
|---|---|---|---|
| `gateway` | `docker/gateway.Dockerfile` (nginx) | **Only public port.** Reverse-proxies everything. | `8080` (published) |
| `frontend` | `docker/frontend.Dockerfile` (`nginx:alpine`) | Serves the built SPA (`dist-web`). | `80` |
| `backend` | `docker/backend.Dockerfile` (`node:22-bookworm-slim`) | `apps/server` — agent/file gateway + verify-only auth. | `9315` |
| `api` | `docker/api.Dockerfile` (`node:22-bookworm-slim`) | `apps/api` — NestJS cloud backend (auth). | `9320` |
| `db` | `postgres:16-alpine` | User store. | `5432` |

Only the **gateway** publishes a host port; the rest are reachable solely on the internal `ccb` network by service name.

### Gateway routing (`docker/nginx/gateway.conf`)

| Path | → upstream |
|---|---|
| `/auth/*` | `api:9320` |
| `/ws`, `/fs/*`, `/recents`, `/health` | `backend:9315` |
| `/` (SPA + assets) | `frontend:80` |

`/ws` carries the WebSocket `Upgrade` headers; `/fs/` disables proxy buffering (HTTP Range media). The dev variant (`gateway.dev.conf`) points `/` at the Vite dev server (`:5173`) and adds Upgrade headers to `/` for HMR.

## Data — directory bind mounts under `./data/`

**No named volumes** — every persistent store is a host directory bind mount, so data is trivial to copy/back up/move:

| Host path | Container | Contents |
|---|---|---|
| `./data/postgres` | `db:/var/lib/postgresql/data` | Postgres cluster (users, oauth accounts). |
| `./data/ccb_home` | `backend:/home/ccb` | `~/.ccb/recents.json`. |
| `./workspace` | `backend:/workspace` | The agent's `CCB_ROOT` sandbox (the dir it reads/edits). |

Back up the stack by stopping it and copying `./data` (+ `./workspace`). Future stores follow the same convention (`./data/redis`, `./data/elasticsearch`, …).

## Quick start (production)

```bash
mkdir -p data/postgres data/ccb_home workspace
cp .env.example .env
# Edit .env: set CCB_JWT_SECRET (openssl rand -hex 32). GOOGLE_* and ANTHROPIC_API_KEY optional.
docker compose up -d --build
docker compose ps                      # db/api/backend/frontend/gateway → healthy
open http://localhost:8080             # login gate (CCB_REQUIRE_AUTH=true), then the IDE
```

## Hot-reload development

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

Same topology, but `api`/`backend`/`frontend` run watchers (`nest start --watch`, `tsx watch`, `vite`) over bind-mounted source (the `deps` build stage + anonymous `node_modules` volumes). Editing `apps/*` is live; editing `packages/shared` or `packages/agent-core` needs a container restart.

> Prefer **no Docker** for day-to-day web dev: `npm run dev:web` (server `:9315` + Vite `:5173`, auth off). Use the Docker dev override when you specifically need the gated, gateway-fronted topology or Postgres.

## Environment variables

Defined in `.env` (compose reads it automatically; `.env.example` is the template).

| Var | Default | Notes |
|---|---|---|
| `GATEWAY_PORT` | `8080` | Host port. Use `80:8080` mapping for privileged. |
| `CCB_ROOT` | `/workspace` | Agent root inside the backend (bind-mounted from `./workspace`). |
| `ANTHROPIC_API_KEY` | — | Optional; only live Claude conversations need it. |
| `CCB_REQUIRE_AUTH` | `true` (in `.env.example`) | Gate the web build. `false` → open. |
| `CCB_JWT_SECRET` | — | **Required when gating.** Shared by `api` (sign) + `backend` (verify). |
| `CCB_JWT_TTL` | `7d` | Token lifetime. |
| `DATABASE_URL` | `postgres://ccb:ccb@db:5432/ccb` | Used by `api`. |
| `CCB_PUBLIC_URL` | `http://localhost:8080` | Public origin; Google `redirect_uri` base. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth; blank disables it. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `ccb` / `ccb` / `ccb` | `db` credentials (keep consistent with `DATABASE_URL`). |
| `CCB_API_PORT` | `9320` | `api` listen port. |

## Image notes / gotchas

- **Backend must be glibc** (`node:22-bookworm-slim`, not alpine): the Claude agent SDK ships a glibc-linked vendored `ripgrep` that won't exec on musl. Frontend is `nginx:alpine` (static only) — fine.
- **Prisma on bookworm-slim** needs `openssl` (installed in `docker/api.Dockerfile`). The api image runs `prisma generate` at build and `prisma db push` at container start to sync the schema (no migration history yet).
- **`node_modules`/`dist` are excluded** via `.dockerignore` — images build their own from the lockfile + source; the host's macOS/arm64 `node_modules` must not leak in.
- **First-run ordering:** `gateway` waits for `backend`/`frontend`/`api` to be healthy (`depends_on: service_healthy`); `api` waits for `db`. Healthchecks use `/health` (node `fetch`) and `pg_isready`.

## Verify

```bash
B=http://localhost:8080
curl -s $B/health                                            # {"status":"ok","requireAuth":true}
curl -s -o /dev/null -w '%{http_code}\n' $B/fs/root          # 401 (gated, no token)
TOKEN=$(curl -s -XPOST $B/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com","password":"password123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s $B/fs/root -H "Authorization: Bearer $TOKEN"         # {"root":"/workspace",...}
# DevTools → Network → WS: /ws?token=… → 101; without a token → 401.
```

## Teardown

```bash
docker compose down            # stop + remove containers (data in ./data is kept)
# data lives in ./data — delete those dirs to wipe Postgres/recents.
```
