# Phase 15 — Intelligence Value & Signal Prioritization Audit

**Type:** Analysis only. No code, schema, extraction, or AI changed in this phase.
**Status:** PASS WITH FINDINGS
**Historical phases re-audited:** NO

---

## 1. Status

```
PASS WITH FINDINGS
```

## 2. Scope

```
Analysis-only.
No production implementation.
No schema changes.
No AI changes.
No extraction changes.
```

This report inherits Phase 9's product-direction gap analysis and Phase 14A/14B's sustained-trend
design and implementation as approved context. Neither is re-litigated. `getActivityPattern`,
`getRepeatedPriceChangePatterns`, `getSustainedActivityTrend`, `getDigestForOrganization`,
`buildDigestInterpretationInput`, and `validateDigestClaimSafety` were read directly against the
current repository (not restated from reports) to build the signal inventory in Section 4; none
were modified, and no contradiction with any prior phase's approved decision was found.

---

## 3. Executive Summary

CMA's deterministic ladder (Observation → Derived Fact → Pattern → Competitive Context → Digest →
Evidence-Grounded AI) is now fully built and internally consistent, verified directly against
`packages/db/src/repositories/patterns.ts`, `intelligence.ts`, `packages/ai/src/buildDigestContext.ts`,
and `validateDigestClaimSafety.ts`. Phase 14B added one genuinely new Tier 3 signal — sustained,
multi-window activity persistence — but deliberately confined it to the competitor detail page
only, per Phase 14A Section 11's Option 3. It is not yet Digest-visible, not yet AI-evidence,
and not yet part of `/compare`.

**Primary finding:** the highest-value next increment is not a new detector. It is composing three
signals that already exist and are already computed independently — `getActivityPattern`'s
current-window qualification, `getSustainedActivityTrend`'s persistence, and the digest's existing
`REPEATED_PRICE_CHANGE`/`LIFECYCLE` items — into one small, additive Digest surfacing decision:
give `getDigestForOrganization` a fifth item kind, `SUSTAINED_ACTIVITY_TREND`, populated by calling
the already-implemented, already-tested `getSustainedActivityTrend` verbatim, gated by
`sustained === true` (the same qualification-gate discipline every other digest item already
follows). This closes the still-open half of Phase 9's "what deserves attention" gap (Section 9
below) without adding a new detector, without touching AI, without a schema change, and without
reopening any approved decision from Phases 10–14B.

The entity-level "sustained repeated price-change" signal (Phase 14A Section 6.2) remains correctly
deferred — the identity-fragility argument in Phase 14A Section 7 is unchanged by anything found in
this audit (Section 10 below). No extraction gap was found that blocks a concrete, currently-askable
customer question (Section 11). AI changes remain out of scope for the recommended next phase
(Section 12).

---

## 4. Existing Intelligence Inventory

Verified directly against the current repository. "Consumed by Digest" / "Consumed by AI" means an
existing, already-shipped code path reads it today — not a hypothetical future integration.

