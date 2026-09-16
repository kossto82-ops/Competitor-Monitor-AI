# Phase 2.1 Hardening Report — Pre-AI Robustness Pass

## Status

**PASS WITH FIXES**

Every remaining risk flagged in the Phase 2 report was investigated against real infrastructure. Two of the five areas investigated (the cron/`enqueueAll` job-id semantics, and the summary-repository N+1 shape) turned out to already be correct and are now backed by real tests rather than just doc comments. Two areas (PENDING-job failure safety, and worker exception handling) had genuine gaps that could leave a `MonitoringJob` row stuck forever under specific failure conditions; both are fixed with regression tests. The concurrency check surfaced one false alarm (a test-isolation mistake on my part, not a product bug — see Bug #3) and, once corrected, found no real race conditions.

## Tests

Real infrastructure throughout (real PostgreSQL 17.11 at `127.0.0.1:5432`, real Redis 7.4.11 at `127.0.0.1:6379`, real Chromium via Playwright, the real fixture server at `127.0.0.1:4100`).

| Suite | Passed | Failed | Skipped | Not run |
|---|---|---|---|---|
| Unit/integration tests (`npm test`, all 7 workspaces, `DATABASE_URL`+`REDIS_URL` set so nothing skips) | 123 | 0 | 0 | 0 |
| Playwright E2E (`npx playwright test`) | 15 | 0 | 0 | 0 |
| Real-infra validation scripts (`scripts/validation/concurrencyCheck.mjs`) | all assertions passed (see Concurrency section) | 0 | — | — |

Breakdown of the 123 unit/integration tests by workspace: `apps/web` 13 (schemas 6, session 3, **new** scan-route enqueue-failure 4), `apps/worker` 11 (pipeline, **+4 new** exception-handling tests), `packages/db` 30 (tenantIsolation 9, **new** dashboard 8, **new** summaryQueries 13), `packages/detection` 13, `packages/extraction` 11, `packages/queue` 5 (job-id unit 2, **new** real-Redis enqueueAll semantics 3), `packages/security` 40.

Typecheck: **PASS** across every workspace (`apps/web`, `apps/worker`, `packages/{core,db,detection,extraction,queue,security}`). Prisma `validate`: **PASS** (schema valid). Prisma `migrate status`: **up to date**, 1 migration applied, no drift. Production build (`next build`, Turbopack): **PASS**.

## Cron path

**Behavior confirmed correct, now backed by real-Redis tests instead of only a doc comment.**

`enqueueAll.ts` calls `monitoringJobId(url.id)` (default 60s bucket) as the BullMQ job id for every active URL on every run. This is the same primitive that caused Bug #1 in Phase 2 (the manual-scan path), so it needed direct verification, not just re-reading the comment.

New suite: `packages/queue/src/enqueueAllJobId.realRedis.test.ts` (real Redis, real BullMQ, its own isolated queue name so it never competes with a real `apps/worker` process — see "Bugs found" for why that isolation matters).

- **A URL with no existing job**: enqueues cleanly, a real worker processes it, `completed` fires for that exact id.
- **The same URL becomes eligible for a genuinely later scan**: once the bucket rolls over (simulated by shrinking `bucketMs` to 50ms rather than waiting a real 60s), the second `monitoringJobId()` call produces a *different* id, `queue.add()` returns that new id (not the stale completed job), and the worker actually re-executes — confirming the exact failure mode from Bug #1 does not reproduce here once real time has passed.
- **Intended dedup, verified**: two near-simultaneous enqueues of the same URL within one 60s bucket collapse into a single real job — confirmed by asserting only one `completed` event ever fires for that id, not by inference.

No changes were made to `monitoringJobId()`, `enqueueAll.ts`, or the bucket size. The design was already sound for the cron use case; the manual-scan path's bug (Phase 2) was that it reused this cron-oriented dedup for a case where each click should be independent, not a flaw in the dedup logic itself.

## PENDING failure handling

**Real gap found and fixed.**

`POST /api/monitored-urls/[urlId]/scan` creates a `PENDING` `MonitoringJob` row, then calls `queue.add()`. Previously, if `queue.add()` threw (Redis unreachable, connection reset, etc.), the route's outer `catch` returned an error response to the client, but the `PENDING` row was never touched — a permanent orphan, since nothing would ever pick it up. The dashboard's poller (`ScanButton`) would spin until its own client-side timeout with no way to ever resolve.

**Fix:** `apps/web/src/app/api/monitored-urls/[urlId]/scan/route.ts` now wraps `queue.add()` in its own `try/catch`. On failure, it calls the new `markMonitoringJobFailed(jobId, message)` (best-effort — if even that update fails, the original enqueue error is still what's returned to the caller) before rethrowing, so a failed enqueue always ends in a terminal, honest state instead of a silent orphan. The queue connection is also always closed via `finally`, regardless of outcome.

**New repository function:** `markMonitoringJobFailed(jobId, errorMessage)` in `packages/db/src/repositories/monitoringPipeline.ts` — sets `status: "FAILED"`, `finishedAt`, `errorMessage`.

**Regression tests:** `apps/web/src/app/api/monitored-urls/[urlId]/scan/route.test.ts` (new, 4 tests): happy path returns 202 and never marks the job failed; `queue.add()` throwing marks the `PENDING` job `FAILED` and returns 500; a failure in `markMonitoringJobFailed` itself doesn't swallow the original enqueue error; a `NotFoundError` from `getMonitoredUrlForOrg` never even creates a `PENDING` row (tenant boundary still enforced before any job exists).

## Dashboard tests

**New, real-Postgres.** `packages/db/src/repositories/dashboard.test.ts`, 8 tests, no mocked Prisma:

- Empty organization → all-zero counts, empty `recentChangeEvents`/`recentJobs`.
- A single competitor with no URLs.
- Multiple monitored URLs spread across multiple competitors — correct `totalCompetitors`/`totalMonitoredUrls`.
- Multiple monitoring jobs (mixed `COMPLETED`/`FAILED`) with `createdAt` placed exactly at 2h/23h/25h/7d ago — confirms the 24h window boundary is exact (23h in, 25h out), not approximate.
- `recentJobs`: 12 jobs created, asserts the cap is exactly 10, newest-first ordering, both statuses represented, and the correct `monitoredUrl` (`url`/`label`/`competitorId`) is attached.
- Change-event 7-day window: events at 1d/6d/8d/30d ago — confirms 8d is correctly excluded.
- `recentChangeEvents`: 8 events created, asserts the cap is exactly 5 and newest-first.
- Tenant isolation: an organization with a full data set never appears in a second, empty organization's summary.

## Summary repository tests

**New, real-Postgres, no repository redesign — nothing here needed fixing.** `packages/db/src/repositories/summaryQueries.test.ts`, 13 tests:

**`listCompetitorsWithSummaryForOrg`** (6 tests): empty org; `monitoredUrlCount` correct across competitors with 3/1/0 URLs each; `latestJob`/`latestChangeEvent` correctly attributed per competitor when two competitors each have their own (never crossed); the *most recent* of several jobs/changes on one competitor's URL is the one returned; no leakage into a second organization's result; and a direct **query-count assertion** (via new `countPrismaQueries` instrumentation, see below) proving the function issues a flat ≤4 SQL queries with 6 competitors × 3 URLs × (job + snapshot + change event) each — not growing per row.

**`listMonitoredUrlsWithStatusForOrg`** (7 tests): empty competitor; `latestJob`/`latestChangeEvent`/`latestSnapshot` correctly attributed per URL (never crossed) across two URLs; the most recent of several scans on one URL; org-wide listing (no `competitorId` filter) returns URLs across all competitors; no cross-tenant leakage; `FAILED_TO_VERIFY` and `CHANGED` snapshots are never conflated in `latestSnapshot`; and the same query-count assertion with 15 URLs, confirming a flat ≤4 queries.

**New test infrastructure:** `packages/db/src/client.ts` now configures the shared Prisma client with `log: [{ emit: "event", level: "query" }]` (inert — emits an event, prints nothing) and exports `countPrismaQueries(fn)`, which counts real SQL queries issued while `fn` runs. This is test-only instrumentation, not used by production code, added specifically so "no N+1" is a checked assertion rather than a trusted comment. Both summary functions passed on the first run — the existing batch-fetch-plus-in-memory-Map pattern documented in their comments is exactly what's happening.

## Concurrency

**Scenario:** 2 organizations (3 monitored URLs in org A, 2 in org B — 5 total), all 5 scans triggered concurrently via `Promise.all`, each mirroring the real `POST /scan` route exactly (create `PENDING` row → enqueue under that row's own id), processed by a real BullMQ worker (concurrency 5) running the real `runMonitoringJob` pipeline against real Postgres.

**Result: PASS.** All 5 jobs reached `COMPLETED`. For every job: exactly one `Snapshot` exists, it points at the correct `MonitoredUrl` (never a different concurrently-scanned one), and carries the correct `organizationId` (never another org's). Zero spurious `ChangeEvent`s were created for these baseline (first-ever) scans. Zero unexpected `worker.on("failed")` events. Genuine overlap between job executions was confirmed (start/end timestamp windows actually overlapped — this was real concurrent execution, not accidentally serialized).

No race conditions found in `MonitoringJob` creation, BullMQ enqueue, snapshot creation, `ChangeEvent` creation, or status transitions under this load.

Script: `scripts/validation/concurrencyCheck.mjs` (real Postgres + real Redis + a real worker instance, its own isolated BullMQ queue name — see Bug #3 below for why isolation was necessary).

## Bugs found

**Bug #1 — Orphaned `PENDING` `MonitoringJob` row when `queue.add()` throws**
- *Symptom:* none observed in production yet — found by code inspection per the task's explicit instruction to review this path, not by a failing test.
- *Root cause:* `POST /api/monitored-urls/[urlId]/scan` created the `PENDING` row, then called `queue.add()` with no failure handling; a thrown error there left the row permanently `PENDING` with nothing ever able to advance it.
- *Fix:* wrap `queue.add()` in `try/catch`; on failure, call the new `markMonitoringJobFailed()` (best-effort) before rethrowing. See "PENDING failure handling" above.
- *Regression test:* `apps/web/src/app/api/monitored-urls/[urlId]/scan/route.test.ts` — 2 of the 4 new tests target this exact path.

**Bug #2 — Unexpected worker exceptions left a `MonitoringJob` row stuck at `RUNNING` forever**
- *Symptom:* none observed in production yet — found by inspecting the lifecycle per the task's explicit instruction (item 6), not by a failing test.
- *Root cause:* `runMonitoringJob` (`apps/worker/src/pipeline.ts`) marked the job `RUNNING`, then ran extraction/comparison/persistence with no exception handling of its own. A genuine extractor bug, an out-of-memory error, or a Postgres error mid-transaction (as opposed to an ordinary fetch failure, which the extractor always resolves rather than throws) would leave the row at `RUNNING` indefinitely — the dashboard's poller would spin forever, and BullMQ's retry/backoff would keep re-running the same broken code with no better outcome.
- *Fix:* wrapped everything after the job is marked `RUNNING` in a `try/catch`. On catch, call the new `markMonitoringJobFailed(job.id, message)` (best-effort) and rethrow the original error unchanged, so BullMQ's own retry/backoff and `failed` event still see the real failure. This is deliberately separate from a normal fetch/verification failure: the extractor never throws for an HTTP error or timeout — it resolves with an `ExtractionResult.errorMessage`, which `persistMonitoringResult` turns into a `COMPLETED` job with a `FAILED_TO_VERIFY` snapshot attached. Reaching the new `catch` means there is no `Snapshot` for this attempt at all — the job's own execution broke, not the fetch.
  - Additional defense-in-depth: `apps/worker/src/index.ts`'s `worker.on("failed", ...)` handler now also checks whether the job's `MonitoringJob` row (when `payload.monitoringJobId` is present) is still non-terminal and marks it `FAILED` if so. This covers the case `runMonitoringJob`'s own `try/catch` cannot: a worker process crash mid-job, or BullMQ's own "stalled job" detection exhausting its retry budget without ever re-invoking the processor.
- *Regression tests:* `apps/worker/src/pipeline.test.ts`, 4 new tests — extractor throws → job marked `FAILED` and rethrown, `persistMonitoringResult` throws → same, a failure in `markMonitoringJobFailed` itself doesn't swallow the original error, and (explicitly) a normal `FAILED_TO_VERIFY` outcome never calls `markMonitoringJobFailed`.

**Bug #3 — False alarm from my own concurrency-check script, not a product bug (documented so it isn't rediscovered the hard way)**
- *Symptom:* the first run of the concurrency check reported 3 of 5 jobs `FAILED` with `"Address 127.0.0.1 resolved to range \"loopback\", which is not a routable public address."`
- *Root cause:* my script's own in-process worker used the *real* `MONITORING_QUEUE_NAME` (via `createMonitoringQueue`/`createMonitoringWorker`), which is the same queue a real `apps/worker` process from earlier in this session was still listening to on the same Redis instance. That real worker had been started with `CMA_ALLOW_PRIVATE_TARGETS=true`; my script's own process did not have that env var set. Since both workers raced for jobs on the same queue, roughly which worker grabbed which job determined whether the SSRF check allowed the loopback fixture-server target or correctly blocked it. This is not a race condition in application code — the SSRF check itself (`packages/security/src/resolveHost.ts`) has no shared mutable state and is deterministic per-call; it's a test-isolation mistake (two independent worker processes, differently configured, sharing one queue name).
- *Fix:* the script now uses its own isolated BullMQ queue name, exactly like `enqueueAllJobId.realRedis.test.ts` already did — never sharing a queue with a real `apps/worker` process during manual/ad-hoc runs.
- *Regression test:* not applicable (a validation script, not part of the automated suite) — the fix and the reasoning are documented directly in `scripts/validation/concurrencyCheck.mjs`'s header comment so the next person (or session) doesn't waste time rediscovering it.

## Remaining risks

- **The cron-style `enqueueAll` path still has no defense against a worker crash mid-job.** Unlike the manual-scan path, it has no pre-created `MonitoringJob` row and no stable id in the BullMQ payload (`createRunningMonitoringJob` only creates the row once the worker actually starts processing), so the new defensive `worker.on("failed")` handler in `apps/worker/src/index.ts` cannot identify which row to mark `FAILED` for this path — it silently does nothing (by design: `monitoringJobId`/`organizationId` are both required before it acts). A worker crash immediately after `createRunningMonitoringJob` but before the row reaches a terminal state would still strand that one row. Fixing this properly would mean giving `enqueueAll.ts` a pre-created-row flow symmetric with the manual-scan path — a reasonable follow-up, not attempted here to keep this hardening pass small per the brief.
- **`markMonitoringJobFailed` is best-effort everywhere it's called** (scan route, pipeline, worker's `failed` handler) — if Postgres is *also* down at the same moment something else fails, the row simply never gets marked, and this is accepted rather than retried-with-backoff, since the alternative (queueing a "mark as failed" retry) adds real complexity for what should be a rare double-failure.
- **No dedicated unit tests for `packages/db/src/client.ts`'s new `countPrismaQueries` instrumentation itself** — it's exercised indirectly (its counts are asserted against in `summaryQueries.test.ts`), but there's no test proving the counter resets correctly across repeated calls in the same process. Low risk (it's test-only infrastructure, not shipped behavior), but worth a note.
- **The concurrency check is a single manually-run script, not part of `npm test`.** It requires the fixture server and `CMA_ALLOW_PRIVATE_TARGETS=true`, which is why it lives under `scripts/validation/` rather than as a vitest suite (consistent with the existing `queueIntegration.mjs` precedent) — it won't run automatically in CI if one is ever added, only on demand.
- **Everything validated here is Phase 1/2 pipeline behavior.** None of Section 6's exception-handling hardening has been exercised against the AI-analysis code path, because that code doesn't exist yet — Phase 3 will need its own equivalent review once it introduces new failure modes (LLM call timeouts, rate limits, malformed model output).

## Recommendation

**Ready for Phase 3.** The monitoring pipeline's job lifecycle (`PENDING → RUNNING → COMPLETED/FAILED`) now has no known path — enqueue failure, unexpected pipeline exception, or worker crash on the manual-scan path — that leaves a job permanently stuck, and both new failure-safety fixes carry regression tests. The cron path's job-id semantics were verified correct rather than assumed. The dashboard and competitor/URL summary read paths that Phase 3's AI-analysis UI will likely build on are now covered by real-Postgres tests, including an explicit N+1 check. A 5-way concurrent-scan check against the real stack found no race conditions in job/snapshot/change-event creation or tenant isolation. The one open item — the cron path's crash-safety gap — is scoped and documented rather than silently accepted, and is small enough to pick up alongside Phase 3 rather than blocking it.
