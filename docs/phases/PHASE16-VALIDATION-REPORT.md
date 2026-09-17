# Phase 16 — Sustained Trend Digest Integration — Validation Report

**Type:** Implementation phase.
**Status:** PASS
**Historical phases re-audited:** NO

---

## 1. Implementation Summary

Implemented Phase 15's Section 16 recommendation exactly: promoted the already-validated,
**unmodified** `getSustainedActivityTrend` (Phase 14B, `packages/db/src/repositories/patterns.ts`)
from the competitor-detail page into `getDigestForOrganization`'s per-competitor composition as a
new, gated `SUSTAINED_ACTIVITY_TREND` `DigestItemKind`, added a `sustainedCount` field to
`DigestCrossCompetitorContext` (same `.filter().length` shape as the existing `aboveBaselineCount`),
and extended the AI evidence-bundle construction (`packages/ai/src/buildDigestContext.ts` /
`digestTypes.ts`) with one additive `factsForItem` case exposing `consecutiveQualifyingWindows` and
`direction` — no new claim-safety category, no new evidence type, no AI prompt/provider/schema
change. `/digest`'s UI renders the new item reusing `SustainedTrendCard`'s existing neutral
vocabulary ("Sustained for N consecutive tracked periods", "Above/Below baseline").

`getActivityPattern`, `getRepeatedPriceChangePatterns`, and `getSustainedActivityTrend` themselves
were **not touched** — every one of them is called verbatim, exactly as Phase 15 Section 17 and
Phase 14A/14B's own non-goals require.

---

## 2. Digest Changes

**File:** `packages/db/src/repositories/intelligence.ts`

