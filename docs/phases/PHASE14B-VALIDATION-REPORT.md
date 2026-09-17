# Phase 14B — Sustained Historical Activity Trend — Validation Report

**Type:** Implementation phase.
**Status:** PASS
**Historical phases re-audited:** NO

---

## 1. Implementation Summary

Implemented `getSustainedActivityTrend(organizationId, competitorId, days, now)` in
`packages/db/src/repositories/patterns.ts`, exactly as specified by
`docs/phases/PHASE14A-HISTORICAL-INTELLIGENCE-DESIGN-AUDIT.md` Section 6.1 / "Phase 14B
Specification". The function composes the existing, **unmodified** `getActivityPattern` at the
current window (offset 0) and up to `MAX_SUSTAINED_LOOKBACK = 2` immediately-preceding "current
windows" (offset `-D`, `-2D`), and reports how many consecutive windows share the same
non-neutral qualifying direction as the current one.

Added one competitor-detail-page-only UI surface, `SustainedTrendCard`, rendered immediately
below the existing `PatternsCard` on `apps/web/src/app/(app)/competitors/[competitorId]/page.tsx`.

No other production file was touched.

---

## 2. Repository Implementation

`packages/db/src/repositories/patterns.ts`:

```ts
const MAX_SUSTAINED_LOOKBACK = 2; // number of PRIOR offsets checked, in addition to offset 0
const MIN_SUSTAINED_WINDOWS = 2;  // consecutiveQualifyingWindows threshold for `sustained: true`

export interface SustainedActivityTrend {
  competitorId: string;
  days: number;
  current: ActivityPattern;
  lookback: ActivityPattern[];
  consecutiveQualifyingWindows: number;
  sustained: boolean;
  sustainedDataAvailable: boolean;
}

export async function getSustainedActivityTrend(
  organizationId: string,
  competitorId: string,
  days: number,
  now: Date = new Date(),
): Promise<SustainedActivityTrend>
```

Algorithm (verbatim from the PHASE14A pseudocode, including the exact placement of the
`AT_BASELINE` check **inside** the loop body — see Section 6 below for why this placement
matters):

1. If `current.qualifies` is `false` (computed via `getActivityPattern(org, competitor, days,
   now)`, called verbatim), return immediately: `consecutiveQualifyingWindows: 0, sustained:
   false, sustainedDataAvailable: false`.
2. Otherwise `streak = 1` (offset 0 itself is the first window in the streak). For `i = 1 ..
   MAX_SUSTAINED_LOOKBACK`, compute `prior = getActivityPattern(org, competitor, days, now -
   i*days)`, push it onto `lookback`, then:
   - if `!prior.qualifies` → stop, `sustainedDataAvailable: false` (not enough tracked history to
     look this far back yet — distinct from a reversal).
   - if `prior.direction !== current.direction` **or** `current.direction === "AT_BASELINE"` →
     stop, `sustainedDataAvailable: true` (a genuine reversal, or offset-0 itself was only
     neutral — either way, real history was consulted and it did not extend the streak).
   - otherwise `streak += 1` and continue.
3. If the loop completes all `MAX_SUSTAINED_LOOKBACK` iterations without stopping,
   `sustainedDataAvailable: true`.
4. `sustained = streak >= MIN_SUSTAINED_WINDOWS` in every branch.

The function issues **zero** direct `ChangeEvent`/`Competitor`/`MonitoredUrl` queries of its
own — every query happens inside the reused `getActivityPattern` calls, so it inherits that
function's tenant isolation, window semantics, and `INSUFFICIENT_HISTORY` handling for free, with
zero risk of diverging from its already-hardened behavior. `getActivityPattern`,
`getRepeatedPriceChangePatterns`, `getDigestForOrganization`, `digestTypes.ts`, and
`buildDigestContext.ts` were **not modified**.

---

## 3. Window Model (D=30 example)

```
now                                  <- Current, offset 0 (getActivityPattern's own window)
now - 30d   = offset -D              <- getActivityPattern's own "current" is [now-60d, now-30d)
now - 60d   = offset -2D             <- getActivityPattern's own "current" is [now-90d, now-60d)
```

