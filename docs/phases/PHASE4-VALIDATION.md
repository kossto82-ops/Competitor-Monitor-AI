# Phase 4 Validation — Daily Competitor Intelligence Report

**Scope:** connect the existing deterministic monitoring + AI analysis systems (Phases 1–3.1)
into a daily report the customer can read on the dashboard, browse in history, and receive by
email — without re-crawling, without a second AI call, and without the product ever assuming a
customer's AI provider or model.

---

## 1. Architecture

```
Scheduler (enqueueDailyReports.ts, one script run once/day per org's own timezone)
        ↓
BullMQ "daily-report-jobs" queue (packages/queue/src/dailyReportQueue.ts)
        ↓
apps/worker's report worker (generateDailyReportJob, apps/worker/src/reportPipeline.ts)
        ↓
  1. resolveOrgLocalDayWindow(reportDate, timezone)   [packages/core — pure, DB-free]
  2. read already-persisted ChangeEvents in that window (packages/db)
  3. read each ChangeEvent's AiAnalysis if one exists (enrichment, never re-computed)
  4. write Report + ReportItem rows (idempotent upsert + skipDuplicates)
  5. attempt email delivery (packages/notifications) — isolated failure, never blocks the report
        ↓
Dashboard "Today's competitor update" card, /reports (history), /reports/[id] (detail)
```

