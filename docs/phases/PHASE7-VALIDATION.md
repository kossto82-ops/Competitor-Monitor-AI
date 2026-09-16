# Phase 7 — Validation Report

## 1. Executive Summary

Phase 7 adds a deterministic **Pattern Intelligence** layer and a full
**Entity History** view on top of Phase 6's Competitive Intelligence Core,
scoped to exactly what the existing `ChangeEvent` history can defensibly
support (see `PHASE7-DATA-AUDIT.md`, written before any code). Two pattern
types are implemented — activity-vs-own-historical-baseline and repeated
price-change activity per identifiable product — each with an explicit,
documented minimum-sample-size gate so a thin history is rendered as
"insufficient" rather than a manufactured claim. A new entity-history query
joins a product's PRODUCT_ADDED → PRICE_CHANGE(s) → (possibly)
PRODUCT_REMOVED events into one lifecycle, using the same stable
`(monitoredUrlId, entityKey)` identity Phase 6 already validated.

Cross-competitor product/plan normalization, promotion patterns, and
historical AI interpretation are **not implemented** — each is documented
as a genuine, evidence-based product boundary (no extraction path produces
promotion data at all; no defensible cross-competitor identity exists) or
an explicit, scoped deferral (AI interpretation — same status as Phase 6,
carried forward for the same reason: not risky to defer, deterministic
intelligence degrades to nothing if absent).

Every number in this phase is a live aggregation over `ChangeEvent` — zero
new tables, zero new event store, zero AI calls anywhere in the new code
path.

## 2. Data / Semantic Audit

See `PHASE7-DATA-AUDIT.md`. Key finding: `entityKey` from
`compare.ts`'s `detectProductAddedOrRemoved` and `detectPriceChanges` uses
the *same* value for a product's ADDED, PRICE_CHANGE, and REMOVED events —
this is what makes a full entity-lifecycle join possible with zero schema
change and zero new identity model.

## 3. Intelligence Model

See `PHASE7-INTELLIGENCE-MODEL.md`. Five tiers (Observation → Derived Fact
→ Pattern → AI Interpretation → Hypothesis); this phase implements through
Pattern only, matching Phase 6's precedent of shipping the deterministic
layer standalone before any AI-dependent layer.

## 4. Entity Identity Model

Unchanged from Phase 6: `(monitoredUrlId, entityKey)` where `entityKey`
originates from JSON-LD `PRICE` extraction (`jsonld:{product name}`,
lowercased). No new identity, no cross-URL or cross-competitor matching.
See Data Audit Sections 1–2 for the full stability analysis, including
the known product-rename failure mode.

## 5. Pattern Definitions

### 5.1 Activity-vs-baseline (`getActivityPattern`)

> **Terminology fixed in Phase 7.1** — see `PHASE7.1-VALIDATION-REPORT.md`
> "Window Semantics" for the full canonical model and worked table. The
> arithmetic below was always correct in code; only this document's prose
> previously understated the minimum history required (said "2×days",
> should have said "3×days"). One genuine implementation bug was also
> found and fixed in Phase 7.1: `qualifyingWindows` was incorrectly
> reported as `0` whenever the pattern did not qualify, even when 1
> historical window genuinely qualified — see Phase 7.1 report Section
> "90-Day Claim" and its Section 6.

- **Formula:** current = count of `ChangeEvent`s in `[now-days, now)`.
  Baseline = mean count over up to 3 consecutive, non-overlapping
  **HISTORICAL** `days`-length windows immediately preceding the current
  window (current is never counted as one of the 3). `ratio = current /
  baselineAverage` when `baselineAverage > 0`.
- **Minimum history:** requires ≥2 of the 3 HISTORICAL windows to fall
  within `Competitor.createdAt..now` to `qualify`. Because windows are
  evaluated most-recent-first, this always means "historical window 1 AND
  2," which requires **at least `3 × days`** of tracked history (e.g. 90
  days when `days = 30`) — not `2 × days` (60 days). The full 3-window
  baseline requires `4 × days` (120 days when `days = 30`). Fewer than 2
  qualifying historical windows → `direction: "INSUFFICIENT_HISTORY"`.