| Signal | Location | Input data | Time horizon | Deterministic? | Persisted? | Level | Evidence | Min. history (D=30) | Cross-competitor? | Consumed by Digest? | Consumed by AI? | UI surface | Tests |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ChangeEvent` (raw observation) | `packages/detection/src/compare.ts` writes; `ChangeEvent` table | Page snapshots | Immediate | Yes (deterministic diff) | Yes (row per event) | Competitor/entity | `evidenceExcerpt`, `id` | 0 days | N/A | Yes (`CHANGE_EVENT` item, always eligible) | Yes (raw fact, cited by id) | Timeline, competitor detail, Digest | `packages/detection` suite |
| `getCompetitorActivityMetrics` / `compareCompetitors` | `intelligence.ts` | `ChangeEvent` counts, current vs. one prior period | Immediate (2-period delta) | Yes | No | Competitor | Implicit (counts) | 0 days (works from day 1, delta is 0 vs 0 initially) | Yes (`/compare`, descriptive only) | No (digest uses `ActivityPattern`, not this) | No | `/compare` | `intelligence.test.ts` |
| `getProductLifecycleSummary` | `intelligence.ts` | `getCompetitorActivityMetrics` byType breakdown | Immediate | Yes | No | Competitor | Implicit (counts) | 0 days | No (never lifted into `getCompetitiveContext` — Phase 9 Section 2 finding, still true) | No (digest derives lifecycle counts independently, in-memory, from the same window's raw events — not by calling this function; see `intelligence.ts` doc comment at `getDigestForOrganization`) | No | Competitor detail (`ProductLifecycleCard`) | `intelligence.test.ts` |
| `getEntityHistoryForCompetitor` | `patterns.ts` | `ChangeEvent` grouped by `(monitoredUrlId, entityKey)` | Full unbounded chronological series | Yes | No | Entity | Full event chain | 0 days (grows richer over time, no gate) | No | No | No | Competitor detail (implied by `PriceHistoryCard`/entity views) | `patterns.test.ts` |
| `getActivityPattern` | `patterns.ts` | `ChangeEvent.detectedAt` counts, current window vs. own 3-window historical baseline | Single-window-vs-baseline | Yes | No | Competitor | `changeEventIds` via digest's raw-event join | 90 days (2/3 windows), 120 days (full 3/3) | Yes (`/compare`, per-row, no ranking) | Yes (`ACTIVITY_PATTERN` item, gated `qualifies && events.length > 0`) | Yes (`facts.direction/ratio/current/baselineAverage/qualifyingWindows/strongEvidence`) | Competitor detail (`PatternsCard`), `/compare`, Digest | `patterns.test.ts` |
| `getRepeatedPriceChangePatterns` | `patterns.ts` | `PRICE_CHANGE` events grouped by `(monitoredUrlId, entityKey)`, single window | Single window, no baseline | Yes | No | Entity | `changeEventIds` | 0 days (no history gate; needs ≥2 changes inside one window, practically 30–60 days to accumulate 2 events) | No (per-competitor only; never unioned org-wide — Phase 9 Candidate C, still not built) | Yes (`REPEATED_PRICE_CHANGE` item, gated `qualifies`) | Yes (`facts.changeCount/days/qualifies`) | Competitor detail (`PatternsCard`), `/compare` (count only), Digest | `patterns.test.ts` |
| **`getSustainedActivityTrend`** (Phase 14B) | `patterns.ts` | `getActivityPattern` called verbatim at 2–3 consecutive `now` offsets | Multi-window persistence | Yes | No | Competitor | `lookback[]` (fully inspectable prior `ActivityPattern`s) + current window's `changeEventIds` | 120 days (2-window streak), 150 days (3-window streak) | **No** — not yet in `/compare` or the digest's `crossCompetitorContext` | **No** — not wired into `getDigestForOrganization` | **No** — no `EvidenceBundleItem` kind exists for it in `digestTypes.ts`/`buildDigestContext.ts` | **Competitor detail page only** (`SustainedTrendCard`) | `patterns.test.ts` (16 cases), `sustained-trend.spec.ts` (3 E2E) |
| `getCompetitiveContext` | `intelligence.ts` | `compareCompetitors` + `getActivityPattern` + `getRepeatedPriceChangePatterns`, per selected competitor | Same as its inputs | Yes | No | Competitor | Inherited | Same floors as inputs | Yes (this *is* the cross-competitor surface) | No | No | `/compare` | `intelligence.test.ts` |
| `getDigestForOrganization` | `intelligence.ts` | Composes `ChangeEvent`, `ActivityPattern`, `RepeatedPriceChangePattern` per active competitor; lifecycle derived in-memory from the same raw-event window | Fixed digest window (`days`) | Yes | No (live-computed per request) | Org-wide, per-competitor items | `changeEventIds` on every item (never empty) | Depends on constituent item; raw `CHANGE_EVENT` items available from day 1 | Yes — `crossCompetitorContext.aboveBaselineCount` (plain count, no ranking) | N/A (this is the composition layer) | Yes — sole input to `buildDigestInterpretationInput` | `/digest` page | `intelligence.test.ts`, `digest.spec.ts` |
| `buildDigestInterpretationInput` + `validateDigestClaimSafety` (Phase 11/12) | `packages/ai/src` | `DigestResult.items` (facts only, never raw page text mixed with facts) | Same window as the digest it was built from | AI output, deterministic gate | `DigestAiInterpretation` row per `(organizationId, days)` | Org-wide | `evidenceChangeEventIds` required per claim | Same as digest | Implicit (digest already aggregates) | N/A | N/A (this is the AI layer) | `/digest` (interpretation section) | `packages/ai` suite |

**Key finding from this table:** every deterministic signal below the "Digest" row is either
already Digest-visible or explicitly, deliberately not yet Digest-visible (`getSustainedActivityTrend`,
`getProductLifecycleSummary` as a standalone org-wide roll-up, `getRepeatedPriceChangePatterns`
unioned org-wide). The gap between "signal exists" and "signal reaches the one screen a customer
actually checks weekly" is the load-bearing gap this audit evaluates — not a missing detector.

---

## 5. Customer Question Coverage

Reconfirms and extends Phase 9 Section 4 against the current, Phase 14B-updated code.

| Customer question | Answerable today? | How |
|---|---|---|
| "What changed recently?" | Yes | `CHANGE_EVENT` digest items, Timeline |
| "Which competitor has been changing most often?" | Yes (descriptive, not ranked) | `/compare` (`totalChanges`), `crossCompetitorContext.aboveBaselineCount` |
| "Has this competitor's activity remained elevated for more than one period, or was it a blip?" | **Yes, since Phase 14B — but only on the competitor detail page** | `getSustainedActivityTrend` / `SustainedTrendCard` |
| "Is this behavior isolated or sustained?" | Same as above | Same |
| "Which products have changed price repeatedly?" | Yes (per competitor) | `getRepeatedPriceChangePatterns` / `REPEATED_PRICE_CHANGE` digest items |
| "What has happened to this product over time?" | Yes | `getEntityHistoryForCompetitor` |
| "Are multiple competitors showing similar activity right now?" | Yes (plain count, no causal claim) | `crossCompetitorContext.aboveBaselineCount` |
| "Are multiple competitors showing a *sustained* pattern right now?" | **No** | `getSustainedActivityTrend` has no org-wide count analogous to `aboveBaselineCount` |
| "What has consistently changed over the last few months, across everything I track, without me visiting every competitor page?" | **Partially** | The digest answers "what changed" and "what's a qualifying single-window pattern," but not "what has *persisted*" — a customer must still open each competitor's detail page to see `SustainedTrendCard` |

The one materially unanswered question that the product's own architecture is positioned to close
without new data is the last row: a persistence-aware digest.

---

## 6. Historical Value Analysis

| Horizon (D=30) | What is knowable today (before any new work) | What changes at this horizon |
|---|---|---|
| 0–7 days | Raw `ChangeEvent`s only; `getRepeatedPriceChangePatterns` can already show "1 change, not yet a pattern" (no baseline gate) | Digest and detail pages both show only raw facts |
| 7–30 days | Same, thicker | First single-window repeated-price qualifications become possible once 2 changes land inside one window |
| 30–90 days | `getActivityPattern` reports `INSUFFICIENT_HISTORY` throughout | No pattern-qualified digest items yet |
| **90 days** | `getActivityPattern` first qualifies (2/3 historical windows) | Digest's `ACTIVITY_PATTERN` items begin appearing; `getSustainedActivityTrend` returns `sustainedDataAvailable: false` (not yet, but no longer silently absent — it now has *something* to say) |
| **120 days** | Full 3-window baseline for `getActivityPattern`; **first day `getSustainedActivityTrend` can report `sustained: true` with a 2-window streak** | This is the exact horizon at which a persistence-aware digest item would first become possible — a **materially deeper claim than anything the digest currently shows**, because it requires successfully having called `getActivityPattern` twice at independent offsets and observed the *same* direction both times |
| 150 days | 3-window sustained streak becomes possible | `consecutiveQualifyingWindows` ceiling reached (capped by design at `MAX_SUSTAINED_LOOKBACK = 2`, so this only matters if that constant is later raised) |
| 180 days | Multiple competitors likely to cross the 120-day sustained floor at different, independent times | A cross-competitor "N of M competitors show a sustained pattern" count (mirroring `aboveBaselineCount`) becomes meaningful for the first time — this is new information no earlier horizon could produce, because it requires *multiple* competitors independently reaching the 120-day floor |
| 365+ days | Deep, multi-cycle history per competitor | A generic AI session started today has zero of this; the asymmetry Phase 9 Section 8 already documented for the 90-day activity pattern is now one tier deeper (120 days) for the sustained signal, and the gap only widens with account age |

**Where the product's historical memory starts creating differentiated value beyond what is
already shipped:** 120 days is already reached by `getSustainedActivityTrend` itself (Phase 14B).
The next differentiated value threshold is **not** a new time floor — it is the moment a customer
whose account has crossed 120 days actually *sees* the sustained signal somewhere other than a page
they have to remember to open. That is a distribution question (Digest visibility), not a data
question.

---

## 7. Signal Novelty Analysis

| Candidate | Classification | Rationale |
|---|---|---|
| `getSustainedActivityTrend` in the Digest (new `DigestItemKind`) | **C — composition that creates a materially more useful interpretation** | Not new data (reuses `getActivityPattern` verbatim, already computed for the `ACTIVITY_PATTERN` item in the same digest call). Not mere repackaging either — a digest item stating "sustained for N consecutive periods" is qualitatively different from "current period qualifies," because it requires the *history* of a prior independent qualification, not just the current one. This is exactly Section 12's canonical composition example. |
| Cross-competitor "N of M sustained" count | **C — composition** | Same shape as the already-shipped `aboveBaselineCount`, applied to `getSustainedActivityTrend.sustained` instead of `getActivityPattern.direction`. Zero new data; a materially different claim (persistence, not a snapshot). |
| Sustained activity + recent activity distinction ("one-off spike" vs. "spike within an already-sustained period") | **C — composition** | See Section 9.A below — answerable today by checking whether the digest's `ACTIVITY_PATTERN` item's competitor also has `sustained: true` from `getSustainedActivityTrend`, computed once per competitor per digest call (already computed, not re-derived). |
| Sustained activity + repeated price changes co-occurrence | **C — composition, with a caveat** | See Section 9.B. Structurally cheap (both are already per-competitor pattern calls in the same digest loop), but the resulting sentence risks implying a causal link between two independent facts unless phrased with care (Section 9.B expands on the exact safe phrasing). |
| Lifecycle + sustained activity co-occurrence | **C — composition, weaker justification** | See Section 9.C. Technically trivial (both are per-competitor booleans in the same loop) but the *customer value* of stating this specific co-occurrence is thinner than 7A/7B — flagged as lower priority, not rejected. |
| Entity-level sustained repeated price-change pattern | **A — genuinely new information, but blocked** | Would be new (no existing function reports "this specific product repriced repeatedly across 2+ consecutive windows"), but is blocked by the `entityKey` identity fragility documented in Phase 14A Section 7 (unchanged — see Section 10 below). |
| Severity/category-weighted digest ordering | **B — mostly repackaging** | `ChangeEvent.severity` is already stored and already unused (Phase 9 Section 2, still true — confirmed by grep: no pattern or digest function reads `.severity` for anything other than display in `ChangeEventDigestItem.severity`). Reordering existing items by an existing field is a real but modest improvement, not new information. |
| Volatility / variance metric | **Rejected in Phase 14A, reconfirmed here** | No defensible non-arbitrary formula was found; nothing in this audit changes that conclusion. |
| Promotion pattern | **N/A — no data exists** | `structuredData.ts` still only emits `type: "PRICE"` or `type: "GENERIC"` (re-verified by direct grep in this audit); `PROMOTION`/`PLAN` remain schema-only enum values with zero producers. |

---

## 8. "What Deserves Attention?" Analysis

Phase 9 identified this as the core structural gap: an organization-level mechanism for "what
deserves attention now." Phase 10 (Digest) closed the *recency* half of this gap — a customer no
longer has to visit every competitor page to see what changed. Phase 14A/14B added a genuinely new
*persistence* signal but explicitly scoped it out of the digest (Phase 14A Section 11, Option 3,
chosen deliberately as the smallest safe first cut).

This audit's finding: **the "what deserves attention" gap is not closed by another detector — it is
closed by finishing the distribution of a detector that already exists.** The current architecture
already supports this without redesign:

```
Existing signals (ActivityPattern, SustainedActivityTrend, RepeatedPriceChangePattern, Lifecycle)
      ↓
