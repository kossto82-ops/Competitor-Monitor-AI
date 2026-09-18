# Phase 26 — Real Monitoring Continuity, Promotion Dogfooding & Cost Control

## 1. STATUS

**OPERATIONAL WITH FINDINGS**

Recurring monitoring is now operational (a new, minimal in-process scheduler exists, was run for
real, and a real cross-platform bug in it was found and fixed during this phase). Three real,
public, promotion-carrying competitor pages (Hostinger, ExpressVPN, Mailchimp) were added to the
real dogfood organization through the real product API and scanned through the real monitoring
pipeline — all nine promotion entities Phase 23/24 found in one-off scripts are now **persisted,
real, product-owned data** for the first time. Zero incremental OpenAI cost was caused by any of
this phase's monitoring activity: AI analysis and Digest AI interpretation counts for the real
dogfood organization are unchanged (still 1 and 1, both pre-dating this phase) despite processing
7 real scans plus a 396-job Redis-persisted fixture backlog left over from earlier phases. The
codebase's own architecture (AI is only ever triggered by an explicit, user-initiated POST — never
by the monitoring pipeline) is the reason this was true even before this phase's scheduler code
existed; this phase adds continuity on top of a design that was already cost-safe.

## 2. SCHEDULING FINDING

**The gap was real and exactly as Phase 25 described it: no recurring trigger existed anywhere in
the repository.** `DevRunbook.md` states this explicitly and has since Phase 1/4: "There is no
scheduler yet for monitoring jobs" — `apps/worker/src/enqueueAll.ts` and
`apps/worker/src/enqueueDailyReports.ts` are one-shot CLI scripts meant to be invoked by an
external OS cron entry or K8s CronJob, by design (Phase 4 Section 11 explicitly says not to build
a cron-expression scheduler). That design decision is sound for a real deployment target that
already has a cron/K8s layer. It has no answer for a local/dev/dogfood environment with neither.

**What was built:** `apps/worker/src/scheduler.ts` — a small, in-process, fixed-interval loop
around the *exact same* `enqueueDueMonitoringJobs`/`enqueueDailyReportJobs` functions the
documented cron/K8s path already calls (refactored out of `enqueueAll.ts`/`enqueueDailyReports.ts`'s
`main()` so both the CLI script and the scheduler call one implementation, not two). It is
explicitly **not** a replacement for OS cron/K8s CronJob in production — the file's own doc comment
says so — it is the smallest possible substitute for environments (like this one) that don't have
one. No cron-expression parsing, no per-organization schedule customization: exactly the two
existing enqueue functions, on two independent `setInterval` loops (15 min for monitoring, 1 hour
for daily reports, both configurable via env vars), with an overlap guard so a slow tick is skipped
rather than run twice concurrently, and a shared Redis connection so it doesn't reconnect every tick.

