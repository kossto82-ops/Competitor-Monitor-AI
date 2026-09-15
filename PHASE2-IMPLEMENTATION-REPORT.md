# Phase 2 Implementation Report — Real Dashboard Vertical Slice

## 1. Status

**PASS WITH FIXES**

The complete real workflow works end-to-end against real infrastructure: a user can sign up, create a competitor, attach a monitored URL, trigger a real scan processed by the real worker, see a real price change detected as a real `ChangeEvent`, and inspect the evidence (previous/current snapshots, extraction method, verification state, source URL) in the browser. Tenant isolation, the CHANGED/NO_CHANGE/FAILED_TO_VERIFY distinction, and responsive layout at desktop and tablet widths are all verified against the real stack. "With fixes" because two real bugs (Section 8) were found and fixed during implementation/testing, not because anything remains broken.

## 2. Implemented

- **Auth reuse:** existing Phase 1 JWT/cookie session (`requireSession()`) reused unchanged as the security boundary for every new page and API route.
- **Dashboard:** stats (competitors, monitored URLs, scans in last 24h, changes in last 7d), recent changes list, recent activity list — all backed by real Postgres queries, no mocked data.
- **Competitors:** list (with per-competitor monitored-URL count, latest job, latest change event), detail page, "add competitor" form.
- **Monitored URLs:** add-URL form under a competitor, per-URL status line that explicitly distinguishes "Never scanned yet" / "Could not verify this page" (FAILED_TO_VERIFY) / "No changes detected" (verified NO_CHANGE) / a clickable change summary (CHANGED).
- **Scan workflow:** "Scan now" button that creates a real `MonitoringJob` row, enqueues a real BullMQ job, and polls `GET /api/monitoring-jobs/{id}` every 1.2s until the real worker reports `COMPLETED`/`FAILED` — Idle → Queued/Scanning → Completed/Failed all reflect real backend state, not simulated UI states.
- **Change feed:** organization-wide list of `ChangeEvent`s (`PRICE_CHANGE`, `PRODUCT_ADDED`, `PRODUCT_REMOVED` all supported).
- **Evidence detail:** what-changed card (previous/current value, percentage), an explicit "This is evidence, not an inference" framing, and two snapshot cards (previous/current) showing fetch time, extraction method, verification state, confidence, and a normalized-content excerpt — sourced directly from the real `Snapshot` rows, not summarized/reinterpreted.
- **Settings/Account:** organization + user detail view.
- **Responsive layout:** verified at desktop (1440×900) and tablet (768×1024) — no horizontal overflow, sidebar/topbar/stat grid all reflow correctly.

## 3. Backend changes

- `packages/db/src/repositories/monitoringPipeline.ts` — added `createPendingMonitoringJob`, `markMonitoringJobRunning`, `getMonitoringJobForOrg` to support a job row that exists (as `PENDING`) from the moment "Scan now" is clicked, not only once the worker picks it up.
- `packages/db/src/repositories/monitoredUrls.ts` — added `listMonitoredUrlsWithStatusForOrg` (URL + latest job + latest change event + latest snapshot, batch-fetched and joined in memory to avoid N+1) and `getMonitoredUrlDetailForOrg`.
- `packages/db/src/repositories/competitors.ts` — added `listCompetitorsWithSummaryForOrg` (per-competitor monitored-URL count + latest job/change, aggregated via an in-memory URL→competitor map since `ChangeEvent`/`MonitoringJob` only carry `monitoredUrlId`).
- `packages/db/src/repositories/dashboard.ts` (new) — `getDashboardSummaryForOrg`.
- `packages/db/src/repositories/reports.ts` — added `listReportsForOrg`, `getReportForOrg`, `getAiAnalysisForOrg`.
- `packages/db/src/repositories/organizations.ts` — added `getUserForOrg`.
- `packages/db/src/repositories/changeEvents.ts` — extended the `monitoredUrl` include with `competitor: { select: { name: true } }` so the change feed and evidence view can show the competitor name without a second query.
- `packages/db/src/repositories/snapshots.ts` — bug fix: `getSnapshotForOrg` now throws `NotFoundError` on a miss instead of returning `null`, matching every other `get*ForOrg` function's contract.
- `packages/queue/src/monitoringQueue.ts` — `MonitoringJobPayload` gained an optional `monitoringJobId` field so the worker can update a pre-created row instead of creating its own.
- `apps/worker/src/pipeline.ts` — `runMonitoringJob` now calls `markMonitoringJobRunning(payload.monitoringJobId)` when present, falling back to the old `createRunningMonitoringJob` path for the cron-style `enqueueAll` flow that has no pre-created row.
- New API routes: `GET /api/competitors/[competitorId]`, `GET /api/monitored-urls/[urlId]`, `GET /api/change-events/[changeEventId]`, `GET /api/monitoring-jobs/[jobId]`, `GET /api/dashboard`.
- `POST /api/monitored-urls/[urlId]/scan` — rewritten to create the `PENDING` `MonitoringJob` row first, then enqueue with that row's own id as the BullMQ `jobId` (see Section 8, Bug #1, for why this replaced the previously time-bucketed id here specifically).

