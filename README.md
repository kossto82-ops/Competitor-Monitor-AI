# Competitor Monitor AI

CMA continuously builds a verified, customer-specific memory of competitor behavior and turns
that accumulated history into explainable competitive intelligence: deterministic change
detection first, historical pattern analysis second, AI interpretation only on top of both -
never a guess standing in for evidence.

**Status:** Phase 10 complete - deterministic monitoring, historical intelligence, and a
per-organization Digest are implemented and validated end-to-end against real Postgres/Redis and
a real browser (Playwright). See [docs/phases/](docs/phases/) for the full history of what was
built, tested, and deliberately deferred at each phase, and [DevRunbook.md](DevRunbook.md) for
day-to-day dev setup (build/run/test commands, ports, environment variables).

## What it does today

- **Monitors competitor pages** on a schedule, extracts structured data (price, product,
  availability) via JSON-LD/HTML parsing, and detects meaningful changes deterministically -
  every `ChangeEvent` carries its own before/after evidence, never an inference.
- **Guards against SSRF** on every fetch (allowlist + DNS-rebinding-resistant resolution), with an
  explicit, double-gated, non-production-only override for testing against local fixtures.
- **Optional AI interpretation** of a single detected change, using a customer's own AI provider
  connection (bring-your-own-key, encrypted at rest) - never required, never a substitute for the
  underlying deterministic evidence.
- **Daily competitive intelligence report**, generated per organization and delivered by email.
- **Historical intelligence**: per-competitor activity metrics, price history, product lifecycle
  (added/removed), and two deterministic patterns - activity vs. a competitor's own historical
  baseline, and repeated price-change detection per product/plan - both gated by a documented
  minimum-sample-size rule so a freshly-tracked competitor is honestly labeled "not enough history
  yet," never given a fabricated trend.
- **Cross-competitor comparison** (`/compare`): the same patterns shown side by side for a
  customer-selected set of competitors - still no ranking, no score, no "winner."
- **Digest** (`/digest`): one per-organization, evidence-linked feed composing all of the above -
  recent verified changes, qualifying patterns, and a purely descriptive "N of M competitors above
  their own baseline" count - ordered by recency only, never by a hidden importance score.

## Stack

Node.js + TypeScript monorepo (npm workspaces) - Next.js (App Router, Server Components + API
routes) - BullMQ/Redis for the monitoring queue - PostgreSQL + Prisma - Cheerio for HTML
extraction - pluggable AI provider abstraction (OpenAI-compatible today, a deterministic fake
provider for tests/local dev).

## Project layout

```
apps/
  web/            Next.js app - dashboard, competitors, changes, compare, digest, reports,
                  settings UI, plus the REST API routes behind them
  worker/         BullMQ worker (monitoring jobs, AI analysis jobs, daily report generation) +
                  manual enqueue CLIs
packages/
  core/           Shared TypeScript types, enums, Zod schemas, deterministic period/window math -
                  no runtime dependency on the others
  security/       SSRF protection (IP allowlist, DNS-rebinding-resistant safe fetch)
  extraction/     Extractor interface + HttpExtractor + CheerioExtractor
  detection/      Deterministic snapshot comparison -> verification state + change events
  db/             Prisma schema, generated client, tenant-scoped repository functions (activity
                  metrics, patterns, competitive context, digest composition)
  queue/          BullMQ queue/worker wiring and job payload types
  ai/             Provider-neutral AI analysis: prompt building, response parsing/validation,
                  retry, pricing, connection testing - no provider-specific code outside this
                  package's registry
  notifications/  Daily report email rendering + provider-neutral sending
docs/
  phases/         One report per delivery phase - design/validation history, see docs/phases/README.md
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
# generate real secrets instead of the placeholders:
#   openssl rand -hex 32
```

Fill in `AUTH_SECRET` and `CMA_AI_ENCRYPTION_KEY`. `.env` is read by `packages/db` (Prisma CLI) and
by `apps/web`/`apps/worker` at runtime. Next.js and the worker's `tsx`-based scripts load `.env`
automatically; if you run compiled `dist/` output directly, export the variables into the shell
first. See `.env.example` for what each variable is for, including the AI provider setup and the
dev-only SSRF override used for testing against a local fixture page.

### 3. Create the database schema

```bash
npm run db:migrate
```

This runs `prisma migrate dev` against `DATABASE_URL` and generates the Prisma client. Re-run
`npm run db:generate` any time you only need to regenerate the client (e.g. after pulling schema
changes without a new migration).

### 4. Run the app

Three processes, each in its own terminal:

```bash
npm run --workspace apps/web dev      # Next.js app + API, http://localhost:3000
npm run --workspace apps/worker dev   # BullMQ worker (monitoring, AI analysis, daily reports)
```

There is no scheduler yet for monitoring jobs - they only run when enqueued:

```bash
npm run worker:enqueue                # enqueue every active MonitoredUrl
npm run worker:enqueue-reports        # enqueue daily report generation for eligible organizations
```

Sign up at `http://localhost:3000/signup`, add a competitor and one of its pages, then trigger a
scan from the competitor's detail page (or `POST /api/monitored-urls/{urlId}/scan`).

## Tests

```bash
npm test          # every workspace
npm run typecheck # every workspace
```

Most of the safety-critical logic (SSRF protection, extraction parsing, deterministic change
detection, AI prompt/response validation, pipeline orchestration) is unit tested with no external
dependencies and runs anywhere.

`packages/db`'s repository test suites (tenant isolation, activity metrics, patterns, competitive
context, digest composition, etc.) require a real, reachable Postgres - they **skip themselves**
(report "skipped", not "passed") when `DATABASE_URL` doesn't resolve. Set up Postgres (Section 1
above) and run `npm run db:migrate` first if you want them to actually execute.

End-to-end coverage (`apps/web/e2e/`, Playwright) exercises the real UI against a real Postgres,
Redis, worker, and a local fixture "competitor site" server (`scripts/validation/fixtureServer.mjs`)
- see [DevRunbook.md](DevRunbook.md) for how to bring up the full stack and run it.

## What's deliberately not built (by design, not oversight)

No ranking/score/"winner" between competitors, no cross-competitor product/plan identity matching,
no importance-weighted digest ordering, no forecasting, no billing/team-permissions, no promotion
extraction (no extractor currently emits promotion data). Each of these is a documented, explicit
non-goal in the relevant phase report under [docs/phases/](docs/phases/) - not a gap that was
missed.
