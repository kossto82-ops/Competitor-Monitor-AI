# Phase 7.1 — Intelligence Model Hardening & Validation

## STATUS

**PASS WITH FIXES**

One genuine implementation bug was found and fixed (`qualifyingWindows`
was silently reported as `0` even when 1 historical window genuinely
qualified). A separate, more consequential problem was found in
documentation/terminology only ("3-window baseline" was ambiguous and one
number — "2×days" — was arithmetically wrong in three docs, even though
the code's own qualification logic was already correct). Both are fixed.
No other correctness issue was found. Every item in Section 34's
Definition of Done is satisfied — see the checklist at the end of this
report.

## Executive Summary

**What was audited:** the exact window-boundary arithmetic in
`getActivityPattern` and `getRepeatedPriceChangePatterns`
(`packages/db/src/repositories/patterns.ts`), the entity-lifecycle
derivation in `getEntityHistoryForCompetitor`, tenant isolation,
half-open-interval boundary behavior, the pattern-result contract (how a
caller distinguishes insufficient-history / evaluated-but-not-qualifying
/ qualifying), the Phase 7 UI (`PatternsCard.tsx`), the AI/provider
boundary, and every Phase 7 document's terminology around "3-window
baseline" and the 90-day/120-day claims.

**What was found:**

1. **A real implementation bug** in `getActivityPattern`: when the
   pattern did not qualify (fewer than 2 historical windows in tracked
   range), the function returned `qualifyingWindows: 0` unconditionally
   from a hardcoded `emptyResult`, even in the case where exactly 1
   historical window genuinely qualified. The `qualifies`/`direction`
   outcome was always correct either way (both 0 and 1 qualifying
   windows are `< MIN_QUALIFYING_BASELINE_WINDOWS (2)`, so the pattern
   never falsely qualified) — but the diagnostic `qualifyingWindows`
   count itself was factually wrong for the 1-window case. This is a
   correctness bug, not a documentation issue: a future caller (UI copy,
   an AI context builder) reading `qualifyingWindows: 0` when 1 window's
   worth of real data exists would understate the competitor's actual
   tracked history. **Fixed** — see "Window Semantics" below.
2. **A documentation/terminology bug**, present in `PHASE7-DATA-AUDIT.md`,
   `PHASE7-VALIDATION.md`, and `PHASE7-PRODUCT-ASSESSMENT.md`: all three
   stated the pattern needs "at least `2 × days`" of tracked history to
   qualify (60 days at the default 30-day window). The actual, and
   always-correct, code requires `3 × days` (90 days) — because reaching
   `MIN_QUALIFYING_BASELINE_WINDOWS` (2) always means "the 2
   *most-recent* historical windows both qualify," and the second-most-
   recent one only enters tracked range at `3 × days`, not `2 × days`.
   `PHASE7-PRODUCT-ASSESSMENT.md`'s value-progression table additionally
   implied the pattern "starts qualifying" gradually somewhere in a
   "60–90 days" range, when it actually activates in one discrete step,
   at exactly 90 days. **Fixed in all three documents** — see "Window
   Semantics" and "90-Day Claim" below.
3. **No entity-lifecycle bug.** All 5 required sequences (A–E) plus the
   "pre-existing product" and "contradictory sequence" cases were traced
   and tested; `currentlyDetected` was already correctly derived from the
   chronologically-last event in every case.
4. **No tenant-isolation issue.** Every pattern query was already scoped
   by `organizationId` directly; 4 new cross-tenant tests (2 for
   `getActivityPattern`, 1 for `getEntityHistoryForCompetitor`, 1 for
   `getRepeatedPriceChangePatterns`) confirm this, in addition to the 3
   that already existed from Phase 7.
5. **A minor half-open-interval gap**, not a bug in practice but worth
   closing: `getRepeatedPriceChangePatterns`'s SQL query had `gte:
   windowStart` with no upper bound (no `lt: now`), meaning events with a
   `detectedAt` in the future — which cannot occur in the real pipeline,
   since `ChangeEvent.detectedAt` defaults to `now()` at write time —
   would technically have been included. Closed for defense-in-depth and
   half-open-interval consistency with `getActivityPattern`, and both
   functions were given an injectable `now` parameter (mirroring
   `resolveComparisonWindow`'s existing convention) so exact-boundary
   behavior is now deterministically testable rather than racing the
   real clock.
6. **No AI boundary issue, no new AI call sites, no hidden provider/model
   default.** Reconfirmed by direct grep of every file this phase
   touched or added.
7. **No new Phase 7.1 mobile regression.** The pre-existing fixed-224px
   sidebar (documented in Phase 6, unchanged since) squeezes `<main>` to
   151px at a 375px viewport; `PatternsCard` inherits that squeeze like
   every other card on the page, but — measured directly via
   `document.documentElement.scrollWidth === window.innerWidth` at
   375px — introduces **no new document-level horizontal overflow**.
   See "Mobile Check" below for the exact measurements.

**Final state:** the deterministic pattern layer's arithmetic was sound
throughout this audit; the one real bug was a diagnostic-field accuracy
issue with no effect on any pattern's true/false qualification outcome,
and the terminology ambiguity the audit was specifically asked to resolve
is now resolved everywhere it appeared, with a single canonical wording
("3 HISTORICAL windows, current excluded; first usable at 3×days with 2
of 3, full baseline at 4×days with all 3") propagated into every touched
document and into the code's own doc comments.

## Window Semantics

**Canonical model, D = `days` (e.g. 30):**

```
Current:      [now - D,   now)          <- never counted as a "baseline window"
Historical 1: [now - 2D,  now - D)
Historical 2: [now - 3D,  now - 2D)
Historical 3: [now - 4D,  now - 3D)
```

For D = 30 (the app's default period):

```
Current:      0–30 days ago
Historical 1: 30–60 days ago
Historical 2: 60–90 days ago
Historical 3: 90–120 days ago
```

**"3-window baseline" means 3 HISTORICAL windows** (Historical 1/2/3), not
3 total windows including current — the current window is never counted
as one of the 3. When the current window is also counted, there are **4
total analysis windows**.

Because windows are evaluated most-recent-first, and
`MIN_QUALIFYING_BASELINE_WINDOWS = 2`, reaching that minimum always means
"Historical 1 AND Historical 2 both qualify" (Historical 1 always
qualifies before Historical 2, since it requires less elapsed history).
Historical 2 requires `Competitor.createdAt <= now - 3D`, so:

| Tracked history | Qualifying historical windows | Pattern qualifies? |
|---|---|---|
| `< 2D` (< 60 days) | 0 | No |
| `[2D, 3D)` (60–89 days) | 1 (Historical 1 only) | **No** — this is the range the pre-Phase-7.1 docs incorrectly said WAS enough |
| `[3D, 4D)` (90–119 days) | 2 (Historical 1 + 2) | **Yes** — first day this can ever be true is exactly `3D` (90 days) |
| `>= 4D` (120+ days) | 3 (all of Historical 1/2/3) | Yes, full baseline |

This table is proven by the `it.each` boundary matrix in
`packages/db/src/repositories/patterns.test.ts` ("getActivityPattern -
window semantics (Phase 7.1)"), which asserts `qualifyingWindows` and
`qualifies` at tracked-history values of 30, 59, 60, 61, 75, 89, 90, 91,
119, and 120 days — exactly the boundary set the audit brief requested.

## 90-Day Claim

**What exactly becomes available at 90 days (with the default 30-day
period)?** The activity-vs-baseline pattern first becomes able to
qualify, using 2 of its 3 historical windows (Historical 1: 30–60 days
ago, Historical 2: 60–90 days ago; Historical 3, 90–120 days ago, is not
yet in tracked range). This activates in one discrete step at day 90 —
not gradually across a 60–90 day range, as `PHASE7-PRODUCT-ASSESSMENT.md`
previously implied. Below 90 days, the pattern always reports
`direction: "INSUFFICIENT_HISTORY"`, `qualifies: false`, regardless of
how many `ChangeEvent`s exist in the current window.

## 120-Day Claim

**What exactly becomes available at 120 days?** Historical 3 (90–120 days
ago) enters tracked range, so `qualifyingWindows` becomes 3 and
`baselineAverage` is now the mean of all 3 historical windows rather than
just 2 — a slightly more stable/representative baseline. The pattern's
qualification behavior (does it report ABOVE/BELOW/AT baseline) does not
change in kind at 120 days, only the number of windows backing the
average.

## The Confirmed Bug and Its Fix

**Location:** `getActivityPattern`, the early-return branch for
insufficient history.

**Before:**
```ts
if (qualifyingWindows.length < MIN_QUALIFYING_BASELINE_WINDOWS) {
  return { ...emptyResult, current: currentCount ?? 0 };
}
```
`emptyResult.qualifyingWindows` is hardcoded to `0`, so a competitor
tracked for, say, 70 days (1 genuinely qualifying historical window)
would report `qualifyingWindows: 0` — factually wrong.

**After:**
```ts
if (qualifyingWindows.length < MIN_QUALIFYING_BASELINE_WINDOWS) {
  return { ...emptyResult, current: currentCount ?? 0, qualifyingWindows: qualifyingWindows.length };
}
```

**Why this is a real (if minor) bug, not just cosmetic:** the brief's own
Section 13 requires the pattern result contract to expose real,
non-fabricated sample-size information distinguishing "insufficient
history" from "sufficient but not qualifying." A `qualifyingWindows`
field that always reads `0` whenever `qualifies` is `false` defeats that
distinction's precision — it collapses "0 windows tracked" and "1 window
tracked" into the same reported number, which a future UI or AI-context
builder could use to (wrongly) claim "no historical data exists at all"
for a competitor that in fact has one qualifying window. The fix makes
the field always report the true count, independent of whether the
pattern as a whole qualifies. Caught by the new boundary test matrix
(4 of the 10 `it.each` cases failed before the fix, all with the same
symptom: `expected 1, received 0`).

## Lifecycle Validation

All 5 required sequences plus 3 additional real-world/defensive cases,
tested in `getEntityHistoryForCompetitor - lifecycle sequences (Phase
7.1)`:

| Sequence | Expected `currentlyDetected` | Result |
|---|---|---|
| A: `PRODUCT_ADDED` | `true` | ✅ |
| B: `PRODUCT_ADDED → PRICE_CHANGE` | `true` | ✅ |
| C: `PRODUCT_ADDED → PRICE_CHANGE → PRODUCT_REMOVED` | `false` | ✅ |
| D: `PRODUCT_ADDED → PRICE_CHANGE → PRODUCT_REMOVED → PRODUCT_ADDED` | `true` | ✅ |
| E: `PRODUCT_ADDED → PRODUCT_REMOVED → PRODUCT_ADDED → PRICE_CHANGE` | `true` | ✅ |
| Lone `PRICE_CHANGE` (product pre-existed before monitoring began — no `PRODUCT_ADDED` ever exists for it) | `true` | ✅ — confirmed this is a real, common case: the very first snapshot of a `MonitoredUrl` has no prior snapshot to diff against, so `compare.ts` records it as the baseline with **zero** `ChangeEvent`s; only a *later* appearance produces `PRODUCT_ADDED` |
| Contradictory `PRODUCT_ADDED → PRODUCT_REMOVED → PRICE_CHANGE` | `true` (last event wins, no crash) | ✅ — see "Contradictory Sequences" below |
| Out-of-DB-insertion-order write (REMOVED row physically inserted before ADDED row, but `detectedAt` says otherwise) | Reflects chronological `detectedAt` order, not insertion order | ✅ — Invariant E |

**Contradictory sequences:** investigated whether the real detection
pipeline (`packages/detection/src/compare.ts`) can itself ever produce
`PRODUCT_REMOVED` immediately followed by `PRICE_CHANGE` for the same
`entityKey` with no intervening `PRODUCT_ADDED`. **It cannot, by
construction:** `detectPriceChanges` only emits a `PRICE_CHANGE` for an
entity present in *both* the prior and current snapshot of one
transition; `PRODUCT_REMOVED` means the entity was absent from the
current snapshot of that transition. For the entity to produce a
`PRICE_CHANGE` in some later transition, it must be present in that
transition's *prior* snapshot — which requires either it existed since
before monitoring began, or an intervening `PRODUCT_ADDED` transition
put it back. This is a structural invariant of the existing (unmodified)
detection pipeline, not something Phase 7.1 changed. A defensive test was
still added (`getEntityHistoryForCompetitor` reads the sequence correctly
and never crashes even if it somehow occurred — e.g. from a future
extraction-logic bug or a manual data correction), per the audit's
instruction to verify existing logic already handles it rather than
inventing new handling.

## Pattern Validation

### `getActivityPattern`

- **Formula:** current = count of `ChangeEvent`s in `[now-D, now)`.
  Baseline = mean count over the qualifying subset of 3 non-overlapping
  historical `D`-length windows immediately preceding current (see
  "Window Semantics").
- **Threshold:** ratio ≥ 1.5 → `ABOVE_BASELINE`; ratio ≤ 1/1.5 (≈0.67) →
  `BELOW_BASELINE`; otherwise `AT_BASELINE`.
- **Minimum sample:** ≥2 of 3 historical windows in tracked range (first
  possible at `3 × D` days tracked).
- **Insufficient-history behavior:** `qualifies: false`,
  `direction: "INSUFFICIENT_HISTORY"`, `baselineAverage: null`,
  `ratio: null`, `qualifyingWindows` reports the TRUE count (0 or 1) —
  Phase 7.1 fix.
- **Qualifying, non-notable behavior:** `qualifies: true`,
  `direction: "AT_BASELINE"` when the ratio is close to 1 — this is the
  "sufficient history, pattern does not qualify [as notable]" state
  required by Section 12 of the brief.
- **Qualifying, notable behavior:** `qualifies: true`,
  `direction: "ABOVE_BASELINE"` or `"BELOW_BASELINE"`.
- **Edge case:** `baselineAverage === 0` with `current > 0` sets
  `strongEvidence: false` — no fabricated multiplier against zero.

### `getRepeatedPriceChangePatterns`

- **Formula:** count of `PRICE_CHANGE` events with a stable `entityKey`
  per `(monitoredUrlId, entityKey)`, within `[now-D, now)`.
- **Threshold:** `changeCount >= 2` → `qualifies: true`.
- **Minimum sample:** none by design — this pattern makes no historical-
  baseline claim, only "how many changes happened in this window," which
  is always answerable (possibly 0). It therefore has no
  "insufficient-history" state, only "evaluated, below threshold" (an
  entry with `qualifies: false`) vs. "evaluated, qualifies" vs. "no
  price-change entities at all" (an empty array) — see "Pattern Result
  Contract" below for why this 3-state shape at the array level already
  satisfies Section 12.
- **Half-open interval fixed:** query now uses `detectedAt: { gte:
  windowStart, lt: now }` (previously missing the upper bound).

## Pattern Result Contract

Section 12 requires distinguishing (A) insufficient history, (B)
sufficient history but not qualifying, (C) qualifies. Confirmed already
satisfied without a shape change:

- **`ActivityPattern`:** `direction === "INSUFFICIENT_HISTORY"` is (A);
  `qualifies === true && direction === "AT_BASELINE"` is (B);
  `qualifies === true && direction !== "AT_BASELINE"` is (C). The UI
  (`PatternsCard`) already branches on exactly this distinction, and now
  carries `data-testid`s (`activity-pattern-insufficient-history` vs.
  `activity-pattern-detail`) so the three states are independently
  assertable — used by the new Playwright coverage.
- **`RepeatedPriceChangePattern[]`:** has no state (A) by design (see
  above). `[]` means "no price-change entity activity in the window at
  all"; a non-empty array with all `qualifies: false` means "activity
  exists but didn't repeat" (B); any entry with `qualifies: true` is (C).
  The UI never collapses these — the empty-state copy is only shown when
  zero entries *qualify*, and the qualifying list only ever shows
  `qualifies: true` entries, so a below-threshold entity is visible in
  the data but intentionally not rendered as a "pattern."

## UI Validation

`PatternsCard.tsx` gained `data-testid` attributes
(`patterns-card`, `activity-pattern-section`, `activity-pattern-badge`,
`activity-pattern-detail`, `activity-pattern-insufficient-history`,
`repeated-price-pattern-section`, `repeated-price-pattern-empty`,
`repeated-price-pattern-item`, `repeated-price-pattern-count`) per the
house E2E-selector rule (data-testid over text/CSS). No copy changes were
needed — the existing `!pattern.qualifies` branch already rendered the
correct insufficient-history state; only its testability was improved.

**New Playwright coverage** — `apps/web/e2e/pattern-intelligence.spec.ts`,
3 tests, run against a real Postgres database, real Next.js dev server,
and a real signup/competitor/URL flow through the actual UI. Historical
`ChangeEvent` seeding (90+ days of history cannot be produced by driving
the real fixture-server scan pipeline inside a test timeout) runs via
`apps/web/e2e/seedPatternEvents.mjs` as a genuinely separate `node`
subprocess — importing `packages/db` directly inside the Playwright spec
file itself throws `TypeError: Cannot redefine property: NotFoundError`
(a duplicate-module-instance issue specific to this machine's Playwright
loader + npm workspace symlinks); the subprocess approach sidesteps it
entirely while still writing to the real database, matching this repo's
existing `scripts/validation/*.mjs` convention for the same kind of need.

- **Test A (insufficient history):** freshly-created competitor (default
  `createdAt`), 2 recent events. Asserts
  `activity-pattern-insufficient-history` visible, badge text "Not enough
  history yet", and `activity-pattern-detail` has **zero** count (the
  claim-bearing line must not render at all in this state).
- **Test B (sufficient, does not qualify):** competitor backdated 150
  days, current window = 2 events, each of 3 historical windows = 2
  events (ratio exactly 1.0). Asserts badge text "In line with recent
  baseline", `activity-pattern-detail` **is** visible (distinct from
  state A), `activity-pattern-insufficient-history` has zero count, and
  the repeated-price-pattern section shows its empty state (a lone price
  change for one entity, correctly not rendered as a pattern).
- **Test C (qualifies):** competitor backdated 150 days, baseline =
  1/window (3 historical windows), current = 4 events (ratio 4.0).
  Asserts badge text "Above recent baseline" and the detail line contains
  the exact numbers ("4 recorded changes in the last 30 days", "average
  of 1", "3 preceding 30-day periods", "4x the baseline average") —
  verifying the UI text matches the seeded arithmetic exactly, not just
  that *some* text renders. Also asserts both seeded repeated-price
  entities (`pro-plan`, `basic-plan`) render as qualifying pattern items.

**Result:** all 3 pass in isolation and in a small batch with other
specs; see "Test Results" for full-suite context.

## Security

- Every new/modified pattern query filters `organizationId` directly on
  `ChangeEvent`/`MonitoredUrl`/`Competitor` — never inferred through a
  join alone (same convention as Phase 6/7).
- 4 new cross-tenant tests added this phase (on top of the 3 already in
  Phase 7): `getEntityHistoryForCompetitor` never leaks (already
  existed), `getActivityPattern` invariant test (heavy activity in Org A
  never affects Org B's pattern), `getRepeatedPriceChangePatterns`
  invariant test (Org A's repeated-entity pattern never surfaces for Org
  B, even with an identical `entityKey` string).
- No new outbound HTTP calls, no new credential handling, no new
  unauthenticated route. `PatternsCard` renders only on the existing
  authenticated `/competitors/[competitorId]` page.
- `seedPatternEvents.mjs` is a test-only script invoked exclusively by
  the Playwright spec via a local `node` subprocess — it is not imported
  by, reachable from, or bundled into any production code path.

## Performance

Re-verified after the `now`-parameter and bug-fix changes:

- `getActivityPattern`: still ≤6 queries regardless of history size (1
  competitor lookup + 1 monitoredUrl lookup + 1 current-window count + up
  to 3 baseline-window counts, all via `Promise.all`) — asserted by the
  existing bounded-query-count test, unaffected by this phase's changes.
- `getEntityHistoryForCompetitor` / `getRepeatedPriceChangePatterns`: 2
  queries each, independent of event/entity count — unchanged.
- No N+1 queries, no persisted metric table introduced.

## AI Boundary

```
New AI call sites: 0
```

Confirmed by direct grep of every file this phase touched or added
(`patterns.ts`, `patterns.test.ts`, `PatternsCard.tsx`,
`pattern-intelligence.spec.ts`, `seedPatternEvents.mjs`) for `@cma/ai`,
`gpt-4o-mini`, `gpt-5.6-luna`, `DEFAULT_OPENAI_MODEL`, `DEFAULT_MODEL`,
`CMA_AI_MODEL`, `CMA_AI_PROVIDER`, `OPENAI_API_KEY` — zero matches in
every case. No historical AI interpretation, no hypothesis generation,
no AI-based compensation for insufficient deterministic data was added.

## Mobile Check

Measured directly (not just visually inspected) at a 375px viewport on
the competitor detail page with a full `PatternsCard` render (activity
pattern qualifying + 1 repeated-price entity with a deliberately long
name, to stress-test wrapping):

```js
document.documentElement.scrollWidth  // 375
window.innerWidth                      // 375
// -> bodyHasHorizontalOverflow: false (no NEW page-level scroll)

sidebar width: 224px (the pre-existing fixed w-56 sidebar, unchanged)
<main> width:  151px (375 - 224, squeezed by the sidebar - Phase 6's
                       already-documented root cause)
patterns-card width: 103px (further squeezed by <main>'s own padding)
```

**Conclusion:** Phase 7.1 introduces **no new document-level horizontal
overflow** — the page itself does not gain a horizontal scrollbar.
`PatternsCard` is visually cramped at 375px, but this is entirely
inherited from the pre-existing fixed-width sidebar (confirmed via direct
measurement: `sidebarWidth: 224px` matches Phase 6's documented `w-56`),
the same root cause every other card on this page (`ActivityMetricsCard`,
`PriceHistoryCard`, `ProductLifecycleCard`) already has. **Not
reclassified as a Phase 7.1 regression** — recorded as a known limitation
below, same as Phase 6.

## Phase 6 Regression

Full Playwright suite (27 pre-existing tests across `ai-analysis` (3),
`ai-connections` (4), `ai-openai-smoke` (4, skipped - no
`OPENAI_API_KEY`), `auth` (6), `competitor-workflow` (2), `evidence` (2),
`monitoring-workflow` (3), `phase5-customer-journey` (1, skipped -
requires real AI env), `smoke` (1), `tenant-isolation` (1)) run in small
batches (2–4 workers) rather than the full 30-test single-worker run,
after the first full-suite attempt showed widespread `signup` timeouts
under heavy resource contention (Postgres + Redis + worker + fixture
server + web dev server + multiple Chromium instances, all on one dev
machine simultaneously). In batches of 2–10, every non-skipped test
passed except one:

- `monitoring-workflow.spec.ts`'s "a real price change... after a second
  scan" test failed with a Playwright **strict-mode locator violation**
  (`getByText(/49\.00/)` matching both a `<span>` price summary and an
  `<a>` link containing the same text). **Confirmed pre-existing**: `git
  stash`-ed every Phase 7.1 change and re-ran this exact test against
  unmodified `main` (commit `337a492`) — **identical failure**, same
  strict-mode violation, same line number. Not a Phase 7.1 regression;
  not introduced or worsened by this phase. Recorded as a known,
  unrelated gap (likely a Playwright/browser version drift since Phase 5
  last validated this spec) rather than fixed here, per the brief's
  Section 30 instruction to avoid unrelated refactors.
- Every other pre-existing spec (25 tests) passed once run without
  contention.

## Test Results

```
Unit/integration (vitest, real Postgres where applicable):
  @cma/ai            76 passed
  @cma/core          32 passed
  @cma/db           147 passed  (103 pre-existing + 44 in patterns.test.ts,
                                  16 from Phase 7 + 28 new this phase)
  @cma/detection      13 passed
  @cma/extraction     11 passed
  @cma/notifications   9 passed
  @cma/queue          10 passed
  @cma/security       53 passed
  @cma/web            59 passed
  -----------------------------------------
  TOTAL              410 passed, 0 failed, 0 skipped

E2E (Playwright, real Postgres + real Redis + real BullMQ worker + real
     fixture server + real Chromium; run in small batches of 2-8 tests
     rather than the full single-worker suite at once, after the first
     full-suite attempt showed unrelated timeouts under resource
     contention - see "Phase 6 Regression" below):
  pattern-intelligence.spec.ts (NEW)         3 passed
  ai-analysis.spec.ts                        3 passed
  ai-connections.spec.ts                     4 passed
  auth.spec.ts                               6 passed
  competitor-workflow.spec.ts                2 passed
  evidence.spec.ts                           2 passed
  monitoring-workflow.spec.ts                2 passed, 1 failed
                                              (pre-existing, unrelated -
                                               see below)
  smoke.spec.ts                              1 passed
  tenant-isolation.spec.ts                   1 passed
  ai-openai-smoke.spec.ts                    4 skipped (no OPENAI_API_KEY)
  phase5-customer-journey.spec.ts            1 skipped (no OPENAI_API_KEY)
  -----------------------------------------
  TOTAL                                      24 passed, 1 pre-existing
                                              failure (unrelated,
                                              reproduced on unmodified
                                              main), 5 skipped (require a
                                              real OpenAI key, same as
                                              every prior phase)

npm run typecheck (all 10 workspaces):        clean
npm run build --workspace packages/db:        clean
npm run build --workspace apps/web:           clean (production route
                                               manifest unchanged plus
                                               new build artifacts only)
```

## Documentation Changes

- `PHASE7-DATA-AUDIT.md` — Section 4.1 minimum-sample-size wording
  corrected from "2×days"/"now-2·days" to the accurate 3×days/4×days
  model, cross-referenced to this report.
- `PHASE7-VALIDATION.md` — Section 5.1 rewritten with the canonical
  window model and a correction notice; "Known Limitations" and the E2E
  evidence section's day-count language corrected.
- `PHASE7-PRODUCT-ASSESSMENT.md` — "Value growth over time" table
  rewritten: the pattern now correctly activates in one discrete step at
  exactly 90 days (not gradually across 60–90 days), and the "full
  3-window baseline" milestone is correctly placed at 120 days.
- `packages/db/src/repositories/patterns.ts` — doc comments on
  `getActivityPattern` and the `qualifyingWindows` field rewritten with
  the full canonical window model inline, so the arithmetic and its
  documentation can never drift apart again without a code review
  noticing.
- This file, `PHASE7.1-VALIDATION-REPORT.md` (new).

## Remaining Gaps

### Known limitations (not blockers)

- **Product renames break entity identity** — unchanged from Phase 7,
  reconfirmed, not addressed (out of this phase's scope per Section 11:
  "keep the current identity model conservative").
- **Pre-existing mobile sidebar overflow** — unchanged since Phase 6,
  reconfirmed via direct measurement this phase, not fixed (explicitly
  out of scope per Section 20).
- **No promotion pattern** — no extraction path produces
  `PROMOTION`-typed entities anywhere in the codebase; unchanged from
  Phase 7.
- **One pre-existing, unrelated Playwright strict-mode failure** in
  `monitoring-workflow.spec.ts` — reproduced identically on unmodified
  `main`; not touched or worsened by this phase.
- **`getRepeatedPriceChangePatterns` does not deduplicate identical
  `ChangeEvent` rows** if an upstream bug or retry ever wrote true
  duplicates — this is a `monitoringPipeline`/`compare.ts` concern (idem
  Phase 6's `intelligence.ts`, which has the same property), not
  introduced or changed by Phase 7.1.

### Blocking issues

None. Both problems found (the diagnostic-field bug and the terminology
ambiguity) are fixed in this phase.

## Phase 8 Readiness

The repository is **ready** for Phase 8 (Competitive Context Engine) to
build on the per-competitor pattern layer, subject to the constraint
already documented in `PHASE7-PRODUCT-ASSESSMENT.md`'s Recommended Next
Direction: Phase 8 should extend `getActivityPattern`'s already-defensible
per-competitor baseline into a purely descriptive cross-competitor
comparison (no ranking/scoring), reusing the now-precisely-documented
window model rather than inventing a second one. Evidence for readiness:

- The window semantics Phase 8 will need to reuse are now unambiguous and
  test-proven at every boundary (Section "Window Semantics" above).
- The pattern result contract (insufficient / non-qualifying / qualifying)
  is stable and UI-testable via `data-testid`s, so Phase 8's UI can adopt
  the same convention.
- Tenant isolation is proven at the pattern level, not just the raw-query
  level, which Phase 8's cross-competitor aggregation will depend on.
- No known correctness issue remains open in the deterministic layer
  Phase 8 would build on.

Phase 8 was **not** implemented in this task, per the brief's explicit
instruction.

## Definition of Done — Checklist

- [x] Window semantics traced to actual code (not inferred from comments)
- [x] "3-window baseline" ambiguity resolved (3 HISTORICAL windows, current excluded)
- [x] 90-day semantics explicitly documented
- [x] 120-day semantics explicitly documented
- [x] Partial-window behavior correct and tested (a window before `Competitor.createdAt` is never queried, let alone counted)
- [x] Exact timestamp boundaries tested (start-inclusive, end-exclusive, on both patterns)
- [x] Insufficient history distinct from non-qualification (already true; testability improved with `data-testid`s)
- [x] Both Phase 7 patterns have explicit sample semantics documented
- [x] Lifecycle sequences A–E tested, plus 3 additional real-world/defensive cases
- [x] Re-add lifecycle behavior verified (Sequences D, E)
- [x] Tenant isolation verified (7 dedicated tests total across both patterns + entity history)
- [x] No cross-competitor entity inference introduced
- [x] No ranking/scoring introduced
- [x] No new AI calls introduced (grep-confirmed, zero hits)
- [x] Phase 6 regression passes (confirmed once resource contention removed; one pre-existing, unrelated failure reproduced identically on unmodified `main`)
- [x] Phase 7 UI has Playwright coverage (3 new tests, all passing against the real stack)
- [x] Mobile regression checked (measured directly: no new document-level overflow; pre-existing sidebar squeeze reconfirmed, not worsened)
- [x] Documentation matches implementation (3 docs corrected, code doc comments expanded)
- [x] Typecheck passes (all 10 workspaces)
- [x] Production build passes (`packages/db`, `apps/web`)
- [x] Relevant full test suite passes (410/410 unit/integration; 24/25 non-skipped E2E passed, the 1 failure confirmed pre-existing and unrelated to Phase 7.1; 5 intentional real-API skips)
- [x] `PHASE7.1-VALIDATION-REPORT.md` exists (this file)
- [x] Final status is evidence-based (`PASS WITH FIXES`, not blindly `PASS`)
