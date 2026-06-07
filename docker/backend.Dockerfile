# syntax=docker/dockerfile:1.7
#
# Backend image — the Node API (apps/server: Express + ws).
# Pure-API by construction: it never receives apps/desktop/dist-web, so the
# server's static-dir probe (existsSync(dist-web/index.html)) is false and no
# SPA fallback route is registered → /fs, /recents, /health stay unshadowed.
#
# Base = node:22-bookworm-slim (glibc), NOT alpine: @anthropic-ai/claude-agent-sdk
# ships a glibc-linked vendored ripgrep; on musl it fails to exec and silently
# breaks the agent's Grep tool.

###############################################################################
# Stage 1 — deps: install the whole workspace from the root lockfile.
# Copy ONLY manifests first so this layer is cached unless a package.json or the
# lockfile changes (not on every source edit). npm ci validates the lockfile
# against the full workspace set, so all six manifests must be present.
###############################################################################
FROM node:22-bookworm-slim AS deps
WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/shared/package.json      packages/shared/package.json
COPY packages/agent-core/package.json  packages/agent-core/package.json
COPY apps/server/package.json          apps/server/package.json
COPY apps/desktop/package.json         apps/desktop/package.json
COPY apps/extension/package.json       apps/extension/package.json
COPY apps/host/package.json            apps/host/package.json

RUN --mount=type=cache,target=/root/.npm npm ci

###############################################################################
# Stage 2 — build: compile in dependency order (turbo bypassed for
# deterministic, cache-friendly layers): shared → agent-core → server.
###############################################################################
FROM deps AS build
WORKDIR /repo

COPY tsconfig.base.json ./
COPY packages/shared      packages/shared
COPY packages/agent-core  packages/agent-core
COPY apps/server          apps/server

RUN npm run build -w packages/shared \
 && npm run build -w packages/agent-core \
 && npm run build -w apps/server

###############################################################################
# Stage 3 — runtime: lean glibc image, pure API.
# The relative layout (/app/node_modules + /app/packages/* + /app/apps/server)
# is preserved so the @claude-code-browser/* workspace symlinks resolve, and the
# SDK's cli.js (resolved at runtime via createRequire) stays reachable.
###############################################################################
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    CCB_PORT=9315 \
    CCB_ROOT=/workspace \
    HOME=/home/ccb
WORKDIR /app

# Non-root user with a writable HOME (~/.ccb/recents.json) and workspace.
RUN useradd --create-home --home-dir /home/ccb --shell /usr/sbin/nologin ccb \
 && mkdir -p /home/ccb/.ccb /workspace \
 && chown -R ccb:ccb /home/ccb /workspace /app

COPY --from=build --chown=ccb:ccb /repo/node_modules        ./node_modules
COPY --from=build --chown=ccb:ccb /repo/package.json        ./package.json
COPY --from=build --chown=ccb:ccb /repo/packages/shared     ./packages/shared
COPY --from=build --chown=ccb:ccb /repo/packages/agent-core ./packages/agent-core
COPY --from=build --chown=ccb:ccb /repo/apps/server         ./apps/server

USER ccb
EXPOSE 9315
# CCB_STATIC_DIR intentionally unset → default resolves to a non-existent
# dist-web → pure API.
CMD ["node", "apps/server/dist/index.js"]