1. **New item kind** — `SUSTAINED_ACTIVITY_TREND` added to `DIGEST_ITEM_KIND_ORDER`, immediately
   after `ACTIVITY_PATTERN` (Phase 14A Section 11 Option 1's original suggestion):
   ```ts
   const DIGEST_ITEM_KIND_ORDER = ["CHANGE_EVENT", "REPEATED_PRICE_CHANGE", "ACTIVITY_PATTERN", "SUSTAINED_ACTIVITY_TREND", "LIFECYCLE"] as const;
   ```
2. **New item shape** — `SustainedActivityTrendDigestItem` carries only two deterministic,
   independently-reconstructible-from-`lookback` fields, never a score:
   ```ts
   export interface SustainedActivityTrendDigestItem extends DigestItemCommon {
     kind: "SUSTAINED_ACTIVITY_TREND";
     consecutiveQualifyingWindows: number;
     direction: "ABOVE_BASELINE" | "BELOW_BASELINE";
   }
   ```
3. **Composition** — `getSustainedActivityTrend(organizationId, competitor.id, days, now)` added as
   a third parallel call in the existing per-competitor `Promise.all`, alongside the already-called
   `getActivityPattern`/`getRepeatedPriceChangePatterns`. No new architecture: the same
   `Promise.all` shape, no sequential per-competitor work added.
4. **Inclusion gate** — `trend.sustained === true` **AND** `events.length > 0` (the current
   window's raw evidence). The second condition mirrors the existing `ACTIVITY_PATTERN` item's own
   dual-condition gate exactly: a sustained `BELOW_BASELINE` streak can legitimately have
   `current.current === 0` (fewer changes than baseline can mean zero), which would otherwise leave
   no `ChangeEvent` to cite as evidence — never an empty `changeEventIds` list (Section 12 of the
   brief; verified by a dedicated test, Section 6 below).
5. **Evidence** — the current window's `changeEventIds` (same set `ACTIVITY_PATTERN` already
   cites) — no new evidence type, no invented historical `ChangeEvent` ids from the lookback.
6. **Cross-competitor context** — `sustainedCount` added to `DigestCrossCompetitorContext`,
   computed identically to `aboveBaselineCount`:
   ```ts
   const sustainedCount = perCompetitorResults.filter((r) => r.sustainedActivityTrend.sustained).length;
   ```
   This is **context**, not a ranking, a score, or its own digest item — matches Section 7 of the
   implementation brief exactly (no "5 competitors are sustained" digest item was created; the
   existing model of per-competitor items + org-level cross-competitor context was followed as-is).
7. **No composition beyond the single new item** — Composition B (sustained + repeated-price
   conjunction sentence) and Composition C (lifecycle + sustained co-occurrence) were **not**
   implemented, per Section 8/17 of the brief; each qualifying signal remains its own standalone,
   independently-gated digest item.

---

## 3. AI Evidence Changes

**Files:** `packages/ai/src/digestTypes.ts`, `packages/ai/src/buildDigestContext.ts`

- `DigestItemForInterpretation.kind` union extended with `"SUSTAINED_ACTIVITY_TREND"`.
- Two additive, optional fields added: `consecutiveQualifyingWindows?: number` and
  `direction?: "ABOVE_BASELINE" | "BELOW_BASELINE"` — exactly the two fields Phase 14A Section 12
  pre-specified and Phase 15 Section 16 item 5 confirmed.
- `factsForItem`'s `switch` gained one new case returning
  `{ kind, consecutiveQualifyingWindows, direction }` — plain numbers/enums, never a re-derived or
  free-text value.
- `untrustedTextForItem` was **not** changed — a `SUSTAINED_ACTIVITY_TREND` item has no page-derived
  free text (no product label, no auto-generated description), so it correctly falls through that
  function's `if` chain with an empty `untrustedText` array.
- `buildDigestInterpretationInput`'s per-competitor item-selection logic (`qualifiedPatternItems =
  group.items.filter((i) => i.kind !== "CHANGE_EVENT")`) is generic over `kind` and required **no
  code change** to include the new kind — it was already correctly generic before this phase.
- **Confirmed unchanged:** the AI prompt architecture, provider/model selection, retry logic,
  output schema, and — critically — the seven `validateDigestClaimSafety.ts` claim-safety
  categories. No new category was added or needed; Phase 15 Section 13's conclusion (the existing
  categories already cover this signal's vocabulary risk) was reconfirmed, not re-litigated.

---

## 4. Schema

```
Schema changes: NONE
```

`git diff -- packages/db/prisma/schema.prisma` is empty. No migration, no new Prisma model, no new
enum. The signal remains fully derived from existing `ChangeEvent` rows via the unmodified
`getSustainedActivityTrend`.

---

## 5. Extraction

```
Extraction changes: NONE
```

`packages/extraction` was not touched. No new entity type, no new structured-data producer.

---

## 6. Compare

```
Compare changes: NONE
```

`/compare` and `getCompetitiveContext` were not touched — the sustained signal remains Digest- and
competitor-detail-only, exactly as scoped. `git diff --stat` against
`packages/db/src/repositories/intelligence.ts`'s `getCompetitiveContext`/`compareCompetitors`
functions and `apps/web/src/app/(app)/compare/` shows no changes.

---

## 7. Entity Identity

```
No entity identity changes.
```

`entityKey` derivation (`packages/extraction/src/structuredData.ts`) was not touched. The
entity-level "sustained repeated price-change pattern" (Phase 14A Section 6.2) remains correctly
deferred, per Phase 15 Section 11's re-confirmed decision — not re-litigated in this phase.

---

## 8. Tests

### 8.1 `packages/db` (real Postgres, skip-if-unreachable convention)

Extended `packages/db/src/repositories/intelligence.test.ts`'s existing
`describe("getDigestForOrganization (Phase 10)")` suite with a nested
`describe("SUSTAINED_ACTIVITY_TREND item (Phase 16)")` block — 7 new tests, reusing the exact,
already-empirically-verified fixtures from `sustained-trend.spec.ts` (Scenarios A/B/C) rather than
re-deriving new boundary arithmetic:

| Test | What it proves |
|---|---|
| Inclusion (`sustained === true`) | `direction: "ABOVE_BASELINE"`, `consecutiveQualifyingWindows: 3` |
| Exclusion — reversal | No `SUSTAINED_ACTIVITY_TREND` item; `ACTIVITY_PATTERN` still present |
| Exclusion — insufficient history | No `SUSTAINED_ACTIVITY_TREND` item; `ACTIVITY_PATTERN` still present (never fabricated merely because the current-window pattern qualifies) |
| Evidence non-emptiness | `changeEventIds.length > 0` for a qualifying item |
| Ordering | `ACTIVITY_PATTERN` index `<` `SUSTAINED_ACTIVITY_TREND` index (documented kind tie-break) |
| Cross-competitor context | `sustainedCount` equals the exact count of qualifying competitors, never a ranking |
| Tenant isolation | Organization B's digest never surfaces Organization A's `SUSTAINED_ACTIVITY_TREND` item or contributes to Organization B's `sustainedCount` |

4 pre-existing `crossCompetitorContext` assertions were updated to include `sustainedCount`
(2 with `sustainedCount: 0`, 2 with `sustainedCount: 1` where the existing fixture's baseline/current
spacing incidentally also produces a genuine 3-window sustained streak — documented inline as
incidental, not the focus of those tests).

One pre-existing query-count bound was raised (Phase 12's `smallQueryCount <= 20` → `<= 26`,
measured directly at 23) after adding the third per-competitor `getSustainedActivityTrend` call —
see Section 11 below for the full accounting; the load-bearing invariant those tests assert
(`O(competitors)`, never `O(events)`) is unaffected and still passes.

**Result:** `202/202` passed across the full `packages/db` suite (195 pre-existing + 7 new) — no
regression. `patterns.test.ts` (58/58, unchanged) confirms `getSustainedActivityTrend` itself was
not modified.

### 8.2 `packages/ai` (unit, no network/DB)

Extended `packages/ai/src/digestInterpretation.test.ts`'s `describe("buildDigestInterpretationInput")`
block with 4 new tests:

- A `SUSTAINED_ACTIVITY_TREND` item's `facts` carry `consecutiveQualifyingWindows`/`direction`
  verbatim, never re-derived.
- It is treated as a qualified pattern item (never dropped by the per-competitor raw-`CHANGE_EVENT`
  cap), same as `ACTIVITY_PATTERN`/`REPEATED_PRICE_CHANGE`.
- It never carries an empty `evidenceChangeEventIds` list.
- The existing four item kinds' `facts`/evidence output is byte-for-byte unaffected by the new kind
  being present in the type union.

**Result:** `120/120` passed across the full `packages/ai` suite (116 pre-existing + 4 new) — no
regression. `validateDigestClaimSafety.test.ts` (21/21, unchanged) confirms the seven claim-safety
categories were not touched.

### 8.3 `apps/web` (Vitest unit)

No new unit tests needed — no new pure-logic module was added; the digest page's rendering logic
was covered by the new E2E tests below (Section 8.4), same convention Phase 14B used for
`SustainedTrendCard`.

**Result:** `68/68` passed — unchanged, no regression.

### 8.4 E2E (`apps/web/e2e/digest.spec.ts`, real Postgres + Redis + real browser)

4 new focused Playwright tests added (numbered 8–11, inserted before the pre-existing tenant-isolation
test):

- **8 — sustained trend appears:** the exact Scenario-A fixture from `sustained-trend.spec.ts`
  (160 tracked days) renders the `SUSTAINED_ACTIVITY_TREND` item with `"Above baseline"` and
  `"Sustained for 3 consecutive tracked periods"`, and its evidence link navigates to a real
  `ChangeEvent` page.
- **9 — insufficient history:** the exact Scenario-B fixture (100 tracked days) shows no
  `SUSTAINED_ACTIVITY_TREND` item, while the `ACTIVITY_PATTERN` item is still present — never a
  fabricated "not enough history" digest message (Section 22 of the brief: the item is simply
  absent, matching every other qualification-gated item's convention).
- **10 — reversal:** the exact Scenario-C fixture (200 tracked days) shows no
  `SUSTAINED_ACTIVITY_TREND` item for the same reason.
- **11 — mobile (375×812):** the sustained-true fixture renders the item with no document-level
  horizontal overflow.

**Result:** `11/11` passed in `digest.spec.ts` (7 pre-existing + 4 new). Regression check:
`sustained-trend.spec.ts` (3/3), `pattern-intelligence.spec.ts` (2/2 of the ones exercised),
`competitor-workflow.spec.ts` (2/2), `competitive-context.spec.ts` (6/6), and
`digest-ai-interpretation.spec.ts` (5/5, run against `apps/worker` with `CMA_AI_PROVIDER=fake`,
confirming the AI interpretation pipeline that consumes `getDigestForOrganization`'s output is
unaffected end to end) — all re-run, all passed, no regression.

### 8.5 Typecheck / Build

```
npm run typecheck   -> PASS across every workspace (web, worker, ai, core, db, detection,
                        extraction, notifications, queue, security)
npm run build        -> PASS across every workspace (Next.js build succeeded; only pre-existing,
                        unrelated Prisma/Turbopack tracing warnings, not caused by this phase)
npm run test          -> PASS: 10/10 workspaces green (web, worker, ai, core, db, detection,
                        extraction, notifications, queue, security)
```

---

## 9. Tenant Isolation

Verified by a dedicated DB-level test (Section 8.1) and by re-running the E2E tenant-isolation test
(`digest.spec.ts` test 6, unmodified): Organization B's digest never surfaces Organization A's
`SUSTAINED_ACTIVITY_TREND` item, competitor, or evidence, and Organization B's
`crossCompetitorContext.sustainedCount` never reflects Organization A's data. **PASS.**

---

## 10. Query / Performance Evidence

`getSustainedActivityTrend` was added as a **third parallel call** in the existing per-competitor
`Promise.all` inside `getDigestForOrganization` — the same `O(competitors)` shape as before, never
`O(events)`. Measured directly via the existing `countPrismaQueries` instrumentation
(`packages/db/src/repositories/intelligence.test.ts`, Phase 12's query-bound tests):

- **Volume-independence unaffected:** `largeQueryCount === smallQueryCount` (a single competitor
  with 3 vs. 60 `ChangeEvent`s, otherwise identical fixture) — still holds exactly as before,
  proving the new call adds fixed per-competitor cost, not per-event cost.
- **Absolute per-competitor cost increased, as expected:** the single-competitor query count rose
  from a previously-observed ~17 to a measured **23** for the `DigestQueryBoundSmall`/`Large`
  fixture (150-day-tracked competitor) — consistent with adding one `getSustainedActivityTrend`
  call, which itself issues `getActivityPattern` calls at up to 3 offsets (bounded at `<= 18` per
  its own Phase 14B invariant, `6 * (1 + MAX_SUSTAINED_LOOKBACK)`) and short-circuits on the first
  reversal/insufficient-history offset in this particular fixture (measured at 2 of the 3 possible
  offsets before stopping). The pre-existing `smallQueryCount <= 20` assertion was raised to `<= 26`
  with an inline comment explaining the change; the load-bearing `O(competitors)` invariant
  (asserted by the same test's `largeQueryCount === smallQueryCount` line, and by the separate
  5-competitors-vs-1-competitor scaling test) is **unaffected and still passes** —
  `fiveCompQueryCount < oneCompQueryCount * 5` continues to hold because both the added cost and the
  pre-existing cost scale identically per competitor.
- **No new N+1 pattern was introduced:** `getSustainedActivityTrend` itself issues zero direct
  `ChangeEvent`/`Competitor`/`MonitoredUrl` queries (all of its queries happen inside the reused,
  unmodified `getActivityPattern`), and it is invoked exactly once per tracked competitor, in
  parallel with the two pre-existing per-competitor calls — never nested inside a loop over
  `ChangeEvent`s.

---

## 11. Mobile (375×812)

Verified via a real Playwright browser session against the running dev server (Section 8.4, test
11): sustained-true fixture seeded, viewport resized to 375×812, and confirmed
`document.documentElement.scrollWidth === window.innerWidth` (no horizontal overflow) with the
`SUSTAINED_ACTIVITY_TREND` item visible and its badge/headline text wrapping naturally. **PASS** —
no regression to the pre-existing mobile digest test (test 7, also re-run and passing).

---

## 12. AI Calls

```
AI integration support added: YES (additive factsForItem case + type union extension)
AI calls required for deterministic Digest/evidence-bundle tests: 0
Real provider calls: 0
```

All new AI-side tests (`packages/ai/src/digestInterpretation.test.ts`) exercise
`buildDigestInterpretationInput` directly — pure, deterministic, no network call. The end-to-end
regression check (`digest-ai-interpretation.spec.ts`, Section 8.4) ran against `apps/worker` with
`CMA_AI_PROVIDER=fake` (the existing deterministic, free, no-network-call dev fallback) — no real,
billed OpenAI call was made anywhere during this phase's validation.

---

## 13. Regression

Focused regression suites re-run (not the entire historical E2E surface, per Section 24 of the
brief):

- `packages/db`: full suite, 202/202 (`patterns.test.ts` 58/58 unchanged).
- `packages/ai`: full suite, 120/120 (`validateDigestClaimSafety.test.ts` 21/21 unchanged).
- `apps/web` (Vitest): full suite, 68/68 unchanged.
- E2E: `digest.spec.ts` (11/11), `sustained-trend.spec.ts` (3/3), `pattern-intelligence.spec.ts`,
  `competitor-workflow.spec.ts`, `competitive-context.spec.ts`, `digest-ai-interpretation.spec.ts` —
  all re-run, all passed.
- `npm run typecheck` and `npm run build` — PASS across every workspace.

No failure occurred outside this phase's touched surface; nothing required investigating beyond it.

---

## 14. Known Findings

None. No pre-existing bug was encountered in `getActivityPattern`, `getRepeatedPriceChangePatterns`,
`getSustainedActivityTrend`, or their tests during this phase.

One pre-existing test-bound number (the Phase 12 query-count ceiling) needed a documented increase
as a direct, expected consequence of this phase's own scope (adding a third per-competitor call) —
not a regression or a discovered defect.

---

## 15. Historical Phases Re-Audited

```
NO
```

`getActivityPattern`, `getRepeatedPriceChangePatterns`, and `getSustainedActivityTrend`'s exact
existing behavior (window model, qualification floors, `AT_BASELINE`/reversal semantics) was read
to compose correctly on top of them — not re-designed, not modified, not second-guessed. No
contradiction with any prior phase's approved decision was found or needed investigating.

---

## Final Output

```
PHASE 16 — SUSTAINED TREND DIGEST INTEGRATION

Status:
PASS

Production changes:
packages/db/src/repositories/intelligence.ts (new SUSTAINED_ACTIVITY_TREND DigestItemKind,
sustainedCount cross-competitor field, third parallel per-competitor call)
packages/ai/src/digestTypes.ts + buildDigestContext.ts (additive evidence-bundle support)
apps/web/src/app/(app)/digest/page.tsx (UI rendering, neutral vocabulary reused from
SustainedTrendCard/patternDisplay.ts conventions)

New Digest item:
SUSTAINED_ACTIVITY_TREND

Qualification:
sustained === true AND at least one real ChangeEvent in the current window (evidence
non-emptiness, same dual-condition gate as ACTIVITY_PATTERN)

Ordering:
Immediately after ACTIVITY_PATTERN in DIGEST_ITEM_KIND_ORDER

Cross-competitor context:
sustainedCount added to DigestCrossCompetitorContext, same shape as aboveBaselineCount

AI evidence:
Added - consecutiveQualifyingWindows + direction, additive optional fields, no new claim-safety
category, no prompt/provider/schema change

Schema:
NONE

Extraction:
NONE

Compare:
NONE

Entity identity:
UNCHANGED

Tests:
packages/db: 202/202 (7 new)
packages/ai: 120/120 (4 new)
apps/web (unit): 68/68 (unchanged)
E2E digest.spec.ts: 11/11 (4 new)
E2E regression (sustained-trend, pattern-intelligence, competitor-workflow,
competitive-context, digest-ai-interpretation): all passed, no regression

Typecheck:
PASS across every workspace

Build:
PASS across every workspace

Mobile 375x812:
PASS - no horizontal overflow, badge/headline text wraps rather than truncating

Query bound:
Raised from <=20 to <=26 (measured 23) for the single-competitor Phase 12 fixture, after adding
getSustainedActivityTrend (<=18 Prisma calls, its own unmodified Phase 14B invariant) as a third
parallel per-competitor call. O(competitors)-not-O(events) invariant unaffected and still passes.

AI calls:
0 real provider calls made during this phase's validation; digest-ai-interpretation E2E suite
re-run against the fake provider end to end, no regression

Known findings:
None

Historical phases re-audited:
NO

Report:
docs/phases/PHASE16-VALIDATION-REPORT.md

Next candidate:
Do not automatically implement Composition B (sustained + repeated-price conjunction sentence),
Composition C (lifecycle + sustained co-occurrence), /compare integration of the sustained
signal, or the entity-level sustained repeated price-change pattern (still blocked by entityKey
identity fragility, unchanged since Phase 14A). First assess real customer/product value
demonstrated by this phase's Digest visibility before considering any further composition.
```
