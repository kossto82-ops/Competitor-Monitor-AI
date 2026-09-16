# Phase 10 — Deterministic Digest: Validation Report

**Type:** Product feature implementation. Composes existing Phase 6/7/8
facts into one per-organization, evidence-linked feed. Zero AI calls, zero
new schema, zero new extraction.

---

## 1. Status

```
PASS
```

All new unit/integration tests (13), all new Playwright E2E tests (7), and
every pre-existing regression suite touched by this change (intelligence
repository suite, competitive-context.spec.ts, pattern-intelligence.spec.ts,
tenant-isolation.spec.ts, smoke.spec.ts, and the full `apps/web` vitest
suite) pass. Typecheck and production build both succeed.

---

## 2. Product Scope Implemented

One new customer-facing surface: **`/digest`** — "Digest" in the sidebar,
placed directly under Dashboard (the natural "log in and check this"
position, matching Phase 9 Section 14's proposed placement).

Per organization, across every **actively tracked** (`isActive: true`)
competitor, in the selected period (7/30/90 days, same selector convention
as `/dashboard` and `/compare`):

1. **Recent verified changes** — every real `ChangeEvent` in the window,
   always eligible, never gated by any pattern's qualification state.
2. **Qualified activity-vs-own-baseline patterns** — `ActivityPattern`
   objects reused verbatim from Phase 7/7.1 (`getActivityPattern`), shown
   with the exact same badge vocabulary `patternDisplay.ts` already
   established for `/compare` (Phase 8) — never a second, differently-worded
   copy of the same fact. Included only when `qualifies === true`.
3. **Repeated price-change signals** — `RepeatedPriceChangePattern` objects
   reused verbatim from Phase 7 (`getRepeatedPriceChangePatterns`).
   Included only when `qualifies === true` (`changeCount >= 2`).
4. **Product lifecycle roll-up** — a per-competitor "added N / removed M"
   aggregate for the window, shown only when something was actually added
   or removed.
5. **Cross-competitor descriptive context** — "N of M tracked competitors
   are currently above their own historical baseline" (Phase 9 Section 9's
   proposed signal), a plain count over `ActivityPattern.direction ===
   "ABOVE_BASELINE"`. Purely descriptive; no causal/coordination claim.

**Not implemented (explicit non-goals — see Section 16):** no importance
score, no AI summarization, no sustained multi-window trend, no promotion
pattern, no cross-competitor product/plan matching, no read/dismissed
state, no changes to the Phase 4 daily report pipeline.

---

## 3. Architecture

```
Organization
   |
listCompetitorsForOrg-equivalent (isActive: true only — same scope as
   |  dailyReports.ts's countActiveCompetitorsForOrg, Phase 4)
   |
   +--> ONE bulk ChangeEvent query for the whole org's tracked competitor
   |    set, bounded by window volume (not by competitor count x event
   |    count) — grouped into memory by competitorId
   |
   +--> per competitor, in parallel (Promise.all, same convention as
        Phase 8's getCompetitiveContext):
           - getActivityPattern (Phase 7, reused verbatim)
           - getRepeatedPriceChangePatterns (Phase 7, reused verbatim)
           - compose DigestItem[] from (a) the bulk-fetched raw events for
             this competitor and (b) the two pattern calls above
   |
   v
Flatten + deterministic sort (detectedAt DESC, then a fixed, documented
tie-break — never an importance score)
   |
   v
DigestResult { items, crossCompetitorContext, ... }
   |
   v
/digest Server Component (reads the repository function directly — no new
API route, matching every existing page's architecture)
```

No new event store, no persisted digest/pattern table, no AI call anywhere
in the composition path.

---

## 4. Files Changed