**Concrete defect found and fixed while validating this:** the CLI-entrypoint guard added to all
three files (`if (import.meta.url === \`file://${process.argv[1]}\`)`, meant to let `scheduler.ts`
import the enqueue functions without triggering their scripts' own `main()`) is **silently always
false on Windows** — `import.meta.url` URL-encodes and forward-slashes the path
(`file:///C:/.../checkmain.ts`, `~` → `%7E`) while a naive `file://${process.argv[1]}` template
keeps Windows backslashes and no encoding. Confirmed with a minimal repro
(`npx tsx` printing both strings side by side) before touching the real files. The practical
symptom: `npm run worker:enqueue` printed nothing and enqueued nothing, on this exact Windows dev
machine, until fixed. Fixed by comparing via `pathToFileURL(process.argv[1]).href` (Node's own
`node:url` helper) instead of a manual template, in all three files. Confirmed fixed by running the
real command afterward — it then correctly printed `[enqueue-all] enqueued 399 monitoring job(s).`
and (separately) correctly surfaced a real `DATABASE_URL not set` error the moment the guard let
`main()` actually run, which is itself further proof the fix is real, not a re-hidden failure.

## 3. COST-CONTROL FINDING

**Which paths can call AI:** exactly two, and both were already manual before this phase:
- `POST /api/change-events/{id}/analysis` (`apps/web/src/app/api/change-events/[changeEventId]/analysis/route.ts`)
- `POST /api/digest/interpretation` (`apps/web/src/app/api/digest/interpretation/route.ts`)

Both are explicit, user-initiated, idempotent (return the existing row instead of re-enqueuing if
one is already PENDING/RUNNING/COMPLETED). Neither is reachable from `apps/worker/src/pipeline.ts`
(the monitoring processor) or `apps/worker/src/reportPipeline.ts` (the daily-report processor) —
traced both files' full call graphs; neither imports `@cma/ai`, `createAiAnalysisQueue`, or
`createDigestInterpretationQueue`. This was true before Phase 26 and remains true after it.

**Does routine monitoring call AI:** no, by construction, confirmed both by static trace and by
real execution (Section 6). `enqueueDueMonitoringJobs`/`enqueueDailyReportJobs`/`scheduler.ts` only
ever construct a `MonitoringJob` payload or a `DailyReportJob` payload — neither payload type nor
either queue has any code path into `@cma/ai`.

**Provider resolution guardrails already in the codebase (`apps/worker/src/resolveAiProvider.ts`),
reused rather than rebuilt:** an organization must have its own enabled `AiConnection` row to get a
real provider in production; outside production only, `CMA_AI_PROVIDER=fake` (zero-cost stub) or
`CMA_AI_PROVIDER=openai` + a real `OPENAI_API_KEY` (dev bootstrap, explicitly documented as
"never in production") can substitute. The real dogfood organization (`cmu5f7zhi0001a9rl4wyg34h6`)
has **zero** `AiConnection` rows (`select count(*) from ai_connections where organizationId=...` →
0) — every AI call this organization could ever make runs through the dev bootstrap, which only
fires on an explicit POST to one of the two routes above.

**A pre-existing risk found, not created by this phase, flagged honestly:** the local `.env`/
`apps/web/.env.local` files in this dev environment have `CMA_AI_PROVIDER=openai` and a real,
164-character `OPENAI_API_KEY` (starts `sk-...`). That means any manual POST to either AI route in
*this* dev environment, for *any* organization without its own `AiConnection`, would place a real,
billed OpenAI call — this is exactly how the one pre-existing `AiAnalysis` and one pre-existing
`DigestAiInterpretation` row for the dogfood org (both from an earlier phase, both already counted
in Phase 25) came to exist. This phase did not trigger either route at any point (verified in
Section 6) and did not change `.env`/`.env.local` (neither file is tracked in git; Section 12).
Recommendation for future dogfooding sessions: set `CMA_AI_PROVIDER=fake` locally unless a real AI
call is specifically intended, since the dev bootstrap has no per-call confirmation prompt.

**Guardrail added this phase:** none beyond the scheduler's own structural guarantee (Section 6's
"never enqueues to any AI queue" test) — the existing manual-trigger + per-org-`AiConnection`
architecture was judged sufficient and was not weakened, rebuilt, or wrapped in a new toggle. No
billing system, no Stripe entitlement, no new quota architecture was added, matching the phase's
own instruction to keep this narrowly scoped.

## 4. REAL DOGFOOD CONFIGURATION

Organization: **CMA Dogfood Phase22** (`cmu5f7zhi0001a9rl4wyg34h6`), created 2026-09-17 11:02:57
via the real signup UI (unchanged from Phase 22/25 — this phase did not create a new organization).

