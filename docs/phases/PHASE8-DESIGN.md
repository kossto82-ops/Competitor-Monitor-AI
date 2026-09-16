# Phase 8 — Competitive Context Engine: Design

Written before implementation, per the brief's Section 6. Previous phases
(6, 7, 7.1) are treated as established context and are not re-audited here
except where Phase 8 directly extends them.

## 1. What `/compare` currently does

`apps/web/src/app/(app)/compare/page.tsx` (Phase 6) is a plain-GET-form
Server Component. A customer checks 2+ competitors and picks a period
(7/30/90 days), and the page calls `compareCompetitors(organizationId,
selectedIds, days, timezone)` from `packages/db/src/repositories/
intelligence.ts`, rendering one table row per competitor with:

- `totalChanges` (current vs previous `PeriodDelta`)
- `priceChanges.current`, `productsAdded.current`, `productsRemoved.current`
- `latestChangeAt` (a bare date, not linked to evidence)

`compareCompetitors` itself calls `getCompetitorActivityMetrics` (current
vs **immediately preceding** period only — `resolveComparisonWindow`, a
single previous window) and a separate latest-`ChangeEvent` lookup, per
competitor, in parallel. It does **not** touch the Phase 7 pattern layer
(`getActivityPattern`, `getRepeatedPriceChangePatterns`) at all — that
work only reached the per-competitor detail page
(`/competitors/[competitorId]`, via `PatternsCard`). This is exactly the
gap `PHASE7-PRODUCT-ASSESSMENT.md`'s "Recommended next direction" and
`PHASE7.1-VALIDATION-REPORT.md`'s "Phase 8 Readiness" both flag: the
per-competitor pattern exists and is trustworthy; it has never been shown
side-by-side across competitors.

**Limitations of the current `/compare`:**
- No notion of "own historical baseline" — only current-vs-previous-period,
  a *much* weaker comparison than Phase 7's 3-historical-window baseline.
- No history-sufficiency signal — a freshly-added competitor with 3 days of
  data is compared exactly like one with 2 years of data, silently.
- No repeated-price-change signal.
- "Most recent change" is plain text, not a link to its evidence.
- No `data-testid`s (pre-dates the Phase 7 E2E-selector convention).

## 2. What Phase 8 adds

Extend `/compare`'s existing table with, per selected competitor:

1. **Activity vs. own historical baseline** — the exact `ActivityPattern`
   already computed by `getActivityPattern` (Phase 7), rendered with the
   *same* badge labels `PatternsCard` already uses ("Not enough history
   yet" / "Above recent baseline" / "In line with recent baseline" /
   "Below recent baseline"), so a customer sees one consistent vocabulary
   whether they're looking at one competitor or several.
2. **Repeated price-change activity** — the count of *qualifying*
   (`changeCount >= 2`) entities from `getRepeatedPriceChangePatterns`,
   descriptive only ("2 products/plans" or "None").
3. **Evidence link** — "Most recent change" becomes a link to
   `/changes/[id]` (the existing evidence page from Phase 3/5), not bare
   text. Requires exposing the `ChangeEvent.id` alongside its date, which
   `getLatestChangeEventAtForCompetitor` currently discards.

No ranking, no score, no global/market baseline — every competitor's
pattern state is still computed only against *its own* history, exactly
as Phase 7 defined it. Column order is exactly the order the customer
selected (already true today).

## 3. Existing Phase 7 logic reused (unchanged)

- `getActivityPattern(organizationId, competitorId, days)` — used as-is,
  no signature change, no new window model. Its `qualifies` /
  `qualifyingWindows` / `direction` / `strongEvidence` fields already give
  Phase 8 everything "history sufficiency" needs (see below) with zero new
  arithmetic.
- `getRepeatedPriceChangePatterns(organizationId, competitorId, days)` —
  used as-is; Phase 8 only counts `.filter(p => p.qualifies).length`.
- The `PatternsCard`/`activityDirectionLabel` badge-label vocabulary — the
  exact same 4 strings are reused (extracted into a small shared helper,
  see Section 6) rather than re-worded, so the same pattern never reads
  differently on two pages.
- Phase 7.1's window semantics (3 historical windows, current excluded,
  first-qualifies-at-3×days, full-baseline-at-4×days) — untouched, not
  reinvented.

## 4. New deterministic calculations

None beyond simple composition. Phase 8 adds exactly one new repository
function, `getCompetitiveContext`, in `intelligence.ts` (same file as
`compareCompetitors`, since it directly extends that function's contract
rather than replacing it):

```ts
export interface CompetitiveContextRow extends CompetitorComparisonRow {
  latestChangeEventId: string | null;
  activityPattern: ActivityPattern;               // from patterns.ts, reused verbatim
  qualifyingRepeatedPriceChangeCount: number;      // from patterns.ts, reused verbatim
}

export async function getCompetitiveContext(
  organizationId: string,
  competitorIds: string[],
  days: number,
  timezone?: string | null,
): Promise<CompetitiveContextRow[]>
```