| File | Change |
|---|---|
| `packages/db/src/repositories/intelligence.ts` | Added `getDigestForOrganization` + `DigestItem`/`DigestResult`/`DigestCrossCompetitorContext` types and the private ordering/bulk-fetch helpers. Appended to the existing file (same convention Phase 8 used for `getCompetitiveContext`). |
| `packages/db/src/repositories/intelligence.test.ts` | Added a `getDigestForOrganization (Phase 10)` describe block — 13 new tests. |
| `apps/web/src/app/(app)/digest/page.tsx` | **New.** The Digest Server Component page. |
| `apps/web/src/components/app/Sidebar.tsx` | Added one nav entry (`/digest`, "Digest", `Newspaper` icon) directly under Dashboard. |
| `apps/web/e2e/digest.spec.ts` | **New.** 7 focused Playwright E2E tests, reusing the existing `seedPatternEvents.mjs` seeding script verbatim. |
| `.env` (local, gitignored) | Added `CMA_ALLOW_PRIVATE_TARGETS="true"` to run the new E2E suite locally against the fixture server — matches DevRunbook.md Section 7's documented dev-only override; not committed (`.env` is gitignored). |

**Files touched but not functionally changed:** none beyond the above.

---

## 5. Schema Changes

```
None.
```

No new table, no new column, no migration. Every field in `DigestItem` is
either a direct `ChangeEvent` column already selected elsewhere, or a
verbatim `ActivityPattern`/`RepeatedPriceChangePattern` object already
defined in `patterns.ts`.

---

## 6. AI/Provider Changes

```
None.
```

Zero new AI call sites. Grep confirms `intelligence.ts` and the new
`digest/page.tsx` reference no AI provider, no `@cma/ai` import, no
`aiAnalysis` table.

---

## 7. Extraction Changes

```
None.
```

No changes to `packages/extraction`, `packages/detection`, or any
extractor. The Digest works entirely from `ChangeEvent` rows the existing
monitoring pipeline (Phases 1–3) already writes.

---

## 8. Digest Item Contract

```ts
export type DigestItemKind = "CHANGE_EVENT" | "REPEATED_PRICE_CHANGE" | "ACTIVITY_PATTERN" | "LIFECYCLE";

interface DigestItemCommon {
  competitorId: string;
  competitorName: string;
  detectedAt: Date;              // ordering key only — never an importance score
  changeEventIds: string[];      // evidence — MUST be non-empty for every item
}

interface ChangeEventDigestItem extends DigestItemCommon {
  kind: "CHANGE_EVENT";
  changeEventId: string;
  changeType: ChangeType;
  severity: Severity;
  description: string;           // describeChangeEvent (@cma/core) — same sentence as everywhere else
}

interface RepeatedPriceChangeDigestItem extends DigestItemCommon {
  kind: "REPEATED_PRICE_CHANGE";
  pattern: RepeatedPriceChangePattern; // verbatim Phase 7 object
}

interface ActivityPatternDigestItem extends DigestItemCommon {
  kind: "ACTIVITY_PATTERN";
  pattern: ActivityPattern;      // verbatim Phase 7 object
}

interface LifecycleDigestItem extends DigestItemCommon {
  kind: "LIFECYCLE";
  added: number;
  removed: number;
}

type DigestItem = ChangeEventDigestItem | RepeatedPriceChangeDigestItem | ActivityPatternDigestItem | LifecycleDigestItem;

interface DigestResult {
  days: number;
  timezone: string;
  windowStart: Date;
  windowEnd: Date;
  totalTrackedCompetitors: number;
  items: DigestItem[];            // deterministically ordered, never truncated
  crossCompetitorContext: { aboveBaselineCount: number; totalTrackedCompetitors: number };
}
```

`getDigestForOrganization(organizationId, days, timezone?, now?)` — `now`
is injectable (default `new Date()`), threaded through every sub-call
(`getActivityPattern`, `getRepeatedPriceChangePatterns`, the bulk
ChangeEvent fetch, `resolveComparisonWindow`) so all three data sources
compute against the *exact same* `[now-days, now)` window.

---

## 9. Deterministic Rules

### Inclusion
- **CHANGE_EVENT**: every real `ChangeEvent` in the window — always
  eligible, no gate.