Signal composition (per-competitor loop already inside getDigestForOrganization)
      ↓
Attention-worthy deterministic items (a new SUSTAINED_ACTIVITY_TREND digest item, gated on
`sustained === true`, exactly like every other digest item is gated on its own qualification flag)
```

This is the "existing signals → composition → attention-worthy item" path the brief asks to
prefer over "existing signals → another isolated detector." No new detector is required; the
detector (`getSustainedActivityTrend`) was already built in Phase 14B specifically to be reusable
for this purpose (Phase 14A Section 12 explicitly pre-specified the future `EvidenceBundleItem`
contract for exactly this composition, anticipating this exact next step).

---

## 9. Digest Gap Analysis

### 9.1 Which existing signals can already appear meaningfully in Digest?

All of them except `getSustainedActivityTrend` and the org-wide `getRepeatedPriceChangePatterns`
union (Candidate C, Phase 9) already appear. The digest's four current item kinds
(`CHANGE_EVENT`, `REPEATED_PRICE_CHANGE`, `ACTIVITY_PATTERN`, `LIFECYCLE`) exhaust the
already-Digest-eligible signal set from Section 4 except the sustained trend.

### 9.2 Which signals currently exist but are stranded on detail pages?

`getSustainedActivityTrend` — confirmed stranded by direct code read: `SustainedTrendCard` is
imported only by the competitor detail page (`apps/web/src/app/(app)/competitors/[competitorId]/page.tsx`);
it is not imported by `/digest/page.tsx`, `/compare`, or any AI-facing file. `intelligence.ts`'s
`getDigestForOrganization` has zero references to `getSustainedActivityTrend` (confirmed by grep).

### 9.3 Should Phase 14B's sustained trend eventually be Digest-visible?

Yes — this is this audit's primary recommendation (Section 15). Phase 14A Section 11 already
reasoned through the three integration options and explicitly named Option 1 (new `DigestItemKind`)
as "the correct target for a follow-up phase once the signal has been validated on the detail
page" (Phase 14A Section 11, verbatim). Phase 14B's validation report closes with "First assess the
real customer/product value demonstrated by this phase" before deciding the next step for the
*entity-level* signal specifically — it does not gate the competitor-level signal's own Digest
promotion on anything further, since the competitor-level signal has no identity dependency to
de-risk further.

### 9.4 Can a Digest item combine multiple existing deterministic signals without introducing a score?

Yes, in the specific, narrow sense already established by the existing `ACTIVITY_PATTERN` item
(which itself already combines `ChangeEvent` evidence + a computed ratio + a qualification flag
without becoming a score). A `SUSTAINED_ACTIVITY_TREND` item would carry:
`{ consecutiveQualifyingWindows: number, direction: string }` — two explainable, inspectable
numbers/enums, structurally identical in spirit to `ActivityPatternDigestItem`'s existing
`pattern.ratio`/`pattern.qualifyingWindows`. This does **not** become an opaque score because every
field is independently reconstructible from the `lookback` array already returned by
`getSustainedActivityTrend`.

### 9.5 Does the resulting item remain explainable and evidence-grounded?

Yes, with one caveat already flagged in Phase 14A Section 6.1: the sustained claim's *evidence*
(`changeEventIds`) is the current window's raw events (same as `ACTIVITY_PATTERN` already cites),
not new evidence — the "sustained" part of the claim is a claim about the *pattern's own repeated
qualification*, not a new fact requiring its own citation. This must be stated in the item's
description exactly as Phase 14A Section 6.1 already specifies ("this also held N periods ago, with
a citable number, not just an assertion") — the number is `consecutiveQualifyingWindows`, already
returned, never a new invented figure.

---

## 10. Composition Analysis (Section 12 of the brief)

### A. Sustained activity + recent activity — distinguishing a one-off spike from activity within an already-sustained period

**Status: valid now, small deterministic implementation.** Both facts already exist independently
per competitor inside `getDigestForOrganization`'s per-competitor loop: the `ACTIVITY_PATTERN` item
(current window qualifies) and — if wired in per Section 9 — the `SUSTAINED_ACTIVITY_TREND` item
(`sustained: true/false`). A digest consumer (UI or the AI evidence bundle) can already distinguish:

- "Activity qualifies as above-baseline in the current window, **and** this is the third consecutive
  qualifying window" (`sustained: true`) — a materially stronger, evidence-grounded claim.
- "Activity qualifies in the current window, but the immediately preceding window did not"
  (`sustained: false`, `sustainedDataAvailable: true`) — a one-off, explicitly distinguished.

No new scoring is introduced: both states are already booleans/enums returned by existing functions.
This composition requires no new query beyond calling `getSustainedActivityTrend` in the same
per-competitor `Promise.all` the digest already runs (it currently calls only `getActivityPattern`
and `getRepeatedPriceChangePatterns` there — adding a third parallel call is the same shape of
change, not a new architectural pattern).

### B. Sustained activity + repeated price changes co-occurring

**Status: valid now, requires care in phrasing.** Both are already independently computed per
competitor in the same digest loop. A factual, defensible statement is possible:

> "Product X has repriced repeatedly (2+ times) during a period in which this competitor's overall
> activity has remained above its historical baseline for 2+ consecutive tracked periods."

This is a **conjunction of two independently true facts about the same time window**, not a claim
that one caused or explains the other. It must be phrased exactly this way — a conjunction, never
"because," "as part of," or "driven by" (all three phrases are already blocked by the existing
`causal-explanation` claim-safety category in `validateDigestClaimSafety.ts`, confirmed present and
unmodified). **This composition is safe to state deterministically in the UI today; it must not be
phrased as causal even by a human copy-writer**, and any future AI-generated version of this
sentence is already covered by the existing seven claim-safety categories with no new category
needed (matching Phase 14A Section 12's conclusion for the sustained signal alone).

### C. Lifecycle + sustained activity — repeated product additions/removals during a sustained elevated period

**Status: valid now, weaker customer-value justification than A/B.** Technically identical
composition cost (both are per-competitor items already computed in the same loop). However, the
customer question this answers ("were product changes concentrated during an already-elevated
period?") is narrower and less immediately actionable than A (spike-vs-sustained) or B
(product-specific repricing pattern). This audit does not reject it, but ranks it below A/B for the
same reason Phase 9 Section 10 ranked Candidate D below A: it is better understood as a documented,
optional refinement of the Digest's existing `LIFECYCLE` item description than a standalone
composition worth its own implementation slot in the next phase.

### D. Cross-competitor context + temporal persistence ("N of M tracked competitors show a sustained pattern")

**Status: valid now, same shape as an already-shipped precedent.** `crossCompetitorContext.aboveBaselineCount`
already computes exactly this shape of statement for the single-window signal
(`perCompetitorResults.filter((r) => r.activityPattern.direction === "ABOVE_BASELINE").length`,
confirmed in `intelligence.ts`). Applying the identical counting pattern to
`getSustainedActivityTrend.sustained` requires zero new architecture — literally the same
`.filter(...).length` shape, over a value already computed once `getSustainedActivityTrend` is
added to the per-competitor loop (Composition A). This is the most direct application of Phase 14A
Section 15's already-approved allowed statement: *"N of your M tracked competitors currently show a
sustained above-baseline activity pattern (2 or more consecutive tracked periods)."*

---

## 11. Entity-Level Price Intelligence Decision (Phase 14A Section 6.2, deferred)

**Remains deferred.** This audit re-examined Phase 14A Section 7's identity-fragility argument
against the current code (not merely re-cited it) and found no change:

- `structuredData.ts` still derives `entityKey = "jsonld:" + name.toLowerCase()` for JSON-LD
  entities with no whitespace/punctuation normalization and no reconciliation logic anywhere in the
  codebase (confirmed by direct read; unchanged since Phase 14A).
- `GENERIC` (regex-fallback) entities are still keyed by a context-hash and still explicitly
  excluded from add/remove diffing.
- No entity-matching or rename-reconciliation code was added in Phase 14B or any phase since.

**Decision:** the entity-level "sustained repeated price-change" pattern (Phase 14A Section 6.2)
does not yet provide enough incremental customer value to justify its identity risk, because the
identity risk is unchanged and the customer-facing failure mode (a JSON-LD label change silently
resetting a sustained streak with zero signal that this happened) has not been mitigated by any
work done since Phase 14A. This is not a new finding — it confirms Phase 14A's own conclusion still
holds. **Not recommended for the next phase.**

---

## 12. Extraction Gap Analysis

Re-verified directly against `packages/extraction/src/structuredData.ts` (grep for every emitted
`type:` literal): only `"PRICE"` (from JSON-LD) and `"GENERIC"` (regex fallback) are ever produced.
`PROMOTION` and `PLAN` remain schema-only `EntityType` enum values with zero code paths producing
them, exactly as Phase 9 Section 15 and Phase 14A Section 2 both already documented.

Applying the "concrete customer question, not a roadmap wishlist item" test:

- **Promotions:** no concrete customer question currently goes unanswered *because* promotions
  aren't extracted — no existing signal, Digest item, or UI surface references promotions at all,
  so there is no "we can see the shape of the gap but not fill it" situation, only a genuinely
  absent capability. This remains an interesting future capability, not a current bottleneck (the
  distinction the brief asks for).
- **Availability, pricing-plan changes, messaging/feature changes, structured product metadata:**
  none of these were found to block any of the customer questions already catalogued in Section 5.
  No customer question in this audit's inventory reduces to "I need availability data and cannot
  get it any other way."

**Conclusion: no extraction gap in the current codebase currently blocks a concrete, presently-
askable customer question.** The extraction surface is sufficient for every signal composition
recommended in Section 10.

---

## 13. AI Evidence Analysis

Which deterministic signals would provide the strongest evidence bundle for future AI
interpretation, without requiring unsupported causal language?

| Combination | Evidence richness | Provenance | Reproducibility | Unsupported-inference risk | AI value |
|---|---|---|---|---|---|
| `ACTIVITY_PATTERN` alone (current) | Moderate | Strong (`changeEventIds`) | Fully deterministic | Low (already claim-safety-gated) | Already interpreted (Phase 11/12) |
| `ACTIVITY_PATTERN` + `SUSTAINED_ACTIVITY_TREND` (Composition A) | **High** — a persistence claim backed by two independently-computed qualifications, both fully reproducible from `lookback` | Strong (same `changeEventIds`, plus fully inspectable `lookback[]` numbers) | Fully deterministic | Low — the existing 7-category claim-safety gate already blocks the exact vocabulary risk ("escalating," "aggressive") this combination would tempt, per Phase 14A Section 12's own analysis | **High** — this is the single richest evidence bundle not yet exposed to the AI layer; "sustained for N periods" is a genuinely stronger, more decision-relevant claim than a single-window ratio |
| `ACTIVITY_PATTERN`/`SUSTAINED` + `REPEATED_PRICE_CHANGE` (Composition B) | High | Strong | Deterministic | Moderate — phrasing risk (Section 10.B) must be enforced as a conjunction, not a causal link; existing claim-safety categories already cover this | Moderate-high, contingent on correct conjunction phrasing in the prompt-construction layer (a future phase's concern) |
| Cross-competitor sustained count (Composition D) | Moderate | Strong (count is a `.filter().length` over already-cited per-competitor claims) | Deterministic | Low | Moderate — useful context, lower marginal value than A |

**Conclusion:** `getSustainedActivityTrend` is currently the single richest deterministic signal
that exists in the codebase today but has **zero** AI-evidence exposure (confirmed: no
`EvidenceBundleItem` kind, no `factsForItem` case, no `DigestItemKind` value references it anywhere
in `packages/ai`). Wiring it into the Digest (Section 15) is also the natural, minimal prerequisite
for eventually exposing it to AI interpretation — but AI exposure itself remains explicitly out of
scope for the phase this audit recommends (Section 15/16).

---

## 14. Commodity / Differentiation Analysis

| Candidate | Does it increase accumulated competitive memory? | Commodity? |
|---|---|---|
| `SUSTAINED_ACTIVITY_TREND` Digest item | Yes — its very existence requires 120 days of this specific organization's own accumulated `ChangeEvent` history; a competitor product with no historical memory cannot produce this signal on day 1 regardless of engineering effort | No — not a commodity feature (generic "website change alert" tools do not compute multi-window own-baseline persistence) |
| Cross-competitor sustained count | Yes — same dependency, applied across the tracked set | No |
| Composition B (sustained + repeated price co-occurrence) | Yes — same dependency, plus entity-level history | No, provided phrasing discipline (Section 10.B) is enforced |
| Severity/category-weighted ordering | Weak — the *underlying* data (already stored `severity`) is what has memory value; the sort itself is orthogonal to history depth | Borderline — a generic tool could apply a similar sort to any data; the defensibility is entirely in the data being sorted, not the sort |
| Promotion pattern | N/A — no data exists to accumulate | N/A |
| Entity-level sustained repricing | Would be non-commodity if built, but blocked (Section 11) | N/A (deferred) |
| Generic AI chat wrapper over the same data | No — a chat UI adds no history dependency of its own | Yes — explicitly rejected per Phase 9 Section 6's own analysis, unchanged |

---

## 15. Candidate Decisions

```
READY FOR IMPLEMENTATION
```
- Wire `getSustainedActivityTrend` into `getDigestForOrganization` as a new `SUSTAINED_ACTIVITY_TREND`
  `DigestItemKind`, gated on `sustained === true` (mirroring every other item's own-qualification
  gate), rendered with the same evidence (`changeEventIds` from the current window) plus the
  already-computed `consecutiveQualifyingWindows`/`direction` fields — no new query beyond adding
  `getSustainedActivityTrend` to the existing per-competitor `Promise.all`.
- Extend `crossCompetitorContext` with a `sustainedCount` field (Composition D), same `.filter().length`
  shape as the existing `aboveBaselineCount`.

```
STRONG CANDIDATE — REQUIRES SMALL DETERMINISTIC EXTENSION
```
- Composition B's conjunction sentence ("repriced repeatedly during a sustained above-baseline
  period") as an enrichment of the `REPEATED_PRICE_CHANGE` digest item's description, gated on both
  facts being true for the same competitor in the same window — requires only reading two
  already-computed values together, but needs a documented, reviewed phrasing rule to avoid
  drifting into causal language (Section 10.B).
- Extending `buildDigestInterpretationInput`/`factsForItem` with a `sustained` fact set once the
  Digest item exists (Section 13) — small, additive, mirrors the existing `ACTIVITY_PATTERN` case
  exactly, per Phase 14A Section 12's pre-specified contract.

```
REQUIRES MORE DATA / HISTORY
```
- None of the candidates above require more historical data than customers already have where the
  underlying `getSustainedActivityTrend`/`getActivityPattern` already qualifies — they are
  presentation/composition gaps, not data-availability gaps.

```
BLOCKED BY ENTITY IDENTITY
```
- Entity-level sustained repeated price-change pattern (Phase 14A Section 6.2) — confirmed still
  blocked in Section 11 above; no change since Phase 14A.

```
DEFERRED
```
- Composition C (lifecycle + sustained co-occurrence) — technically valid, lower customer-value
  justification than A/B/D (Section 10.C); revisit after A/B/D ship and usage data exists.
- `/compare` integration of `getSustainedActivityTrend` (Phase 14A Section 20's open question) —
  not required to prove the Digest integration's value; a small, additive follow-up once the Digest
  item exists.
- Severity/category-weighted digest ordering (Phase 9 Candidate D) — still correctly scoped as a
  modifier to fold into an existing surface later, not a standalone phase.
- Org-wide `getRepeatedPriceChangePatterns` union (Phase 9 Candidate C) — real, cheap, but no new
  finding in this audit elevates it above the sustained-trend Digest work; unchanged priority since
  Phase 9.

```
NOT CURRENTLY JUSTIFIED
```
- Volatility/variance metric — no defensible formula found (Phase 14A, reconfirmed).
- Promotion pattern — no extractor produces the underlying data (Section 12).
- Cross-competitor product/plan equivalence — no defensible identity model exists.
- Any AI change in this phase — the richest new evidence (`getSustainedActivityTrend`) is not yet
  even Digest-visible; wiring AI to a signal the Digest itself does not yet surface would be
  premature (Section 13's conclusion).

---

## 16. Recommended Next Phase

**Phase 16 (proposed name: "Sustained Trend Digest Integration") should implement exactly:**

1. Add `getSustainedActivityTrend(organizationId, competitorId, days, now)` to the existing
   per-competitor `Promise.all` inside `getDigestForOrganization` (`intelligence.ts`), alongside the
   already-called `getActivityPattern`/`getRepeatedPriceChangePatterns`.
2. Add a fifth `DigestItemKind`, `SUSTAINED_ACTIVITY_TREND`, inserted into `DIGEST_ITEM_KIND_ORDER`
   at a documented position (immediately after `ACTIVITY_PATTERN`, matching Phase 14A Section 11
   Option 1's original suggestion). Item carries `consecutiveQualifyingWindows`, `direction`, and
   the current window's `changeEventIds` — no new evidence type, no score.
3. Inclusion rule: only when `trend.sustained === true` (mirrors every other item's own
   qualification gate exactly — `REPEATED_PRICE_CHANGE` gates on `.qualifies`, `ACTIVITY_PATTERN`
   gates on `.qualifies && events.length > 0`).
4. Add `sustainedCount` to `DigestCrossCompetitorContext`, computed identically to
   `aboveBaselineCount` but over `.sustained` instead of `.direction === "ABOVE_BASELINE"`.
5. Extend `EvidenceBundleItem`/`factsForItem` in `packages/ai` with one additive, optional field set
   for the new kind (`consecutiveQualifyingWindows`, `direction`) — the exact contract Phase 14A
   Section 12 already pre-specified. No new claim-safety category (the existing seven already cover
   this vocabulary risk, per Phase 14A Section 12's own conclusion, reconfirmed in Section 13 above).
6. UI: render the new item on `/digest` reusing the neutral-language conventions already
   established by `SustainedTrendCard`/`patternDisplay.ts` ("Sustained for N consecutive tracked
   periods" — never "escalating," "aggressive," or "winning").
7. Tests: extend `intelligence.test.ts`'s existing digest composition/ordering/gating suite with the
   new item kind (inclusion gate, ordering position, tenant isolation, evidence non-emptiness);
   extend `digest.spec.ts` E2E with a seeded 150+-day fixture proving the item appears, and a
   <120-day fixture proving it is correctly absent (not fabricated as "not sustained" — simply
   absent, matching every other qualification-gated item's convention).

**Explicitly NOT part of this recommended next phase** (see Section 17): Composition B's conjunction
sentence, `/compare` integration, the entity-level sustained pattern, any new extraction, any
volatility metric, any severity-based reordering.

**If the evidence pointed elsewhere:** it does not. Every prerequisite for this scope already
exists, tested, in the codebase (`getSustainedActivityTrend` itself, the digest's existing
per-item-kind gating convention, the AI evidence-bundle's existing additive-field convention). No
further signal needs to be built before this composition is possible.

---

## 17. Explicit Non-Goals

Do **not** implement in the next phase:

- Do **not** build the entity-level sustained repeated price-change pattern (Section 11 — still
  blocked by identity fragility, unchanged since Phase 14A).
- Do **not** add a volatility/variance metric (no defensible formula, reconfirmed).
- Do **not** add promotion-pattern intelligence (no extractor produces the data).
- Do **not** add cross-competitor product/plan equivalence matching (no defensible identity model).
- Do **not** add any new AI prompt, provider call, or claim-safety category beyond the additive,
  optional `factsForItem` field extension in item 5 of Section 16 — no new category is needed.
- Do **not** add opaque scoring, importance ranking, or "top N" truncation anywhere in the digest.
- Do **not** implement Composition B's conjunction sentence or Composition C's lifecycle
  co-occurrence in this phase — both are real, but deferred/strong-candidate status, not
  ready-for-implementation (Section 15).
- Do **not** modify `getActivityPattern`, `getRepeatedPriceChangePatterns`, or
  `getSustainedActivityTrend` themselves — every one of them is reused verbatim in the recommended
  scope, exactly as Phase 14A/14B's own non-goals already require.
- Do **not** re-open or re-validate Phase 10, 11, 12, 13, or 14B's own approved implementations —
  this audit found no contradiction requiring that.

---

## 18. Validation / Repository Evidence

This is an analysis-only phase; no test suite was run beyond what was necessary to ground factual
claims in the current source (grep/read, not execution — matching Phase 9 and Phase 14A's own
"analysis-only, no test suite executed" convention).

Evidence gathered, all via direct repository inspection (not restated from prior reports):

- `packages/db/src/repositories/patterns.ts` — read in full for `getActivityPattern`,
  `getRepeatedPriceChangePatterns`, `getSustainedActivityTrend` (confirms Phase 14A/14B's
  descriptions match the shipped code exactly).
- `packages/db/src/repositories/intelligence.ts` — read in full for `getDigestForOrganization`,
  `DigestItemKind`, `DigestCrossCompetitorContext`, `getCompetitiveContext`, `compareCompetitors`,
  `getProductLifecycleSummary` (confirms the four current item kinds, the `aboveBaselineCount`
  precedent, and that `getSustainedActivityTrend` is never referenced here).
- `packages/ai/src/buildDigestContext.ts` — read for `factsForItem`/`toEvidenceBundleItem` (confirms
  the four-kind `switch` has no case for a sustained-trend kind).
- `packages/ai/src/validateDigestClaimSafety.ts` — grepped for the seven claim-safety categories
  (confirms they are present and unmodified, and confirms the specific phrases Section 10.B/13
  reference are already blocked).
- `packages/db/prisma/schema.prisma` — grepped for `EntityType` (confirms `PROMOTION`/`PLAN` remain
  enum-only).
- `packages/extraction/src/structuredData.ts` — grepped for every emitted `type:` literal (confirms
  only `PRICE`/`GENERIC` are ever produced).
- `apps/web/src/app/(app)/competitors/[competitorId]/page.tsx` — grepped to confirm
  `SustainedTrendCard` is imported only here, not on `/digest` or `/compare`.
- `docs/phases/PHASE9-PRODUCT-DIRECTION-AUDIT.md`, `PHASE14A-HISTORICAL-INTELLIGENCE-DESIGN-AUDIT.md`,
  `PHASE14B-VALIDATION-REPORT.md` — read in full as approved context, not re-litigated.

No production, schema, extraction, or AI file was modified during this phase.

```bash
git status --short
git diff --stat
```

The only expected change is this report file itself.

---

## Final Decision

```
PHASE 15 — INTELLIGENCE VALUE & SIGNAL PRIORITIZATION AUDIT