Each offset computes its **own independent** 3-historical-window baseline relative to its own
`now` value (never mixing the current window into any offset's own baseline) — this falls out of
`getActivityPattern` being called verbatim at a different `now` each time, with no shared state
between calls.

---

## 4. Qualification Model

- `MIN_SUSTAINED_WINDOWS = 2`, `MAX_SUSTAINED_LOOKBACK = 2`.
- `AT_BASELINE` is never a sustained direction — the loop breaks on the first iteration whenever
  `current.direction === "AT_BASELINE"`, provided the first prior offset itself qualifies
  (`sustainedDataAvailable: true` in that case — the “not enough history” signal is reserved
  strictly for cases where a needed offset lacks tracked history, never for a neutral direction).
- A reversal (prior direction differs from current direction) breaks the streak immediately — no
  averaging, no smoothing, no majority vote across the lookback window.
- A reversal at the **third** window (offset `-2D`) does **not** retroactively invalidate an
  already-established 2-window streak — the function returns the streak value as of the point it
  stopped, not zero.

---

## 5. Time-to-Value

- **120 tracked days (D=30):** first day a 2-consecutive-window sustained claim
  (`consecutiveQualifyingWindows: 2`) becomes possible — one tier deeper than
  `getActivityPattern`'s own 90-day floor, because a 2-window sustained check additionally
  requires the offset `-D` call to itself have 90 days of tracked history relative to *its own*
  `now` (`now - D - 90 = now - 120` at D=30).
- **150 tracked days (D=30):** first day a 3-consecutive-window sustained claim becomes possible.
- Verified exactly by the boundary matrix at 119/120/121/149/150/151 tracked days (Section 7).

---

## 6. Tests

### 6.1 Unit / integration (`packages/db/src/repositories/patterns.test.ts`)

16 new tests added under `describe("getSustainedActivityTrend (Phase 14B)")`, nested inside the
existing `describe("patterns repository (Phase 7)")` suite (real Postgres, skip-if-unreachable
convention, same as every other test in this file):

| Test | What it proves |
|---|---|
| Case 1: offset-0 does not qualify | `consecutiveQualifyingWindows: 0`, `sustained: false`, `sustainedDataAvailable: false`, `lookback === [current]` |
| Case 7: current `AT_BASELINE` | Never counts as sustained even when the next offset has enough history (`streak: 1`, `sustainedDataAvailable: true` — the AT_BASELINE-inside-the-loop placement, not a pre-loop short-circuit) |
| Case 5: reversal ABOVE→BELOW | `streak: 1`, `sustained: false`, `sustainedDataAvailable: true` |
| Case 6: reversal BELOW→ABOVE | Same, direction-symmetric |
| Case 8: 2-window streak, reversal at the 3rd window | `streak: 2`, `sustained: true` (already-established streak survives the later reversal), `lookback.length: 3` |
| Tenant isolation | Organization B's call never surfaces Organization A's activity |
| Query-count bound (single call) | `<= 18` Prisma calls |
| Query-count bound (volume-independent) | Identical query count before/after adding 40 out-of-horizon `ChangeEvent`s, `before === 18` (full 3-offset evaluation) |
| Window-boundary matrix (`it.each`, 6 cases) | Exact day-count floors: 119→(streak 1, not sustained, data unavailable), 120/121/149→(streak 2, sustained, data unavailable — 3rd offset lacks history), 150/151→(streak 3, sustained, data available) |

**Result:** `58/58` passed in `patterns.test.ts` (16 new + 42 pre-existing, all still green — no
regression). Full `packages/db` suite: `195/195` passed across all 12 test files.

### 6.2 Frontend unit (`apps/web`)

No new frontend unit tests were needed (`SustainedTrendCard` is a pure server-rendered
presentational component reusing the same `data-testid` convention as `PatternsCard`; covered by
E2E below). Full `apps/web` vitest suite: `68/68` passed, no regression.

### 6.3 E2E (`apps/web/e2e/sustained-trend.spec.ts`)

3 focused Playwright tests, reusing the existing `seedPatternEvents.mjs` script unmodified (same
convention as `pattern-intelligence.spec.ts`):

- **A — sustained:** 160 tracked days, events placed to produce a genuine 3-window ABOVE_BASELINE
  streak → card shows `"Sustained for 3 consecutive tracked periods"` with an `"Above baseline"`
  badge.
- **B — not enough history:** 100 tracked days (current qualifies, next offset does not) → card
  shows `"Not enough history yet"`.
- **C — trend did not hold:** 200 tracked days, current ABOVE_BASELINE, immediately preceding
  offset BELOW_BASELINE → card shows `"Trend did not hold"`.

**Result:** `3/3` passed. Regression check: `pattern-intelligence.spec.ts` (5 tests) and
`competitor-workflow.spec.ts` (2 tests) re-run, `5/5` and `2/2` passed — no regression.

---

## 7. Query-Count Evidence

Measured directly via the existing `countPrismaQueries` test instrumentation
(`packages/db/src/client.ts`):

- Full 3-offset evaluation (current + 2 priors, each a worst-case 6-query `getActivityPattern`
  call): **18 Prisma calls**, matching `6 * (1 + MAX_SUSTAINED_LOOKBACK)`.
- Adding 40 additional `ChangeEvent` rows (placed outside every window the invocation queries)
  produces the **identical** query count (18 → 18) — bounded, independent of event volume,
  matching the invariant required by the design audit and Section 27 of the implementation brief.
- Short-circuiting (offset-0 not qualifying, or an early reversal/AT_BASELINE break) issues
  strictly fewer queries (as low as 12 for a single-offset evaluation) — this is expected,
  data-dependent behavior, not a regression; the upper bound of 18 always holds.

---

## 8. Tenant Isolation

`getSustainedActivityTrend` issues no `ChangeEvent`/`Competitor`/`MonitoredUrl` queries directly —
every query happens through `getActivityPattern`'s already-tested, already-`organizationId`-scoped
`competitor.findFirst`/`monitoredUrl.findMany` calls. A dedicated test confirms calling the
function with Organization B's id against Organization A's competitor returns
`current.qualifies: false`, `current.current: 0`, `sustained: false`,
`sustainedDataAvailable: false` — **PASS**.

---

## 9. Mobile (375×812)

Verified via a real browser session (Chrome DevTools-equivalent, in-app browser pane) against the
running dev server: signed up, created a competitor, added a monitored URL, seeded a genuine
3-window sustained scenario via the seed script, resized the viewport to 375×812, and confirmed:

- `document.documentElement.scrollWidth === document.documentElement.clientWidth === 375` — no
  horizontal overflow.
- The direction badge (`"Above baseline"`) renders fully, not truncated.
- The headline (`"Sustained for 3 consecutive tracked periods"`) wraps naturally across multiple
  lines rather than being clipped.

**Result:** PASS. (The sidebar visually overlapping content at this width is a pre-existing,
project-wide layout characteristic, not something this card introduced or regressed.)

---

## 10. AI

```
AI calls required: 0
```

`packages/db/src/repositories/patterns.ts` imports no `@cma/ai` module (verified via `grep
"@cma/ai" patterns.ts` — no matches). `SustainedTrendCard.tsx` makes no network/AI calls — it is a
pure server-rendered component over the already-computed `SustainedActivityTrend` object. No
prompt, provider, or claim-safety code was touched.

---

## 11. Schema

```
Schema changes: none
```

`git diff -- packages/db/prisma/schema.prisma` is empty. No migration, no new Prisma model, no new
enum.

---

## 12. Digest / Compare / AI-bundle

```
Digest changes: none
Compare changes: none
AI-bundle changes: none
```

`getDigestForOrganization`, `digestTypes.ts`, `buildDigestContext.ts`, `/digest`, and `/compare`
were not touched — verified via `git diff --stat` against those paths (empty). No new
`DigestItemKind` was added. The signal is intentionally validated first on the competitor detail
page only, per Section 11 (Option 3) of the design audit.

---

## 13. Known Findings

None. No pre-existing bug was encountered in `getActivityPattern`, `getRepeatedPriceChangePatterns`,
or their tests during this phase.

---

## 14. Historical Phases Re-Audited

```
NO
```

`getActivityPattern`'s exact current behavior (window model, qualification floor, zero-baseline
special case, `AT_BASELINE` semantics) was read to compose correctly on top of it — not
re-designed, not modified, not second-guessed. No contradiction with any prior phase's approved
decision was found or needed investigating.

