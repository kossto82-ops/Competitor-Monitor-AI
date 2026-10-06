# DevRunbook

Practical day-to-day reference for building, running, and testing Competitor Monitor AI on any
machine. Written for this project specifically — if something below stops matching reality, fix
this file in the same commit that caused the drift.

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 20+ (built and validated on Node 26) | `node --version` |
| npm | comes with Node | `npm --version` |
| PostgreSQL | 16+ | `psql --version` (or see Section 3 for a no-install setup) |
| Redis | 6.2+ | `redis-cli --version` (or see Section 3) |

No global installs beyond Node/npm are required — everything else (TypeScript, Prisma CLI,
Vitest, Next.js) is a workspace devDependency, invoked via `npm run`.

## 2. First-time setup

```bash
git clone <this repo's URL>
cd "Competitor Monitor AI"
npm install
cp .env.example .env
```

Edit `.env`:
- `DATABASE_URL` / `REDIS_URL` — point at your Postgres/Redis (Section 3 if you need to stand
  these up from scratch).
- `AUTH_SECRET` and `CMA_AI_ENCRYPTION_KEY` — generate two **different** real values:
  `openssl rand -hex 32`. `apps/web` and `apps/worker` **refuse to start** (exit code 1, every problem
  listed) when either is a placeholder, shorter than 32 characters, too repetitive, or when both are the
  same value. With `NODE_ENV=production` they also refuse a missing encryption key and a default
  database password (`postgres`, `password`, `admin`...), and warn about a remote Redis without a
  password. The check lives in `packages/security/src/startupChecks.ts`.
- Leave `CMA_ALLOW_PRIVATE_TARGETS` unset unless you are specifically testing the monitoring
  pipeline against a local fixture server (see Section 7) — it is a double-gated dev-only SSRF
  override, inert whenever `NODE_ENV=production`.

Then apply the database schema:

```bash
npm run db:migrate
```

## 3. Database & queue — getting Postgres/Redis running

### Option A — Docker

Set `POSTGRES_PASSWORD` and `REDIS_PASSWORD` in `.env` (generate with `openssl rand -hex 24`) and use
the same values in `DATABASE_URL` and `REDIS_URL` (`redis://:PASSWORD@localhost:6379`) — the compose
file has **no default credentials** and will not start without them. Then:

```bash
docker compose up -d
```

Postgres and Redis are published on `127.0.0.1` only. Redis is the job queue: anyone who can reach it
can inject jobs for any organization, so never expose it. (Note: this compose file was reviewed but
not executed on the machine that wrote it - Docker was unavailable there.)

### Option B — no Docker (native, no admin rights needed)

Both databases run fine as plain user-level processes on Windows, macOS, or Linux — no service
registration, no elevation.

**PostgreSQL:**
1. Download the official Windows/macOS/Linux binaries for your platform from the PostgreSQL
   project's own downloads page (search "PostgreSQL binaries download" for your OS — on Windows,
   prefer the "binaries zip" over the installer; the installer requires admin rights for Windows
   service registration, the zip doesn't).
2. Initialize a data directory and start it:
   ```bash
   # from the extracted bin/ directory
   ./initdb -D /path/to/pgdata -U postgres --pwfile=<a file containing the password>
   ./pg_ctl -D /path/to/pgdata -l /path/to/pg.log -o "-p 5432 -h 127.0.0.1" start
   ```
3. Create the database:
   ```bash
   PGPASSWORD=postgres ./psql -h 127.0.0.1 -p 5432 -U postgres -c "CREATE DATABASE competitor_monitor;"
   ```

**Redis:**
1. Download a plain (non-service) Redis-for-Windows/macOS/Linux build — on Windows specifically,
   pick a release that ships `redis-server.exe` as a standalone binary rather than an installer.
2. Run it directly: `./redis-server --port 6379 --bind 127.0.0.1`.
3. Verify: `./redis-cli -h 127.0.0.1 -p 6379 ping` should print `PONG`.

Either option: put the resulting connection strings into `.env`'s `DATABASE_URL`/`REDIS_URL`.

