# Phase 21 — Product Value & Intelligence Maturity Audit

**Type:** Analysis only. No production code, tests, schema, migrations, extraction, detection, AI, prompts, UI, or dependency changes.
**Date:** 2026-09-17

---

## 1. Status

**PASS WITH FINDINGS**

The repository contains no production/test/schema changes as a result of this phase (verified in §19). The audit surfaces one narrow, evidence-backed candidate for Phase 22 and recommends against most other candidates as feature creep, entity-identity overreach, or premature presentation work.

---

## 2. Executive Summary

CMA's deterministic intelligence ladder, as built through Phase 20, is **materially past the "we monitor websites" stage** and has produced at least three signals that a generic LLM given only a competitor's current webpage cannot reproduce: (1) an own-history activity baseline (`getActivityPattern`), (2) a competitor-level sustained-trend composition across consecutive windows (`getSustainedActivityTrend`), and (3) a same-competitor co-occurrence fact tying sustained activity to repeated price changes (`repeatedPriceChangeCoOccurs`, Phase 20). These require accumulated, tenant-scoped historical memory that does not exist anywhere else.

At the same time, the **customer question matrix** (§4) shows the product has fully answered the "what changed / is this unusual for this competitor" layer, but leaves two adjacent classes of question weak: (a) **cross-competitor attribution** — "is this pattern isolated or shared across my tracked competitors, and by whom" is only partially answered (a count exists; identities do not), and (b) **decision support / actionability** — "what should I actually do with this" is not answered by design (correctly, per Phase 19's rejection of unsupported scoring).

The **repeated pattern found across Phases 15/17/19** — a signal computed and unit-tested at the repository layer but not yet threaded to the customer-visible surface or the AI evidence bundle — has now **fully drained**: `sustainedCount` (Phase 15→18) and `repeatedPriceChangeCoOccurs` (Phase 19→20) are both stored, derived, AI-visible, and UI-visible. There is currently **no known "stranded signal"** left in the repository layer of the same shape.

The one gap that is evidence-backed rather than speculative is a **naming/attribution gap in the existing cross-competitor context**, not a missing intelligence layer: `DigestCrossCompetitorContext.sustainedCount` and `.aboveBaselineCount` are anonymous integers ("2 of 5 competitors") with no accompanying `competitorIds`/`competitorNames` list, so the customer-visible sentence in `/digest` cannot answer "**which** competitors" without opening each competitor's own page. This is the only concrete, non-speculative candidate identified in this audit (see §17).

Beyond that specific gap, this audit's evidence supports **pausing new intelligence-layer construction** and prioritizing product validation, UI/UX consolidation of already-built signals (e.g., surfacing `LifecycleSummary` and `PriceHistory` at the cross-competitor `/compare` view, where they currently do not appear), and real historical-depth validation once tenants accumulate 90–150 days of data.

---

## 3. Phase 20 Context

Phase 20 implemented `repeatedPriceChangeCoOccurs: boolean` on `SustainedActivityTrendDigestItem`, computed in-memory as `sustained === true && repeatedPricePatterns.some(p => p.qualifies)` inside the existing per-competitor `Promise.all` in `getDigestForOrganization` (`packages/db/src/repositories/intelligence.ts`). It required zero new Prisma queries, was threaded through `factsForItem()` in `packages/ai/src/buildDigestContext.ts` as a trusted boolean fact, and rendered as a UI annotation on `/digest`. 210/210 DB tests, 124/124 AI tests, 16/17 E2E passed (1 pre-existing unrelated flake, explicitly not touched by this phase — see §16).

Phase 20 was itself the resolution of Phase 19's Composition Maturity finding: that `SUSTAINED_ACTIVITY_TREND` and `REPEATED_PRICE_CHANGE` digest items were computed independently for the same competitor/period with nothing linking them, and that a general attention/scoring layer should be explicitly rejected for lack of defensible weights. Phase 19 also flagged (and deferred) a direction-ambiguity refinement in `sustainedCount` (it counts both ABOVE- and BELOW-baseline sustained competitors together) — that refinement is re-examined in §8C below and remains **not required**.

This phase (21) treats Phases 0–20 as established fact per the task instructions and does not re-audit or re-run their validation suites.

---

## 4. Customer Question Matrix

| # | Question | Classification | Supporting layer |
|---|---|---|---|
| **Current monitoring** | | | |
| 1 | What changed recently? | **ANSWERED** | `ChangeEvent` list, `/changes/[changeEventId]`, digest `CHANGE_EVENT` items |
| 2 | Which competitors changed something? | **ANSWERED** | Digest groups items by competitor; `compareCompetitors` gives per-competitor `totalChanges` |
| 3 | What prices changed? | **ANSWERED** | `ChangeEvent.changeType=PRICE_CHANGE`, `oldValue`/`newValue`/`percentageChange`, `PriceHistoryCard` |
| 4 | Which products appeared or disappeared? | **ANSWERED** | `getProductLifecycleSummary` (added/removed period delta), `ProductLifecycleCard` |
| **Historical memory** | | | |
| 5 | What has changed repeatedly? | **ANSWERED** | `getRepeatedPriceChangePatterns` — `changeCount >= 2` per `(monitoredUrlId, entityKey)` in-window |
| 6 | What has been unusually active vs. this competitor's own history? | **ANSWERED** | `getActivityPattern` — current window vs. mean of up to 3 own prior windows, `ratio`, `direction`, `strongEvidence` |
| 7 | Has behavior persisted across several periods? | **ANSWERED** | `getSustainedActivityTrend` — composes `getActivityPattern` at offsets 0/-D/-2D, `consecutiveQualifyingWindows`, `sustained` |
| 8 | Has an activity pattern continued or stopped? | **PARTIALLY ANSWERED** | `sustained` is boolean-and-count, not a state transition; no explicit "this streak just broke" fact (see §8F) |
| 9 | Are repeated price changes occurring alongside sustained activity? | **ANSWERED** | Phase 20 `repeatedPriceChangeCoOccurs` |
| **Cross-competitor context** | | | |
| 10 | Are several competitors behaving unusually at the same time? | **ANSWERED** | `DigestCrossCompetitorContext.aboveBaselineCount` / `.sustainedCount`, `totalTrackedCompetitors` |
| 11 | Is a pattern isolated to one competitor or visible across several? | **PARTIALLY ANSWERED** | The count exists and is customer-visible on `/digest`, but the count is anonymous — no competitor names/IDs accompany it, so "which ones" requires opening every competitor page individually |
| 12 | Which changes are shared vs. competitor-specific? | **NOT ANSWERED** | No entity-equivalence or shared-event grouping exists across competitors (correctly — see §10, entity identity is not cross-competitor comparable) |
| **Intelligence / attention** | | | |
| 13 | What should I pay attention to without reading every competitor? | **PARTIALLY ANSWERED** | Digest ordering (`DIGEST_ITEM_KIND_ORDER`) plus AI `summary`/`observations` provide a reading order, but see §9 — no explicit "attention" composition beyond what already exists |
| 14 | What is becoming persistent rather than a one-off? | **ANSWERED** | `SUSTAINED_ACTIVITY_TREND` digest item is exactly this fact |
| 15 | What is genuinely different from the competitor's normal behavior? | **ANSWERED** | `getActivityPattern.direction` (ABOVE/BELOW/AT_BASELINE) is precisely a deviation-from-normal fact |
| 16 | What would I have missed looking only at today's changes? | **ANSWERED** | Items 6, 7, 9 above are all invisible in a single-snapshot view by construction |
| 17 | What can CMA tell me after 90–120 days that it couldn't in week one? | **ANSWERED (qualitatively — see §5)** | Baseline qualification requires ≥90 tracked days; full 3-window baseline and 2-window sustained streak require 120 days; 3-window sustained streak requires 150 days |
| **Decision support** | | | |
| 18 | What does this mean for my business? | **NOT ANSWERED (by design)** | AI `interpretations`/`hypotheses` exist but are constrained by `validateDigestClaimSafety` to exclude causal/strategic/financial claims — this is a correct boundary, not a gap |
| 19 | Which competitor behavior deserves investigation? | **PARTIALLY ANSWERED** | Same as #13 — ordering and sustained/co-occurrence facts function as an implicit "worth a look" signal, without an explicit label |
| 20 | Can CMA explain why a pattern is notable without pretending to know intent? | **ANSWERED** | `factsForItem()` supplies only trusted numeric/boolean/enum facts to the AI; `validateDigestClaimSafety` blocks intent/causal language in AI output |

**Observation:** Every "NOT ANSWERED" or correctly-scoped rejection in this matrix (#12, #18) is a deliberate boundary already established by Phases 14A/19 (entity identity, unsupported inference), not an oversight. The only two genuine "PARTIALLY ANSWERED" items with a concrete missing fact rather than a missing judgment call are **#11** (anonymous cross-competitor counts) and **#8** (no explicit streak-break/direction-change event).

---

## 5. Historical Maturity: 0–7 / 30 / 60 / 90 / 120 / 150+

| Period | What exists | What becomes possible | What still requires more history | Incremental customer value from memory |
|---|---|---|---|---|
| **Day 0–7** | Raw `ChangeEvent`s only (snapshots are too sparse for any window comparison) | Nothing beyond "here is what changed since I started monitoring" | Everything pattern-related | None beyond a generic monitoring tool — CMA is not yet differentiated |
| **Day 30** | One full window (`days` default, D=30) of activity counts | `compareCompetitors` descriptive comparison across competitors becomes meaningful for one period | `getActivityPattern` needs ≥90 days (3 prior windows) to fully qualify (it can produce `INSUFFICIENT_HISTORY` before that) | Still largely "we monitor websites"; a generic AI shown the same 30-day change list could approximate this |
| **Day 60** | Two windows of history | Partial baseline comparison possible with reduced confidence (fewer than 3 baseline windows) | Full baseline (3 windows), sustained trend (needs ≥2 consecutive qualifying windows) | Marginal — early signal of deviation, but `strongEvidence` gating means most output is still tentative |
| **Day 90** | Three prior windows exist | `getActivityPattern` fully qualifies; ABOVE/BELOW/AT_BASELINE deviation facts become reliable; `getRepeatedPriceChangePatterns` fully meaningful within any window | 2-window sustained streak (needs current + 2 prior windows = 90 days minimum, confirmed achievable exactly at day 90 per Phase 14B) | **This is the first point where CMA states something a same-day website read cannot**: "this competitor is currently 1.8x its own historical baseline" |
| **Day 120** | 2-window sustained streak achievable; full 3-window baseline stable | `SUSTAINED_ACTIVITY_TREND` digest item fires; cross-competitor `sustainedCount` becomes meaningful; Phase 20 `repeatedPriceChangeCoOccurs` becomes evaluable in the same period | 3-window sustained streak (150 days) | This is where the "we remember how these competitors behave" proposition becomes concretely true — sustained trend and co-occurrence are structurally impossible without ≥120 days of this tenant's own accumulated snapshots |
| **Day 150+** | 3-window sustained streak achievable | Highest-confidence sustained-trend statements; longest available `getEntityHistoryForCompetitor` / `getPriceHistoryForCompetitor` chains for a given entity (bounded only by how long that `entityKey` has survived — see §10) | Nothing structurally new emerges past this point in the current model; deeper history mostly increases confidence, not new fact types | Diminishing returns on *new* fact types; continuing value is confidence and evidence depth, not new capability |

**Conclusion for this section:** the proposition "we remember how these competitors behave over time" becomes **materially true, not aspirational, starting at day 90 and structurally complete at day 120**. Before day 90, CMA's incremental value over a manual competitor check is limited (it saves labor, but does not yet produce a fact a human with the current page couldn't approximate). This is a repository-verified conclusion (window/threshold constants in `packages/db/src/repositories/patterns.ts`, confirmed against Phase 14B's measured day-count validation), not marketing framing.

---

## 6. Current Intelligence Ladder

```
Tier 1 — Observations
  ChangeEvent: changeType, severity, confidence, entityKey, oldValue/newValue,
  percentageChange, evidenceExcerpt, detectedAt, currency, fieldPath

Tier 2 — Derived facts (packages/db/src/repositories/intelligence.ts)
  getOrgActivityMetrics / getCompetitorActivityMetrics   — window activity counts
  getProductLifecycleSummary                              — added/removed deltas
  getPriceHistoryForCompetitor                            — full chronological price series
  compareCompetitors / getCompetitiveContext              — descriptive cross-competitor row

Tier 3 — Patterns (packages/db/src/repositories/patterns.ts)
  getActivityPattern              — current window vs. own 3-window historical baseline
  getRepeatedPriceChangePatterns  — same-entity price-change count within a window
  getSustainedActivityTrend       — getActivityPattern composed across 3 consecutive windows
  getEntityHistoryForCompetitor   — full per-entity add/reprice/remove chain

Tier 3.5 — Composition / cross-competitor context
  DigestCrossCompetitorContext.aboveBaselineCount / .sustainedCount / .totalTrackedCompetitors
  SustainedActivityTrendDigestItem.repeatedPriceChangeCoOccurs   (Phase 20)

Tier 4 — AI interpretation (packages/ai/src)
  factsForItem() → trusted facts only, per digest item kind
  buildDigestInterpretationInput() → EvidenceBundle (capped, tenant-isolated)
  validateDigestClaimSafety → blocks causal/intent/strategy/forecast/financial/win-loss language

Tier 5 — Hypotheses
  AiInterpretationOutput.hypotheses[] — present, schema-validated, subject to the same
  claim-safety gate as interpretations/observations
```

This ladder matches the task's expected model exactly, confirming no tier is missing structurally. The question this phase must answer is not "is a tier missing" but "is there a missing **fact or composition inside an existing tier** that materially changes customer value" — addressed in §14.

---

## 7. Signal Utilization Audit

| Signal | A. Stored | B. Deterministically derived | C. Customer-visible | D. AI-visible | E. Composed with others | F. Redundant | G. Answers a real question |
|---|---|---|---|---|---|---|---|
| `ChangeEvent` (raw) | Yes | N/A (extraction) | Yes (`/changes/[id]`, digest `CHANGE_EVENT`) | Yes | Base of all higher tiers | No | Yes (#1, #3) |
| `ChangeEvent.confidence` | Yes | N/A | No (not rendered) | **No** — never read downstream per prior-phase finding (Phase 17), unchanged in this audit | No | No — but currently inert | **Partial** — informational only; not itself an actioned signal, but not disproven-useless either |
| `getOrgActivityMetrics` / `getCompetitorActivityMetrics` | Derived, not stored | Yes | Yes (dashboard, competitor page) | Indirectly (underlies `getActivityPattern`) | Yes (baseline input) | No | Yes (#2) |
| `getProductLifecycleSummary` | Derived | Yes | Yes (competitor detail page only) | **No** — not in digest evidence bundle, not in `/compare` | No | No | Yes (#4) but scoped narrowly to one page |
| `getPriceHistoryForCompetitor` | Derived | Yes | Yes (`PriceHistoryCard`) | No | No | No | Yes (#3, historical variant) |
| `compareCompetitors` / `getCompetitiveContext` | Derived | Yes | Yes (`/compare`) | No | Yes (wraps `getActivityPattern`, repeated-price count) | Partial overlap with digest cross-competitor context — see below | Yes (#10, #2) |
| `getActivityPattern` | Derived | Yes | Yes (competitor page `PatternsCard`) | Yes (`factsForItem`) | Base of sustained trend and co-occurrence | No | Yes (#6, #15) |
| `getRepeatedPriceChangePatterns` | Derived | Yes | Yes (digest `REPEATED_PRICE_CHANGE` item) | Yes | Composed into co-occurrence | No | Yes (#5) |
| `getSustainedActivityTrend` | Derived | Yes | Yes (`SustainedTrendCard`, digest item) | Yes | Base of `sustainedCount` and co-occurrence | No | Yes (#7, #14) |
| `getEntityHistoryForCompetitor` | Derived | Yes | Yes (competitor detail) | No | No | No | Yes (#3/#4, entity-level detail) |
| `aboveBaselineCount` | Derived | Yes | Yes (digest summary sentence) | Yes | Cross-competitor aggregate of `getActivityPattern` | No | Yes (#10) |
| `sustainedCount` | Derived | Yes | Yes (Phase 18) | Yes (Phase 18) | Cross-competitor aggregate of `getSustainedActivityTrend` | Partially overlaps `aboveBaselineCount` semantically (a sustained competitor is usually also above baseline in its latest window) but is not numerically redundant — see §8C | Yes (#10) |
| `repeatedPriceChangeCoOccurs` | Derived | Yes | Yes (Phase 20) | Yes (Phase 20) | Explicit composition of `sustained` + `repeatedPricePatterns` | No | Yes (#9) |

**Finding:** As of Phase 20, there is **no remaining "computed but stranded" signal** of the shape that recurred in Phases 15 and 17. `getProductLifecycleSummary` and `getPriceHistoryForCompetitor` are the closest candidates to "underutilized" (competitor-detail-only, not in digest/compare), but this is a **presentation-consolidation** observation, not a missing-intelligence one — see §17.

---

## 8. Composition Maturity

**A. Sustained + repeated price (Phase 20, implemented).** Product meaning is real and specific: it distinguishes "this competitor has been unusually active for two consecutive periods, *and* the reason includes at least one item that has been repriced repeatedly" from "unusually active for unrelated, non-repeating reasons." This is more informative than either fact alone because sustained activity could be driven entirely by non-price changes (content, promotions) — the co-occurrence flag tells the customer specifically that pricing is part of the sustained story. **Assessment: materially useful, not restated.**

**B. Sustained + lifecycle.** Would combine `getSustainedActivityTrend.sustained` with `getProductLifecycleSummary.added/removed` counts for the same window. Conceptually this would answer "is the sustained activity coming with a changing catalog, not just repricing" — a real, distinct question from (A). However, unlike (A), which reuses data already computed in the same `Promise.all`, this composition would require either (i) calling `getProductLifecycleSummary` inside the digest's per-competitor loop (a new query path not currently exercised there) or (ii) restating `getCompetitorActivityMetrics`' existing byType breakdown, which already contains PRODUCT_ADDED/PRODUCT_REMOVED counts for the same window. On inspection, **`getActivityPattern`'s underlying window counts already include product add/remove events in its totals** (activity metrics count by `changeType`, and `PRODUCT_ADDED`/`PRODUCT_REMOVED` are members of that enum) — so "sustained activity that includes lifecycle changes" is already partially expressible by checking the existing per-type breakdown, without a new composition. A genuinely new fact here would be narrow (e.g., "sustained + net-positive catalog growth" vs. "sustained + net removal") and its incremental value over reading the existing lifecycle card is marginal. **Assessment: mostly restates two existing observations; not clearly justified as a dedicated composition.**

**C. Cross-competitor sustained behavior (`sustainedCount`).** Already answers "how many of my tracked competitors are currently in a sustained trend" adequately for the org-wide summary sentence. The one real gap is **not** a new composition — it's **identity**: the count has no accompanying list of *which* competitors. See §17 for why this is treated as the one concrete candidate rather than a new pattern type.

**D. Change concentration.** Could ask "did one competitor account for a disproportionate share of this period's total activity across all tracked competitors." This is deterministically computable from data already fetched by `compareCompetitors`/`getCompetitiveContext` (per-competitor `totalChanges` vs. sum across competitors) without new extraction or entity-identity assumptions. It would be materially different from `getActivityPattern` (which compares a competitor to *its own* history, not to *peer* competitors in the same period) — it answers a different question ("is X unusually loud this month relative to peers" vs. "is X unusually loud relative to itself historically"). This is a legitimate, low-risk candidate but was **not selected** as the Phase 22 recommendation because it does not resolve a question already surfaced as a customer pain point in §4 (no matrix item explicitly asks for peer-relative concentration; the closest, #11, is about identity not concentration) and because introducing a second "unusualness" axis (self-baseline vs. peer-share) risks confusing the digest's current single mental model before the identity gap in §17 is closed.

**E. Repeated price + lifecycle.** Would say something like "this competitor is repeatedly repricing an item that was recently added." This edges toward implying a commercial narrative ("testing a new product's price") that the evidence does not support — exactly the class of inference `validateDigestClaimSafety` is designed to prevent at the AI-output layer. Composing it as a *deterministic fact* (not AI prose) would be safe in principle, but the customer-observable value over separately reading "recently added" + "repeated price changes" is thin, and the naming risk (a composition named e.g. `newProductRepricing`) invites the reader to infer strategy CMA cannot support. **Assessment: not worth building; the risk/value ratio is unfavorable.**

**F. Direction changes (ABOVE → AT → BELOW).** `getActivityPattern.direction` is already a per-window enum; a sequence of directions across consecutive windows is technically derivable from the same lookback array `getSustainedActivityTrend` already builds (`lookback[]`). This would answer customer question #8 ("has this continued or stopped") more precisely than the current boolean `sustained` flag, which only tracks a streak of *qualifying* windows in one direction and does not explicitly say "this streak just broke" or "this reversed from ABOVE to BELOW." This is the **second-most-concrete candidate** identified in this audit (after §17's identity gap) and is listed as a Next-Phase Candidate in §15, but not selected for Phase 22 because (i) its baseline data (`lookback[]`) is not yet exposed anywhere customer-visible even in its current form, so exposing a derived "reversal" fact before exposing the raw sequence risks presenting an inference without its evidence trail, and (ii) it would benefit from being scoped together with the §17 identity fix (both touch the same digest cross-competitor context) rather than as an isolated third phase.

**G. Multi-signal "attention."** CMA does **not** lack building blocks for attention — it already has: item ordering (`DIGEST_ITEM_KIND_ORDER`), an explicit boolean co-occurrence fact, and per-competitor grouping. What CMA correctly lacks, per Phase 19's explicit rejection (reaffirmed here), is an **opaque scoring/ranking layer**. The evidence does not support building one now: none of the customer-question matrix items in §4 require a numeric priority score to be answered; ordering and explicit boolean facts are sufficient and are more explainable than a score would be. **Assessment: no attention layer is missing; the existing composition primitives already constitute the attention mechanism the product needs.**

---

## 9. Attention Layer Assessment

Restating §8G as a direct answer to the task's explicit question: CMA does not lack an attention layer. It has chosen (correctly, per Phase 19 and reaffirmed by this audit) to express "what deserves attention" through **explicit, named, boolean/enum facts** (`sustained`, `repeatedPriceChangeCoOccurs`, `direction`) plus a **fixed, explainable ordering** of digest item kinds, rather than through a numeric score. This is more defensible than a weighted-score approach because every fact traces to a named deterministic rule the customer (or a support engineer) can audit, whereas a score would require justifying weights that Phase 19 already found no defensible basis for. No change is recommended here.

---

## 10. Entity Identity Constraints

Reconfirmed unchanged from Phase 14A/15/17/19 (not re-audited beyond the code-location check performed for this phase):

- JSON-LD entity keys are name-derived strings (`"jsonld:" + name.toLowerCase()`, `packages/extraction/src/structuredData.ts`) with no rename reconciliation. Any competitor renaming a product (casing, whitespace, wording) produces a new `entityKey` indistinguishable in the data model from a removal followed by a fresh addition.
- Identity is additionally scoped by `monitoredUrlId`; moving a product between monitored pages resets identity even if the name string is unchanged.
- Generic (regex-fallback) entities use a context hash and are explicitly excluded from add/remove diffing.
- No cross-competitor or cross-page entity equivalence exists anywhere in the codebase.

**Implication for this audit:** every candidate considered in §8 and §15 was checked against this constraint. Candidates requiring entity-level longitudinal identity across competitors (e.g., "competitor A and competitor B both changed the price of an equivalent product") are excluded from consideration, consistent with prior-phase guidance. All recommended-for-consideration candidates operate at **competitor level** (using `monitoredUrlId`-scoped, single-tenant entity keys only within one competitor's own history), never at cross-competitor entity-equivalence level.

---

## 11. Generic AI Differentiation Test

| Layer | Could a generic LLM given only the current page reproduce it? | Why / why not |
|---|---|---|
| Single price/product change detection | Partially — yes, if also given the immediately prior snapshot | Requires two pages, not accumulated memory; CMA's differentiation here is automation + evidence storage, not uniqueness of the fact itself |
| `getActivityPattern` (own-history baseline, ABOVE/BELOW/AT_BASELINE) | **No** | Requires ≥90 days of this tenant's own accumulated snapshot history; a generic LLM has no access to CMA's private historical database |
| `getRepeatedPriceChangePatterns` (within-window repeat count) | Partially — theoretically yes if given the full window's raw change log, but that log itself is CMA's stored history, not public web content | Depends on CMA's private change-event store |
| `getSustainedActivityTrend` (multi-window streak) | **No** | Structurally requires 3 consecutive accumulated windows of this tenant's private history (90–150 days); no public source contains this |
| `repeatedPriceChangeCoOccurs` (Phase 20) | **No** | Composition of two signals that each independently require CMA's private history |
| Cross-competitor `sustainedCount`/`aboveBaselineCount` | **No** | Requires simultaneous accumulated history across every tracked competitor for one tenant — this data exists nowhere outside CMA |
| AI `summary`/`observations`/`hypotheses` | **No**, for the same reason as their inputs | The AI layer is explicitly downstream of the above facts (`factsForItem`); its output is only as differentiated as its evidence bundle, which is itself non-reproducible |

**Conclusion:** the moat is verifiably shifting from "AI-generated summaries of website changes" (which a generic AI given the same page could approximate) to **persistent, tenant-scoped competitive memory** that a generic AI structurally cannot access. This became true starting with `getActivityPattern` (baseline) and was substantially deepened by `getSustainedActivityTrend` and Phase 20's co-occurrence composition. This is the strongest positive finding of this audit.

---

## 12. Product Value Assessment

Synthesizing §4–§11: CMA has reached a genuinely valuable product layer for the questions a real customer asks about **one competitor's own trajectory** and about **simple counts of how many peers are behaving unusually**. It has not yet reached — and, per §10, may be structurally unable to reach without a materially different identity model — the layer of **cross-competitor entity-level comparison** ("are competitor A and competitor B doing the same specific thing"). It has deliberately and correctly declined to build a **decision-support/strategy-inference layer**, which is the right call given the evidence-safety constraints already in place.

The customer value gained by continuing to add competitor-level composition facts (§8B, §8D, §8E) is diminishing: each new candidate examined in §8 either restates an existing observation, introduces unsupported inference risk, or addresses a question not actually present in the customer matrix. The one exception — cross-competitor competitor identity in the count fields (§17) — is not a new intelligence *layer* at all; it is closing a naming/attribution gap in an existing, already-shipped composition.

---

## 13. Feature-Creep Rejections

The following are explicitly rejected as feature-count expansion rather than intelligence-value increments, consistent with the task's Section 11 guidance and this audit's findings:

- Generic AI chat interface — would bypass the deterministic evidence-bundle discipline that is CMA's actual differentiator.
- Battlecards / sales enablement content — decision-support layer explicitly out of scope per §12.
- CRM integration — distribution mechanism, not intelligence.
- Sentiment analysis — no textual sentiment source exists in the current extraction pipeline; would require new extraction scope, out of bounds for this audit's remit.
- Market share / revenue estimation — directly the class of claim `validateDigestClaimSafety`'s `financial-inference` category exists to block.
- Forecasting / predictive modeling — blocked by the same `forecast` category; also has no defensible basis in the current deterministic-fact model.
- Competitor intent/strategy inference — blocked by `competitor-intent`/`competitor-strategy` categories; Phase 19 already rejected a related "attention scoring" idea for the same reason.
- Opaque priority scores / "threat levels" — explicitly rejected in §8G/§9; the existing explicit-fact-plus-ordering approach is more defensible.
- Cross-competitor product matching without defensible identity — blocked by §10's entity identity constraints.
- Additional notification channels — distribution, not intelligence; not evaluated further here.
- Speculative strategy inference of any kind — same rejection basis as intent/strategy above.

---

## 14. Remaining Intelligence Gap

Selecting from the task's option list (§12 of the prompt):

**Primary answer: H — nothing significant is missing; the current intelligence model is sufficiently mature for its current scope**, with one narrow exception that is closer to **E (better attention/presentation)** than to a new fact type: the anonymization of the existing `sustainedCount`/`aboveBaselineCount` cross-competitor fields (§17).

No evidence in this audit supports A (more raw observations — extraction is out of scope and no matrix question is blocked by missing raw data), B (more derived facts — Tier 2 already covers every matrix "ANSWERED" item), C (more historical patterns — Tier 3 is complete for competitor-level analysis and cannot go further without changing the entity-identity model per §10), D (more compositions — §8 examined five candidates and rejected four as restating existing facts or introducing unsupported inference), F (evidence-grounded AI interpretation — already implemented and safety-gated), or G (actionability — correctly out of scope per §12/§18).

---

## 15. Next-Phase Candidates

**Candidate 1 — Name the cross-competitor counts**
- Customer question: #11 ("is a pattern isolated to one competitor or visible across several — which ones?")
- Current capability: `DigestCrossCompetitorContext.aboveBaselineCount`/`.sustainedCount` are anonymous integers.
- What is missing: the identities of the competitors contributing to each count.
- Why this would be genuinely new: today the customer must open every competitor's own page to discover which ones are in the count; a named list removes that manual cross-referencing step entirely — a capability that does not exist today at any surface.
- Required data: none new — `getActivityPattern`/`getSustainedActivityTrend` are already computed per competitor with `competitorId` in scope inside the same `Promise.all` that produces the counts.
- Required identity assumptions: none beyond existing competitor-level identity (no entity-level assumption).
- Deterministic or AI: deterministic; would also thread into the AI evidence bundle as a trusted fact list (not a new claim-safety category).
- Potential evidence model: `{aboveBaselineCount, aboveBaselineCompetitorIds, sustainedCount, sustainedCompetitorIds, totalTrackedCompetitors}`.
- Potential customer-visible output: `/digest` summary sentence naming competitors instead of only a count; no new page.
- Main risk: minor prompt-length growth in the AI evidence bundle if competitor lists are long (bounded by existing `MAX_BUNDLE_COMPETITORS`).
- Why it may NOT be worth building: it is presentation/attribution, not new intelligence — a purist reading of "new intelligence" (per §16 of the task) could classify this as out of scope for an "intelligence" phase rather than a UI phase.

**Candidate 2 — Streak-break / direction-reversal fact**
- Customer question: #8 ("has this continued or stopped").
- Current capability: `sustained: boolean` and `consecutiveQualifyingWindows` exist; `lookback[]` direction sequence is computed internally but not exposed.
- What is missing: an explicit "this streak just ended" or "this reversed direction" fact.
- Why this would be genuinely new: distinguishes "still sustained" from "was sustained, now stopped" — a state-transition fact not currently expressible.
- Required data: none new — reuses `getSustainedActivityTrend`'s existing `lookback[]`.
- Required identity assumptions: none (competitor-level only).
- Deterministic or AI: deterministic.
- Potential evidence model: `{previousDirection, currentDirection, streakBroken: boolean}`.
- Potential customer-visible output: a digest item or annotation similar to Phase 20's co-occurrence annotation.
- Main risk: exposing a derived transition without first exposing the raw `lookback[]` direction history risks presenting a conclusion the customer cannot independently verify on the same page.
- Why it may NOT be worth building: no matrix question demands it as sharply as #11 does; and it duplicates information already inferable by a customer who reads two consecutive digests.

**Candidate 3 — Change concentration (peer-relative, not self-baseline)**
- Customer question: not explicitly present in §4's matrix; closest is #11.
- Current capability: `compareCompetitors`/`getCompetitiveContext` already returns per-competitor `totalChanges` for the same period.
- What is missing: an explicit "X accounts for N% of this period's total tracked activity" fact.
- Why this would be genuinely new: answers a peer-relative question distinct from self-baseline deviation.
- Required data: none new — pure arithmetic over existing `compareCompetitors` rows.
- Required identity assumptions: none.
- Deterministic or AI: deterministic.
- Potential evidence model: `{competitorId, shareOfTotalActivity: number}`.
- Potential customer-visible output: `/compare` page addition.
- Main risk: introduces a second, differently-normalized "unusualness" concept (peer-share vs. self-baseline-ratio) that could confuse the digest's single current mental model.
- Why it may NOT be worth building: no customer question in this audit's matrix directly requests it; risk of concept proliferation outweighs an unrequested convenience.

**Candidate 4 — Sustained + lifecycle composition**
- Customer question: adjacent to #7/#4, no direct match.
- Current capability: both `getSustainedActivityTrend` and `getProductLifecycleSummary` exist independently.
- What is missing: an explicit co-occurrence fact like Phase 20's price one, but for lifecycle changes.
- Why this would be genuinely new: marginal — see §8B; largely restates the existing by-type breakdown already inside activity metrics.
- Required data: none new.
- Required identity assumptions: none.
- Deterministic or AI: deterministic.
- Potential evidence model: `{sustained, lifecycleCoOccurs: boolean}`.
- Potential customer-visible output: digest annotation, mirroring Phase 20's UI pattern.
- Main risk: signal redundancy with information already visible in the existing lifecycle card and activity-pattern byType breakdown.
- Why it may NOT be worth building: §8B's analysis found the incremental fact thin relative to Phase 20's price composition.

**Candidate 5 — Lifecycle/price-history surfaced at `/compare`**
- Customer question: #4, #3 at cross-competitor scope.
- Current capability: `getProductLifecycleSummary`/`getPriceHistoryForCompetitor` exist and render only on competitor-detail pages; `/compare` does not include them.
- What is missing: nothing computationally — this is pure UI consolidation, not new intelligence.
- Why this would be genuinely new: it would not be new intelligence; flagged here only because §7 identified it as underutilized, and it is listed for completeness though it does not meet the "new intelligence" bar the task requires.
- Required data: none.
- Required identity assumptions: none.
- Deterministic or AI: N/A (presentation).
- Potential evidence model: N/A.
- Potential customer-visible output: `/compare` page rows extended with lifecycle/price columns.
- Main risk: none intelligence-related; purely a UI-scope decision.
- Why it may NOT be worth building as an "intelligence phase": it is presentation, explicitly excluded from qualifying as new intelligence per §16 of the task.

**Candidate 6 — Repeated price + lifecycle composition**
- Customer question: none directly in the matrix.
- Current capability: both signals exist independently.
- What is missing: a joint fact.
- Why this would be genuinely new: technically yes, but see §8E — it edges toward implying commercial narrative the evidence does not support.
- Required data: none new.
- Required identity assumptions: none beyond existing entity-key-within-competitor scoping.
- Deterministic or AI: deterministic fact, but naming/framing risk at presentation layer.
- Potential evidence model: `{repeatedPriceQualifies, recentlyAdded: boolean}`.
- Potential customer-visible output: digest annotation.
- Main risk: invites strategic-inference reading despite being phrased as a neutral fact.
- Why it may NOT be worth building: risk/value ratio unfavorable per §8E; the safest posture is to not build compositions whose most natural reading implies intent.

---

## 16. Recommendation

**DO NOT IMPLEMENT A NEW INTELLIGENCE FEATURE YET.**

Evidence basis: §14 found no missing fact type in categories A–D or F–G; the deterministic ladder is structurally complete for competitor-level analysis given the entity-identity constraints in §10, and every composition candidate examined in §8 was either already built (A), thin/redundant (B, D partially), or carries unsupported-inference risk disproportionate to its value (E). The one concrete, evidence-backed gap identified (§17, cross-competitor count identity) is an attribution/naming fix to an *existing* shipped composition, not a new intelligence layer, and is small enough that building it as a dedicated "Phase 22 intelligence phase" would overstate its scope.

What should happen instead:
1. **Product validation** — no evidence in this repository establishes whether real tenants have reached the 90–120 day threshold identified in §5 where CMA's differentiation becomes observable. Before adding new composition logic, validate with actual tenant data/usage whether the already-shipped `SUSTAINED_ACTIVITY_TREND` and `repeatedPriceChangeCoOccurs` signals are firing in production and are being read.
2. **UI/UX consolidation** — surface `getProductLifecycleSummary`/`getPriceHistoryForCompetitor` on `/compare` (Candidate 5) as ordinary UI work, not an intelligence phase, since §7 found them underutilized relative to their computed value.
3. **The one small fix** — if a phase is opened at all, scope it narrowly to Candidate 1 (naming the cross-competitor counts) exactly as described in §17, because it is the only candidate that is evidence-backed, low-risk, reuses 100% existing computation, and closes a real matrix gap (#11) rather than an invented one.
4. **README staleness** — noted only as an aside (not a Phase 21 deliverable): the root README's status line ("Phase 10 complete") is stale relative to `docs/phases/` reaching Phase 20; this is an operational-hygiene item, not an intelligence gap, and is explicitly not fixed in this analysis-only phase.

---

## 17. Proposed Phase 22 Scope (if applicable)

This scope is offered strictly as the narrow candidate from §16 point 3, in case the product owner elects to open a phase rather than defer per the primary recommendation in §16.

**Objective:** Attribute the existing `DigestCrossCompetitorContext.aboveBaselineCount` and `.sustainedCount` fields to the specific competitors that contribute to them, closing customer question #11 without introducing any new pattern-detection logic.

**Customer question:** "Are several competitors behaving unusually at the same time — and which ones?"

**Existing capabilities reused:** `getActivityPattern` and `getSustainedActivityTrend` are already computed per-competitor inside `getDigestForOrganization`'s existing `Promise.all` (`packages/db/src/repositories/intelligence.ts`); `competitorId`/`competitorName` are already in scope at that point.

**New intelligence created:** none — this is an attribution/naming addition to an already-shipped composition, not a new derived fact or pattern. It should be scoped and described honestly as a **presentation/attribution enhancement**, not framed as a new "intelligence layer," consistent with §16 of the task ("if the answer is merely displayed more nicely, classify it as presentation").

**Why it is not merely presentation (rebuttal check, per task requirement):** it is largely presentation, and this report says so plainly. The only reason it is listed here at all rather than dismissed outright is that it removes a genuine multi-page manual cross-referencing step for the customer (today: open every competitor page to find out which ones are in the count) — a small but real workflow improvement, not an intelligence increment. If the product owner's bar for "intelligence phase" excludes this, the correct action is to treat it as ordinary UI backlog work, not a numbered Phase 22.

**Data requirements:** none new.

**Identity assumptions:** none beyond existing competitor-level identity (`competitorId`); no entity-key assumptions.

**Evidence requirements:** the new list fields would be trusted, deterministic values (competitor IDs/names already validated elsewhere in the system) — no new claim-safety category needed in `validateDigestClaimSafety`.

**AI implications:** `factsForItem`/`buildDigestContext` would pass the named lists through as additional trusted facts in `crossCompetitorContext`, capped by the existing `MAX_BUNDLE_COMPETITORS` limit already in place.

**UI surface:** `/digest` summary sentence only; no new page.

**Performance/query implications:** none — zero new Prisma queries; the computation already occurs.

**Explicit non-goals:** no new pattern type, no new composition logic, no entity-level cross-competitor matching, no scoring/ranking, no change to `getActivityPattern`/`getSustainedActivityTrend` thresholds or windows.

**Definition of done:** `/digest` summary sentence names the specific competitors contributing to `aboveBaselineCount`/`sustainedCount`; AI evidence bundle carries the same named lists; existing test suites extended (not replaced) to cover the new fields; zero new Prisma query count increase (query budget must remain at or below Phase 20's measured baseline).

---

## 18. Explicit Non-Goals

The following are explicitly out of scope for this audit's conclusions and for any Phase 22 scoped from it:
- No decision-support, strategy-inference, forecasting, or financial-estimation capability of any kind.
- No cross-competitor entity-level product matching.
- No opaque scoring, ranking, or "threat level" mechanism.
- No new extraction capability (sentiment, structured data beyond current JSON-LD/regex fallback).
- No changes to `getActivityPattern`/`getSustainedActivityTrend` window sizes or thresholds.
- No fix to the pre-existing Phase 20 E2E flake (documented, not touched, per task instruction).
- No README/status-line correction (noted as an aside only).

---

## 19. Repository Change Verification

```
$ git status --short
(clean before this phase's report was added)

$ git diff --stat
(no diff — this phase adds exactly one new file)
```

The only artifact created by this phase is `docs/phases/PHASE21-PRODUCT-VALUE-AND-INTELLIGENCE-MATURITY-AUDIT.md` itself. No production code, test, schema, migration, extraction, detection, AI, prompt, UI, or dependency file was modified. This was confirmed via `git status --short` before writing this report (clean tree) and no other tool in this session performed a Write/Edit against any path outside this report file.

---

## 20. Final Conclusion

CMA's deterministic intelligence model, as it stands after Phase 20, has crossed the threshold from "AI-assisted website monitoring" to "persistent competitive memory that a generic AI cannot reproduce," verified concretely in §11. The customer question matrix in §4 shows every question a real SMB customer would ask about a single competitor's own trajectory is answered; the two remaining partial gaps are an attribution/naming issue in an already-shipped cross-competitor composition (§17) and a state-transition refinement (§15 Candidate 2) that is not yet evidence-justified as more valuable than its risk of premature exposure. No composition, pattern, or fact type examined in §8 clears the bar of "genuinely new and clearly worth the risk." The correct next step is not a new intelligence phase but product validation of what has already been built, optional UI consolidation of underutilized existing signals, and — if any code change is made at all — the narrow, honestly-scoped attribution fix in §17.