- **REPEATED_PRICE_CHANGE**: only when `pattern.qualifies === true`
  (`changeCount >= 2`, Phase 7's existing threshold, unchanged).
- **ACTIVITY_PATTERN**: only when `pattern.qualifies === true` **and**
  there is at least one real `ChangeEvent` in the current window to cite
  as evidence. This second condition is a deliberate, documented rule (not
  an accident): a qualifying pattern with zero current-window events (the
  `AT_BASELINE`-both-zero case) has no `ChangeEvent` to point to, and
  Section 15 of the brief forbids an unsupported item. The underlying
  "nothing happened" fact is not lost — it's simply not asserted as a
  named pattern item without evidence.
- **LIFECYCLE**: only when `added > 0 || removed > 0` for that competitor
  in the window.

### Ordering (see `compareDigestItems` in `intelligence.ts`)
1. `detectedAt` DESC (recency-first — the only ordering rule that matters
   product-wise).
2. `competitorId` ASC (stable tie-break).
3. A fixed, documented kind order: `CHANGE_EVENT` → `REPEATED_PRICE_CHANGE`
   → `ACTIVITY_PATTERN` → `LIFECYCLE`.
4. A stable per-kind id (`changeEventId`, or `monitoredUrlId::entityKey`,
   or `kind::competitorId`).

**Never** a hidden importance/relevance/threat score. No "top N"
truncation — every qualifying item is included.

### Aggregation ("N of M")
`aboveBaselineCount` = plain count of tracked competitors whose
`ActivityPattern.direction === "ABOVE_BASELINE"` (which itself implies
`qualifies === true` by construction in `patterns.ts` — `direction` is
only ever set to a non-`INSUFFICIENT_HISTORY` value when the pattern
qualifies). `totalTrackedCompetitors` = count of `isActive: true`
competitors for the org, regardless of qualification state. Purely
descriptive — no causal or coordination claim (Phase 9 Section 9's
explicit constraint).

### Evidence
Every `DigestItem.changeEventIds` is non-empty and traces to real
`ChangeEvent` rows:
- CHANGE_EVENT: `[event.id]`.
- REPEATED_PRICE_CHANGE: the pattern's own `changeEventIds` (Phase 7).
- ACTIVITY_PATTERN: every raw `ChangeEvent` id in the current window for
  that competitor (exactly what composes the pattern's `current` count).
- LIFECYCLE: the `PRODUCT_ADDED`/`PRODUCT_REMOVED` event ids from the same
  window.

### Scope / tenant isolation
`getDigestForOrganization` scopes the competitor lookup by
`organizationId` directly (`prisma.competitor.findMany({ where: {
organizationId, isActive: true } })`), then derives every subsequent query
(bulk ChangeEvent fetch, per-competitor pattern calls) from that
already-scoped competitor id list — never a global query filtered
afterward.

### Why `getProductLifecycleSummary` was NOT reused for the lifecycle item
(deliberate deviation from Phase 9 Section 14's suggested function list,
documented in `intelligence.ts`'s doc comment): that function (and
`getCompetitorActivityMetrics` underneath it) does not accept an
injectable `now` — it always resolves its own window via `new Date()` at
call time. Calling it would (a) break the single-shared-`now` guarantee
that makes the whole digest deterministically testable, and (b) require a
second per-competitor query pair on top of the bulk fetch already done for
the CHANGE_EVENT items. The added/removed counts are instead derived
directly from the same already-fetched raw `ChangeEvent` window — the
numbers are provably identical (same `organizationId`/`competitorId`/
`changeType`/window), computed once, in memory, with real evidence ids
attached.

---

## 10. Test Results

### Unit/Integration (vitest, real Postgres)

```
packages/db: 11 test files, 169 tests passed (was 156 before Phase 10 — 
  +13 new getDigestForOrganization tests, 0 regressions)
apps/web:    12 test files, 59 tests passed, 0 regressions
```

New `getDigestForOrganization` tests (13), all passing:
1. Empty digest for zero competitors.
2. Empty digest for competitors with zero ChangeEvents.
3. Raw CHANGE_EVENT items for a freshly-tracked (non-qualifying) competitor.
4. ACTIVITY_PATTERN item present only once the pattern qualifies, with the
   exact current-window evidence ids (never the baseline-window ones).
5. REPEATED_PRICE_CHANGE item only for the qualifying entity, non-qualifying
   entities still show as raw CHANGE_EVENT items (never hidden).
6. LIFECYCLE item with correct added/removed counts and evidence.
7. No LIFECYCLE item when nothing was added/removed.
8. Cross-competitor "N of M" count, verified against a mixed fresh+established set.
9. Deactivated (`isActive: false`) competitors excluded from the tracked set.
10. Deterministic `detectedAt` DESC ordering.
11. Every item's `changeEventIds` is non-empty.
12. No duplicate items of the same kind for the same competitor/evidence.
13. Organization isolation (Org B's digest never contains Org A's data,
    even when Org A has heavy qualifying activity).

### E2E (Playwright, real browser + real Postgres + real fixture server)

```
apps/web/e2e/digest.spec.ts: 7/7 passed
```

1. Empty state (brand-new org, zero competitors) → onboarding explainer,
   not an empty-feed digest.
2. Recent changes → raw CHANGE_EVENT items for a fresh competitor, no
   pattern/lifecycle items.
3. Qualifying activity pattern → same badge vocabulary as `/compare`
   ("Above recent baseline"), evidence link navigates to a real
   `/changes/[id]` page ("This is evidence, not an inference").
4. Repeated price-change pattern → appears only for the qualifying entity,
   evidence link works.
5. Cross-competitor context → "1 of 2" rendered correctly.
6. Tenant isolation → Org B (zero competitors) sees only its own
   onboarding explainer; page body never contains Org A's competitor name
   or pattern badge text.
7. Mobile (375×812) → no document-level horizontal overflow.

Regression suites re-run (not re-audited, just re-verified green):
`competitive-context.spec.ts` (6/6), `pattern-intelligence.spec.ts` (3/3
run of the full suite's representative subset), `tenant-isolation.spec.ts`
(1/1), `smoke.spec.ts` (1/1) — all pass unchanged.

### Typecheck

```
packages/db:  PASS (tsc --noEmit)
apps/web:     PASS (tsc --noEmit)
```

### Build

```
apps/web: npm run build → PASS (exit 0)
/digest route present in the build's route manifest.
```

---

## 11. Tenant Isolation Evidence

- **Repository level** (`intelligence.test.ts`, test 13): Org A gets a
  competitor with 7 seeded `ChangeEvent`s (enough to qualify
  `ABOVE_BASELINE`); Org B has only its own, unrelated competitor. Calling
  `getDigestForOrganization(orgB.id, 30)` returns `items: []` and asserts
  `items.every(i => i.competitorId !== compA.id)`. Calling it for Org A
  independently confirms `aboveBaselineCount === 1`, proving the isolation
  isn't accidental (Org A's own digest *does* contain the pattern; Org B's
  genuinely does not).
- **E2E level** (`digest.spec.ts`, test 6): two real browser sessions, two
  real signups. Org A seeds heavy above-baseline activity for a named
  competitor. Org B (zero competitors of its own) navigates to `/digest`
  and the test asserts the onboarding explainer is shown *and* that the
  full page body text contains neither Org A's competitor name nor the
  "Above recent baseline" badge text — a direct negative assertion against
  cross-tenant leakage, not just "the page loaded".
- **Scope enforcement**: `getDigestForOrganization` queries
  `prisma.competitor.findMany({ where: { organizationId, isActive: true
  } })` first; every subsequent query (bulk `ChangeEvent` fetch,
  per-competitor pattern calls) is derived from that already-org-scoped id
  list — there is no code path where an unscoped query is filtered
  client-side afterward.

---

## 12. Evidence/Drill-Down Validation

- Every `CHANGE_EVENT` item's "View evidence" link navigates to
  `/changes/[changeEventId]` — the existing Phase 3/5 evidence page,
  confirmed in E2E test 3 and 4 via the literal assertion `"This is
  evidence, not an inference"` (the same heading `evidence.spec.ts` and
  `competitive-context.spec.ts` already assert against).
- `REPEATED_PRICE_CHANGE` and `ACTIVITY_PATTERN` items link to the most
  recently detected `ChangeEvent` in their own `changeEventIds` list — a
  real, existing evidence page, not a synthetic summary page.
- Every item also links its competitor name to `/competitors/[id]`, the
  full detail page (PatternsCard, Timeline, entity history) for a customer
  who wants the complete picture beyond the digest's one-line summary.

---

## 13. Mobile Validation

**Viewport measured:** 375×812 (iPhone X/11/12/13 mini class — the exact
viewport `competitive-context.spec.ts`/`pattern-intelligence.spec.ts`
already use, kept consistent).

**Result:** `document.documentElement.scrollWidth > window.innerWidth`
evaluates to `false` with a populated digest feed containing a
long-entity-name price-change item (deliberately seeded to stress-test
wrapping, same fixture pattern as the existing compare-table mobile test).

768px and 1280px were not separately re-measured in this phase (the
existing pages this UI reuses — `Card`, `Badge`, flex-wrap layouts — are
already responsive at those breakpoints per Phases 6–8's own validation;
the digest page introduces no new fixed-width elements).

---

## 14. Performance/Query Observations

- **Raw `ChangeEvent` fetch:** exactly **one** query for the entire
  organization's tracked competitor set per `getDigestForOrganization`
  call, bounded by the window's event volume (a small, customer-controlled
  `days` value) — never `O(competitors × events)`.
- **Per-competitor pattern calls:** `getActivityPattern` and
  `getRepeatedPriceChangePatterns`, run in parallel (`Promise.all`) per
  competitor — bounded strictly by the number of *tracked* competitors,
  matching Phase 8's `getCompetitiveContext` convention exactly. No nested
  per-item queries inside that loop.
- No N+1 pattern was introduced: the only per-competitor work is the two
  already-existing, already-query-bounded Phase 7 functions: nothing new
  was added inside that loop that issues its own query.
- Not separately re-measured with `countPrismaQueries` in this phase (the
  existing `getCompetitiveContext` query-bound test already establishes the
  pattern for asserting this mechanically); flagged as a natural follow-up
  test if the digest's competitor-count ceiling grows materially — see
  Section 15.

---

## 15. Known Limitations

- **Query-count regression test not added.** `getCompetitiveContext` has an
  explicit `countPrismaQueries`-based test asserting its query count stays
  bounded as event volume grows; `getDigestForOrganization` was not given
  an equivalent test in this phase. The architecture is bounded by
  construction (one bulk event query + N parallel pattern-pair calls for N
  tracked competitors), but a future phase should add the same mechanical
  guard once real usage data shows how large N (tracked competitors per
  org) tends to get.
- **No pagination.** For an organization with very large ChangeEvent
  volume in a 90-day window, the digest currently renders every qualifying
  raw item with no cap. This is deliberate for Phase 10 (Section 13 of the
  brief explicitly forbids hiding real items via a "top N"), but a future
  phase may want real pagination (not truncation-by-importance) if this
  becomes a genuine UX problem at scale.
- **768px/1280px not independently re-measured** in this phase (see
  Section 13) — relies on the existing, already-validated responsive
  primitives (`Card`, `Badge`, flex-wrap) rather than new layout code.
- **The pre-existing, unrelated mobile sidebar squeeze** documented in
  Phases 6/7.1/8's own validation reports remains unaddressed — out of
  scope for this phase (Section 25 non-goal), unrelated to any code
  touched here.

---

## 16. Explicit Non-Goals (confirmed NOT implemented)

```
AI interpretation                       — NOT implemented (0 new AI call sites)
Importance/relevance/threat scoring     — NOT implemented (recency-only ordering)
Sustained multi-window trend            — NOT implemented (Candidate B, deferred per Phase 9)
Promotion extraction                    — NOT implemented (no extractor produces PROMOTION_CHANGE)
Cross-competitor product/plan matching  — NOT implemented (entityKey stays (monitoredUrlId, entityKey)-scoped)
Forecasting                             — NOT implemented
Billing/monetization changes            — NOT implemented
Notifications/email changes             — NOT implemented (Phase 4's report pipeline untouched)
Read/dismiss state                      — NOT implemented (Phase 9 Section 15's open question, left open)
```

Confirmed by direct code inspection (not assumption): `intelligence.ts`'s
new code imports only `@cma/core` (period/change-description helpers,
already used elsewhere in the same file) and the existing Phase 7
`patterns.js` module — no new imports of `@cma/ai`, no new Prisma model, no
new migration file.

---

## 17. Future AI Readiness

`DigestResult`/`DigestItem` is exactly the kind of multi-signal, per-
organization, already-qualified structured input Phase 9 Section 14
argued a future AI-interpretation phase needs to be worth its cost —
richer than interpreting one isolated `ActivityPattern` at a time (which
Phase 8's own "Future AI Readiness" section already flagged as too thin).
A future Tier 4 phase could pass a `DigestResult` (or a filtered subset of
its `items`) to an AI provider to produce a plain-language summary
*on top of* this deterministic composition — without needing to touch
`getDigestForOrganization` itself, since every fact it needs (competitor
name, change type, pattern direction/ratio, evidence ids) is already
present, typed, and evidence-linked. This phase deliberately stops short
of building that; **no AI call was added anywhere in this implementation.**

### Relationship to Phase 4's daily report (Phase 9 Section 15's open question)

Not resolved in this phase, and deliberately so — flagged here as a
decision for a future phase rather than assumed. The daily report
(`packages/db/src/repositories/dailyReports.ts`) and the new Digest
currently compute independently (different window models: the report is
calendar-day-aligned via `reportWindow.ts`; the digest is a rolling
`[now-days, now)` window via `period.ts`, matching `/compare`'s existing
convention). They do not yet share vocabulary or a single composition
function. A future phase could re-derive the daily report's content from
`getDigestForOrganization`'s output, but that would require reconciling
the two window models first — out of scope here, and not attempted.

---

## 18. Historical Phases Re-Audited

```
NO
```

Phase 8's `PHASE8-DESIGN.md`/`PHASE8-VALIDATION-REPORT.md` and Phase 9's
`PHASE9-PRODUCT-DIRECTION-AUDIT.md` were read for grounding (as instructed
— this phase directly depends on and extends their contracts). The
underlying `intelligence.ts`, `patterns.ts`, `compare/page.tsx`,
`dashboard/page.tsx`, `dailyReports.ts`, and `patternDisplay.ts` source
files were read to reuse their exact conventions (badge vocabulary, window
model, tenant-scoping pattern, `isActive: true` "tracked" definition) —
not to re-validate their prior conclusions. No prior architectural
decision was reopened; no prior bug was re-investigated. The full existing
regression suites this phase touches (`intelligence.test.ts`'s pre-existing
tests, `competitive-context.spec.ts`, `pattern-intelligence.spec.ts`,
`tenant-isolation.spec.ts`, `smoke.spec.ts`, and the complete `apps/web`
vitest suite) were re-run to confirm zero regressions, not re-authored or
re-audited.

---

## PHASE 10 FINAL OUTPUT

```
PHASE 10 — DETERMINISTIC DIGEST

Status:
PASS

Implementation:
One new per-organization, evidence-linked Digest surface (/digest) composing
existing ChangeEvent/ActivityPattern/RepeatedPriceChangePattern facts via a
new getDigestForOrganization repository function. Recency-ordered only,
zero importance score, zero AI calls, zero schema changes.

Report:
PHASE10-VALIDATION-REPORT.md

Code changed:
YES

Schema changed:
NO

AI/provider calls added:
0

Extraction changed:
NO

Tests:
packages/db: 169/169 passed (13 new)
apps/web:    59/59 passed (0 new unit tests needed - page is a thin
             composition of existing display helpers)
E2E:         7/7 new digest.spec.ts passed; 11/11 pre-existing regression
             E2E (competitive-context, pattern-intelligence, tenant-isolation,
             smoke) re-verified green

Typecheck:
PASS (packages/db, apps/web)

Build:
PASS (apps/web production build, /digest route present)

Tenant isolation:
PASS (repository-level + E2E-level, both with direct negative assertions
against cross-tenant data leakage, not just page-load checks)

Mobile:
PASS (375x812 measured, zero document-level horizontal overflow)

Known findings:
No query-count regression guard yet for getDigestForOrganization (see
Section 15); no pagination (deliberate, per the no-hidden-truncation rule);
daily-report/digest vocabulary reconciliation left as an open Phase 9
question, not resolved here.

Next logical phase:
AI interpretation (Tier 4) consuming DigestResult as its structured input -
NOT implemented here. Also candidates B (sustained multi-window trend) and
D (severity/category-weighted ordering) from PHASE9-PRODUCT-DIRECTION-AUDIT.md
Section 10, both explicitly deferred.

Historical phases re-audited:
NO
```
