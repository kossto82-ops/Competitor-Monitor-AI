# Phase 8 — Competitive Context Engine: Validation Report

## STATUS

**PASS**

## Executive Summary

**What was implemented:** a purely descriptive Competitive Context extension
to the existing `/compare` page (Phase 6). Every selected competitor's row
now additionally shows its own Phase 7 activity-vs-historical-baseline
pattern state (`ABOVE_BASELINE`/`AT_BASELINE`/`BELOW_BASELINE`/
`INSUFFICIENT_HISTORY`), its own repeated-price-change count, and a direct
link from "most recent change" to that ChangeEvent's evidence page. Every
competitor is still compared **only against its own accumulated history** —
there is no global/market baseline, no ranking, no score, and no
cross-competitor product matching anywhere in this phase.

**Why:** Phase 7.1's own readiness assessment
(`PHASE7.1-VALIDATION-REPORT.md`, "Phase 8 Readiness") and
`PHASE7-PRODUCT-ASSESSMENT.md`'s "Recommended next direction" both
identified this as the highest-leverage next step: the per-competitor
pattern already existed and was already trustworthy (Phase 7/7.1); it had
never been shown side-by-side across a customer's monitored competitor
set, which is the comparative view the brief's Section 4 describes
("across my monitored competitors, A is above its own historical
baseline...").

**Existing code reused (unchanged):**
- `getActivityPattern` and `getRepeatedPriceChangePatterns`
  (`packages/db/src/repositories/patterns.ts`, Phase 7/7.1) — called
  verbatim, no signature change, no new window model.
- `compareCompetitors` (`packages/db/src/repositories/intelligence.ts`,
  Phase 6) — extended, not replaced; its own base row shape
  (`CompetitorComparisonRow`) is still produced internally and spread into
  the new `CompetitiveContextRow`.
- The `PatternsCard` badge vocabulary — extracted (not rewritten) into
  `apps/web/src/lib/patternDisplay.ts` so the compare table and the
  competitor-detail page render the identical wording for the identical
  pattern.

**Schema changes:** none. No new table, no new persisted metric. One
existing internal helper (`getLatestChangeEventAtForCompetitor`) was
extended to also select the already-existing `ChangeEvent.id` column
(previously discarded) — not a schema change, a query-shape change.

**Intentionally deferred (see PHASE8-DESIGN.md Section 9 for the full
list and rationale):** ranking/scoring, a global/market baseline,
cross-competitor product/plan identity normalization, promotion-change
context (no extractor produces `PROMOTION_CHANGE` data — reconfirmed by
grep, not re-audited beyond that), historical AI interpretation/
hypotheses, `getEntityHistoryForCompetitor` at the compare-table level,
and the pre-existing mobile sidebar redesign.

## Phase 8 Model

```
ChangeEvents (Phase 1-5, unchanged)
      |
Derived facts (Phase 6: getCompetitorActivityMetrics, compareCompetitors)
      |
Per-competitor patterns (Phase 7/7.1: getActivityPattern,
                          getRepeatedPriceChangePatterns - reused verbatim)
      |
Competitive Context (Phase 8, NEW: getCompetitiveContext) -
      side-by-side per-competitor pattern state, still each competitor
      only ever compared against ITS OWN history
      |
[Future: AI interpretation / hypotheses - NOT implemented this phase]
```

`getCompetitiveContext(organizationId, competitorIds, days, timezone)` in
`packages/db/src/repositories/intelligence.ts`: calls the existing
`compareCompetitors` for the base row shape, then — per selected
competitor, in parallel via `Promise.all`, bounded by the customer's own
selection size, never by event volume — calls `getActivityPattern`,
`getRepeatedPriceChangePatterns`, and a latest-`ChangeEvent`-with-id
lookup, merging the results into `CompetitiveContextRow`. See
`PHASE8-DESIGN.md` Sections 3-4 for the full reasoning.

## Window Semantics

Unchanged, reused verbatim from Phase 7.1 — no second window model was
introduced:

```
Current:      [now - D,   now)          <- never counted as a "baseline window"
Historical 1: [now - 2D,  now - D)
Historical 2: [now - 3D,  now - 2D)
Historical 3: [now - 4D,  now - 3D)
```

First qualifies at exactly `3 × D` days tracked (2 of 3 historical
windows), full 3-window baseline at `4 × D` days. See
`PHASE7.1-VALIDATION-REPORT.md`, "Window Semantics," for the full worked
example — Phase 8's tests below directly exercise this same boundary
(150-day backdating for qualifying competitors, default `createdAt` for
insufficient-history ones).

## Data Provenance

| Displayed metric | Source |
|---|---|
| Verified changes / price changes / added / removed | `compareCompetitors` → `getCompetitorActivityMetrics` (Phase 6, unchanged) — direct `ChangeEvent` counts |
| "Activity vs. own baseline" badge + detail | `getActivityPattern` (Phase 7/7.1, unchanged) — `qualifies`/`direction`/`current`/`baselineAverage`/`qualifyingWindows`/`ratio`, all traceable to the same `ChangeEvent` counts the competitor-detail `PatternsCard` shows |
| "Repeated price changes" count | `getRepeatedPriceChangePatterns` (Phase 7, unchanged), filtered to `qualifies === true` |
| "Most recent change" link | `ChangeEvent.id` + `.detectedAt` of the single most recent `ChangeEvent` for that competitor, linking to the existing `/changes/[id]` evidence page (Phase 3/5, unchanged) |

Nothing in the new columns is a number without a real underlying
`ChangeEvent` row (or a `ActivityPattern`/`RepeatedPriceChangePattern`
object that itself carries `changeEventIds`/evidence back-references).

## Tenant Isolation

- `getCompetitiveContext` performs no new raw query of its own beyond
  calling the three already-org-scoped functions
  (`compareCompetitors`, `getActivityPattern`,
  `getRepeatedPriceChangePatterns`) — every one of those already filters
  `organizationId` directly, never inferred through a join (unchanged
  convention from Phase 6/7).
- New unit test: `getCompetitiveContext` — "silently drops a competitorId
  that does not belong to the organization... no cross-tenant pattern/
  repeated-price leak," seeding heavy above-baseline activity in Org A and
  asserting Org B's request (which includes Org A's competitorId) returns
  only Org B's own row.