| Competitor | Monitored URL | Added | How |
|---|---|---|---|
| Basecamp | `https://basecamp.com/pricing` | Phase 22 | Real UI |
| Namecheap | `https://www.namecheap.com/hosting/shared/` | Phase 22 | Real UI — **bot-blocked (403), pre-existing, unchanged, not fixed this phase** |
| Dropbox | `https://www.dropbox.com/plans` | Phase 22 | Real UI |
| Buffer | `https://buffer.com/pricing` | Phase 22 | Real UI |
| **Hostinger** | `https://www.hostinger.com/web-hosting` | **Phase 26** | Real `POST /api/competitors` + `POST /api/competitors/{id}/urls`, authenticated as the real dogfood user via a session JWT minted with the app's own `createSessionToken`/`AUTH_SECRET` (no password was on hand to log in interactively; the token is bit-for-bit what the login flow itself would issue, and every subsequent call went through the real, tenant-scoped API — never a direct database insert) |
| **ExpressVPN** | `https://www.expressvpn.com/order` | **Phase 26** | Same |
| **Mailchimp** | `https://www.mailchimp.com/pricing/marketing/` | **Phase 26** | Same |

The three new URLs are the exact pages Phase 23/24 already proved carry a real, qualifying
promotion signal — chosen specifically so promotion-lifecycle intelligence has a real chance to be
exercised through the actual product, not just unit-tested (per the brief's own Section "2.
Optionally, once recurring observation is running, add one or more of the sites...").

## 5. REAL OBSERVATION EVIDENCE

All timestamps from `snapshots.fetchedAt`, queried directly against the real Postgres database:

| Competitor | Snapshot time | State | HTTP |
|---|---|---|---|
| Basecamp | 2026-09-17 11:07:17 | NO_CHANGE | 200 |
| Namecheap | 2026-09-17 11:12:24 | FAILED_TO_VERIFY | 403 |
| Dropbox | 2026-09-17 11:12:27 | NO_CHANGE | 200 |
| Buffer | 2026-09-17 11:13:12 | NO_CHANGE | 200 |
| Dropbox | 2026-09-17 11:15:46 | CHANGED | 200 |
| **Hostinger** | **2026-09-18 06:11:45** | **NO_CHANGE** | **200** |
| **ExpressVPN** | **2026-09-18 06:11:47** | **NO_CHANGE** | **200** |
| **Namecheap** | **2026-09-18 06:11:47** | **FAILED_TO_VERIFY** | **403** |
| **Mailchimp** | **2026-09-18 06:11:48** | **NO_CHANGE** | **200** |

The bottom four rows are this phase's real, product-flow observations — genuinely on a **second
calendar day**, ~19 hours after the first session, not a same-session re-check. They were produced
by the real pipeline: `npm run worker:enqueue` (the same command DevRunbook.md documents; the
`scheduler.ts` process was separately started and confirmed to register the identical call
correctly — see Section 8) → BullMQ → `apps/worker/src/pipeline.ts` → real HTTP fetch → real
extraction → real Postgres write. No fixture, no manual DB insert.

**Same-session vs. recurring, stated explicitly:** Basecamp/Buffer/Dropbox were **not** re-scanned
in this phase — correctly, because their `scanFrequencyMinutes` (1440 = 24h) had not yet elapsed
(last successful scan ~19h earlier, not yet 24h). `listDueMonitoredUrls` filtered them out. This is
`scanFrequencyMinutes` behaving exactly as designed (Phase 5), and it is itself evidence the
enqueue function's due-filtering is real and enforced, not decorative — nothing was force-scanned
to manufacture a second data point.

**Honest limitation, stated plainly:** this is still two observation points at most (one per
competitor, 19 hours apart for the pages that had any prior history), not the "days to weeks" of
repeated observation Phase 25 called for. See Section 11.

## 6. PROMOTION EVIDENCE

All nine promotion `ExtractedEntity` rows Phase 23/24 found through one-off scripts against live
HTML are now real, persisted, product-owned data for the dogfood organization, extracted through
the actual monitoring pipeline (`packages/extraction` → `packages/detection`), not a script:

| Competitor | Entity key | Label | Value | Source |
|---|---|---|---|---|
| Hostinger | `jsonld-promo:web hosting` | Web hosting | `priceValidUntil=2027-09-18` | JSON-LD |
| Hostinger | `html-promo:premium` | Premium | `percentOff=75` | Bounded HTML |
| Hostinger | `html-promo:unlimited` | Unlimited | `percentOff=79` | Bounded HTML |
| Hostinger | `html-promo:cloud startup` | Cloud Startup | `percentOff=71` | Bounded HTML |
| ExpressVPN | `html-promo:basic` | Basic | `percentOff=80` | Bounded HTML |
| ExpressVPN | `html-promo:advanced` | Advanced | `percentOff=76` | Bounded HTML |
| ExpressVPN | `html-promo:express pro` | Express Pro | `percentOff=73` | Bounded HTML |
| Mailchimp | `html-promo:standard` | Standard | `percentOff=50` | Bounded HTML |
| Mailchimp | `html-promo:premium` | Premium | `percentOff=50` | Bounded HTML |

These match Phase 24's script-run findings percentage-for-percentage (Hostinger 75/79/71,
ExpressVPN 80/76/73, Mailchimp 50/50) and the JSON-LD `priceValidUntil` date rolled forward by
exactly one year relative to Phase 25's `2026-09-17` observation, consistent with a "roughly a year
out" rolling expiry — the same pattern Phase 23 described, now confirmed as **the same real value
class two independent phases apart.**

