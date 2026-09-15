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
- `AUTH_SECRET` — generate a real one: `openssl rand -hex 32`. Never reuse the placeholder.
- Leave `CMA_ALLOW_PRIVATE_TARGETS` unset unless you are specifically testing the monitoring
  pipeline against a local fixture server (see Section 7) — it is a double-gated dev-only SSRF
  override, inert whenever `NODE_ENV=production`.

Then apply the database schema:

```bash
npm run db:migrate
```

## 3. Database & queue — getting Postgres/Redis running

### Option A — Docker

```bash
docker compose up -d
```

Starts Postgres on `5432` and Redis on `6379`, matching `.env.example` exactly. This is the
easiest path if Docker is available on your machine.

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
npm run --workspace apps/worker dev   # BullMQ worker (processes monitoring jobs)
```

There is no scheduler yet (Phase 1 scope) — jobs only run when you enqueue them:

```bash
npm run worker:enqueue                       # enqueue every active MonitoredUrl
# or trigger one via the API:
curl -X POST http://localhost:3000/api/monitored-urls/<urlId>/scan -b cookies.txt
```

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

## 7b. AI analysis (Phase 3)

`apps/worker` also runs a second BullMQ worker for AI analysis jobs (queue `ai-analysis-jobs`).
It needs an AI provider — real or fake:

```bash
# Real provider (costs money, calls the actual Anthropic API):
ANTHROPIC_API_KEY="sk-ant-..."
# Optional: CMA_AI_MODEL="claude-haiku-4-5-20251001" (default shown)

# Fake provider (local dev / E2E / CI — deterministic, free, no network call):
NODE_ENV=development
CMA_AI_PROVIDER=fake
```

Same convention as `CMA_ALLOW_PRIVATE_TARGETS`: `CMA_AI_PROVIDER=fake` is a no-op whenever
`NODE_ENV=production`, so a misconfigured production deployment fails loudly (missing
`ANTHROPIC_API_KEY` throws the moment a job needs it) instead of silently faking analysis output.
**`apps/web/e2e/ai-analysis.spec.ts` requires `apps/worker` to be running with
`CMA_AI_PROVIDER=fake`** — start it with:

```bash
CMA_AI_PROVIDER=fake npm run --workspace apps/worker dev
```

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
| `next build` warns about "Dynamic filesystem access" / "unexpected export *" from `packages/db/generated` | Harmless — comes from Prisma's generated client, not from this project's own code. Does not fail the build. |