- New E2E test (`competitive-context.spec.ts`, Test 5): two real
  organizations through two real browser contexts; Org B's `/compare`
  picker never lists Org A's competitor name; direct navigation to
  `/compare?competitorIds=<OrgA's id>` from Org B's own authenticated
  session returns zero rows and the "Nothing to compare" empty state, with
  the full page body checked for the competitor name's absence.
- **Result: both pass.** No cross-tenant leak found in the new
  aggregation path.

## Performance

- `getCompetitiveContext`'s query cost is bounded by the number of
  **selected** competitors (a small, customer-controlled set — the
  checkbox form), not by event volume. New unit test asserts a query count
  ≤16 for 1 competitor with 15 seeded `ChangeEvent`s (measured via the
  existing `countPrismaQueries` harness, same convention as
  `getCompetitorActivityMetrics`'s own bounded-query test).
- No N+1 pattern of the kind the brief warns against (per-row-per-column
  fan-out proportional to *data volume*): the per-competitor pattern/
  repeated-price/latest-event calls all run in parallel via `Promise.all`,
  and their cost is fixed per competitor regardless of how many
  `ChangeEvent`s that competitor has accumulated.
- One accepted inefficiency, noted rather than hidden: `getCompetitive
  Context` re-resolves the latest `ChangeEvent` (this time selecting `id`
  too) even though `compareCompetitors` already resolved its `detectedAt`
  internally — a second, small query per competitor rather than
  restructuring `compareCompetitors`'s stable, already-tested return
  shape. For the customer-controlled selection sizes this page supports
  (a handful of competitors, not hundreds), this is a fixed, bounded
  duplication, not a scaling risk.

## AI

```
New AI call sites: 0
```

Confirmed by direct grep of every file this phase touched or added
(`intelligence.ts`, `intelligence.test.ts`, `compare/page.tsx`,
`patternDisplay.ts`, `PatternsCard.tsx`, `competitive-context.spec.ts`) for
`@cma/ai`, `OPENAI_API_KEY`, `CMA_AI_PROVIDER`, `CMA_AI_MODEL`,
`gpt-4o-mini`, `AiConnection`, `resolveAiProvider` — zero matches. No
historical AI interpretation, no hypothesis generation was added.

## Test Results

Run against the project's real local infrastructure (Postgres 17 +
Redis 7.4, both started from `.local-infra/` per `DevRunbook.md` Section
3, Option B; `apps/worker` running with `CMA_AI_PROVIDER=fake` per Section
7b; the Phase 1 fixture server on port 4100; the Next.js dev server on
port 3101) — not mocks.