Status:
PASS WITH FINDINGS

Production changes:
NONE

Schema changes:
NONE

AI changes:
NONE

Extraction changes:
NONE

Primary finding:
CMA's deterministic ladder (Observation -> Derived Fact -> Pattern -> Competitive Context ->
Digest -> Evidence-Grounded AI) is complete and internally consistent. Phase 14B added a
genuinely new, deterministic, evidence-grounded persistence signal (getSustainedActivityTrend)
but deliberately confined it to the competitor detail page. The highest-value next increment is
NOT a new detector - it is composing that already-existing, already-tested signal into the
Digest (a new SUSTAINED_ACTIVITY_TREND item kind, gated on `sustained === true`, plus a
cross-competitor sustained count mirroring the existing aboveBaselineCount) and, as an additive
follow-up, into the AI evidence bundle. This closes the remaining half of Phase 9's "what
deserves attention" gap using data and functions that already exist, with zero new extraction,
zero schema change, and zero new AI category required (the existing seven claim-safety
categories already cover this signal's vocabulary risk).

Next implementation scope:
1. Add getSustainedActivityTrend to getDigestForOrganization's existing per-competitor
   Promise.all.
2. Add a fifth DigestItemKind, SUSTAINED_ACTIVITY_TREND, gated on `sustained === true`.
3. Add `sustainedCount` to DigestCrossCompetitorContext (same shape as aboveBaselineCount).
4. Extend buildDigestInterpretationInput/factsForItem with one additive, optional field set for
   the new kind - no new claim-safety category needed.
5. UI: render the new item on /digest reusing SustainedTrendCard's existing neutral-language
   conventions.
6. Tests: extend intelligence.test.ts and digest.spec.ts with the new item kind's inclusion
   gate, ordering, tenant isolation, and evidence non-emptiness.

Deferred:
Entity-level sustained repeated price-change pattern (blocked by entityKey identity fragility,
unchanged since Phase 14A); Composition B's sustained+repeated-price conjunction sentence and
Composition C's lifecycle+sustained co-occurrence (both valid, lower priority than the core
Digest wiring); /compare integration of the sustained signal; severity/category-weighted digest
ordering; org-wide repeated-price-change union (Phase 9 Candidate C); volatility metric
(rejected, no defensible formula); promotion pattern (rejected, no extractor produces the data);
cross-competitor product/plan equivalence (rejected, no defensible identity model).

Historical phases re-audited:
NO
```