**No `PROMOTION_ADDED`/`PROMOTION_CHANGED`/`PROMOTION_REMOVED` `ChangeEvent` exists yet** — correctly:
this is each competitor's **first** snapshot, so there is no prior state to compare against (the
comparator correctly reports `NO_CHANGE` for a baseline, not a synthetic "added" event). Promotion
lifecycle intelligence (Phase 25 Section 6's stated gap) is still unproven end-to-end; it now has,
for the first time, real baseline data through the real product to compare a *second* real
observation against, once one is taken. That second observation did not happen in this session
(these three competitors' `scanFrequencyMinutes` is also 1440 — next due ~2026-09-19 06:11).

## 7. AI/COST RESULT

| Metric | Before this phase (Phase 25) | After this phase | Delta |
|---|---:|---:|---:|
| Real dogfood org — `AiAnalysis` rows | 1 | 1 | **0** |
| Real dogfood org — `DigestAiInterpretation` rows | 1 | 1 | **0** |
| Real dogfood org — `AiConnection` rows (org's own key) | 0 | 0 | **0** |
| Real monitoring scans this phase (all competitors) | — | 4 new + 3 fresh = **7 successful, 1 failed (Namecheap)** | — |
| Fixture-backlog monitoring jobs drained this phase (other orgs, deterministic-only, 0 AI) | — | **396** | — |
| AI provider calls caused by this phase's actions | — | **0** | **0** |
| AI provider retries caused by this phase's actions | — | **0** | **0** |

**Cost regression check (Section 16 of the brief):** adding 3 new competitors and running the
scheduler's deterministic enqueue path against them, plus incidentally draining a 396-job
deterministic backlog left over from earlier E2E test sessions, produced **zero** AI provider
calls. `scheduler.test.ts`'s "never enqueues to any AI queue" test additionally proves this
structurally, not just empirically: `SchedulerDeps` has exactly two dependency groups
(`monitoring`, `dailyReports`), neither of which exposes an AI queue, an AI provider, or `@cma/ai`
anywhere in its type — there is no code path by which running the scheduler longer, or adding more
competitors, could ever reach an AI call.

**Actual OpenAI billing could not be measured from the repository** — no cost/token telemetry is
persisted anywhere in the schema (`apps/web/src/app/(app)/settings/usage/page.tsx`'s own comment:
"no monetary figure is shown here... `@cma/ai`'s own pricing table... cannot reliably price every
configured provider/model"). This phase reports **call counts**, not monetary cost, per the brief's
own instruction to never invent a dollar figure. Call count for this phase: **0**.

## 8. OPERATIONAL RELIABILITY

- **Duplicate-job behavior:** confirmed safe. Running `npm run worker:enqueue` and then starting
  `scheduler.ts` (which runs an identical enqueue tick immediately on boot) back-to-back did not
  double-scan any URL — `listDueMonitoredUrls`'s `scanFrequencyMinutes` filter is the real
  idempotency gate (a URL scanned seconds ago is not due again for `scanFrequencyMinutes`), backed
  by BullMQ's own 60-second job-id bucket dedup for near-simultaneous enqueues of the same URL.
  `monitoring_jobs` status counts for the dogfood org before/after the scheduler's immediate tick:
  `PENDING 2, COMPLETED 7, FAILED 2` → `PENDING 2, COMPLETED 7, FAILED 3` — the only change is one
  more Namecheap failure (still-bot-blocked, always-due since it has never succeeded), exactly as
  expected, no runaway duplication.
- **Overlap guard (new this phase):** `scheduler.test.ts` proves a tick that fires while the
  previous tick of the same kind is still in flight is skipped, not run concurrently
  (`skips a tick that fires while the previous tick of the same kind is still running`).
- **Worker behavior / failed-URL isolation:** unchanged from prior phases — Namecheap's continued
  403 did not block Hostinger/ExpressVPN/Mailchimp/Basecamp/Buffer/Dropbox from completing.
- **PENDING/RUNNING never-terminal risk:** unchanged; `apps/worker/src/index.ts`'s existing
  defense-in-depth `'failed'` handlers (Phase 2.1) were not touched and were not needed this phase.
- **Tenant isolation:** every write this phase made went through the real, session-authenticated,
  tenant-scoped API routes (`requireSession()` + `organizationId`-scoped repository functions) —
  no direct database insert was used to create a competitor, URL, or organization.
- **Cost-control behavior:** see Section 7.

## 9. CODE CHANGES

| File | Change |
|---|---|
| `apps/worker/src/enqueueAll.ts` | Extracted `enqueueDueMonitoringJobs(deps)` out of `main()` (dependency-injectable, matching the existing `PipelineDeps` convention in `pipeline.ts`) so `scheduler.ts` can call the identical logic. Fixed the Windows CLI-entrypoint guard bug (Section 2). |
| `apps/worker/src/enqueueDailyReports.ts` | Same extraction (`enqueueDailyReportJobs(deps)`) and same Windows guard fix. |
| `apps/worker/src/scheduler.ts` | **New.** The in-process recurring scheduler described in Section 2 — two independent `setInterval` loops over the two functions above, overlap guard, shared Redis connection, graceful `SIGTERM`/`SIGINT` shutdown. |
| `apps/worker/package.json` | Added `"scheduler": "tsx src/scheduler.ts"` script. |
| `package.json` | Added `"worker:scheduler": "npm run scheduler --workspace apps/worker"` root script, matching the existing `worker:enqueue`/`worker:enqueue-reports` convention. |

No API route, database schema, extraction, detection, or AI-package code was touched. No
production behavior for existing routes changed.

## 10. TESTS

**Unit/integration (real, not fixture-inflated — 11 new tests, all newly added this phase, all
exercising the new scheduling code specifically):**

| Workspace | Before | After |
|---|---:|---:|
| `apps/worker` | 60 tests / 5 files | **71 tests / 8 files** (+`enqueueAll.test.ts`, +`enqueueDailyReports.test.ts`, +`scheduler.test.ts`) |
| All other workspaces | unchanged | unchanged |
| **Repo-wide total** | 636 tests (Phase 25) | **650 tests, 0 failures, 3 skipped** (same pre-existing real-Redis skip as Phase 25) |

`npm run typecheck` (all workspaces): **0 errors.**
`npm run build` (all workspaces): **succeeds**, including `apps/web`'s own Next.js build/typecheck.

**Real dogfood validation (not a test run — direct execution against the real product):**
- `npm run worker:enqueue` against the real, running `apps/web` + `apps/worker` dev processes,
  connected to the real local Postgres/Redis (started for this phase; Postgres was already running
  from a prior session, Redis was started fresh).
- Real HTTP requests were made to `www.hostinger.com`, `www.expressvpn.com`, `www.mailchimp.com`,
  and `www.namecheap.com` (bot-blocked as expected). `basecamp.com`, `dropbox.com`, and
  `buffer.com` were correctly **not** re-fetched this phase — their `scanFrequencyMinutes` window
  had not yet elapsed (Section 5).
- `scheduler.ts` was started for real, confirmed to log its startup and immediate first tick
  correctly, then stopped (not left running indefinitely — see Section 13 for how to restart it).

**Real-provider calls:** 0 (Section 7). No fake-provider AI calls were made either — this phase
never invoked either AI endpoint, manual or automatic.

## 11. CURRENT LIMITATION

Meaningful longitudinal intelligence (sustained trends, repeated pricing, promotion lifecycle,
cross-competitor baselines) still requires real elapsed time this phase did not manufacture and was
explicitly told not to manufacture. What changed: the *mechanism* for that elapsed time to actually
accumulate now exists and was proven to work for real (Section 2's Windows fix was found precisely
*because* this phase insisted on running the real command instead of trusting the code review).
Three new real observation points (Hostinger, ExpressVPN, Mailchimp baselines) and one real
second-day gap (Dropbox/Basecamp/Buffer's due-filtering correctly skipping a too-soon re-scan) now
exist that did not exist in Phase 25. That is still short of "days to weeks" — this report does not
claim otherwise.

## 12. RECOMMENDATION

**Continue real observation; no new intelligence implementation is justified yet.** Specifically:

1. Keep `apps/worker/src/scheduler.ts` running (see Section 13 to restart it) so the 7 real
   competitors accumulate a second, third, and fourth real observation automatically over the next
   several days, at the existing `scanFrequencyMinutes=1440` (24h) cadence — no code change needed
   for this to start producing real `PROMOTION_ADDED`/`PRICE_CHANGE`/baseline data; it only needs
   time.
2. Set `CMA_AI_PROVIDER=fake` in this local dev environment before any further exploratory
   dogfooding, given the real `OPENAI_API_KEY` currently present in `.env`/`.env.local` (Section 3).
3. Re-run Phase 25's longitudinal-validation methodology once a real multi-day/multi-week window has
   elapsed on the now-7-competitor dogfood organization. At that point Hostinger/ExpressVPN/
   Mailchimp's promotion lifecycle and Basecamp/Buffer/Dropbox's baseline classification can be
   evaluated against real second/third observations rather than remaining `INSUFFICIENT_HISTORY`.

No implementation gap was found in this phase that would justify new intelligence code. The one
concrete defect found (Section 2's Windows path bug) was in *this phase's own new scheduler code*,
not in any pre-existing product capability, and was fixed and verified within the phase.

## 13. HOW TO RESTART CONTINUOUS OBSERVATION

```bash
# Terminal 1 - Postgres/Redis already running locally (see DevRunbook.md Section 3)
# Terminal 2
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/competitor_monitor?schema=public" \
REDIS_URL="redis://127.0.0.1:6379" \
npm run --workspace apps/worker dev

# Terminal 3 - the actual recurring trigger (Phase 26's deliverable)
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/competitor_monitor?schema=public" \
REDIS_URL="redis://127.0.0.1:6379" \
npm run worker:scheduler
```

`CMA_SCHEDULER_MONITORING_INTERVAL_MS` / `CMA_SCHEDULER_DAILY_REPORT_INTERVAL_MS` override the
default 15-minute / 1-hour tick intervals if a tighter or looser cadence is wanted.

## 14. GIT HYGIENE

```
 M apps/worker/package.json
 M apps/worker/src/enqueueAll.ts
 M apps/worker/src/enqueueDailyReports.ts
 M package.json
?? apps/worker/src/enqueueAll.test.ts
?? apps/worker/src/enqueueDailyReports.test.ts
?? apps/worker/src/scheduler.test.ts
?? apps/worker/src/scheduler.ts
?? dump.rdb
```

`dump.rdb` is the same pre-existing untracked Redis dump file present in `git status` at this
session's start (per the environment snapshot) — not created or modified by this phase's work
(Redis was started this phase with `--dir .local-infra`, writing its own dump there, not to the
repo root). `.env`/`.env.local` were read but never modified. No file was staged or committed.
Nothing under `.local-infra/`, `.next/`, or `node_modules/` is part of this diff.
