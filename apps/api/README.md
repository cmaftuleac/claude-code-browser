# @claude-code-browser/api

The **cloud backend** for the IDE — NestJS (Fastify adapter) + Prisma + Postgres. Owns user accounts and `/auth/*`; it's where "personal space" and other SaaS features will live. It *issues* JWTs that `apps/server` *verifies* (shared `CCB_JWT_SECRET`) to gate the web build.

Full reference: [`docs/AUTH.md`](../../docs/AUTH.md) · running it: [`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md).

## Layout

```
src/
  main.ts                 Fastify bootstrap (CORS, port CCB_API_PORT=9320)
  app.module.ts           ConfigModule + PrismaModule + AuthModule + HealthController
  health.controller.ts    GET /health
  prisma/                 PrismaService + global PrismaModule
  auth/
    auth.controller.ts    /auth/signup,login,logout,me,google/start,google/callback
    auth.service.ts       signup/login/me + Google upsert (Prisma)
    google.service.ts     OAuth URL build + code exchange + loopback validation
    jwt-auth.guard.ts      Bearer JWT guard (req.user)
    passwords.ts          scrypt hash/verify (node:crypto)
prisma/schema.prisma      User, OAuthAccount
```

## Scripts

| Command | Does |
|---|---|
| `npm run build -w apps/api` | `prisma generate && nest build` |
| `npm run dev -w apps/api` | `prisma generate && nest start --watch` |
| `npm run prisma:push -w apps/api` | `prisma db push --skip-generate` (sync schema → DB) |
| `npm run start -w apps/api` | `node dist/main.js` |

## Notes

- **CommonJS workspace** (its own `tsconfig.json`, decorators on) — distinct from the ESM/bundler root. Shared types are imported with `import type` only, so there's no ESM/CJS runtime interop.
- Needs a reachable `DATABASE_URL` (Postgres) to run; `prisma db push` creates the tables (no migration history yet).
- Email+password via `node:crypto` scrypt (no native bcrypt); JWT via `@nestjs/jwt` (HS256). Google OAuth via plain `fetch` (no passport).
- Env: `CCB_API_PORT`, `DATABASE_URL`, `CCB_JWT_SECRET`, `CCB_JWT_TTL`, `CCB_PUBLIC_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