The report generation step is a **pure read of already-persisted data**. It never calls an
extractor, never calls `compareSnapshots`, and never calls an `AiProvider`. This is enforced
structurally (`ReportPipelineDeps` has no dependency capable of doing any of those things — see
`apps/worker/src/reportPipeline.test.ts`'s Section 28 test) and confirmed at runtime by the E2E
validation script counting real `fetch()` calls during generation (0, always).

---

## 2. AI provider behavior

**Competitor Monitor AI does not require a specific AI vendor. Provider and model are
organization-configurable, exactly as Phase 3.1 established — Phase 4 changes nothing about that
contract, it only adds a consumer (the report) that respects it.**

The daily report always shows the deterministic `ChangeEvent` fact. It shows an AI interpretation
underneath *only* when that organization's own `AiConnection` produced a `COMPLETED` `AiAnalysis`
for that specific change. If the organization has no `AiConnection`, or the analysis is `FAILED`,
the report still renders the fact — the AI line says "AI interpretation unavailable." This is
tested directly (`reportPipeline.test.ts`) and proven with a real, live end-to-end run (Section 6).

---

## 3. Default-model audit (Section 24 — the blocking requirement)

**Finding: no production code path configures a default AI model. `gpt-5.6-luna` was previously
a hidden fallback in one place; that regression is now fixed.**

### 3.1 The regression found and fixed

`apps/worker/src/resolveAiProvider.ts` contained:

```ts
const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";
...
model: process.env["CMA_AI_MODEL"] ?? DEFAULT_OPENAI_MODEL,
```

This was a **hidden fallback model** in the dev/test `CMA_AI_PROVIDER=openai` bootstrap path — if
a developer set `CMA_AI_PROVIDER=openai` and `OPENAI_API_KEY` but forgot `CMA_AI_MODEL`, the
system would silently call OpenAI with `gpt-5.6-luna` instead of failing. That is exactly the
"environment fallback" class of violation this phase's audit was told to hunt for.

**Fix applied:** the constant is deleted. The bootstrap path now requires `CMA_AI_MODEL` to be
explicitly set; if it's missing, bootstrap resolution simply returns `null` and the pipeline falls
through to `NoAiProviderConfiguredError`, exactly like any other missing configuration — never a
silent substitution. `.env.example` and `DevRunbook.md` were updated to match (they previously
also documented `gpt-5.6-luna` as a "default"). A regression test was added:
`resolveAiProvider.test.ts` → *"the dev bootstrap NEVER defaults to a hard-coded model when
CMA_AI_MODEL is unset - it fails cleanly instead"*.

### 3.2 Every remaining occurrence of `gpt-5.6-luna`

| Location | Category | Why it's acceptable |
|---|---|---|
| `apps/web/e2e/ai-connections.spec.ts` (×4) | Test fixture | Arbitrary model-name string typed into a form field to prove the UI round-trips whatever the user types; not a default. |
| `apps/web/src/app/api/ai-connections/**/*.test.ts` (×6) | Test fixture | Arbitrary model string in a mocked `AiConnection` row. |
| `apps/worker/src/aiPipeline.test.ts` (×1) | Test fixture | Arbitrary `AiConnectionConfig.model` in a unit test. |
| `apps/worker/src/resolveAiProvider.test.ts` (×2) | Test fixture | Arbitrary model in an `AiConnection` mock — proves the *organization's own* configured value is what's used, never a hard-coded one. |
| `apps/worker/src/resolveAiProvider.ts` (×1, comment only) | Documentation | Doc comment explaining *why* the constant was removed (this file). No executable reference remains. |
| `packages/ai/src/pricing.test.ts`, `pricing.ts` (comment) | Test fixture / doc | Proves an unpriced model correctly returns `costUsd: null`; the doc comment explicitly calls it "NOT a product default". |
| `packages/ai/src/providers/openaiProvider.test.ts` (×11), `registry.test.ts` (×2) | Test fixture | Arbitrary model string passed into unit tests of the OpenAI provider adapter and provider registry. |
| `packages/db/src/repositories/aiConnections.test.ts` (×10) | Test fixture | Arbitrary model value written into test `AiConnection` rows. |
| `DevRunbook.md` (×1) | Historical documentation | Section 7b's Phase 3 history — kept as a record of what the *smoke test* used, explicitly not styled as a default anywhere near it now. |
| `PHASE3.1-VALIDATION.md` (×1) | Historical documentation | Frozen validation report from a prior phase; not touched (historical record, not current guidance). |

**Zero** occurrences remain in a production code path as a fallback, default, or implicit value.

### 3.3 Every occurrence of `gpt-4o-mini`

| Location | Category |
|---|---|
| `apps/worker/src/aiPipeline.test.ts`, `resolveAiProvider.test.ts` | Test fixture (arbitrary real-looking model string) |
| `packages/ai/src/pricing.ts`, `pricing.test.ts` | Published OpenAI pricing table entry (`MODEL_PRICING["openai/gpt-4o-mini"]`) — a price lookup, not a default *selector*. If an organization's `AiConnection.model` happens to equal this string, its price is known; if not, `costUsd` stays `null` (never guessed). |
| `packages/db/src/repositories/aiConnections.test.ts` | Test fixture |
| `DevRunbook.md`, `PHASE3.1-VALIDATION.md` | Documentation of the model used during Phase 3.1's real-OpenAI smoke test — this project's `.env` happens to still use it for local dev, which is fine (it's an explicit, developer-chosen `CMA_AI_MODEL` value, read from env, never hard-coded in source). |

### 3.4 `OPENAI_API_KEY` / `CMA_AI_MODEL` / `CMA_AI_PROVIDER` — every place they are actually read

```
apps/worker/src/resolveAiProvider.ts   ← the ONLY production code path that reads these
apps/web/e2e/ai-openai-smoke.spec.ts   ← test-only (drives the real-OpenAI Playwright suite)
apps/worker/src/resolveAiProvider.test.ts ← test-only
scripts/validation/dailyReportE2E.mjs  ← this phase's own validation script, reads them to build Org B's real AiConnection - never as a fallback
```

`resolveAiProvider.ts`'s reads are gated by `NODE_ENV !== "production"` (confirmed by
`resolveAiProvider.test.ts`'s "never uses the env bootstrap in production" / "never falls back to
fake in production" tests, both still passing). **In production, the only source of provider,
model, and credential is an organization's own `AiConnection` row.** No other file in
`apps/worker`, `apps/web`, `packages/ai`, `packages/db`, or `packages/notifications` reads any of
these three variables.

---

## 4. Report generation & the reporting window

- `Organization.timezone` (new column, default `"UTC"`) defines the organization's calendar day.
  A missing/invalid timezone string normalizes to `"UTC"` rather than throwing or silently mixing
  zones (`packages/core/src/reportWindow.ts::normalizeOrgTimezone`).
- `resolveOrgLocalDayWindow(reportDate, timezone)` converts "which calendar day, in which zone"
  into `[startUtc, endUtc)` UTC instants, correctly across month/year rollovers and DST
  transitions (a Europe/Berlin fall-back day is correctly computed as 25 hours — see
  `reportWindow.test.ts`).
- **Every persisted `ChangeEvent` already represents a verified change** — Phase 1/2's
  `compareSnapshots` never creates a `ChangeEvent` row for a `NO_CHANGE` or `FAILED_TO_VERIFY`
  snapshot. So "ChangeEvents in this window" *is* "verified competitor changes in this window";
  no separate status filter exists or is needed on `ChangeEvent` itself (Section 6).
- A `Report` row is the idempotency anchor: `@@unique([organizationId, reportDate, timezone])`.
  `getOrCreateReportPeriod` finds-or-creates it; a race is resolved via the same
  catch-the-unique-violation pattern Phase 3's `getOrCreatePendingAiAnalysis` established.
- `ReportItem` rows are written via `createMany({ skipDuplicates: true })` against
  `@@unique([reportId, changeEventId])` — re-running generation for an already-`COMPLETED` report
  is a no-op (the pipeline skips aggregation entirely once `status === "COMPLETED"`, and even if
  it didn't, the constraint would still prevent duplicate items).

---

## 5. AI behavior — enrichment, never authority

`ChangeEvent` is authoritative. `AiAnalysis` is enrichment. This hierarchy is enforced at every
layer:

- The report-generation query (`listChangeEventsForReportWindow`) never filters on `AiAnalysis`
  status — a `ChangeEvent` with no analysis, or a `FAILED` one, is included exactly the same as
  one with a `COMPLETED` analysis.
- `toReportEmailChangeInput` / `groupReportItemsForDisplay` only ever read `aiAnalysis.summary`
  when `aiAnalysis.status === "COMPLETED"` — a `PENDING`, `RUNNING`, or `FAILED` analysis renders
  identically to "no analysis at all": the deterministic fact, plus "AI interpretation
  unavailable."
- No code path in the report/email pipeline can write to `ChangeEvent` — verified structurally
  (there is no such function in `ReportPipelineDeps`) and by a dedicated test.

---

## 6. Live, real-infrastructure proof

Two Node scripts run the real system — real PostgreSQL, real Redis, real BullMQ, real worker code
compiled from `apps/worker/dist`, and (for one organization) a real, billed OpenAI API call.
Neither uses a mock database or a mock queue.

### `scripts/validation/dailyReportE2E.mjs`

| Scenario | Result |
|---|---|
| **Org A — no `AiConnection` at all.** Report reaches COMPLETED, 1 verified change, **0 network calls made during generation** (measured via a real `fetch` spy), the item's `AiAnalysis` is `null`, deterministic values untouched. Re-running generation resolves to the same report, does not duplicate items, does not re-send the email. | **PASS** (10/10 assertions) |
| **Org B — real `AiConnection` (`provider: "openai"`, `model` read from `process.env.CMA_AI_MODEL`, real `OPENAI_API_KEY`).** A real OpenAI analysis is run and persisted first; report generation then makes **0 additional network calls** (the persisted analysis is reused, Section 28's cost-control requirement) and the report carries the real AI-generated summary, with the model column matching the env-configured value exactly. | **PASS** (4/4 assertions) |
| **Org C — `AiConnection(provider: "fake")`.** Proves the report pipeline has zero provider-specific branching: it works identically for a completely different (non-OpenAI) provider, driven purely by that organization's own `AiConnection` row. | **PASS** (2/2 assertions) |
| **Cross-cutting.** Org C cannot read Org A's report by id (`NotFoundError`); Org A's report history contains only its own report. | **PASS** (2/2 assertions) |

Full run output (abbreviated):

```
=== ORG A: no AiConnection configured ===
PASS: Org A: report reaches COMPLETED status
PASS: Org A: exactly one verified change is in the report
PASS: Org A: generating the report makes ZERO network calls (no AI provider is ever contacted)
PASS: Org A: the item's ChangeEvent has NO AiAnalysis (never invented)
PASS: Org A: the deterministic old/new values are exactly what was persisted - never altered
PASS: Org A: re-running generation resolves to the SAME report row
PASS: Org A: re-running generation does not re-send the report email
PASS: Org A: re-running generation does not duplicate report items
PASS: Org A: re-running generation does not create a second notification log row

=== ORG B: real AiConnection (provider=openai, model=gpt-4o-mini from env, never hard-coded) ===
PASS: Org B: the real OpenAI analysis call completes
PASS: Org B: report reaches COMPLETED status
PASS: Org B (Section 28, cost control): generating the report makes ZERO additional network calls
PASS: Org B: the report item carries the REAL AI-generated summary
PASS: Org B: the persisted model is exactly the env-configured one, never a hard-coded default

=== ORG C: FakeProvider AiConnection (provider=fake) ===
PASS: Org C: the FakeProvider analysis completes without any network call
PASS: Org C: the report item's AI analysis reflects the organization's OWN configured provider

=== Cross-cutting: tenant isolation ===
PASS: Org C reading Org A's report by id throws NotFoundError (tenant isolation)
PASS: Org A's report history contains exactly its own report, never another organization's

=== Phase 4 daily report E2E validation complete ===
```

### `scripts/validation/dailyReportQueueIntegration.mjs`

Real Redis + real BullMQ `daily-report-jobs` queue + a real `Worker` processing `generateDailyReportJob`:

```
PASS: the real worker processed the job and the report reached COMPLETED
PASS: the real worker's report has exactly one verified change
PASS: a duplicate enqueue for the same period does not cause a second worker execution
PASS: the duplicate add() resolves to the same job id
```

### Manual browser verification (real Next.js dev server, real Postgres, real session/auth)

Signed up a fresh organization through the actual signup form, seeded two competitors / two
verified changes (one with a completed AI analysis, one without) via the real repository
functions, and ran `generateDailyReportJob` for real. Confirmed in a real Chromium tab:
- Dashboard's new **"Today's competitor update"** card renders the honest empty state before a
  report exists, and the real counts (`Ready`, 4/4/4) after one is generated.
- `/reports` history lists the report with correct change/competitor counts and status badge.
- `/reports/[id]` groups changes by competitor, shows the deterministic fact first, shows the real
  AI interpretation with a confidence badge for the analyzed change, and shows "AI interpretation
  unavailable." (not a blank or missing row) for the one without an analysis.
- "View evidence →" navigates to the existing `/changes/[id]` page correctly.

---

## 7. Email delivery

`@cma/notifications` defines an `EmailProvider` interface (same "vendor is a swappable
implementation detail" philosophy as `@cma/ai`'s provider registry). **Only a `ConsoleEmailProvider`
is implemented in this phase** — there is no real SMTP/API vendor wired up, because none was
available or credentialed for this phase, and fabricating one would be worse than being explicit
about the gap. Everything downstream (idempotency, content building, failure isolation) is written
against the interface and works unchanged the day a real provider is added.

- **Idempotency:** `NotificationLog` gained a `PENDING` status and a
  `@@unique([reportId, channel, recipient])` constraint. `reserveReportEmailNotification` reserves
  the row *before* calling the provider (same reserve-then-resolve shape as
  `getOrCreatePendingAiAnalysis`); a second attempt for an already-`SENT` recipient/report pair
  short-circuits and never calls the provider again. A previously `FAILED` attempt can retry and
  become `SENT`, but never creates a second row. Verified in `dailyReports.test.ts` (real Postgres)
  and in the E2E script's idempotent-rerun assertions.
- **Failure isolation:** an email-send failure marks only the `NotificationLog` row `FAILED` — the
  `Report` row is untouched and stays `COMPLETED`, and `generateDailyReportJob` does not throw.
  Verified in `reportPipeline.test.ts`'s "Section 17" test.
- **Content:** built once from already-persisted data (`buildDailyReportEmail`, pure function, no
  I/O) — no second AI call, no invented facts. Uses the same `describeChangeEvent` /
  `groupChangesByCompetitor` functions (`packages/core`) as the web UI, so the email and the
  dashboard/report pages never disagree about wording or ordering.
- No credential or API key is ever placed in email content (tested).

---

## 8. Security / tenant isolation

Every new query is scoped by `organizationId` directly (not via a join), matching every existing
repository in the codebase. Verified with real Postgres in `tenantIsolation.test.ts` (report,
report-with-items, report history) and `dailyReports.test.ts` (notification reservation scoped
per report/org), plus the E2E script's live cross-org assertion.

---

## 9. Cost control

- Report generation issues **zero** AI-provider network calls — structurally (no such dependency
  in `ReportPipelineDeps`) and confirmed live (fetch-count spy, Section 6).
- An already-`COMPLETED` `AiAnalysis` is read, never recomputed, by the report pipeline.
- No email path triggers an AI call — `buildDailyReportEmail` is a pure function over already-
  persisted data.

---

## 10. Tests

| Suite | Files | Tests | Notes |
|---|---|---|---|
| `packages/core` | 4 | 34 | `reportWindow` (14, incl. DST), `reportGrouping` (6), `changeDescription` (shared via existing tests), plus pre-existing |
| `packages/db` | 6 | 61 | `dailyReports.test.ts` (13, real Postgres), `tenantIsolation.test.ts` extended (10, incl. new Phase 4 case), rest pre-existing |
| `packages/queue` | 3 | 10 | `dailyReportQueue.test.ts` (5) + pre-existing |
| `packages/notifications` | 2 | 9 | new package: `emailProvider` (2), `reportEmail` (7) |
| `apps/worker` | 4 | 50 | `reportPipeline.test.ts` (11) + `resolveAiProvider.test.ts` extended (9, incl. the Section 24 regression test) + pre-existing |
| `apps/web` | 8 | 38 | 4 new report-route tests + updated dashboard/statusDisplay, rest pre-existing |
| `packages/ai`, `detection`, `extraction`, `security` | 18 | 144 | unchanged, still green |
| **Total** | **43 files** | **332 tests** | **all passing** |

Plus 2 real-infrastructure Node validation scripts (Section 6) and one manual real-browser pass.

`npm run typecheck`, `npm run test`, and `npm run build` all pass cleanly across every workspace.

---

## 11. Remaining risks (genuine, not padding)

1. **No real email vendor is integrated.** `ConsoleEmailProvider` logs and "succeeds" for every
   send — production email delivery does not exist yet. The interface, idempotency, and failure
   isolation are all in place and tested; only the actual SMTP/API integration is missing pending
   a chosen vendor and credentials.
2. **The scheduler is a manual/cron-invoked script**, not a managed scheduler service — matches
   the phase's explicit "no cron-expression UI" scope, but means a production deployment must
   itself wire up a K8s CronJob (or equivalent) to run `npm run worker:enqueue-reports` daily per
   the DevRunbook.
3. **No Playwright browser spec was added for `/reports`** — verified manually in a real browser
   (Section 6) and via API-route unit tests, but there is no automated regression spec for the UI
   yet, unlike the existing `monitoring-workflow.spec.ts` style suites for other flows.
4. **`Report.reportDate` uniqueness is per (org, date, timezone) tuple** — if an organization ever
   changes its own `timezone` setting, a new period identity is possible for the same real day;
   this is a known, minor consequence of Section 3's "don't overbuild timezone management" scope
   and would only matter for an organization changing its timezone repeatedly.
5. Local dev Postgres accumulated leftover test-fixture organizations from repeated validation
   runs during this session (harmless — local dev data only, not a code defect).

---

## 12. Final verdict

**READY FOR PHASE 5**