**Security preserved, not modified:** every route resolves `organizationId` exclusively from the server-side session (`requireSession()`); the browser-supplied `organizationId` is never trusted. All list/detail queries continue to scope by `organizationId` and throw `NotFoundError` (never leak via `null`) on a cross-tenant lookup. SSRF protections (`packages/security`) were not touched.

## 4. Frontend changes

- Tailwind CSS 4 + hand-built shadcn-style primitives (`Button`, `Card`, `Badge`, `Input`, `EmptyState`, `Spinner`, `Alert`) under `apps/web/src/components/ui/`.
- `apps/web/src/lib/statusDisplay.ts` — single place mapping backend enums to UI copy, explicitly encoding the CHANGED/NO_CHANGE/FAILED_TO_VERIFY distinction so it can't drift per-page.
- `apps/web/src/lib/formatTime.ts` — relative/absolute time formatting.
- `apps/web/src/lib/useHydrated.ts` — gates form submit buttons until client hydration completes (see Section 8, Bug #2).
- `apps/web/src/proxy.ts` (renamed from `middleware.ts` per Next.js 16) — redirect-only convenience layer; every route still independently calls `requireSession()`, so this is not the security boundary.
- `apps/web/next.config.mjs` — `allowedDevOrigins: ["127.0.0.1", "localhost"]` (see Section 8, Bug #3).
- `apps/web/src/app/(app)/layout.tsx` + `Sidebar`/`Topbar` — auth-gated shell with the information architecture from the spec (Dashboard / Monitoring → Competitors, Changes / Settings → Account).
- `apps/web/src/components/app/ScanButton.tsx` — real polling client component (`data-testid="scan-control"`, `scan-phase-badge`, `scan-now-button`) driving Idle → Queued → Scanning → Completed/Failed from the real API.
- `apps/web/src/app/(app)/competitors/[competitorId]/page.tsx` — `MonitoringStatusLine` component (see Section 8, Bug #4).
- `apps/web/src/app/(app)/changes/[changeEventId]/page.tsx` — evidence detail page with `SnapshotCard` × 2.
- All new pages/components under `apps/web/src/app/(app)/`, `apps/web/src/app/login/`, `apps/web/src/app/signup/`.

## 5. E2E results

Real Playwright/Chromium against the real running stack (Postgres 17.11, Redis 7.4.11, the real worker process, the real fixture server, `next dev` on 127.0.0.1:3101). No mocks, no `webServer` auto-start.

| Spec | Result |
|---|---|
| `smoke.spec.ts` — 1 test | ✅ passed |
| `auth.spec.ts` — 6 tests (signup, login, wrong-password rejection, logout, unauth page redirect, unauth API 401) | ✅ passed |
| `competitor-workflow.spec.ts` — 2 tests (create competitor + URL + dashboard reflection; add-URL-under-foreign-competitor rejected) | ✅ passed |
| `monitoring-workflow.spec.ts` — 3 tests (baseline scan Idle→Queued/Scanning→Completed; real price change detected on second scan; fixture 403 → "Could not verify", never a false change) | ✅ passed |
| `evidence.spec.ts` — 2 tests (full evidence detail: values, snapshots, source URL; change feed → same evidence) | ✅ passed |
| `tenant-isolation.spec.ts` — 1 test (two real orgs, two real browser contexts: UI list, direct competitor-detail 404, empty URL list, create-under-foreign-competitor 404, change-events list exclusion) | ✅ passed |

**Total: 15 passed / 0 failed / 0 skipped / 0 not-run.**

Unit tests (also real, run against real Postgres — `packages/db/src/tenantIsolation.test.ts` is skip-if-unreachable, and was confirmed running, not skipped, for this report): **91 passed / 0 failed / 0 skipped** across 12 test files (`apps/web` 9, `apps/worker` 7, `packages/db` 9, `packages/detection` 13, `packages/extraction` 11, `packages/queue` 2, `packages/security` 40).

## 6. Security validation

- Verified via the real `tenant-isolation.spec.ts` E2E test (two real signed-up organizations, two real browser contexts, real cookies) and the real `tenantIsolation.test.ts` unit suite (real Postgres): a second organization cannot see the first's competitors in its list, cannot load the first's competitor detail via direct URL (UI shows no leaked data, API returns 404), gets an empty monitored-URLs list, cannot create a URL under the other org's competitor (404), and never sees the other org's data in the org-wide change-events feed.
- Confirmed by reading every new/modified route: `organizationId` is taken only from `requireSession()`, never from a request body/param/header.
- SSRF protections (`packages/security`) were not modified in Phase 2; their existing unit suite (40 tests) still passes.
- The FAILED_TO_VERIFY vs. NO_CHANGE vs. CHANGED distinction — a correctness/trust requirement, not just UX — is verified end-to-end: `monitoring-workflow.spec.ts`'s 403 test asserts "Could not verify this page" is shown and that neither "No changes detected" nor an invented "Product removed/Price changed" ever appears for a fetch failure.

## 7. Real infrastructure validation

- **PostgreSQL 17.11** at `127.0.0.1:5432`, database `competitor_monitor` — confirmed reachable and used by both the E2E run and the unit test run (`tenantIsolation.test.ts` executed against it, not skipped).
- **Redis 7.4.11** at `127.0.0.1:6379` — confirmed in use via real BullMQ job creation/consumption in every scan-workflow E2E test.
- **Real worker** (`apps/worker/dist/index.js`) — confirmed processing real jobs: the scan-workflow tests only pass because the worker actually transitions a real `MonitoringJob` row from `PENDING`/`RUNNING` to `COMPLETED`, which the UI's real polling loop observes.
- **Real fixture server** (`scripts/validation/fixtureServer.mjs`) at `127.0.0.1:4100` — used for baseline/price-change/403 scenarios; its state is mutated live between scans within a single test to produce a genuine detectable change.
- **Real Next.js dev server** at `127.0.0.1:3101` with `allowedDevOrigins` fix applied — confirmed via passing hydration-dependent tests (form submission, polling).
- Production build (`next build`, Turbopack) completes successfully; `tsc --noEmit` is clean across every workspace.

## 8. Bugs discovered

**Bug #1 — Scans triggered within the same 60-second window silently never complete (real application bug, found via E2E, not a test bug)**
- *Symptom:* the two E2E tests that trigger a second "Scan now" immediately after the first (price-change detection, both evidence tests) had their scan button stuck `disabled` until the 20s test timeout.
- *Root cause:* `POST /api/monitored-urls/[urlId]/scan` created a genuinely new `PENDING` `MonitoringJob` row per click, but enqueued the BullMQ job under `monitoringJobId(monitoredUrl.id)` — a job id bucketed to a 60-second window. A second scan of the same URL inside that window produced the same BullMQ job id as the first, so `queue.add` returned the *already-completed first job* instead of creating a new one. The worker never touched the freshly-created row, so it stayed `PENDING` forever and the UI's polling loop never saw a terminal state.
- *Fix:* the manual-scan route now uses the pre-created `MonitoringJob` row's own id as the BullMQ job id (`apps/web/src/app/api/monitored-urls/[urlId]/scan/route.ts`). Each row is already unique per click, so this removes the collision entirely while preserving the intended dedup behavior for the unrelated cron-style `enqueueAll.ts` sweep, which still uses the bucketed `monitoringJobId()` helper (it has no pre-created row to key off).
- *Regression test:* `monitoring-workflow.spec.ts`'s price-change test and both `evidence.spec.ts` tests exercise back-to-back scans of the same URL and would fail again if this regressed.

**Bug #2 — `allowedDevOrigins` silently blocked all client hydration, not just HMR (real application bug, found via E2E + manual browser debugging)**
- *Symptom:* login/signup forms appeared to submit natively (password visible in the URL query string) instead of via the client-side handler.
- *Root cause:* Next.js 16's `allowedDevOrigins` protection blocked dev-resource requests from `127.0.0.1` (the app was being accessed via `127.0.0.1`, not `localhost`), which silently prevented the client bundle from hydrating at all — not merely HMR, as the warning text implies.
- *Fix:* `allowedDevOrigins: ["127.0.0.1", "localhost"]` added to `apps/web/next.config.mjs`.
- *Regression test:* `smoke.spec.ts` and every auth E2E test depend on working client hydration and would fail again if this regressed. `useHydrated()` (`apps/web/src/lib/useHydrated.ts`) additionally gates every form's submit button as defense-in-depth against the same class of failure mode for any future hydration race, since native form submission would leak the password via GET query string / browser history / server logs.

**Bug #3 — `getSnapshotForOrg` returned `null` instead of throwing `NotFoundError` (consistency bug, found via code review while extending the tenant-isolation test suite)**
- *Symptom:* none observed in practice yet (no caller currently relies on the null case), but it violated the contract every sibling `get*ForOrg` function follows, which is exactly what the tenant-isolation tests assert against for every other entity.
- *Root cause:* an oversight from Phase 1 — this function predates the pattern being made consistent everywhere else.
- *Fix:* `packages/db/src/repositories/snapshots.ts` now throws `NotFoundError` on a cross-tenant or missing snapshot id, matching `getCompetitorForOrg`, `getMonitoredUrlForOrg`, etc.
- *Regression test:* covered by the general `get*ForOrg` contract assertions already present in `tenantIsolation.test.ts`.

**Bug #4 — FAILED_TO_VERIFY, "never scanned", and NO_CHANGE all rendered as identical "No changes detected yet" text (real application bug, caught by re-reading the spec before writing E2E tests)**
- *Symptom:* a monitored URL that could not be fetched (e.g., blocked with a 403) looked identical in the UI to one that was successfully verified and genuinely unchanged — the exact conflation the Phase 2 spec calls out as unacceptable.
- *Root cause:* the competitor-detail page's initial implementation used one generic message for every "no CHANGED event yet" case, without branching on verification state.
- *Fix:* `MonitoringStatusLine` in `apps/web/src/app/(app)/competitors/[competitorId]/page.tsx` now distinguishes "Never scanned yet" / "Could not verify this page" (amber, FAILED_TO_VERIFY) / "No changes detected" (verified NO_CHANGE) / a clickable change summary (CHANGED).
- *Regression test:* `monitoring-workflow.spec.ts`'s 403 test explicitly asserts "Could not verify this page" is shown and that "No changes detected" has zero matches on that row.

**Bug #5 — Playwright specs collected and failed as vitest unit tests (test-infrastructure bug, found while assembling this report)**
- *Symptom:* `npm test` at the repo root silently produced failing output for `apps/web` (`Playwright Test did not expect test.describe() to be called here`) that was easy to miss because it scrolled past in a long combined log.
- *Root cause:* `apps/web` had no `vitest.config.ts`, so vitest's default `**/*.spec.ts` glob picked up the Playwright specs under `e2e/`.
- *Fix:* added `apps/web/vitest.config.ts` excluding `e2e/**`.
- *Regression test:* not itself testable by a test (it's test-runner config), but `npm test` now exits 0 and every workspace's real result is visible without truncation.

No test-authoring-only bugs remain — the three earlier selector fixes (`.first()` on ambiguous text matches, `getByRole("alert")` needing a text filter, `getByText` instead of `getByRole("heading")` for a `<p>`) were applied and verified in the prior iteration of this suite; the fixes recorded above are all against application or tooling code, not test files (except the single `Extraction method` strict-mode fix in `evidence.spec.ts`, applied alongside Bug #1's fix).

## 9. Remaining risks

- **Time-bucketed dedup on the `enqueueAll.ts` cron path is unchanged and untested by Phase 2's E2E suite.** It still uses the same 60-second-bucket strategy that caused Bug #1 for the manual path; it works correctly for its intended purpose (deduping near-simultaneous sweeps) but has not been exercised by an automated test in this phase.
- **`packages/db/src/repositories/dashboard.ts` and the competitor/URL summary queries are not covered by dedicated unit tests** — only indirectly by the E2E suite. A future change to their aggregation logic could regress without a fast, isolated signal.
- **No load/concurrency testing was performed** — the scan-workflow tests trigger one scan at a time per test; concurrent scans across many URLs/organizations were not exercised.
- **`AiAnalysis`/`Report` read paths (`listReportsForOrg`, `getReportForOrg`, `getAiAnalysisForOrg`) were added but have no UI consumer yet and no E2E coverage** — they exist because the spec's data model implies them, but nothing in Phase 2's scope surfaces them to a user.
- **The dev-only `allowedDevOrigins` fix is a development-environment concern; production deployment behavior for this class of issue was not separately validated** (production `next build`/`next start` does not apply this dev-only protection, but that was not explicitly re-verified beyond a successful production build).

## 10. Recommendation

**Ship Phase 2.** The complete real workflow specified — sign up, add a competitor, attach a URL, trigger a real scan, have the real worker process it, detect a real change, and inspect the evidence — works end-to-end against real Postgres, real Redis/BullMQ, and a real worker process, with zero mocked data anywhere in the tested path. Tenant isolation and the CHANGED/NO_CHANGE/FAILED_TO_VERIFY distinction — the two correctness properties the spec treats as non-negotiable — are both verified by tests that would fail if either regressed. The five bugs found were fixed in place, each with a regression test (or, for Bug #5, a config fix that restores the visibility needed to catch such regressions going forward). Recommend picking up the "Remaining risks" items (dashboard/summary unit tests, enqueueAll coverage) as fast-follow hardening rather than blockers.
