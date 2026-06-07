# syntax=docker/dockerfile:1.7
#
# Frontend image — builds the web SPA (apps/desktop, web build) and serves the
# static dist-web with nginx. The renderer talks to the backend over relative
# URLs only, so it is zero-config behind the gateway. alpine is fine here: nginx
# serves static files, no native binaries involved.

###############################################################################
# Stage 1 — deps (same caching strategy as the backend; npm ci needs all
# workspace manifests present).
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
# Stage 2 — build the SPA. The renderer imports @claude-code-browser/shared only
# as `import type` (stripped by Vite) and never imports agent-core, so building
# shared (for type resolution, mirroring `build:web`) is sufficient.
###############################################################################
FROM deps AS build
WORKDIR /repo

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/desktop    apps/desktop

RUN npm run build -w packages/shared \
 && npm run build:web -w apps/desktop
# → /repo/apps/desktop/dist-web (base "/", relative assets, single index.html)

###############################################################################
# Stage 3 — serve the static SPA via nginx.
###############################################################################
FROM nginx:alpine AS runtime
COPY docker/nginx/frontend.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/desktop/dist-web /usr/share/nginx/html
EXPOSE 80
# nginx:alpine's default CMD runs nginx in the foreground.