---

## Final Output

```
PHASE 14B — SUSTAINED HISTORICAL ACTIVITY TREND

Status:
PASS

Implementation:
Added getSustainedActivityTrend(organizationId, competitorId, days, now) to
packages/db/src/repositories/patterns.ts, composing the existing, unmodified
getActivityPattern at up to 3 offsets (current + 2 priors). Added SustainedTrendCard,
rendered on the competitor detail page only, immediately below PatternsCard.

New repository function:
getSustainedActivityTrend()

Lookback:
MAX_SUSTAINED_LOOKBACK = 2

Minimum sustained streak:
MIN_SUSTAINED_WINDOWS = 2

D=30 first possible sustained signal:
120 tracked days

UI:
Competitor detail page only

Digest changes:
NONE

AI calls:
0

Schema changes:
NONE

New extraction:
NONE

Tenant isolation:
PASS (dedicated test - Organization B's call never surfaces Organization A's activity)

Query bound:
PASS - <=18 Prisma calls per invocation (6 * (1 + MAX_SUSTAINED_LOOKBACK)), measured directly;
identical query count before/after a 40-event volume increase (out-of-horizon events)

Unit/integration:
58/58 passed in patterns.test.ts (16 new + 42 pre-existing); 195/195 across the full
packages/db suite - no regression

E2E:
3/3 new sustained-trend.spec.ts tests passed; 5/5 pattern-intelligence.spec.ts +
2/2 competitor-workflow.spec.ts re-run with no regression

Typecheck:
PASS across all workspaces (npm run typecheck)

Build:
PASS across all workspaces (npm run build)

Mobile 375x812:
PASS - no horizontal overflow (scrollWidth === clientWidth === 375), badge/headline text
wraps rather than truncating

Regression:
PASS - getActivityPattern, getRepeatedPriceChangePatterns, getDigestForOrganization,
getCompetitiveContext untouched; no pre-existing test broke

Known findings:
None

Historical phases re-audited:
NO

Report:
docs/phases/PHASE14B-VALIDATION-REPORT.md

Next candidate:
Do not automatically implement the deferred entity-level sustained price-change pattern.
First assess the real customer/product value demonstrated by this phase.
```