Implementation: call the existing `compareCompetitors` for the base row
shape (name, deltas — unchanged), then, per competitor (bounded to the
customer-selected `competitorIds`, in parallel via `Promise.all`, same
convention `compareCompetitors` already uses), call `getActivityPattern`
and `getRepeatedPriceChangePatterns` and merge. `getLatestChangeEventAtFor
Competitor` gains one extra selected column (`id`) so its date and id
travel together — a one-line change, not a new query.

**Why not a new/rewritten pattern formula:** the brief (Sections 9–11) is
explicit that Phase 8 must not invent a second baseline model. Every
number in `CompetitiveContextRow` is either already-existing
(`CompetitorComparisonRow`) or a direct pass-through of an already-tested
Phase 7 type.

## 5. Schema changes

**None.** No new table, no new column beyond selecting an `id` that
already exists on `ChangeEvent`. This matches Section 18's instruction to
prefer existing data.

## 6. API changes

**None (no new REST route).** `/compare` is a Server Component that calls
`packages/db` repository functions directly (already true today — there
is no `/api/compare` route to extend). `getCompetitiveContext` is a new
exported repository function, consumed directly by the page, matching the
existing architecture exactly.

The one small refactor: extract `activityDirectionLabel` (currently a
private function inside `PatternsCard.tsx`) into a shared helper
(`apps/web/src/lib/patternDisplay.ts`) so both `PatternsCard` and the new
compare-table row use the *identical* label/tone mapping — avoids two
copies of the same vocabulary silently drifting apart.

## 7. UI changes

Extend the existing table in `compare/page.tsx` with two new columns
after "Removed" and before "Most recent change":

| Competitor | Verified changes | Price changes | Added | Removed | Activity vs. own baseline | Repeated price changes | Most recent change |
|---|---|---|---|---|---|---|---|

- **"Activity vs. own baseline"** cell: the same badge (`Badge` +
  `activityDirectionLabel`) `PatternsCard` renders, plus, only when
  `qualifies` is true, a one-line detail matching `PatternsCard`'s wording
  ("N changes, avg M across K periods") so evidence-bearing claims are
  never reduced to just a color. When `!qualifies`, render **only** the
  badge — never a fabricated detail line — exactly mirroring
  `PatternsCard`'s existing branch (Section 12's Pattern Result Contract).
- **"Repeated price changes"** cell: `"{n} product(s)/plan(s)"` when
  `n > 0`, else `"None"` — no badge needed, this is a plain count.
- **"Most recent change"**: becomes `<Link href={/changes/{id}}>` when an
  id exists, plain "—" otherwise (unchanged for the no-data case).

`data-testid`s added (new, following the exact naming convention Phase 7.1
established): `compare-table`, `compare-row` (one per competitor),
`compare-pattern-badge`, `compare-pattern-detail`, `compare-repeated-price-count`,
`compare-latest-change-link`.

No redesign of the page layout, no new page, no dashboard changes.

## 8. Evidence exposure

- The pattern badge/detail cell's numbers are the *same* numbers
  `PatternsCard` already shows on the competitor detail page (reusing the
  identical repository call) — a customer can click through to
  `/competitors/[id]` (the existing name link, unchanged) to see the full
  `PatternsCard` + Timeline + entity evidence.
- "Most recent change" now links directly to `/changes/[id]`, the existing
  per-event evidence page (before/after values, excerpt, snapshot
  provenance — built in Phase 3/5, untouched here).
- No new aggregate is introduced that cannot be traced this way; nothing
  in the new columns is a number without an underlying `ChangeEvent` (or
  `ActivityPattern`/`RepeatedPriceChangePattern`, which themselves carry
  `changeEventIds`).

## 9. What is explicitly deferred

- Ranking, scoring, "most/least active" labels — never (Section 9/29,
  permanent constraint, not a phase-8-only deferral).
- A global/market/average-competitor baseline — never (Section 10).
- Cross-competitor product/plan identity normalization — deferred (Section
  14; `entityKey` stays scoped to `(monitoredUrlId, entityKey)`).
- Promotion-change context — no extractor produces `PROMOTION_CHANGE`
  today (reconfirmed, not re-audited beyond a grep); the byType breakdown
  already in `ActivityMetrics.byType` naturally omits it since it's always
  zero, so no explicit handling is needed, but this is called out so a
  future implementer does not "fix" the absence by inventing data.
- Historical AI interpretation / hypotheses — zero AI call sites, this
  phase and future (Section 16).
- `getEntityHistoryForCompetitor` at the compare-table level — the
  per-product entity timeline stays a detail-page concern; surfacing it in
  a multi-competitor table would either explode the table's width or
  require picking "the" product per competitor arbitrarily, neither of
  which is honest. A customer who wants that already has the competitor
  detail page one click away.
- Mobile sidebar redesign — unchanged, pre-existing, out of scope (Section
  25).
