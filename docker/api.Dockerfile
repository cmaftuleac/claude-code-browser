# syntax=docker/dockerfile:1.7
#
# Cloud API image — apps/api (NestJS + Prisma, Postgres-backed auth).
# node:22-bookworm-slim (glibc) + openssl: Prisma's query engine is glibc/openssl-linked.

###############################################################################
# Stage 1 — deps: install the whole workspace from the root lockfile (cached
# unless a manifest changes). openssl is installed here so the `deps` stage is
# also usable as the dev-override base (it runs prisma generate at dev runtime).
###############################################################################
FROM node:22-bookworm-slim AS deps
WORKDIR /repo
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/shared/package.json      packages/shared/package.json
COPY packages/agent-core/package.json  packages/agent-core/package.json
COPY apps/server/package.json          apps/server/package.json
COPY apps/desktop/package.json         apps/desktop/package.json
COPY apps/extension/package.json       apps/extension/package.json
COPY apps/host/package.json            apps/host/package.json
COPY apps/api/package.json             apps/api/package.json
RUN --mount=type=cache,target=/root/.npm npm ci

###############################################################################
# Stage 2 — build: shared (for `import type`) → prisma generate + nest build.
###############################################################################
FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api        apps/api
RUN npm run build -w packages/shared \
 && npm run build -w apps/api   # = prisma generate && nest build

###############################################################################
# Stage 3 — runtime.
###############################################################################
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production CCB_API_PORT=9320 HOME=/home/ccb
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --home-dir /home/ccb --shell /usr/sbin/nologin ccb \
 && chown -R ccb:ccb /app

COPY --from=build --chown=ccb:ccb /repo/node_modules    ./node_modules
COPY --from=build --chown=ccb:ccb /repo/package.json    ./package.json
COPY --from=build --chown=ccb:ccb /repo/packages/shared ./packages/shared
COPY --from=build --chown=ccb:ccb /repo/apps/api        ./apps/api

USER ccb
EXPOSE 9320
WORKDIR /app/apps/api
# Sync schema to the DB (basics: db push, no migration history yet) then start.
CMD ["sh", "-c", "node /app/node_modules/prisma/build/index.js db push --skip-generate && node dist/main.js"]