- **Edge case handling:** `baselineAverage === 0` with `current > 0` sets
  `strongEvidence: false` (no fabricated multiplier against zero — the
  brief's own "1 vs 0 is not dramatic" example, Section 9).
- **Thresholds:** ratio ≥ 1.5 → `ABOVE_BASELINE`; ratio ≤ 0.67 →
  `BELOW_BASELINE`; else `AT_BASELINE`.
- **Limitations:** the baseline is the organization's own accumulated
  history for that one competitor only — never cross-tenant, never
  cross-competitor (see Intelligence Model, "Baseline / anomaly").

### 5.2 Repeated price-change activity per entity (`getRepeatedPriceChangePatterns`)

- **Formula:** count of `PRICE_CHANGE` events with non-null `entityKey`
  per `(monitoredUrlId, entityKey)`, within `[now-days, now)`.
- **Minimum history:** `changeCount >= 2` to `qualify`. A single change is
  returned (so the UI can distinguish "1, not a pattern yet" from
  "nothing happened") but never rendered as qualifying.

### 5.3 Entity history (`getEntityHistoryForCompetitor`)

- Not itself a "pattern" (no threshold/qualification) — a derived-fact-tier
  view: the ordered evidence trail for one identifiable product, including
  its `currentlyDetected` lifecycle flag (false only when the most recent
  event is `PRODUCT_REMOVED`, mirroring Phase 6's existing "no longer
  detected ≠ business decision" disclaimer).

## 6. Historical Intelligence Architecture

All three functions live in `packages/db/src/repositories/patterns.ts`,
same pattern as Phase 6's `intelligence.ts`: pure Prisma queries, scoped by
`organizationId` directly on every query (never inferred through a join
alone — see Section 8), no persisted metric rows, no new Prisma models.

## 7. AI Architecture

**Unchanged. Zero new AI call sites.** `patterns.ts` imports nothing from
`@cma/ai`; none of the new UI (`PatternsCard.tsx`) or repository code
touches `AiConnection`, `AiAnalysis`, or any provider. Historical AI
interpretation (brief Sections 14–16) remains deferred — same status as
Phase 6, for the same reason (see Section 12 below).

## 8. Provider/Model Audit

Re-ran the grep from Phase 6 (`gpt-4o-mini`, `gpt-5.6-luna`,
`DEFAULT_OPENAI_MODEL`, `DEFAULT_MODEL`, `CMA_AI_MODEL`,
`CMA_AI_PROVIDER`) against the current tree — same 29 files, identical
classifications (test fixtures, an input placeholder string, a pricing
lookup table entry, and `resolveAiProvider.ts`'s dev-only, explicitly
NODE_ENV-gated bootstrap with its own "no hard-coded fallback" doc
comment). **No new hits.** No file touched by Phase 7 references any
model/provider identifier.

## 9. Security Audit

- **Tenant isolation:** every new function filters directly on
  `organizationId` (`getEntityHistoryForCompetitor`, `getActivityPattern`,
  `getRepeatedPriceChangePatterns` — all resolve `MonitoredUrl`s scoped to
  `{organizationId, competitorId}` first, exactly like Phase 6's
  `getCompetitorActivityMetrics`). 4 dedicated cross-tenant tests
  (`patterns.test.ts`): entity history never leaks another org's data;
  `getActivityPattern` returns `qualifies: false, current: 0` for a
  competitor id belonging to another org, never an error and never that
  org's real counts.
- **SSRF:** no new outbound HTTP calls (100% database-query-driven).
- **Credentials:** no new code path touches `AiConnection.encryptedApiKey`.
- **Auth:** the new `PatternsCard` renders on the existing
  `/competitors/[competitorId]` page, already behind `(app)/layout.tsx`'s
  `getSession()` gate — no new route, no new bypass.

## 10. Performance / Query-Count Evidence

- `getActivityPattern`: bounded at ≤6 queries regardless of history size
  (1 competitor lookup + 1 monitoredUrl lookup + 1 current-window count +
  up to 3 baseline-window counts, run via `Promise.all`) — asserted by a
  dedicated query-count test, same convention as Phase 6's
  `intelligence.test.ts`.
- `getEntityHistoryForCompetitor` / `getRepeatedPriceChangePatterns`: 2
  queries each (monitoredUrl lookup + one `findMany`), independent of how
  many `ChangeEvent`s or distinct entities exist — no N+1.

## 11. Test Results

```
packages/db (full suite, real Postgres): 11 files, 119 passed, 0 failed
  - patterns.test.ts (NEW): 16 tests, 16 passed
    - getEntityHistoryForCompetitor: 5 tests (empty, joined lifecycle,
      currentlyDetected true/false, null entityKey excluded, cross-tenant)
    - getActivityPattern: 7 tests (insufficient history, qualifying
      ABOVE_BASELINE with hand-verified arithmetic, zero-baseline
      strongEvidence=false, both-zero/no-URLs case, cross-tenant,
      bounded query count)
    - getRepeatedPriceChangePatterns: 5 tests (empty, single change does
      not qualify, 2+ qualifies, outside-window exclusion, null
      entityKey excluded)
  - intelligence.test.ts (Phase 6, regression check): 18 passed, unchanged
`npm run typecheck` (all 10 workspaces, including apps/web): clean.
`npm run build --workspace packages/db`: clean (prisma generate + tsc).
`npm run build --workspace apps/web`: clean; production route manifest
  confirms `/competitors/[competitorId]` present with the new Patterns
  section compiled in.
```

## 12. Real E2E Evidence

Real Postgres (native, already running on this machine per
`DevRunbook.md` Section 3) + real Next.js dev server
(`npm run --workspace apps/web dev -- -p 3100`, launched via
`.claude/launch.json`'s `web` configuration) + real signup/login flow +
real seeded data, viewed in the actual browser:

- Seeded one organization, one competitor (backdated `createdAt` to 150
  days ago, well past the 90-day minimum for the pattern to qualify at
  all - see Phase 7.1's corrected window semantics), one monitored URL,
  and 7 real `ChangeEvent` rows spanning 105 days ago to 1 day ago (3
  `basic-plan` price changes spread across the 3 baseline windows, one
  `pro-plan` PRODUCT_ADDED + 2 PRICE_CHANGEs in the current window, one
  more `basic-plan` change in the current window).
- Logged in as the seeded user, navigated to
  `/competitors/{id}?days=30`, and read the rendered page text directly
  (no screenshot needed — `get_page_text` gives exact, verifiable
  strings):
  - **Activity card:** "4 · verified changes · last 30 days ·
    +3 vs previous period (+300%)" — matches the 4 current-window events
    exactly.
  - **Patterns card, activity pattern:** *"Above recent baseline"* /
    *"4 recorded changes in the last 30 days, vs. an average of 1 across
    the 3 preceding 30-day periods for which this competitor has been
    tracked. (4x the baseline average.)"* — hand-verified: baseline
    windows each contained exactly 1 `basic-plan` event (mean = 1),
    current window contained 4 events, ratio 4/1 = 4 ≥ 1.5 threshold →
    `ABOVE_BASELINE`, `strongEvidence: true`. **Matches exactly.**
  - **Patterns card, repeated price changes:** *"pro-plan · 2 price
    changes"* — matches the 2 seeded `pro-plan` `PRICE_CHANGE` events in
    the current window; `basic-plan`'s single current-window change
    correctly does NOT appear (only 1 change, below the qualifying
    threshold of 2).
  - **Pricing card (Phase 6, unaffected):** both `basic-plan` (4 points)
    and `pro-plan` (2 points) series rendered correctly, confirming Phase
    7 did not regress the existing price-history view.
  - **Timeline (Phase 5, unaffected):** all 7 events rendered, correctly
    grouped by calendar day, including the `PRODUCT_ADDED` event alongside
    the `PRICE_CHANGE` events for the same entity — visual confirmation
    that the entity-history join logic (`patterns.ts`) matches what the
    pre-existing Timeline independently derives from the same rows.
- Seeded organization and the scratch seed script were deleted after
  verification (`_scratch_seedPhase7.mjs`, not committed) — same
  convention as Phase 6's validation session.

No automated Playwright coverage was added for the new UI in this pass —
same known gap as Phase 6 (Section 14 below).

## 13. ChatGPT Substitution Test

See `PHASE7-PRODUCT-ASSESSMENT.md`, "The ChatGPT test" — 5 representative
questions, each concluding that the unique value is continuous, dated,
evidenced observation with an enforced minimum-sample-size discipline, not
the arithmetic itself (which any tool could replicate given the same input
data CMA alone has been collecting).

## 14. Customer Value Test

See `PHASE7-PRODUCT-ASSESSMENT.md`, "The customer value test" — 3
personas (SaaS pricing monitoring, ecommerce competitor monitoring,
multi-client agency), each showing the value compounding specifically at
the 90-day mark where the activity-vs-baseline pattern first qualifies.

## 15. Known Limitations

- **Product renames break entity identity.** If a competitor renames a
  JSON-LD product, `entityKey` changes and the system reports it as
  REMOVED + ADDED, not a rename. Documented, not silently glossed over
  (Data Audit Section 1).
- **Mobile layout** (`Sidebar` fixed-width overflow at narrow viewports):
  pre-existing since at least Phase 5, confirmed unchanged by Phase 7
  (not touched by any file in this diff — `PatternsCard` reuses the same
  `Card`/`Badge` primitives every other card on the page already uses, so
  it inherits whatever responsive behavior those primitives have, neither
  better nor worse). Fixing the app shell remains out of this phase's
  scope for the same reason it was out of Phase 6's: it is not an
  intelligence-layer concern, and reviewing it properly (375/768/1280px,
  per the brief's Section 32) deserves its own focused pass rather than a
  drive-by fix bundled into a data-model phase.
- **No Playwright E2E coverage added** for `PatternsCard` — verified
  manually against a real server and real seeded data (Section 12), not
  captured as a repeatable spec. Same gap Phase 6 flagged for its own new
  pages; recommend a combined pass adding Playwright coverage for both
  Phase 6 and Phase 7's UI additions together.
- **Baseline requires 3×days (90 days at the default 30-day window) of
  monitoring history minimum before it can ever qualify** — a brand-new
  competitor will show "not enough history yet" for the first 3 months.
  This is a deliberate honesty constraint (Section 4.1 of the data
  audit), not a bug, but it does mean the pattern layer's value is
  invisible at signup time — worth setting customer expectations about in
  onboarding copy (not addressed in this phase; a product-copy concern,
  not a data concern). Corrected from an earlier ("2×days") documentation
  error in Phase 7.1.

## 16. Deferred Features (deliberate, not oversights)

- **Cross-competitor product/plan normalization** — still no defensible
  identity exists (Data Audit Section 3, reconfirmed this phase).
- **Promotion patterns** — no extraction path produces `PROMOTION`-typed
  entities anywhere in the codebase; building this pattern now would be
  inventing data (Data Audit Section 1).
- **Sequence/co-occurrence pattern** — temporal proximity between
  differently-typed events is visible today via the existing Timeline;
  promoting it to a named "pattern" would risk implying causation the
  brief explicitly forbids (Data Audit Section 4.3).
- **Cross-competitor pattern comparison** — the per-competitor pattern
  this phase builds is the hard prerequisite; extending it descriptively
  across competitors is the recommended next step (see Product
  Assessment).
- **Historical AI interpretation** (brief Sections 14–16) — same
  deferral as Phase 6, same reasoning: deterministic intelligence works
  standalone and degrades to nothing if AI is absent, so shipping without
  it is not risky, but it is a real, not-yet-attempted piece of the
  original multi-phase brief.
- **Persisted metric/pattern tables, billing/entitlement enforcement** —
  not built; every pattern remains a live calculated query (brief Section
  17/32).
- **Playwright E2E for the new pattern UI** — see Known Limitations.

## 17. Product Differentiation

See `PHASE7-PRODUCT-ASSESSMENT.md` in full. Summary: the individual
formulas are commodity and could be reimplemented by a competitor in an
afternoon; what cannot be copied quickly is the accumulated per-customer,
per-competitor history the formulas run over. Phase 7's real contribution
is making that accumulated history *do something a snapshot-in-time tool
structurally cannot* — refuse to answer with false confidence below a
documented minimum sample size, and give a customer a full evidenced
lifecycle for a specific identifiable product rather than a single
before/after diff.

## 18. Recommended Next Direction

Cross-competitor pattern comparison (thin, descriptive, no ranking) — see
`PHASE7-PRODUCT-ASSESSMENT.md`'s final section for the full reasoning.

## 19. Final Verdict

**READY WITH CONDITIONS**

The deterministic Pattern Intelligence core (activity-vs-baseline,
repeated price-change detection, full entity lifecycle history) is
implemented, tenant-isolated, tested against real Postgres (16 new tests,
119/119 passing across the full `packages/db` suite), typechecked across
all 10 workspaces, built (including a clean production `apps/web` build),
and manually verified end-to-end in a real browser against real seeded
data with hand-checked arithmetic matching the UI exactly. It is safe to
ship as-is: every claim it renders is gated by an explicit, testable
minimum-sample-size rule, and a competitor with too little history
correctly renders "not enough history yet" rather than a fabricated trend.

The condition — same shape as Phase 6's — is that the brief's historical
AI-interpretation layer (Sections 14–16) remains genuinely unattempted,
and the cross-competitor pattern comparison that would make this phase's
work visible on the `/compare` page is scoped but not built. Neither
omission makes the shipped code risky or incorrect; both are real,
explicitly-tracked next steps rather than silent gaps.
