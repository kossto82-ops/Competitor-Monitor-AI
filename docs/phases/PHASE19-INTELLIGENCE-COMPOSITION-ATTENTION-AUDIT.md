# Phase 19 — Intelligence Composition & Attention Audit

**Type:** Analysis-only. No production, schema, extraction, AI-provider, prompt, UI, or test changes were made in this phase.

---

## 1. Status

**PASS WITH FINDINGS.**

The audit confirms CMA's deterministic ladder (`ChangeEvent → History → Pattern → Context → Insight`) is intact and that Phase 18 added no new intelligence (pure plumbing, as expected and as Phase 18's own report states). It identifies one concrete, low-risk composition gap — the digest currently computes `SUSTAINED_ACTIVITY_TREND` and `REPEATED_PRICE_CHANGE` for every competitor independently and presents them as two unrelated list items, even when both are true for the same competitor in the same period. Nothing in the current code, digest output, AI evidence bundle, or `/compare` table tells the customer that a competitor's price volatility is not an isolated event but part of that competitor's own sustained behavioral pattern. This is answerable today from data already computed inside `getDigestForOrganization`'s existing `Promise.all` (`packages/db/src/repositories/intelligence.ts:667-671`) — no new Prisma query, no new baseline formula, no entity-identity risk.

A second, smaller finding is noted but explicitly **not** recommended as the Phase 20 focus: `DigestCrossCompetitorContext.sustainedCount` (added Phase 16, surfaced Phase 18) currently conflates `ABOVE_BASELINE` and `BELOW_BASELINE` sustained trends into one integer, which the Phase 18 report itself flags via its "direction-agnostic wording" workaround (`apps/web/src/app/(app)/digest/page.tsx:161-183`). This is a refinement of an existing signal, not a new composition, and is listed under deferred candidates (Section 14).

## 2. Scope

Analysis only, per the mandate. No files under `apps/`, `packages/db/prisma/`, `packages/extraction/`, `packages/detection/`, `packages/ai/src/providers/`, or any test file were modified. Verified via `git status --short` (clean before and after) and `git diff --stat` (empty) — see Section 17.

## 3. Historical Phases Re-Audited

None re-audited from scratch. Per the brief, Phases 0–18 are established context. This report reads and cites (without re-verifying against the repo beyond spot-checks already performed by the fact-finding pass):