```
Unit/integration (vitest, real Postgres/Redis where applicable):
  @cma/worker          50 passed
  @cma/ai              76 passed
  @cma/core            32 passed
  @cma/db             156 passed  (147 pre-existing + 9 new in
                                    getCompetitiveContext's describe block)
  @cma/detection       13 passed
  @cma/extraction      11 passed
  @cma/notifications    9 passed
  @cma/queue           10 passed
  @cma/security        53 passed
  @cma/web             59 passed
  -----------------------------------------
  TOTAL               469 passed, 0 failed, 0 skipped

E2E (Playwright, real Postgres + real Redis + real BullMQ worker + real
     fixture server + real Chromium; run in small batches, single worker,
     matching Phase 7.1's convention after full-suite resource contention):
  competitive-context.spec.ts (NEW, Phase 8)   6 passed
  pattern-intelligence.spec.ts                 3 passed
  ai-analysis.spec.ts                          3 passed
  ai-connections.spec.ts                       4 passed
  auth.spec.ts                                 6 passed
  competitor-workflow.spec.ts                  2 passed
  evidence.spec.ts                             2 passed
  monitoring-workflow.spec.ts                  2 passed, 1 failed
                                                (pre-existing, unrelated -
                                                 see below)
  smoke.spec.ts                                1 passed
  tenant-isolation.spec.ts                     1 passed
  ai-openai-smoke.spec.ts                      4 skipped (no OPENAI_API_KEY)
  phase5-customer-journey.spec.ts              1 skipped (no OPENAI_API_KEY)
  -----------------------------------------
  TOTAL                                        30 passed, 1 pre-existing
                                                failure (unrelated,
                                                reproduced identically),
                                                5 skipped (real-API-key
                                                gated, same as every prior
                                                phase)

npm run typecheck (packages/db, apps/web):    clean
npm run build (packages/db, apps/web):        clean (route manifest
                                               includes /compare
                                               unchanged - already existed;
                                               no new route added)
```