**Keep native binaries out of git.** If you go the native route, put them under a local,
gitignored directory (this repo's `.gitignore` already excludes `.local-infra/` for exactly this).

## 4. Running the app

Three processes, each in its own terminal:

```bash
npm run --workspace apps/web dev      # Next.js API, http://localhost:3000
npm run --workspace apps/worker dev   # BullMQ worker (monitoring, AI analysis, daily reports)
npm run worker:scheduler              # in-process scheduler (Phase 26)
```

**Scheduler (`apps/worker/src/scheduler.ts`).** A fixed-interval loop, not a cron-expression engine and
without per-organization schedules: every 15 minutes it enqueues the monitored URLs that are due
(`CMA_SCHEDULER_MONITORING_INTERVAL_MS`), and every hour it enqueues the daily-report jobs
(`CMA_SCHEDULER_DAILY_REPORT_INTERVAL_MS`; job-id dedup makes re-checks harmless). It never calls an
AI provider. It is a substitute for an external cron; in production you may instead run the one-shot
commands from an OS cron entry or a Kubernetes CronJob:

```bash
npm run worker:enqueue                       # enqueue every URL that is due
# or trigger one via the API (counts against CMA_LIMIT_MANUAL_SCANS_PER_HOUR):
curl -X POST http://localhost:3000/api/monitored-urls/<urlId>/scan -b cookies.txt
```

**Failure backoff (Phase 28.1).** A URL that keeps failing is not retried every tick: the wait doubles
from 15 minutes up to 24 hours (`monitoringBackoffMs`) and resets on the first success. See
[PHASE28.1](docs/phases/PHASE28.1-MONITORING-BACKOFF-REPORT.md) for the known limitations. The
scheduler and the worker are separate processes — **both** must be running.

**Daily reports (Phase 4):** same "minimum scheduling" scope — one script, run once a day (a
plain OS cron entry or a K8s CronJob in production), enqueues one `daily-report-jobs` job per
organization with `dailyReportEnabled=true`, for "today" **in that organization's own
`timezone`** (see `packages/core/src/reportWindow.ts`):

```bash
npm run worker:enqueue-reports
```

The report worker (part of `apps/worker`'s single process, alongside the monitoring and AI-analysis
workers) picks the job up, aggregates already-persisted `ChangeEvent`s into a `Report` +
`ReportItem` rows (never re-crawls, never re-runs AI), and attempts to email the organization's
owner via `@cma/notifications`.

**Email delivery (Phase 29).** Any SMTP account works. Two ways to configure it:
1. **Per organization** (recommended): Settings → Notifications → "Send reports from your own email
   account" (host, port 25/465/587/2525, SSL/TLS or STARTTLS, optional username/password, From address).
   The password is encrypted at rest and never shown again; the host is SSRF-validated on every send;
   "Send test email" mails the organization's own report recipient.
2. **Operator default**, used when an organization has none: `CMA_EMAIL_SMTP_HOST`,
   `CMA_EMAIL_SMTP_PORT`, `CMA_EMAIL_SMTP_SECURE` (`ssl`/`starttls`/`none`), `CMA_EMAIL_SMTP_USER`,
   `CMA_EMAIL_SMTP_PASS`, `CMA_EMAIL_FROM`, `CMA_EMAIL_FROM_NAME` (see `.env.example`).

With neither, the report is still generated and visible in the app, but **no email is sent and nothing
is recorded as SENT** (the job result says `SKIPPED_NOT_CONFIGURED`). `CMA_EMAIL_PROVIDER=console` logs
instead of sending, for local development only. A failed send is retried by BullMQ (3 attempts, exponential
backoff) without regenerating the report. The email body is deterministic: it contains an AI summary only for
changes a user already asked to have analyzed.

## 5. Build

```bash
npm run build                                # every workspace, in no particular order
npm run build --workspace apps/web           # just the Next.js app (also runs its own typecheck)
npm run build --workspace packages/db        # regenerates the Prisma client, then compiles
```

**Build order matters for `npm install` freshness, not for `npm run build`**: every package's
`main`/`types` point at its own `dist/` (or, for `packages/db`, at `dist/` which re-exports the
generated Prisma client). If you see a "Cannot find module '@cma/...'" error right after cloning,
run `npm run build` once at the root before anything else.

## 6. Tests

```bash
npm test                 # every workspace
npm run typecheck        # every workspace
npm run test --workspace packages/security   # a single package
```

**CI** (`.github/workflows/ci.yml`) runs on every push to `main` and every pull request against real
Postgres and Redis service containers: builds the packages in dependency order, applies the migrations,
typechecks, runs every workspace's tests, then re-runs `packages/db`, `packages/queue` and `apps/web`
and **fails if any test was skipped** (those suites skip themselves when the service is unreachable, and
a skip must not be mistaken for a pass). Playwright E2E is not part of CI - it needs the full stack.

Run the unit tests **without** `CMA_ALLOW_PRIVATE_TARGETS`, `OPENAI_API_KEY` or `CMA_AI_PROVIDER` in
your environment (do not `source .env` first): some tests assert the behaviour of an environment
without them and fail otherwise. `packages/db`, `packages/queue` and the rate limiter in `apps/web` need
`DATABASE_URL` / `REDIS_URL` to actually run.

Test categories:
- **Pure unit tests** (`packages/security`, `packages/extraction`, `packages/detection`,
  `packages/queue`, `apps/worker`, `apps/web`) — no external services required, run anywhere,
  always in CI.
- **`packages/db`'s tenant-isolation suite** — requires a real, reachable Postgres. It checks
  connectivity itself and **skips** (not "passes") when none is reachable. Point `DATABASE_URL` at
  a real database and run `npm run db:migrate` first if you want it to actually execute.

`packages/db`'s `build`/`typecheck` scripts run `prisma generate` first. On Windows, this can fail
with `EPERM: operation not permitted, rename ... query_engine-windows.dll.node` if another process
(a running `apps/worker` or `apps/web dev` instance) is holding the Prisma client's native binary
open. Stop those processes first, or run `npx tsc -p packages/db/tsconfig.json --noEmit` directly
to typecheck without regenerating an already-up-to-date client.

## 7. Testing the monitoring pipeline against a local page

The SSRF guard (`packages/security`) blocks `localhost`/private/loopback addresses by design —
that's correct in production, but it also means you can't point a `MonitoredUrl` at a page running
on your own machine without an explicit override.

Set, in `.env` (or inline in the shell), **both**:
```bash
NODE_ENV=development
CMA_ALLOW_PRIVATE_TARGETS=true
```
Both must be set — the override is a no-op whenever `NODE_ENV=production`, regardless of the flag.
Never set `CMA_ALLOW_PRIVATE_TARGETS` in a real deployment.

## 7b. AI analysis (Phase 3 / 3.1 - provider-neutral, multi-tenant)

`apps/worker` also runs a second BullMQ worker for AI analysis jobs (queue `ai-analysis-jobs`).
It calls whichever `AiProvider` `apps/worker/src/resolveAiProvider.ts` resolves for the
**ChangeEvent's own organization** - never a single global provider. Precedence, strict, never
silently crossed:

1. **The organization's own enabled `AiConnection`** (`packages/db/src/repositories/aiConnections.ts`)
   - the real, multi-tenant, SaaS path. Each organization configures its own provider/model/
   credential via `/settings/ai` in the app (`POST /api/ai-connections`).
2. **Local dev/test env fallback** (`CMA_AI_PROVIDER=fake` or `=openai` + `OPENAI_API_KEY`) - only
   when `NODE_ENV !== "production"` **and** the organization has no `AiConnection` of its own.
3. Otherwise, the analysis fails cleanly (`AiAnalysis.status = FAILED`, the underlying
   `ChangeEvent` is never touched) - never a silent fallback to a different provider than the one
   (if any) the organization configured.

```bash
# Any organization creating a connection needs this set wherever a connection is
# created/decrypted - both apps/web (encrypts on save) and apps/worker (decrypts to call
# the provider):
CMA_AI_ENCRYPTION_KEY="<any long random string - generate with: openssl rand -hex 32>"

# Local dev/test env fallback, used only when an organization has no AiConnection:
# Real provider (costs money, calls the actual OpenAI API):
OPENAI_API_KEY="sk-..."
CMA_AI_PROVIDER=openai          # default; explicit for clarity
CMA_AI_MODEL="gpt-4o-mini"      # REQUIRED for this bootstrap path - there is no hard-coded
                                 # default model anywhere in the codebase (Phase 4, Section 24).
                                 # Pick whatever model your OPENAI_API_KEY is entitled to call.

# Fake provider (local dev / E2E / CI — deterministic, free, no network call):
NODE_ENV=development
CMA_AI_PROVIDER=fake
```

Same convention as `CMA_ALLOW_PRIVATE_TARGETS`: both the fake and the env-based OpenAI fallback
are no-ops whenever `NODE_ENV=production`, so a misconfigured production deployment fails loudly
(no `AiConnection` + no env fallback = `NoAiProviderConfiguredError`) instead of silently faking
analysis output or reaching for a shared credential. `OPENAI_API_KEY` and `CMA_AI_ENCRYPTION_KEY`
are read only in `apps/worker`/`apps/web` server code — never in the browser, never in a BullMQ
job payload, a database row, or a log line (see `SecurityGuidelines.md` and Phase 3.1's own
validation doc).

**`apps/web/e2e/ai-analysis.spec.ts` and `ai-connections.spec.ts` require `apps/worker` to be
running with `CMA_AI_PROVIDER=fake`** (both use fresh orgs with no `AiConnection`, so the dev
fallback is what actually runs) — start it with:

```bash
CMA_AI_PROVIDER=fake npm run --workspace apps/worker dev
```

**`apps/web/e2e/ai-openai-smoke.spec.ts`** is the dedicated *real* OpenAI end-to-end smoke test
(Phase 3.1). It is skipped automatically unless `OPENAI_API_KEY` is set for the Playwright
process — run it with `apps/worker` started using the *real* provider (no `CMA_AI_PROVIDER=fake`):

```bash
OPENAI_API_KEY="sk-..." npm run --workspace apps/worker dev
OPENAI_API_KEY="sk-..." npx playwright test e2e/ai-openai-smoke.spec.ts --workspace apps/web
```

This test makes real, billed OpenAI API calls (via the dev-fallback path, since the fresh test
organizations it creates have no `AiConnection` of their own). Do not run it in ordinary CI.

## 7c. Abuse and cost limits (Phase 29)

Failed-login throttling (10 per IP+email per 15 min, 50 per email alone), sign-up (5 per IP per hour),
per-organization quotas (manual scans 20/h, AI analyses 30/day, digest interpretations 10/day, AI and
SMTP connection tests 10/h) and caps (25 competitors, 100 monitored URLs, minimum scan interval 60 min).
Every value is a `CMA_LIMIT_*` environment variable (full list and defaults in `.env.example`); an
invalid value falls back to the default. Counters live in Redis (fixed windows); if Redis is down the
limiter lets requests through and logs once.

**Playwright E2E** signs up many accounts and triggers many scans from one address, so start the web
server for E2E with the limits raised (the exact variables are listed in `.env.example`).

## 7d. Database safety — read before running any Prisma command

`prisma migrate dev`, `prisma migrate reset`, `prisma db push --force-reset` and **`prisma migrate diff
--shadow-database-url <url>`** all **reset the target database** (drop everything and re-apply the
migrations). Never give any of them your real `DATABASE_URL`. On 2026-10-06 a `migrate diff` run with the
dev database as its shadow database wiped the local dev data (the dogfood organization and its weeks of
observations); nothing could be recovered because `.local-infra/` is not in git and has no backups.

- To validate a migration, create a throwaway database (e.g. `CREATE DATABASE cma_shadow_tmp;`), point
  `--shadow-database-url` at it, and drop it afterwards.
- Applying migrations to an existing database is safe: `npm exec --workspace packages/db -- prisma migrate deploy`.
- If a database ever loses its `_prisma_migrations` table (so `migrate dev` wants to reset), baseline it with
  `prisma migrate resolve --applied <migration-name>` for each migration instead of letting it reset.
- Want a backup of the local database? `pg_dump` from `.local-infra/postgres/pgsql/bin` before risky work.

## 8. Git workflow

- Branch from `main`, name branches descriptively (e.g. `feature/dashboard-competitors-list`).
- Commit messages: short imperative summary line, body explaining *why* when it's not obvious from
  the diff.
- Open a PR against `main`; merge once CI (typecheck + test) is green.
- No separate long-lived integration branch yet at this project size — trunk-based is enough until
  there's a reason to change it.

## 9. Working from more than one machine

Nothing in this repo is machine-specific except:
- `.env` (gitignored — recreate from `.env.example` on each machine, with that machine's own
  `DATABASE_URL`/`REDIS_URL`/`AUTH_SECRET`).
- `.local-infra/` (gitignored — if you went the native-Postgres/Redis route on a given machine,
  its binaries and data directory live here and are **not** synced between machines; each machine
  either runs its own local instance or points `.env` at a shared/remote database instead).
- `node_modules/`, `dist/`, `.next/`, `packages/db/generated/` — all gitignored, regenerated by
  `npm install` + `npm run build` on any machine.

To resume work on a second machine: `git pull`, `npm install`, recreate `.env`, `npm run db:migrate`
(safe to re-run — Prisma no-ops if the schema is already up to date), then Section 4.

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module '@cma/...'` | Run `npm run build` at the repo root once. |
| Prisma `EPERM ... query_engine-windows.dll.node` | Stop any running `apps/worker`/`apps/web` process holding the old client open, then retry. |
| Tenant-isolation tests report "skipped" | No reachable `DATABASE_URL` — see Section 3. |
| `SsrfBlockedError` when adding a `MonitoredUrl` pointing at your own machine | Expected — see Section 7. |
| BullMQ job never seems to re-run for a URL you already scanned once | Check you're on the current code — job IDs are time-bucketed per `packages/queue/src/monitoringQueue.ts`'s `monitoringJobId()`; an older build with a permanently-fixed job ID per URL had a bug where a completed job blocked all future re-scans of that URL (fixed during Phase 1 validation). |
| Web or worker exits at startup with "Insecure or invalid configuration" | A secret in `.env` is a placeholder, too short/repetitive, or both secrets are equal - see Section 2. |
| 429 "Too many failed sign-in attempts" / "limit reached" | Phase 29 limits - see Section 7c; raise the `CMA_LIMIT_*` value for the environment (e.g. E2E). |
| Daily report generated but no email arrived | No SMTP configured (`SKIPPED_NOT_CONFIGURED`) or the send failed - Settings → Notifications, "Send test email"; the job log shows the outcome. |
| `next build` warns about "Dynamic filesystem access" / "unexpected export *" from `packages/db/generated` | Harmless — comes from Prisma's generated client, not from this project's own code. Does not fail the build. |