- **PHASE15-INTELLIGENCE-VALUE-AUDIT.md** — built the full signal inventory that Section 8 below extends; established the "composition over new detection" methodology this report continues.
- **PHASE16-VALIDATION-REPORT.md** — implemented `SUSTAINED_ACTIVITY_TREND` as a digest item (Phase 15's recommendation).
- **PHASE17-PRODUCT-INTELLIGENCE-VALUE-AUDIT.md** — found `sustainedCount` computed but stranded (DB-only, not AI/UI-visible).
- **PHASE18-VALIDATION-REPORT.md** — propagated `sustainedCount` to AI evidence and `/digest` UI. Confirmed (Section 6 below) as producing zero new intelligence, consistent with its own report.
- **PHASE14A-HISTORICAL-INTELLIGENCE-DESIGN-AUDIT.md** — source of the entity-identity fragility finding relied on in Section 11.

Direct code inspection was performed for every claim in Sections 4–15 below; citations point to the actual current files.

## 4. Current Intelligence Architecture

Confirmed against the repository (`packages/db/src/repositories/patterns.ts`, `packages/db/src/repositories/intelligence.ts`, `packages/ai/src/digestTypes.ts`, `packages/ai/src/buildDigestContext.ts`):

```text
Tier 1  Observation / ChangeEvent
        packages/db/prisma/schema.prisma:299-328 (ChangeEvent model)
        changeType: PRICE_CHANGE | PRODUCT_ADDED | PRODUCT_REMOVED | PROMOTION_CHANGE | CONTENT_CHANGE
        severity: LOW | MEDIUM | HIGH; confidence: Float (written, never read downstream — Phase 17 §8)

Tier 2  Derived facts (single-window, competitor-scoped)
        getActivityPattern()          patterns.ts:218-310   — current window vs. own historical baseline
        getRepeatedPriceChangePatterns() patterns.ts:483-541 — entityKey grouping within ONE window, no baseline
        in-digest lifecycle roll-up   intelligence.ts:746-762 — added/removed counts, in-window, NOT baselined

Tier 2.5 Entity history
        getEntityHistoryForCompetitor() (patterns.test.ts references confirm existence/coverage)

Tier 3  Patterns (multi-window composition, competitor-scoped)
        getSustainedActivityTrend()   patterns.ts:371-444
        — composes getActivityPattern() at offset 0, -D, -2D (MAX_SUSTAINED_LOOKBACK=2)
        — sustained = consecutiveQualifyingWindows >= MIN_SUSTAINED_WINDOWS (2)
        — issues ZERO of its own Prisma queries; pure composition over Tier-2 calls

Tier 3.5 Cross-competitor descriptive context
        DigestCrossCompetitorContext  intelligence.ts:479-486
        aboveBaselineCount, sustainedCount — both are `.filter(...).length` over the org's competitors
        computed inline in getDigestForOrganization (intelligence.ts:769-770)

Tier 4  AI interpretation
        EvidenceBundle / DigestForInterpretation  packages/ai/src/digestTypes.ts:64-120
        buildDigestInterpretationInput()          packages/ai/src/buildDigestContext.ts:127-167
        digestPrompt.ts → providers/{fake,openai,openaiCompatible}Provider.ts

Tier 5  Hypothesis
        DigestAiInterpretation.hypotheses (Json array, schema.prisma:446-496)
```

This matches the conceptual ladder in the brief with one correction: the brief's Tier 3.5 wording implies cross-competitor context is itself a "pattern," but the code shows it is a simple **count of Tier-3 results**, not an independently computed signal. It has no formula of its own beyond `.filter().length`.

## 5. Customer Question Matrix

| # | Question | Status | Answered by |
|---|---|---|---|
| 1 | What changed recently? | ANSWERED | `CHANGE_EVENT` digest items (`intelligence.ts:731`, always-eligible); `changeType`/`severity`/`evidenceExcerpt` on `ChangeEvent` |
| 2 | Which competitor changed something? | ANSWERED | Every digest item carries `competitorId`/`competitorName` (`digestTypes.ts:12-20`) |
| 3 | What exactly changed? | ANSWERED | `fieldPath`, `oldValue`, `newValue`, `evidenceExcerpt` on `ChangeEvent` (schema.prisma:299-328) |
| 4 | What was the previous value? | ANSWERED | `oldValue` field, directly on `ChangeEvent` |
| 5 | Has this happened before? | PARTIALLY ANSWERED | `getActivityPattern`'s `baselineAverage`/`qualifyingWindows` answer "is this level of activity typical," not "has this *specific* event recurred." For price-entity recurrence specifically, `getRepeatedPriceChangePatterns` answers within a single window only — it does not look back further than `days`. |
| 6 | Is this behavior unusual for this competitor? | ANSWERED | `getActivityPattern.direction` (`ABOVE_BASELINE`/`BELOW_BASELINE`/`AT_BASELINE`/`INSUFFICIENT_HISTORY`), surfaced in `/digest` and `/compare` via `patternDisplay.ts` |
| 7 | Has activity increased or decreased vs. its own history? | ANSWERED | Same as #6 — `getActivityPattern.ratio`/`.direction`, always the competitor's own history, never cross-tenant (verified test: "never leaks another organization's activity") |
| 8 | Has the behavior persisted across periods? | ANSWERED | `getSustainedActivityTrend.sustained`/`.consecutiveQualifyingWindows` (patterns.ts:371-444), surfaced as `SUSTAINED_ACTIVITY_TREND` digest item since Phase 16 |
| 9 | Is the competitor repeatedly changing prices? | ANSWERED (single-window only) | `getRepeatedPriceChangePatterns.qualifies` (`>=2` changes to the same `entityKey` inside one window) |
| 10 | Is repeated price-changing itself a sustained, multi-period pattern (not just a busy month)? | **NOT ANSWERED** | No function composes `getRepeatedPriceChangePatterns` across multiple historical windows, and no function checks whether a competitor's *repeated-price-change* qualification co-occurs with that same competitor's *sustained activity* qualification. This is the gap addressed in Section 9/15. |
| 11 | Are multiple competitors behaving similarly? | PARTIALLY ANSWERED | Only at the coarsest level: `aboveBaselineCount`/`sustainedCount` (two integers) say *how many* competitors qualify, but not *which* competitors, nor whether the behavior is the same kind (e.g., all price-driven vs. all content-driven). No per-competitor breakdown by `changeType` exists anywhere in the digest or evidence bundle today. |
| 12 | Is a behavior isolated or appearing across several tracked competitors? | PARTIALLY ANSWERED | Same limitation as #11 — the count exists, the qualitative "same kind of behavior" comparison does not. |
| 13 | Are several competitors showing sustained activity? | ANSWERED | `sustainedCount` (Phase 16/18), rendered in `/digest`'s cross-competitor card |
| 14 | What deserves investigation first? | **NOT ANSWERED** | `compareDigestItems` (`intelligence.ts:520-528`) sorts by `detectedAt DESC → competitorId ASC → fixed kind order → id` — a chronological/deterministic tie-break, not an attention ranking. There is no factual "this item combines N independent signals" flag anywhere. |
| 15 | Which observed behavior is persistent rather than incidental? | ANSWERED (per-signal) / **NOT ANSWERED (combined)** | Persistence is answerable per-signal (`sustained` flag). Whether a *specific incident* (e.g., a repeated price change) is itself persistent-behavior-backed is not answerable — see #10. |
| 16 | Which behavior combines multiple independently verified signals? | **NOT ANSWERED** | No co-occurrence composition exists in the codebase today. This is the core gap identified by this audit. |
| 17 | What might this mean? / What hypotheses are consistent with the evidence? | ANSWERED (AI layer) | `DigestAiInterpretation.hypotheses`, constrained to `allowedEvidenceChangeEventIds` (`digestTypes.ts:120`) so AI cannot hypothesize beyond cited evidence |
| 18 | What should a human investigate further? | ANSWERED (AI layer, informally) | Part of the AI interpretation's `interpretations`/`hypotheses` output, but not backed by any deterministic "priority" fact — the AI is inferring importance from raw item order/content, not from a computed attention signal |

## 6. Phase 18 Product Effect

Re-verified directly against the code (not re-trusting the Phase 18 report's self-assessment):

- **DB intelligence before Phase 18:** `sustainedCount` was already computed in `getDigestForOrganization` (`intelligence.ts:770`) as of Phase 16. Phase 18 changed **zero** DB code.
- **AI context added by Phase 18:** `crossCompetitorContext.sustainedCount` added to `DigestForInterpretation`/`EvidenceBundle` (`digestTypes.ts:72,114`) and threaded through `buildDigestInterpretationInput` (`buildDigestContext.ts:161`). This is additive field propagation of an already-computed number — no new formula.
- **UI context added by Phase 18:** a second sentence on `/digest`'s cross-competitor summary card (`digest/page.tsx:161-183`, `data-testid="digest-sustained-cross-competitor-context"`).
- **Actual new intelligence:** **No.** Confirmed. Phase 18 made an already-true fact visible in two more places. It introduced no new Prisma query, no new pattern function, no new digest item kind, no new AI evidence category. This matches the Phase 18 report's own claim ("0 new Prisma queries, 0 new AI calls, 0 new claim-safety categories") and the plumbing diagram in the Phase 19 prompt.

**Conclusion:** Phase 18 closed a *visibility* gap (data existed but wasn't reachable by the customer or the AI), not an *intelligence* gap (a new fact about competitor behavior). Phase 19's job is to identify the next *intelligence* gap, not another visibility gap — though Section 14 still lists remaining visibility gaps as lower-priority deferred items (e.g., `sustainedCount` direction-ambiguity).

## 7. Historical Depth Audit

Grounded in `patterns.ts`'s actual constants (`BASELINE_RATIO_THRESHOLD=1.5`, `MAX_SUSTAINED_LOOKBACK=2`, `MIN_SUSTAINED_WINDOWS=2`, `MIN_REPEATED_PRICE_CHANGES=2`), at digest period `D=30` days (the most common configured period, per `VALID_PERIOD_DAYS` in `/digest/page.tsx`):

| History available | What the customer can know | What newly qualifies |
|---|---|---|
| 0–29 days | Raw `CHANGE_EVENT` items only. `getActivityPattern` returns `INSUFFICIENT_HISTORY` (fewer than 2 of the up-to-3 historical windows exist). `getRepeatedPriceChangePatterns` **is** answerable (single-window, no baseline needed) — repeated price changes can be flagged from day 1 if `>=2` changes to the same `entityKey` occur inside the window. | Repeated-price-change detection only. |
| 30–89 days | Still `INSUFFICIENT_HISTORY` for `getActivityPattern` unless 2 of 3 historical windows exist — at `D=30` this needs ~60-90 days depending on window alignment to `now`. | Nothing new until the 2/3-window threshold is crossed. |
| ~90 days | `getActivityPattern` first qualifies (2 of 3 historical windows present) → `direction` (`ABOVE`/`BELOW`/`AT_BASELINE`) becomes answerable. | Activity-vs-own-baseline comparison. |
| ~120 days | Full 3-window baseline for `getActivityPattern`'s offset-0 evaluation. | Higher-confidence baseline average (3 windows vs. 2). |
| ~120–150+ days | `getSustainedActivityTrend` requires offset-0's own baseline (needs the ~90-120 days above) **plus** its own qualification at offset `-D` and (if the streak continues) offset `-2D`, each of which itself needs its own 2-3 window baseline further back. In practice this places the earliest possible `sustained=true` result meaningfully past 120 days of total history, and a full 3-offset evaluation (`consecutiveQualifyingWindows` up to 3) requires history extending well past 150 days. | Sustained-trend qualification (`SUSTAINED_ACTIVITY_TREND` digest item, `sustainedCount`). |
| 150+ days | Multiple full historical periods exist for every offset `getSustainedActivityTrend` evaluates. This is also the point where a **composition** across `getSustainedActivityTrend` and `getRepeatedPriceChangePatterns` becomes maximally informative — a competitor sustained-qualifying at this depth combined with a same-period repeated-price-change flag represents corroboration from two independently-thresholded computations, not a coincidence of thin data. | Nothing new is computed automatically — this is where the composition audit (Section 9) becomes valuable, because both inputs are now reliably qualified rather than borderline. |

**Key observation for Section 9:** the audit's recommended composition (sustained + repeated-price co-occurrence) does not require *new* historical depth beyond what `getSustainedActivityTrend` already needs. It only requires that both already-computed values be read together in the same digest pass — which happens today (`Promise.all` at `intelligence.ts:667-671`) but the *results* are never cross-referenced.

## 8. Existing Signal Utilization

| Signal | Deterministic source | Historical? | Persisted? | Surfaced? | AI-visible? | Customer question answered | Potentially redundant? |
|---|---|---|---|---|---|---|---|
| `ChangeEvent` (raw) | `packages/detection/src/compare.ts` | No (point-in-time) | Yes (`change_events` table) | Yes (`CHANGE_EVENT` digest item, always) | Yes (`facts`/`untrustedText`) | Q1-4 | No |
| `getActivityPattern` | `patterns.ts:218-310` | Yes (own multi-window baseline) | No (computed on read) | Yes (`ACTIVITY_PATTERN` item, `/compare`) | Yes (`pattern` facts bag) | Q6-7 | No |
| `getRepeatedPriceChangePatterns` | `patterns.ts:483-541` | No (single window only) | No | Yes (`REPEATED_PRICE_CHANGE` item, `/compare`) | Yes | Q9 | No |
| `getSustainedActivityTrend` | `patterns.ts:371-444` | Yes (composes `getActivityPattern` across offsets) | No | Yes (`/digest` only — **not** `/compare`, confirmed absent) | Yes (Phase 16) | Q8 | No |
| In-digest lifecycle roll-up | `intelligence.ts:746-762` | No (in-window delta only, NOT baselined) | No | Yes (`LIFECYCLE` item) | Yes | (Not in matrix explicitly — product-portfolio awareness) | No, but weakly comparable to other signals since it's the only non-baselined "pattern-like" item |
| `getProductLifecycleSummary` | `intelligence.ts:150-164` | Partially (current vs. previous period delta) | No | **No** — not called by the digest (deliberately, due to missing injectable `now`, per Section 2 fact-finding) | No | Not currently reachable from the digest at all | Possibly redundant with in-digest lifecycle roll-up if ever wired in — two different lifecycle computations exist in the codebase today |
| `aboveBaselineCount` | `intelligence.ts:769` | Derived from Tier-2 results | No | Yes | Yes | Q13 (above-baseline variant) | No |
| `sustainedCount` | `intelligence.ts:770` | Derived from Tier-3 results | No | Yes (Phase 18) | Yes (Phase 18) | Q13 | No, but **directionally ambiguous** (mixes ABOVE/BELOW sustained — see Section 14) |
| `entityKey` / `fieldPath` / `severity` / `changeType` per-event | `schema.prisma:299-328` | N/A (per-event attributes) | Yes | Yes (rendered per `CHANGE_EVENT` item) | Yes | Q1-4 | **Not currently aggregated** across a competitor's changes for the period — see Section 9D |
| `confidence` (on `ChangeEvent`) | `schema.prisma:312` | N/A | Yes | No | No | Unanswered — written at ingestion, read nowhere downstream (Phase 17 §8 finding, unchanged) | Effectively dead column for digest purposes; out of scope for Phase 20 but worth flagging |

## 9. Composition Audit

### A. Sustained + repeated price — RECOMMENDED (see Section 15)

Today `getSustainedActivityTrend` and `getRepeatedPriceChangePatterns` run in the same `Promise.all` per competitor (`intelligence.ts:667-671`) but their results are consumed independently — one produces (at most) a `SUSTAINED_ACTIVITY_TREND` item, the other produces (at most) one `REPEATED_PRICE_CHANGE` item per qualifying `entityKey` group. Nothing checks whether both are true for the same competitor in the same digest.

**Does this describe a meaningfully different customer-observable behavior than either alone?** Yes. "This competitor changed the same product's price twice this month" (repeated-price, single window) is a materially weaker claim than "this competitor changed the same product's price twice this month, **and** this competitor's overall activity has been elevated for two or more consecutive tracked periods" (repeated-price + sustained). The second statement corroborates the first with an independently-thresholded, differently-scoped computation (entity-level within-window vs. competitor-level multi-window). This is exactly the kind of "two independently verified signals" the brief's Section 5 (Q16) and Section 11 ask about.

**Identity risk:** none, if scoped at the co-occurrence (boolean AND) level rather than the entity level. A **competitor-level** co-occurrence flag (`sustained === true AND at least one qualifying repeated-price-change group exists`) requires no `entityKey` matching across periods — it only reads two already-computed booleans/collections for the same competitor in the same digest pass. A stronger, entity-level version ("this specific product's repeated price changes are themselves a sustained, multi-period pattern") would require reconciling `entityKey` identity across historical windows and is explicitly blocked by the Section 11 finding below. **This audit recommends only the competitor-level (boolean) composition, not the entity-level one.**

### B. Sustained + lifecycle — EVALUATED, NOT RECOMMENDED

The in-digest lifecycle roll-up (`intelligence.ts:746-762`) is explicitly **not baselined** — it is a raw in-window added/removed count, computed directly from the same `ChangeEvent`s already fetched for `CHANGE_EVENT` items, deliberately bypassing `getProductLifecycleSummary` (which does have a period-delta but is not wired into the digest at all — see Section 8). Composing a baselined, multi-window signal (`sustained`) with a non-baselined, single-window raw count (`added`/`removed`) would pair evidence of different evidentiary strength: one has been statistically qualified against the competitor's own history, the other has not. Presenting them together risks implying the lifecycle count is equally "unusual" when no baseline comparison has actually been performed for it. **Rejected for this reason — not for identity or query-cost reasons.**

### C. Cross-competitor sustained behavior (`sustainedCount`) — EVALUATED, DEFERRED

`sustainedCount` (Section 6/8) is already useful as coarse context but has a known limitation: it does not distinguish `ABOVE_BASELINE`-sustained from `BELOW_BASELINE`-sustained competitors, a limitation the Phase 18 report itself worked around via "direction-agnostic wording" rather than fixing at the source. A higher-level composition (e.g., splitting into `sustainedAboveCount`/`sustainedBelowCount`) is possible and low-risk (same `.filter().length` pattern, no new query), but it is a **refinement of an existing signal**, not a new composition of independently-verified evidence, so it does not meet the bar this audit is applying (Section 12) as strongly as Candidate A. Listed in Section 14 as a defer-able, low-effort follow-up.

### D. Change concentration by type — EVALUATED, NOT RECOMMENDED AS PRIMARY

`changeType`, `fieldPath`, `entityKey`, `severity` all exist per-`ChangeEvent` and are already loaded in full by `listRecentChangeEventsForDigest` (`intelligence.ts:553-590`) for every digest run. A factual aggregation ("of this competitor's N changes this period, X were `PRICE_CHANGE`, Y were `CONTENT_CHANGE`") is fully supportable with zero new queries and zero entity-identity risk. However, per the Section 13 generic-AI differentiation test, this capability is answerable from the **current digest window alone** — it requires no accumulated history, no baseline, no multi-period composition. A generic LLM given the same current-period `ChangeEvent` list (which CMA's own AI evidence bundle already includes per-item) could compute this breakdown itself with no need for CMA's stored history. It is a legitimate, cheap UI/AI convenience, but it does not strengthen CMA's core historical-memory differentiator the way Candidate A does. **Deferred, not rejected outright — see Section 14.**

### E. Multi-signal attention without scoring — EVALUATED, PARTIALLY FOLDED INTO RECOMMENDATION

A fully general "attention" concept (grouping arbitrary combinations of existing signals into an explainable summary) is broader than what current evidence supports cleanly. However, the specific two-signal composition in Candidate A is itself a constrained, explainable instance of this idea: a factual co-occurrence flag, not a score. Section 10 formalizes why a general attention layer is not yet justified, while the narrow composition in Candidate A is.

## 10. Attention-Layer Audit

**Conclusion: no general attention/scoring layer is currently justified.** Reasoning:

- The digest already has a **deterministic, explainable ordering** (`compareDigestItems`, `intelligence.ts:520-528`: `detectedAt DESC → competitorId ASC → fixed DIGEST_ITEM_KIND_ORDER → id`). This is explainable by construction — no black-box weighting.
- Introducing a numeric score (`priority: 0-100`) would require assigning relative weights across categorically different signal types (a `HIGH` severity single event vs. a `sustained` multi-period trend vs. a repeated-price-change group) with no evidentiary basis for the weights — exactly the anti-pattern the brief rejects in Section 11/16 ("Attention score: 87", "Threat score: 74").
- What **is** justified, per the Data-to-Value test (Section 12) and consistent with the composition audit above, is a **factual co-occurrence flag**: an item is annotated as corroborated by more than one independently-thresholded signal, or it is not. This is binary, explainable, and traceable to exactly which two functions produced `true`. It is not a ranking, not a score, and does not compare competitors against each other — only a competitor's own signals against each other, mirroring the "never compare against other tenants, only own history" discipline already established by `getActivityPattern`.
- This audit explicitly does **not** recommend labeling anything "most important," "top competitor," or assigning any cross-competitor ranking. The recommended Phase 20 (Section 15) produces a *fact* ("this competitor's price volatility co-occurs with its own sustained-activity trend"), not a *priority*.

## 11. Entity Identity Constraints

Confirmed via `packages/extraction/src/structuredData.ts:64-72` and `packages/detection/src/compare.ts:93-209`:

- JSON-LD `PRICE` entities receive `key: `jsonld:${name}`.toLowerCase()` — a name-derived key with no normalization beyond case-folding.
- `detectProductAddedOrRemoved` (`compare.ts:148-193`) is **restricted to JSON-LD `PRICE` entities on purpose** (explicit doc comment, `compare.ts:140-147`): `GENERIC` (regex-matched) entities are explicitly documented as "NOT stable enough to diff for add/remove without generating constant false positives."
- No reconciliation logic exists anywhere in the codebase for a product/price label rename — a renamed entity silently resets its `entityKey` with zero signal that a rename (rather than a removal + new addition) occurred. This finding is unchanged since Phase 14A and re-confirmed by Phase 15 §11 and Phase 17 §8.

**Implication for this audit's recommendation:** the recommended composition (Section 9A / Section 15) is deliberately scoped at the **competitor level** (boolean co-occurrence of two competitor-scoped facts), not the **entity level** (e.g., "this specific product's repeated price changes have themselves been sustained across 3 historical periods"). The entity-level version would require exactly the cross-period `entityKey` reconciliation that Section 11 documents as unsolved, and this audit does not attempt to solve it. Any future phase proposing entity-level longitudinal composition must first address identity reconciliation as its own scoped problem — it should not be silently absorbed into a composition phase.

## 12. Generic-AI Differentiation

Applying the brief's hypothetical (same competitor URLs/pages handed to a generic LLM today, with no CMA history):

| Capability | Requires CMA's accumulated history? | Generic LLM could replicate without it? |
|---|---|---|
| "What changed on this page since last time?" | Requires at least one prior snapshot | No — needs a diff, which needs storage |
| "Has this competitor repeatedly changed prices?" (within one window) | No — single window, but still needs *some* period of monitored change events | Partially — if given the same event list for the window |
| "Has activity remained elevated for 2+ consecutive periods relative to this competitor's own baseline?" | **Yes — requires 90-150+ days of this specific competitor's own stored history** (Section 7) | **No** — a generic LLM handed today's page has no access to this competitor's own multi-period baseline; it cannot compute `getActivityPattern`'s ratio without CMA's persisted snapshot/event history |
| "Is this competitor's repeated price-changing part of a broader sustained pattern, or an isolated blip?" (Candidate A) | **Yes — strictly requires the sustained-trend computation above, which strictly requires accumulated history** | **No** — this is the composition this audit recommends, and it inherits the full historical-data dependency of `getSustainedActivityTrend` |
| Change-type concentration in the current window (Candidate D) | No — answerable from the current window's event list alone | **Yes** — a generic LLM given the same current-period event list could tally this itself |

This table is the concrete basis for preferring Candidate A over Candidate D as the next phase: Candidate A's output is **not reproducible without CMA's stored multi-period history**, which is precisely the product's stated differentiator (Section 2, North Star). Candidate D, while cheap and useful, does not depend on accumulated history and is therefore a weaker fit for what Phase 19 was asked to identify: the next capability that "would increase this historical-data advantage."

## 13. Candidate Capabilities

No numerical scores or ranking are assigned, per instruction. Each candidate is evaluated qualitatively.

| # | Name | Customer question | Deterministic inputs | Historical depth required | Uses existing signals? | New intelligence or new presentation? | Entity identity dependency | AI dependency | Complexity | Reason to build | Reason to defer |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Sustained + repeated-price co-occurrence (competitor-level) | Is this competitor's price volatility isolated, or part of its own sustained pattern? | `getSustainedActivityTrend.sustained`, `getRepeatedPriceChangePatterns[].qualifies` (both already computed) | ~120-150+ days for reliable qualification (Section 7) | Yes — pure composition, zero new queries | New intelligence (a corroboration fact neither signal states alone) | None (competitor-scoped, no cross-period entity matching) | Yes — becomes a new `facts` field in the evidence bundle | Low | Directly strengthens the "two independently verified signals" answer (Q16); zero schema/query cost; consistent with Phase 15-18's minimal-footprint methodology | History-dependent — thin-history orgs (<120 days) will rarely see it fire |
| 2 | Lifecycle + sustained composition | Is a competitor's product-portfolio churn part of a sustained behavioral trend? | Lifecycle roll-up (non-baselined) + `sustained` (baselined) | Same as #1 for the sustained half | Yes | Would appear as new presentation but mismatched evidentiary strength (Section 9B) | None | Yes | Low-Medium | Superficially similar to #1 | Rejected — pairs baselined and non-baselined evidence, implying false statistical weight for the lifecycle half |
| 3 | Change-type concentration | Where is this competitor's activity concentrated this period? | `changeType` tally over already-fetched `ChangeEvent`s | None (current window only) | Partially (reuses already-fetched raw events, not a "signal" per se) | New presentation, not new intelligence (Section 12 table) | None | Optional | Low | Cheap, useful, zero query cost | Doesn't need CMA's history — weak fit for the historical-differentiation mandate; a generic LLM could replicate it |
| 4 | Cross-competitor sustained-direction split | Are the sustained-trending competitors accelerating or decelerating? | Split `sustainedCount` into above/below | Same as existing `sustainedCount` | Yes — refines an existing computed value | Refinement, not new intelligence | None | Yes (trivial field rename/split) | Very low | Fixes a real ambiguity flagged by Phase 18's own workaround | Small fix, not a "capability" — better suited to a follow-up patch than a full phase |
| 5 | Entity-level sustained repeated-price pattern | Has *this specific product's* price been repeatedly changed across multiple historical periods, not just this window? | `getRepeatedPriceChangePatterns` composed across multiple offsets, keyed by `entityKey` | Same order of magnitude as `getSustainedActivityTrend`, but per-entity | Would reuse the pattern-composition technique of `getSustainedActivityTrend` but at entity granularity | Genuinely new intelligence (deepest possible extension of Candidate A) | **High — blocked by Section 11** | Yes | Medium-High | Highest theoretical customer value (product-specific persistent price behavior) | **Blocked**: requires solving cross-period `entityKey` reconciliation for renamed/migrated entities first, which is explicitly out of scope and unsolved |
| 6 | More historical trend depth (extend `MAX_SUSTAINED_LOOKBACK` beyond 2) | Has this trend been sustained for even longer? | Same function, larger constant | Proportionally more (Section 7) | Yes — parameter tuning, not new logic | Marginal — extends existing signal's granularity | None | No | Very low | Trivial to implement | No customer question currently asks for a 4th/5th consecutive window; speculative without demand evidence |
| 7 | Additional AI interpretation capabilities (e.g., richer hypothesis categories) | What could this combination of signals mean strategically? | Existing evidence bundle | N/A | N/A | Not a data/intelligence change — a prompt/AI-behavior change | N/A | Yes, exclusively | Medium | Could improve narrative quality | Out of scope per Section 18 (no prompt changes in Phase 19); and the brief's north star treats AI as downstream interpretation, not the differentiator itself |
| 8 | No new feature — improve evidence/UX polish only | (meta) | N/A | N/A | N/A | Neither | N/A | N/A | Low | Always a safe fallback | Rejected as the primary recommendation because Candidate A meets the bar (Section 15) with low risk and clear customer value; "do nothing" is not indicated when a low-cost, history-dependent, evidence-grounded composition is available |

## 14. Rejected/Deferred Directions

**Deferred (real, but not Phase 20's focus):**
- Candidate 3 (change-type concentration) — cheap, useful, but current-window-only; does not use accumulated history; weaker fit for the historical-memory differentiator. Suitable for a future UX-polish phase.
- Candidate 4 (sustained-direction split) — a genuine ambiguity in an existing field, but scoped as a small refinement/patch, not a phase-sized capability.
- Candidate 6 (deeper lookback) — no customer demand evidence exists yet; defer until Candidate 1 is in production and usage data suggests deeper streaks matter.

**Rejected:**
- Candidate 2 (lifecycle + sustained) — mismatched evidentiary strength between a baselined and a non-baselined signal (Section 9B).
- Candidate 5 (entity-level sustained repeated-price pattern) — blocked by unresolved entity-identity reconciliation (Section 11); would need its own dedicated identity-hardening phase before this composition could be attempted safely.
- Candidate 7 (AI capability changes) — out of scope for a composition/attention audit; also secondary to deterministic-signal work per the product's stated architecture (AI is downstream interpretation, not the source of truth).

**Explicitly rejected per Section 16 of the brief (feature-creep guardrail), none of which any part of this audit's findings point toward:** generic AI chat, battlecards, CRM integration, win/loss analysis, market share, revenue estimation, forecasting, competitor intent detection, causal inference, product equivalence, embeddings, opaque scoring, competitor ranking, global market baselines, sentiment analysis, speculative strategy inference. No candidate capability generated by this audit requires any of these — confirmed by re-reading Section 13's table: every recommended/deferred candidate is a deterministic composition or presentation of data already computed from CMA's own accumulated `ChangeEvent` history.

## 15. Recommended Next Phase

```text
RECOMMEND NEXT PHASE
```

### Phase objective

Compose two already-computed, already-tested, competitor-scoped signals — `getSustainedActivityTrend`'s `sustained` flag and `getRepeatedPriceChangePatterns`'s per-entity `qualifies` flag — into a single deterministic co-occurrence fact per competitor per digest period, and surface that fact through the same evidence/UI pipeline Phase 16 and Phase 18 already established (digest item facts → `EvidenceBundle` → AI prompt → `/digest` UI). The composition answers a specific gap identified in Section 5 (Q10, Q16): whether a competitor's repeated price-changing behavior in the current window is corroborated by that same competitor's own multi-period sustained-activity trend, or stands alone as an isolated-window observation. No new Prisma query, no new baseline formula, and no entity-identity reconciliation is introduced — the phase strictly recomposes existing Tier-2/Tier-3 outputs that are already computed together in `getDigestForOrganization`'s per-competitor `Promise.all` (`intelligence.ts:667-671`) but never cross-referenced.

### Customer question

"Is this competitor's repeated price-changing this period an isolated event, or part of a broader pattern of sustained activity for this competitor?"

### Existing primitives reused

- `getSustainedActivityTrend(organizationId, competitorId, days, now)` — `packages/db/src/repositories/patterns.ts:371-444` (its `.sustained` boolean, read-only, no changes to this function).
- `getRepeatedPriceChangePatterns(organizationId, competitorId, days, now)` — `packages/db/src/repositories/patterns.ts:483-541` (its per-group `.qualifies` boolean, read-only).
- The existing per-competitor `Promise.all` in `getDigestForOrganization` — `packages/db/src/repositories/intelligence.ts:667-671` (both values are already fetched here; the phase adds a cheap in-memory boolean combination after both resolve, not a new async call).
- The existing `SUSTAINED_ACTIVITY_TREND` and `REPEATED_PRICE_CHANGE` digest item construction sites (`intelligence.ts:731-744`) — the phase would extend one or both items' `facts` payloads rather than replace them.
- The established Phase 16/18 propagation path: `DigestItemForInterpretation` (`packages/ai/src/digestTypes.ts:12-62`) → `EvidenceBundle` (`digestTypes.ts:106-120`) via `buildDigestInterpretationInput`/`factsForItem` (`packages/ai/src/buildDigestContext.ts:21-52,127-167`) → `digestPrompt.ts` → `/digest/page.tsx`'s `DigestItemRow` (`apps/web/src/app/(app)/digest/page.tsx:29-90`).

### New intelligence introduced

A single new deterministic boolean fact per competitor per digest period: **"this competitor's `SUSTAINED_ACTIVITY_TREND` and `REPEATED_PRICE_CHANGE` qualifications both hold in the same digest window."** This is not a new detector, not a new Prisma query, and not a new statistical formula — it is the logical conjunction of two already-independently-verified facts, computed once both are available in the existing `Promise.all`. The AI evidence bundle gains one new boolean field (e.g., `repeatedPriceChangeCoOccursWithSustainedTrend: boolean`, exact naming left to Phase 20's design step) attached to the relevant digest item(s)' `facts`. No new `DigestItemKind` is strictly required — the flag can live on the existing `SUSTAINED_ACTIVITY_TREND` item's facts (mirroring how `sustainedCount` was added to `crossCompetitorContext` in Phase 18 without creating a new item kind).

### Data flow

```text
existing data (ChangeEvent rows already fetched for the digest window)
  → existing signal: getSustainedActivityTrend()  →  sustained: boolean
  → existing signal: getRepeatedPriceChangePatterns()  →  qualifies: boolean (per entityKey group)
  → proposed composition: per-competitor boolean AND, computed in getDigestForOrganization
      after both Promise.all results resolve (intelligence.ts:667-671)
  → attached to the SUSTAINED_ACTIVITY_TREND digest item's facts (intelligence.ts:731-744)
  → DigestItemForInterpretation.facts (packages/ai/src/digestTypes.ts:12-62)
  → EvidenceBundleItem.facts (digestTypes.ts:83-98), via buildDigestInterpretationInput
  → digestPrompt.ts (jsonLine serialization, same mechanism as crossCompetitorContext today)
  → /digest UI: DigestItemRow (digest/page.tsx:29-90) — a new inline annotation/badge on the
      existing SUSTAINED_ACTIVITY_TREND row, not a new list item or new card
```

### Production files likely affected (not modified in this phase — identification only)

- `packages/db/src/repositories/intelligence.ts` (the composition site inside `getDigestForOrganization`, and possibly `DigestItem`'s TypeScript type if a new field is added to the `SUSTAINED_ACTIVITY_TREND` item shape)
- `packages/db/src/repositories/intelligence.test.ts` (new assertions mirroring the existing `describe("SUSTAINED_ACTIVITY_TREND item (Phase 16)")` block, e.g. a new `describe("co-occurrence fact (Phase 20)")`)
- `packages/ai/src/digestTypes.ts` (extend `DigestItemForInterpretation`'s SUSTAINED_ACTIVITY_TREND-specific fields)
- `packages/ai/src/buildDigestContext.ts` (`factsForItem` — additive case, same pattern as Phase 16/18)
- `packages/ai/src/digestInterpretation.test.ts` (new propagation tests mirroring the existing Phase 16/18 test blocks)
- `apps/web/src/app/(app)/digest/page.tsx` (`DigestItemRow` — one new conditional badge/sentence on the existing `SUSTAINED_ACTIVITY_TREND` branch)
- Possibly `apps/web/e2e/sustained-trend.spec.ts` or a new sibling spec (new E2E assertion)

`/compare`, `packages/detection/`, `packages/extraction/`, `packages/db/prisma/schema.prisma`, and all AI provider files are **not** expected to require changes.

### Explicit non-goals

- No new `DigestItemKind` unless the design step determines the flag cannot fit cleanly on the existing `SUSTAINED_ACTIVITY_TREND` item (to be decided in that phase's own design step, not pre-decided here).
- No entity-level co-occurrence (i.e., "this specific product's repeated price changes are themselves sustained across periods") — blocked per Section 11 until identity reconciliation is solved as its own phase.
- No numeric score, priority, or ranking of any kind.
- No cross-tenant/cross-organization comparison.
- No new Prisma query or schema migration.
- No changes to `getSustainedActivityTrend` or `getRepeatedPriceChangePatterns` themselves — both remain exactly as tested today; the composition reads their existing outputs only.
- No AI prompt/system-prompt rewrite beyond the additive `jsonLine` field already used for `crossCompetitorContext` (Phase 16/18 precedent).
- No lifecycle composition (Candidate B, rejected per Section 9B).
- No change-type concentration feature (Candidate D, deferred per Section 13/14).

### Acceptance criteria

1. A competitor whose `getSustainedActivityTrend(...).sustained === true` **and** whose `getRepeatedPriceChangePatterns(...)` contains at least one `.qualifies === true` group, in the same digest window, produces a digest item carrying a `true` co-occurrence fact; a competitor satisfying only one of the two conditions produces `false` (or the field is correctly omitted/absent, per whatever null-handling convention the design step selects — must be explicit, not implicit, mirroring the Phase 18 "never omitted/null/undefined" test discipline at `digestInterpretation.test.ts:176`).
2. The co-occurrence fact is **never computed from a new Prisma query** — a test must assert the total query count for `getDigestForOrganization` does not increase versus the pre-Phase-20 baseline (mirroring the existing bounded-query-count tests referenced in Section 2/8, e.g. `patterns.test.ts`'s "(<=3 getActivityPattern calls x <=6 Prisma calls = <=18)" pattern).
3. Tenant isolation: a test must assert the co-occurrence fact for one organization's competitor is never influenced by another organization's `ChangeEvent`s or patterns (mirroring the existing "never leaks another organization's activity" test in `patterns.test.ts`).
4. The fact is present verbatim (not recomputed) in `EvidenceBundle`/`DigestForInterpretation` — a propagation test mirroring Phase 18's "Test C: straight passthrough" pattern (`digestInterpretation.test.ts:186`) must exist.
5. `/digest` UI renders the fact only when `true` (no empty/false-state clutter added to every `SUSTAINED_ACTIVITY_TREND` row) — verified via an E2E assertion analogous to the existing `sustained-trend.spec.ts` coverage.
6. `/compare` is **not** modified as part of this acceptance — its exclusion is itself a pass condition, consistent with `getSustainedActivityTrend` also being intentionally absent from `/compare` today.
7. No change to `getSustainedActivityTrend` or `getRepeatedPriceChangePatterns`'s existing test suites' pass/fail status — all existing tests in `patterns.test.ts` and `intelligence.test.ts` continue to pass unmodified, demonstrating the composition is strictly additive.

## 16. Explicit Non-Goals (Phase 19 itself)

- No implementation of the recommended Phase 20 was performed in this phase.
- No schema, migration, extraction, detection, AI-provider, or prompt changes were made.
- No UI changes were made.
- No test files were created or modified.
- No dependency changes were made.
- No refactors of any kind were performed.

## 17. Repository Cleanliness

```text
$ git status --short
(no output — clean)

$ git diff --stat
(no output — empty)
```

Verified before starting (Section 1's initial check, this report's own creation aside) and re-verified at the time of writing this report. The only file created by this phase is this report itself, `docs/phases/PHASE19-INTELLIGENCE-COMPOSITION-ATTENTION-AUDIT.md`, which is new and untracked prior to commit — consistent with every prior phase's own report file.

## 18. Final Conclusion

CMA's deterministic ladder remains intact through Phase 18, and Phase 18 correctly added zero new intelligence (pure visibility plumbing, as its own report claims and as this audit independently re-confirms against the code). The most important remaining gap is not a missing detector but a missing **composition**: two independently-thresholded, competitor-scoped signals (`getSustainedActivityTrend` and `getRepeatedPriceChangePatterns`) are computed together in the same code path today but never cross-referenced, leaving the customer question "is this competitor's price volatility part of a sustained pattern, or an isolated blip?" unanswered despite both underlying facts already existing. This composition is recommended as Phase 20 because it (a) requires zero new queries or schema changes, (b) introduces no entity-identity risk by staying at competitor-level granularity, (c) strictly depends on CMA's accumulated multi-period history in a way a generic LLM handed the same live pages could not replicate, and (d) produces a factual corroboration flag rather than a score, ranking, or priority — consistent with every constraint in the brief's attention-without-scoring and feature-creep guardrails.