**The one E2E failure** (`monitoring-workflow.spec.ts`'s "a real price
change... after a second scan" test) is the **exact same pre-existing
Playwright strict-mode locator violation** documented in
`PHASE7.1-VALIDATION-REPORT.md`'s "Phase 6 Regression" section
(`getByText(/49\.00/)` matching both a `<span>` price summary and an
`<a>` evidence link containing the same text) — same test, same assertion
line, same failure mode. Phase 8 touched none of `monitoring-workflow.spec.ts`,
`ChangeEventList`, or the price-summary rendering it exercises. Not
re-fixed here, per the brief's instruction to avoid unrelated refactors;
recorded as a known, pre-existing gap, not a Phase 8 regression.

## Mobile

Measured directly (not just visually inspected), same method as Phase
7.1: `document.documentElement.scrollWidth > window.innerWidth` at a
375×812 viewport on `/compare` with a real competitor row rendered,
including a deliberately long `entityKey` in the seeded data
("a-really-quite-long-entity-name-for-wrapping-stress-test") to
stress-test the pattern-detail line's wrapping.

**Result: `false` — no new document-level horizontal overflow.** The
table itself lives inside the existing `<Card className="overflow-x-auto">`
container (unchanged from Phase 6 — the table's own `min-width` grew from
640px to 860px to fit the two new columns, but that width is contained by
the card's own horizontal scroll, not the document). The pre-existing
fixed-224px sidebar squeeze (documented in Phase 6, reconfirmed in Phase
7.1, unchanged here) still applies to `<main>`'s available width, same as
every other page — not a Phase 8 regression, not fixed here (explicitly
out of scope per Section 25 of the brief).

## Product Value

Concrete questions that now require CMA's own accumulated,
customer-specific monitoring history to answer — and that a generic AI
given only a short pasted excerpt cannot answer correctly:

1. *"Which of my monitored competitors is currently above its own
   historical activity baseline?"* — `getCompetitiveContext`'s
   `activityPattern.direction === "ABOVE_BASELINE"` per row, computed only
   from that competitor's own accumulated `ChangeEvent` history.
2. *"Which competitors have sufficient history to establish that
   baseline, and which don't yet?"* — `activityPattern.qualifies` /
   `qualifyingWindows`, rendered as an explicit "Not enough history yet"
   badge rather than a fabricated number or a silently dropped row (proven
   by the "different history ages" unit and E2E tests).
3. *"Which competitors have repeated price-change activity in the last 30
   days?"* — `qualifyingRepeatedPriceChangeCount`, a real count of
   `(monitoredUrlId, entityKey)` groups with `changeCount >= 2`.
4. *"How does current change activity differ across my monitored
   competitors, side by side?"* — the whole `/compare` table, now carrying
   both the raw counts (Phase 6) and the own-history pattern state (Phase
   8) in one view.

## ChatGPT Substitution Test

None of the four questions above can be answered by a generic LLM without
first being handed exactly the data CMA has been accumulating: the full,
dated `ChangeEvent` history per competitor, going back at minimum 90 days
for the baseline question to even have an answer (below that, CMA itself
returns `INSUFFICIENT_HISTORY` — the honest answer, not a guess). A
customer who has never used CMA has no such dataset to hand a generic AI
in the first place; the formulas themselves (mean-of-3-windows,
`ratio >= 1.5`, `changeCount >= 2`) are trivial and not the moat — the
accumulated, verified, per-customer history is. This is the same
conclusion `PHASE7-PRODUCT-ASSESSMENT.md`'s "ChatGPT test" reached for the
single-competitor case; Phase 8 extends it to "side by side across my
monitored set," which is the comparative framing customers actually asked
for.

## Remaining Gaps

### Known limitations (not blockers)

- **No promotion-change context** — unchanged from Phase 7/7.1: no
  extractor produces `PROMOTION_CHANGE`-typed entities anywhere in the
  codebase (reconfirmed by grep, not re-audited beyond that). Documented
  rather than worked around with fabricated data.
- **Cross-competitor product/plan identity normalization remains
  deferred** — `entityKey` stays scoped to `(monitoredUrlId, entityKey)`,
  as required (Section 14 of the brief); Phase 8 introduces no embeddings,
  no fuzzy matching, no cross-competitor entity inference.
- **One accepted query duplication**: `getCompetitiveContext` re-resolves
  the latest `ChangeEvent` (with `id`) separately from `compareCompetitors`'s
  own internal `latestChangeAt` resolution — see "Performance" above for
  why this was accepted rather than refactoring `compareCompetitors`'s
  stable, already-tested contract.
- **Pre-existing mobile sidebar overflow** — unchanged since Phase 6,
  reconfirmed (not worsened) this phase, out of scope per Section 25.
- **One pre-existing, unrelated Playwright strict-mode failure** in
  `monitoring-workflow.spec.ts` — reproduced identically to Phase 7.1's own
  finding; not touched or worsened by this phase.

### Blocking issues

None.

## Future AI Readiness

The `CompetitiveContextRow` shape produced by `getCompetitiveContext` —
name, raw counts, an `ActivityPattern` object (itself already carrying
`qualifies`/`direction`/`current`/`baselineAverage`/`qualifyingWindows`/
`ratio`/`strongEvidence`), a qualifying repeated-price-change count, and a
traceable `latestChangeEventId` — is exactly the kind of structured,
deterministic, already-labeled input the Intelligence Model's "AI
INTERPRETATION" tier (`PHASE7-INTELLIGENCE-MODEL.md`) describes as safe to
feed an AI call: numbers plus explicit qualification flags, never raw page
content. A future phase could pass an array of these rows (one per
monitored competitor) to a single AI call that produces hedged,
per-organization prose ("across your monitored competitors this month...")
— but that AI interpretation layer is **not implemented here**, per the
brief's explicit instruction (Section 17, Section 34's Definition of
Done). This phase only builds the Competitive Context layer the future AI
step would consume.

## Definition of Done — Checklist

- [x] Relevant previous phase reports read (Phase 7 Intelligence Model,
      Phase 7 Product Assessment, Phase 7.1 Validation Report)
- [x] Previous approved phases treated as established context, not re-audited
- [x] Current `/compare` implementation audited (Section 1 of PHASE8-DESIGN.md)
- [x] Phase 7 pattern implementation (`getActivityPattern`,
      `getRepeatedPriceChangePatterns`) reused verbatim
- [x] Phase 7.1 temporal semantics preserved, not reinvented
- [x] `PHASE8-DESIGN.md` written before implementation
- [x] Competitive Context implemented (`getCompetitiveContext`)
- [x] Own-history baseline preserved (no global/market baseline introduced)
- [x] History sufficiency explicit (insufficient-history badge, never hidden)
- [x] Cross-competitor output remains descriptive
- [x] No ranking / no score / no winner-loser semantics
- [x] No product normalization / no embeddings / no causal inference /
      no strategic interpretation
- [x] No AI calls (grep-confirmed, zero hits)
- [x] Every aggregate traceable to deterministic evidence
- [x] Evidence drill-down works (E2E Test 4)
- [x] Tenant isolation verified for the new aggregation path (unit + E2E)
- [x] No N+1 query pattern introduced (bounded-query-count unit test)
- [x] Boundary conditions tested (reuses Phase 7.1's proven window model)
- [x] Different history ages tested (unit + E2E)
- [x] Playwright coverage added (6 new tests, all passing against the real stack)
- [x] Mobile checked (measured directly: no new document-level overflow)
- [x] Regression suite executed (469/469 unit/integration; 30/31 non-skipped
      E2E passed, the 1 failure confirmed pre-existing and unrelated)
- [x] Typecheck passes (packages/db, apps/web)
- [x] Build passes (packages/db, apps/web)
- [x] Product-value test completed
- [x] ChatGPT substitution test completed
- [x] `PHASE8-VALIDATION-REPORT.md` created (this file)
- [x] Remaining limitations documented, separated from blocking issues
- [x] Future AI boundary documented (not implemented)
