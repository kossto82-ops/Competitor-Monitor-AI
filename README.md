# Competitor Monitor AI

Automated competitor monitoring: deterministic change detection first, AI interpretation second.
See [PHASE0-ANALYSIS.md](PHASE0-ANALYSIS.md) for the architecture rationale.

**Status:** Phase 1 (foundation), validated against real Postgres/Redis/BullMQ - see
[PHASE1-REPORT.md](PHASE1-REPORT.md) and [PHASE1-VALIDATION.md](PHASE1-VALIDATION.md) for what's
implemented, what's tested, and what's deliberately deferred. See [DevRunbook.md](DevRunbook.md)
for the day-to-day dev setup (build/run/test commands, ports, environment variables).

## Stack

Node.js + TypeScript monorepo (npm workspaces) - Next.js (API routes only so far) - BullMQ/Redis -
PostgreSQL + Prisma - Cheerio for HTML extraction.

## Project layout

```
apps/
  web/       Next.js - API routes for auth, competitors, monitored URLs, scans, change events
  worker/    BullMQ worker + manual "enqueue all active URLs" CLI
packages/
  core/         Shared TypeScript types, enums, Zod schemas - no runtime dependency on the others
  security/     SSRF protection (IP allowlist, DNS-rebinding-resistant safe fetch)
  extraction/   Extractor interface + HttpExtractor + CheerioExtractor
  detection/    Deterministic snapshot comparison -> verification state + change events
  db/           Prisma schema, generated client, tenant-scoped repository functions
  queue/        BullMQ queue/worker wiring and job payload types
```

## Local development setup

### 1. Prerequisites

- Node.js 20+ (developed against Node 26)
- A PostgreSQL instance reachable via `DATABASE_URL`
- A Redis instance reachable via `REDIS_URL`

If you have Docker available:

```bash
docker compose up -d
```

This starts Postgres on `5432` and Redis on `6379` matching `.env.example`.

If Docker isn't available on your machine, install PostgreSQL and Redis natively instead (both run
fine as plain user processes, no admin rights or service registration required) - see
[DevRunbook.md](DevRunbook.md) for the exact steps used to set this project up without Docker.

Either way, point `DATABASE_URL`/`REDIS_URL` in `.env` at wherever they end up listening.

### 2. Install and configure

```bash
npm install
cp .env.example .env
# generate a real secret instead of the placeholder:
#   openssl rand -hex 32
```

`.env` is read by `packages/db` (Prisma CLI) and by `apps/web`/`apps/worker` at runtime. Next.js
and the worker's `tsx`-based scripts load `.env` automatically; if you run compiled `dist/` output
directly, export the variables into the shell first.

### 3. Create the database schema

```bash
npm run db:migrate
```

This runs `prisma migrate dev` against `DATABASE_URL` and generates the Prisma client. Re-run
`npm run db:generate` any time you only need to regenerate the client (e.g. after pulling schema
changes without a new migration).

### 4. Run the web app and worker

```bash
npm run --workspace apps/web dev      # http://localhost:3000
npm run --workspace apps/worker dev   # starts the BullMQ worker
```

### 5. Trigger a scan manually (Phase 1 has no cron yet)

```bash
npm run worker:enqueue
```

Enqueues one job per active `MonitoredUrl` across all organizations. Or trigger a single URL via
the API: `POST /api/monitored-urls/{urlId}/scan` (requires an authenticated session cookie).

### 6. Try the API end-to-end

```bash
curl -c cookies.txt -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"organizationName":"Acme","email":"you@example.com","password":"a-long-enough-password"}'

curl -b cookies.txt -X POST http://localhost:3000/api/competitors \
  -H "Content-Type: application/json" \
  -d '{"name":"Competitor A"}'

# use the returned competitor.id below
curl -b cookies.txt -X POST http://localhost:3000/api/competitors/<competitorId>/urls \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/","category":"PRICING_PAGE"}'
# Testing against your OWN local page instead of a real site? The SSRF guard
# blocks localhost/private addresses by design - see CMA_ALLOW_PRIVATE_TARGETS
# in .env.example for the double-gated (non-production only) dev override.

# use the returned monitoredUrl.id below
curl -b cookies.txt -X POST http://localhost:3000/api/monitored-urls/<urlId>/scan

curl -b cookies.txt http://localhost:3000/api/change-events
```

## Tests

```bash
npm test          # every workspace
npm run typecheck # every workspace
```

Most of the safety-critical logic (SSRF protection, extraction parsing, deterministic change
detection, pipeline orchestration) is unit tested with no external dependencies and runs anywhere.

The tenant-isolation suite (`packages/db/src/tenantIsolation.test.ts`) requires a real, reachable
Postgres - it **skips itself** (reports "skipped", not "passed") when `DATABASE_URL` doesn't
resolve. Set up Postgres (Section 1 above) and run `npm run db:migrate` first if you want this
suite to actually execute rather than just exist.

## What Phase 1 does not include yet

Dashboard UI, AI analysis, daily report generation, email sending, billing, team permissions,
external notification channels, a real cron scheduler, headless-browser extraction tiers. See
[PHASE1-REPORT.md](PHASE1-REPORT.md) for the full list and rationale.
