# Phase 9 — Product Direction & Intelligence Gap Audit

**Type:** Analysis only. No code, schema, or UI changed in this phase.

---

## 1. Executive Summary

CMA has built, over Phases 1–8, a genuinely defensible three-tier
deterministic ladder: **Observation** (`ChangeEvent`) → **Derived Fact**
(`getCompetitorActivityMetrics`, `compareCompetitors`) → **Pattern**
(`getActivityPattern`, `getRepeatedPriceChangePatterns`, both org-scoped,
minimum-sample-gated, and now shown side-by-side across a customer's
tracked competitor set via `getCompetitiveContext`). This is real
architecture, not a demo: every number traces to a `ChangeEvent` row, every
pattern refuses to answer below a documented sample-size threshold, and
tenant isolation is unit- and E2E-tested at every layer.

**The gap is not "not enough AI."** It is that the product currently
answers **single-competitor, single-metric** questions ("is this
competitor above its own baseline?") but cannot yet answer the questions
that make a customer log in every week: *"what changed across everything
I monitor that I should actually look at,"* and *"is my picture of this
competitor's behavior evolving over time, or did I only just start
noticing it?"* Both of those require assembling multiple already-computed
facts into one coherent unit — not new math, not AI, not a new dashboard.

**Recommended next capability (this audit's conclusion, argued in Section
10):** a deterministic **Digest / Notable-Changes surface** built by
composing the patterns and derived facts that already exist
(`getCompetitiveContext`, `getActivityPattern`,
`getRepeatedPriceChangePatterns`, `getProductLifecycleSummary`) into one
ranked-by-recency (never ranked-by-importance-score), evidence-linked feed
per organization, gated by the same minimum-sample discipline Phase 7
established. This is Tier 3.5, not Tier 4: it requires zero new AI calls,
zero new schema, and turns "log in and manually check 5 competitor pages"
into "read one screen." AI interpretation on top of it (Tier 4) is
explicitly the *following* phase, not this one — see Section 14.

**What this audit found but did not fix (Section 15):** none. No
implementation contradiction was discovered that changes this
recommendation; Phase 7.1's and Phase 8's own validation reports already
document the one real historical bug (fixed in 7.1) and the one
pre-existing, unrelated E2E flake (documented in both 7.1 and 8, never
re-opened here).

---

## 2. Current Intelligence Capability (as implemented, verified against code)

Verified directly against `packages/db/prisma/schema.prisma`,
`packages/db/src/repositories/patterns.ts`,
`packages/db/src/repositories/intelligence.ts`, and
`packages/extraction/src/structuredData.ts` — not merely restated from
prior reports.

| Tier | Capability | Where | Status |
|---|---|---|---|
| 1. Observation | `ChangeEvent` (PRICE_CHANGE, PRODUCT_ADDED, PRODUCT_REMOVED, CONTENT_CHANGE; PROMOTION_CHANGE defined but never emitted) | Phase 1–3 | **Implemented** |
| 2. Derived Fact | `getCompetitorActivityMetrics`, `compareCompetitors`, `getProductLifecycleSummary`, `getPriceHistoryForCompetitor` | Phase 6 | **Implemented** |
| 2.5 Entity history | `getEntityHistoryForCompetitor` — full added→repriced→removed timeline per `(monitoredUrlId, entityKey)` | Phase 7 | **Implemented** |
| 3. Pattern (single competitor) | `getActivityPattern` (activity-vs-own-3-window-baseline), `getRepeatedPriceChangePatterns` (≥2 price changes per entity per window) | Phase 7/7.1 | **Implemented**, minimum-sample gated, boundary-tested |
| 3.5 Pattern (cross-competitor, descriptive) | `getCompetitiveContext` — same pattern fields, one row per selected competitor, no ranking | Phase 8 | **Implemented** |
| 4. AI Interpretation | none | — | **Not implemented** (by design; every phase's grep audit confirms 0 new AI call sites in the pattern/context layer) |
| 5. Hypothesis | none | — | **Not implemented** |

**What is stored but underexploited today:**

1. `getEntityHistoryForCompetitor`'s per-product lifecycle exists but is
   only ever rendered on the single-competitor detail page. It is never
   aggregated ("which products, across all my competitors, have
   repriced ≥2 times this month") or surfaced anywhere near-real-time.
2. `getProductLifecycleSummary` (added/removed counts) exists at the
   per-competitor derived-fact tier but was never lifted into
   `getCompetitiveContext` alongside activity/repeated-price — Phase 8
   deliberately scoped only two of the three available Phase 7 signals
   into the compare table (Section 9 of PHASE8-DESIGN.md explicitly
   defers `getEntityHistoryForCompetitor` at the table level, but does
   not address why lifecycle *counts*, which already exist as a
   `compareCompetitors`-shaped derived fact, are also absent from the
   context row).
3. `ChangeEvent.severity` (LOW/MEDIUM/HIGH, populated since Phase 1) is
   stored on every row and is never read by any pattern or derived-fact
   function — `getActivityPattern` and `getRepeatedPriceChangePatterns`
   both count events uniformly regardless of severity. This is a real,
   already-captured signal sitting unused.
4. `Organization.timezone` and per-`MonitoredUrl` `category`
   (`PRICING_PAGE`/`PRODUCT_PAGE`/`GENERAL`) are read for window alignment
   and never used to weight or scope what surfaces to a customer (e.g. a
   customer who tracks only pricing pages implicitly cares more about
   price patterns than content patterns — noted in
   `PHASE7-INTELLIGENCE-MODEL.md` as a real signal, never acted on).

---

## 3. Implemented vs. Missing Intelligence

| Capability | Implemented? | Notes |
|---|---|---|
| Single ChangeEvent + evidence | ✅ | Phase 1–3 |
| Per-competitor activity counts (current vs. one prior period) | ✅ | Phase 6 |
| Per-competitor activity vs. own 3-window historical baseline | ✅ | Phase 7/7.1 |
| Repeated price-change detection per entity | ✅ | Phase 7 |
| Full entity lifecycle history (added→repriced→removed) | ✅ | Phase 7, detail page only |
| Cross-competitor side-by-side pattern comparison (descriptive) | ✅ | Phase 8, `/compare` only |
| **Cross-organization "what should I look at today/this week" digest** | ❌ | **Gap — Section 10** |
| **Entity-level pattern aggregation across competitors** ("which products anywhere in my tracked set repriced repeatedly") | ❌ | **Partial gap — data exists per-competitor, never aggregated org-wide** |
| Severity-weighted or category-weighted relevance | ❌ | Data captured, unused |
| Sustained multi-window trend (3+ consecutive above-baseline windows) | ❌ | `getActivityPattern` only ever compares current vs. baseline; it does not look at whether *the previous* current window was also above baseline |
| Cross-competitor simultaneous-activity detection ("2+ competitors both had above-baseline activity in the same window") | ❌ | Deferred; would be a thin descriptive layer over existing per-competitor patterns |
| Promotion pattern | ❌ (by data gap) | No extractor emits `PROMOTION`-typed entities anywhere in the codebase (reconfirmed by grep in this audit — Section 15) |
| AI interpretation of any pattern | ❌ | Deliberately deferred every phase |
| Product/plan cross-competitor normalization | ❌ | No defensible identity model exists |
| Any ranking/score/"winner" | ❌ (by design, permanent) | Explicit non-goal since Phase 6 |

---

## 4. Customer Question Matrix

| Question | Answerable today? | How |
|---|---|---|
| What changed? | ✅ | ChangeEvent + evidence |
| Which competitor changed something? | ✅ | Timeline / compare table |
| What price changed? | ✅ | ChangeEvent, PriceHistoryCard |
| What product was added/removed? | ✅ | ProductLifecycleCard, `getProductLifecycleSummary` |
| Has this competitor been changing more often recently? | ✅ (after 90 days) | `getActivityPattern` |
| Is this behavior unusual for this competitor? | ✅ (after 90 days, own-baseline only) | `getActivityPattern` |
| Has this product changed price repeatedly? | ✅ | `getRepeatedPriceChangePatterns` |
| How has this competitor's pricing evolved? | ✅ | `getEntityHistoryForCompetitor` |
| What products have appeared/disappeared over time? | ✅ (per competitor, per period) | `getProductLifecycleSummary` |
| Which competitors are changing (right now, across my whole set)? | **Partial** | `/compare` requires manually selecting competitors each visit; no default/persistent "what's new across everyone" view |
| How do competitors differ in current activity? | ✅ | `/compare` table |
| Is one competitor behaving differently from its own normal baseline? | ✅ | `getActivityPattern` in `/compare` |
| **Is there a sustained change in competitor behavior** (not just "this window vs. baseline" but "above baseline for 2+ consecutive windows")? | ❌ | Not computed — `getActivityPattern` is single-window-vs-baseline only |
| Are several related changes happening together (cross-event, same competitor)? | **Partial** | Visible only via manual Timeline inspection, no named/queryable signal |
| Is a competitor systematically changing pricing (recurring, not one-off)? | ✅ (per entity) / ❌ (across all entities/products at once, competitor-wide) | `getRepeatedPriceChangePatterns` answers per-product; there is no "how many of this competitor's products are in a repeated-repricing state right now" rollup |
| Is a competitor changing its offer/product mix over time? | **Partial** | `getProductLifecycleSummary` gives counts per period; no trend-over-multiple-periods view |
| Is there a recurring competitive pattern (cross-competitor)? | ❌ | Explicitly deferred — Section 9 |

**Conclusion:** CMA answers *point-in-time, per-competitor* questions well.
It does not yet answer *aggregate, "what deserves my attention right now
across everything I track"* questions, nor *sustained-trend* (multi-window,
not single-window-vs-baseline) questions. Both gaps are addressable with
data CMA already has.

---

## 5. Generic AI Substitution Test

For every implemented capability, could a customer get equivalent value by
pasting today's page (or today's ChangeEvents) into ChatGPT/Claude/Gemini?

| Capability | Generic-AI-with-one-page? | Generic-AI-with-today's-ChangeEvents? | Requires CMA's accumulated history? |
|---|---|---|---|
| "What changed?" | No (AI has no memory of yesterday's page) | Yes, trivially | No — this alone is commoditized |
| Activity-vs-own-baseline | No | No — baseline requires 90 days of prior counts the customer would have to manually assemble and paste | **Yes** |
| Repeated price-change pattern | No | Partially, if 30 days of events are pasted | **Yes**, for any real "yesterday's number vs. today's" comparison |
| Entity lifecycle history | No | No — requires the full historical chain, which does not exist as a document a customer already has | **Yes** |
| Cross-competitor descriptive comparison | No | Partially, for one snapshot in time; loses all baseline context without pasted history | **Yes**, for the baseline column specifically |
| **Proposed: Digest/notable-changes surface (Section 10)** | No | Partially, if the customer manually re-derives which patterns qualify from raw data every time | **Yes** — the value is precisely in not having to manually reconstruct "what qualifies today" from raw counts each visit |

**Test applied to the proposed next capability specifically:** "Could a
customer paste this week's ChangeEvents into ChatGPT and get the digest?"
Only if they first correctly re-derive, by hand, every pattern's
qualification state (sample-size gates, 3-window baseline, per-entity
repeat thresholds) across every competitor — which is exactly the
error-prone manual work the brief's Section 9 worked example warns a naive
tool would get wrong (small samples described as "dramatic"). The digest's
value is *assembling already-verified qualifications*, not the arithmetic.

---

## 6. Defensibility Analysis

Applied qualitatively (Strong / Moderate / Weak) to each existing pillar
and to the proposed next capability. Not a ranking — six independent
dimensions per candidate.

**Existing: Activity-vs-baseline pattern**
- Data dependency: Strong (90+ days of `ChangeEvent` history, no shortcut)
- Evidence dependency: Strong (`changeEventIds` traceable)
- Customer specificity: Strong (own history only)
- Time dependency: Strong (literally undefined before 90 days)
- Replacement difficulty: Strong (must hand a competitor a 90-day dataset)
- Explainability: Strong (documented formula, threshold, window model)

**Existing: `/compare` cross-competitor context**
- Data dependency: Strong (reuses the above)
- Evidence dependency: Strong
- Customer specificity: Strong
- Time dependency: Strong
- Replacement difficulty: Moderate (a customer could, in principle,
  manually run the single-competitor question N times and assemble the
  table themselves — CMA saves effort, not impossibility)
- Explainability: Strong

**Proposed: Digest / Notable-Changes surface (Section 10)**
- Data dependency: Strong (requires the full accumulated event stream
  across every tracked competitor, plus the existing pattern layer)
- Evidence dependency: Strong (every digest item traces to a `ChangeEvent`
  or an already-qualifying `ActivityPattern`/`RepeatedPriceChangePattern`)
- Customer specificity: Strong (org-scoped, reflects exactly what this
  customer chose to track)
- Time dependency: Strong (empty/near-empty on day 1, materially richer at
  90+ days once patterns can qualify, richer again as more competitors
  cross that threshold)
- Replacement difficulty: Strong (reproducing it manually means visiting
  every competitor detail page and every `/compare` row, every time)
- Explainability: Moderate (a "why is this item first" ordering rule must
  be simple and documented — recency-first, not a hidden score — or this
  dimension weakens; see Section 14's explicit non-goal against opaque
  scoring)

**Rejected candidate (for comparison): generic AI chat over competitor
data**
- Data dependency: Weak (an AI chat interface adds no new dependency on
  accumulated history beyond what retrieval already returns)
- Evidence dependency: Moderate (traceable only if the interface forces
  citation, which is extra engineering, not free)
- Customer specificity: Moderate
- Time dependency: Weak (a chat interface over day-1 data is exactly as
  useful, feature-wise, as one over day-365 data — the *underlying* data
  compounds, the chat wrapper itself does not)
- Replacement difficulty: Weak (any competitor could wrap the same
  ChangeEvent export in a chat UI in a day)
- Explainability: Weak-to-Moderate (depends entirely on prompt discipline,
  not a deterministic contract)

---

## 7. Data Sufficiency Analysis

| Candidate capability | Required data | Currently captured? | Identity stable enough? | Historical coverage sufficient? | Deterministic? |
|---|---|---|---|---|---|
| Digest: recent qualifying patterns across all tracked competitors | `ActivityPattern`/`RepeatedPriceChangePattern` per competitor (already computed), `ChangeEvent.detectedAt` for recency ordering | Yes | Yes (reuses Phase 7/8 identity rules unchanged) | Yes — same 90-day gate already documented; digest items for non-qualifying competitors are simply absent or shown as "not enough history," never fabricated | Yes — pure composition of existing repository calls |
| Digest: product lifecycle roll-up (added/removed across competitors) | `getProductLifecycleSummary` per competitor | Yes | Yes | Yes | Yes |
| Sustained-trend pattern (2+ consecutive above-baseline windows) | Two consecutive `getActivityPattern` calls at offset periods, or one new query comparing window N and N-1 | Partially — requires calling the *existing* function twice with different `now` offsets, or a small new query; no new schema | Yes | Requires *4* windows of qualifying history (one more `days`-length window than the existing pattern), i.e. `120+` days at the 30-day default — a small, well-understood prerequisite | Yes, with one small new repository function |
| Severity-weighted digest ordering | `ChangeEvent.severity` (already populated) | Yes, unused today | Yes | Yes | Yes |
| Cross-competitor simultaneous-activity detection | Per-competitor `activityPattern.direction` for the same window, compared across competitors | Yes (already computed per row in `getCompetitiveContext`) | Yes | Yes | Yes — purely descriptive counting, no new inference |
| Promotion pattern | `PROMOTION`-typed `ExtractedEntity` | **No** — zero extractor code emits it | N/A | N/A | **Rejected**: would require new extraction work first, out of scope for this phase |
| Cross-competitor product/plan equivalence | A shared product taxonomy or embedding-based matching | **No** | **No** | N/A | **Rejected**: no identity model exists; building one is a research problem, not a composition of existing data |

**Immediately implementable (composition only, no new extraction, no new
schema):** the digest surface, the lifecycle roll-up, severity-aware
ordering, and cross-competitor simultaneous-activity counting.

**Requires a small prerequisite (one new bounded query, reusing existing
window math):** the sustained (multi-window) trend signal.

**Requires new data collection (rejected for Phase 9's scope):** any
promotion-based capability, any cross-competitor product/plan equivalence.

---

## 8. Historical Accumulation Analysis

Using the existing 30-day-default window model as the reference clock
(unchanged from Phase 7.1/8):

| Age of monitoring | What becomes possible today (Phase 8 baseline) | What the proposed digest adds at this age |
|---|---|---|
| Day 1 | Nothing — baseline snapshot only | Empty digest ("no verified changes yet") — honest, not hidden |
| 7–30 days | Raw ChangeEvents, activity counts | Digest lists raw recent changes (Tier 1/2 items) only — no pattern items yet, correctly labeled |
| 30–90 days | `INSUFFICIENT_HISTORY` for the activity pattern throughout | Digest still lists raw changes; pattern-derived items absent, not faked |
| **90 days** | Activity pattern first qualifies (2 of 3 historical windows) | Digest can, for the first time, include a pattern-qualified item ("Competitor X above its own baseline") — this is the point the digest becomes qualitatively richer than a raw event list |
| 120 days | Full 3-window baseline | Digest's pattern items now rest on the fully-stabilized baseline |
| 120+ days (with the small sustained-trend prerequisite from Section 7) | — | Digest can add a genuinely new class of item: "2 consecutive above-baseline windows" — a claim no earlier phase's data could support, because it needs 4 windows (120 days), not 3 |
| 180+ days | Multiple competitors likely crossing the 90-day pattern threshold at different times | Digest becomes proportionally richer per competitor added earlier; a customer who onboarded a competitor on day 1 sees strictly more digest depth for that competitor than one added on day 150 |
| 1 year+ | — | The sustained-trend signal (Section 7) has enough repeated 120-day cycles to distinguish "this competitor is reliably active" from "this competitor had one active quarter" — a genuinely longitudinal claim, still fully deterministic |

**The key asymmetry a generic AI cannot replicate:** at day 1, CMA's
digest and a ChatGPT session are equally uninformative. At day 180, CMA's
digest contains dozens of pattern-qualified, evidence-linked items that
required 180 days of continuous, verified observation to exist at all — a
generic AI session started today has *zero* of that, and the customer has
no practical way to hand it 180 days of correctly-labeled historical
qualification state (it isn't a document; it's the output of a stateful
pipeline).

---

## 9. Cross-Competitor Analysis

Phase 8's `getCompetitiveContext` is **descriptive only** — it computes
each competitor's own pattern independently and displays them in the same
table. This audit confirms (by reading `intelligence.ts` directly) that
this remains true: no aggregation, no ranking, no cross-competitor
statistic is computed anywhere in the current codebase.

**What genuinely new cross-competitor intelligence could be added without
inventing causality:**

- **Observed correlation (defensible):** "N of your M tracked competitors
  are currently above their own historical baseline in the same window."
  This is a plain count over already-computed, already-qualified
  `ActivityPattern.direction` values — no new inference, no claim that one
  competitor's behavior *caused* another's, only that both are true at the
  same time. This is squarely a Tier 3 (Pattern) claim: a derived fact plus
  a documented rule ("count where direction === ABOVE_BASELINE"), not an
  interpretation.
- **Causal explanation (NOT defensible, must not be built):** any claim
  that competitors are reacting to each other, coordinating, or that one's
  activity explains another's. The current data model has no mechanism to
  distinguish coincidence from response, and the brief's own doctrine
  (Section 13 of this audit's brief) is explicit that this distinction
  must never be blurred.

**Recommendation:** the "N of M competitors above baseline this window"
count is a natural, low-risk **inclusion inside the proposed digest**
(Section 10) — it is exactly the kind of purely-descriptive cross-
competitor fact `getCompetitiveContext` was built to support, and adding it
requires no new data, no new identity model, and no ranking.

---

## 10. Candidate Future Directions

Four candidates evaluated. Not ranked; trade-offs discussed in Section 11.

### Candidate A — Digest / Notable-Changes Surface

- **Problem solved:** a customer must currently visit each competitor's
  detail page and manually re-check `/compare` to notice anything
  qualifying (pattern-qualified or otherwise notable). There is no single
  place that says "here is what's actually worth your attention, right
  now, across everything you track."
- **Customer question answered:** "What should I actually look at across
  all my competitors today/this week?"
- **Required data:** `ActivityPattern`, `RepeatedPriceChangePattern`,
  `getProductLifecycleSummary`, raw recent `ChangeEvent`s — all per
  organization, across all its competitors.
- **Current data sufficiency:** Fully sufficient today; zero new
  extraction, zero new schema.
- **Deterministic vs. AI:** 100% deterministic composition/ordering.
  Ordering rule: recency-first (`detectedAt` descending), with a
  documented, fixed set of item "kinds" (raw change / qualifying pattern /
  lifecycle event) — never a hidden importance score.
- **Evidence model:** every digest item is a citation to a real
  `ChangeEvent` id or an already-evidence-carrying pattern object
  (`changeEventIds`).
- **Why accumulated history matters:** a competitor with 3 days of history
  contributes only raw-change items; one with 180 days contributes
  pattern-qualified items too — the digest's depth is a direct function of
  accumulated monitoring, not of the UI.
- **Why generic AI cannot easily reproduce it:** reproducing it requires
  first hand-deriving every pattern's qualification state across every
  tracked competitor from raw data — the exact manual-error-prone step the
  digest exists to remove.
- **Implementation complexity:** Low-moderate. One new repository function
  composing existing calls; one new page/section.
- **New schema required?** No.
- **New extraction required?** No.
- **Potential prerequisite:** none blocking; the cross-competitor
  "N of M above baseline" count (Section 9) is a natural same-phase
  addition, not a prerequisite.
- **Main risks:** scope creep toward "just add AI summarization on top"
  (must be resisted — see Section 14); risk of the ordering rule silently
  becoming a de facto importance score if not kept strictly recency-based
  and documented.
- **What NOT to build with it:** no importance/urgency score, no "top 5"
  truncation that hides lower-ranked-but-real items, no AI-written
  headline text in this phase.

### Candidate B — Sustained (Multi-Window) Trend Pattern

- **Problem solved:** `getActivityPattern` only ever compares the current
  window to a historical baseline average — it cannot say "this
  competitor has been above baseline for 2 consecutive windows," which is
  a materially stronger, more actionable claim than a single window's
  ratio.
- **Customer question answered:** "Is there a *sustained* change in this
  competitor's behavior, not just a one-off spike?"
- **Required data:** two (or more) consecutive `getActivityPattern` results
  at offset `now` values — i.e., "what was the pattern one window ago" in
  addition to "what is it now."
- **Current data sufficiency:** Sufficient, with one small prerequisite:
  requires 4 windows of tracked history (120 days at the 30-day default)
  rather than 3, and a new small repository function
  (`getSustainedActivityTrend` or similar) that calls the existing
  window-slicing logic at an additional offset.
- **Deterministic vs. AI:** 100% deterministic.
- **Evidence model:** two linked `ActivityPattern` objects, each already
  evidence-bearing.
- **Why accumulated history matters:** strictly more history-dependent than
  the existing single-window pattern (120 days vs. 90) — an even harder
  floor for a generic AI to substitute.
- **Why generic AI cannot easily reproduce it:** same reasoning as the
  existing activity pattern, one level deeper.
- **Implementation complexity:** Low — reuses `getActivityPattern`'s
  window math, adds one comparison.
- **New schema required?** No.
- **New extraction required?** No.
- **Potential prerequisite:** none; purely additive.
- **Main risks:** describing "sustained" in customer-facing copy without
  overclaiming ("consistently more active" is fine; "escalating" or
  "aggressive" is not — same discipline as Phase 7's existing language
  rules).
- **What NOT to build with it:** no trend *forecasting* (predicting a
  future window) — only backward-looking, already-observed consecutive
  windows.

### Candidate C — Org-Wide Entity Repricing Roll-Up

- **Problem solved:** `getRepeatedPriceChangePatterns` already flags
  individual products with ≥2 price changes, but only per competitor, on
  the detail page. There is no view answering "across everything I
  monitor, which specific products/plans are in an active repeated-
  repricing state right now."
- **Customer question answered:** "Which specific products, anywhere in my
  tracked set, are being repriced repeatedly?"
- **Required data:** `getRepeatedPriceChangePatterns` called per
  competitor, unioned.
- **Current data sufficiency:** Fully sufficient; pure composition.
- **Deterministic vs. AI:** 100% deterministic.
- **Evidence model:** inherits `changeEventIds` from the existing pattern.
- **Why accumulated history matters:** the underlying pattern is already
  history-dependent (requires ≥2 price changes within the window); a
  fresh competitor contributes nothing until it has real repricing
  activity.
- **Why generic AI cannot easily reproduce it:** requires the full
  per-entity price-change history across every tracked competitor, which
  does not exist as something a customer could paste in.
- **Implementation complexity:** Low — a thin aggregation, could ship as
  part of Candidate A rather than standalone.
- **New schema required?** No.
- **New extraction required?** No.
- **Potential prerequisite:** none.
- **Main risks:** could be seen as redundant with Candidate A if built
  standalone — better framed as one *section* of the digest, not a
  separate feature.
- **What NOT to build with it:** no cross-competitor product-name matching
  (a "Product X" on Competitor A and "Product X" on Competitor B are never
  treated as the same entity — Section 3's identity rule stands).

### Candidate D — Severity/Category-Weighted Relevance

- **Problem solved:** every existing pattern and digest candidate treats
  all `ChangeEvent`s uniformly; `ChangeEvent.severity` and
  `MonitoredUrl.category` are captured but never used to prioritize what a
  customer sees first.
- **Customer question answered:** implicitly supports "what matters most,"
  but does not answer a question on its own — it is a *modifier* to
  Candidates A/B/C, not a standalone capability.
- **Required data:** `ChangeEvent.severity` (populated since Phase 1),
  `MonitoredUrl.category`.
- **Current data sufficiency:** Fully sufficient; already stored.
- **Deterministic vs. AI:** Deterministic (a documented sort/filter rule,
  e.g. "HIGH severity items surface first within the same recency
  bucket").
- **Evidence model:** inherits from the underlying `ChangeEvent`.
- **Why accumulated history matters:** not history-dependent per se — this
  is an orthogonal signal, not a time-compounding one.
- **Why generic AI cannot easily reproduce it:** weakly true at best — a
  generic AI given severity-labeled data could apply a similar sort. The
  defensibility here comes entirely from having the *underlying* data
  (Candidates A/B/C), not from this weighting rule itself.
- **Implementation complexity:** Very low if folded into Candidate A;
  standalone it is not a complete feature.
- **New schema required?** No.
- **New extraction required?** No.
- **Potential prerequisite:** best implemented as a modifier inside
  Candidate A, not shipped alone.
- **Main risks:** if built standalone and marketed as "smart
  prioritization," risks drifting toward an opaque score — must stay a
  simple, documented, inspectable sort key.
- **What NOT to build with it:** no learned/ML-based weighting, no hidden
  scoring formula — the rule must be statable in one sentence.

---

## 11. Trade-offs

No candidate is declared a winner. Observations:

- **A (Digest) is the only candidate that is a complete, shippable
  customer-facing surface on its own.** B, C, and D are each real,
  data-sufficient, low-risk deterministic additions, but each is better
  understood as *content that would live inside* a digest than as an
  independent page a customer would navigate to separately. Building B or
  C as a standalone page before A exists risks the same fragmentation
  problem `/compare` already solved for cross-competitor patterns:
  customers would again have to remember to check N different places.
- **B (sustained trend)** is the most technically novel of the four (a new
  repository function, a new 120-day floor) but is a small, additive
  extension of already-proven code — low implementation risk, moderate
  customer-copy risk (avoiding overclaiming "sustained" as "escalating").
- **C (repricing roll-up)** is the lowest-risk, smallest-effort candidate,
  but standalone it answers a narrower question than A. It is naturally
  Candidate A's second section.
- **D (severity/category weighting)** should not be scheduled as its own
  phase; it is a modifier that makes A's ordering more useful and should
  be folded into A's design rather than deferred to "someday."

**Architectural fit conclusion (not a ranking, a structural observation):**
Candidate A is the correct *frame*; Candidates B, C, and D are naturally
its constituent sections/refinements rather than competing directions.
This is the basis for Section 14's recommended next implementation phase.

---

## 12. Recommended Architectural Direction

```
Current (implemented):

ChangeEvent
   |
Derived Facts (activity metrics, lifecycle summary)
   |
Per-competitor Patterns (activity-vs-baseline, repeated price change)
   |
Competitive Context (descriptive cross-competitor, Phase 8)


Proposed (Phase 9 candidate — NOT implemented, this audit only):

ChangeEvent
   |
Derived Facts                              [existing]
   |
Per-competitor Patterns                    [existing]
   |
Competitive Context                        [existing]
   |
Cross-Competitor Descriptive Aggregation   [PROPOSED: "N of M above
   |                                        baseline" count — Section 9]
   |
Digest / Notable-Changes Composition       [PROPOSED: Candidate A,
   |                                        sections = existing patterns
   |                                        + Candidates B/C/D as content]
   |
AI Interpretation                          [DEFERRED — Section 14,
   |                                        explicitly the phase AFTER
   |                                        Phase 9's proposed scope]
   v
Competitive Intelligence
```

Everything above "AI Interpretation" is proposed to be built from data and
functions that already exist. No box in the proposed section requires new
schema or new extraction.

---

## 13. Phase 9 Non-Goals

Explicitly out of scope for the next implementation phase:

- No Stripe, billing, or monetization changes.
- No large UI redesign (the pre-existing mobile sidebar squeeze documented
  in Phases 6/7.1/8 remains a known, separately-tracked limitation, not
  addressed here).
- No generic AI chatbot / chat-with-your-data interface.
- No speculative ML, embeddings, or vector search.
- No opaque scoring, importance ranking, or "top N" hiding of real items.
- No forecasting of future competitor behavior.
- No market-share or revenue estimation.
- No promotion-pattern feature (no extractor produces the underlying data;
  building this now would mean inventing semantics the data cannot
  support — reconfirmed in Section 15).
- No cross-competitor product/plan identity normalization.
- No AI interpretation layer yet — this is the deliberate *next* phase
  after the digest exists (Section 14), not part of it.

---

## 14. Proposed Next Implementation Phase

**Proposed Phase Name:** Phase 10 — Deterministic Digest (Notable Changes
Across All Tracked Competitors)

- **Objective:** compose the existing pattern/derived-fact layer into one
  per-organization, evidence-linked feed answering "what across everything
  I monitor deserves attention right now," with zero new AI calls and zero
  new schema.
- **User-facing problem:** customers must currently visit each competitor
  individually (or manually select competitors in `/compare`) to notice
  anything qualifying; there is no single, always-current view.
- **Core data model involved:** `ChangeEvent`, `ActivityPattern`,
  `RepeatedPriceChangePattern`, `getProductLifecycleSummary` — all
  existing, unmodified.
- **Existing functions/repositories to reuse:** `getActivityPattern`,
  `getRepeatedPriceChangePatterns`, `getCompetitiveContext`,
  `getProductLifecycleSummary`, `getCompetitorActivityMetrics`.
- **New functions likely required:**
  - `getDigestForOrganization(organizationId, days)` — composes the above
    across every active competitor in the org, in parallel
    (`Promise.all`, same convention as `getCompetitiveContext`).
  - (Optional, foldable into the same function) a small
    `getCrossCompetitorActivitySummary` returning "N of M competitors
    currently ABOVE_BASELINE" (Section 9), purely a count.
  - (If Candidate B is included in the same phase, not required for a
    minimal digest) `getSustainedActivityTrend` — one additional
    `getActivityPattern`-style call at a 120-day floor.
- **Potential schema changes:** None expected. If digest "read/unread" or
  "dismissed" state is desired, a new join table
  (`DigestItemState` or similar, org+item-scoped) would be needed — this
  should be treated as a *separate*, explicitly-scoped decision, not
  assumed as part of the initial digest.
- **Potential API changes:** None required if the digest is a Server
  Component page reading repository functions directly (matching every
  existing page's architecture) rather than a new REST route.
- **Potential UI surfaces:** one new page (e.g. `/digest` or as the
  dashboard's default landing content), listing items grouped by
  recency, each with a `data-testid`, an evidence link
  (`/changes/[id]` or `/competitors/[id]`), and an explicit "why this
  appears" one-line label (e.g. "Above its own 90-day baseline" / "2nd
  price change this month for {product}") reusing the exact
  `patternDisplay.ts` vocabulary Phase 8 already established.
- **Deterministic logic required:** ordering (recency-first, documented,
  never a hidden score), inclusion rule per item kind (only include
  pattern items where `qualifies === true`; raw-change items always
  eligible), minimum-sample-size gating reused verbatim from Phase 7/7.1.
- **AI involvement:** None in this phase. The digest's structured output
  (per-item: kind, competitor, evidence id(s), qualification fields) is
  explicitly the shape a *future* AI-interpretation phase would consume —
  matching `PHASE8-VALIDATION-REPORT.md`'s own "Future AI Readiness"
  section, extended one more composition step.
- **Evidence requirements:** every digest item must carry at least one
  real `ChangeEvent` id; no item may be a plain summary with no
  drill-down.
- **Tenant isolation requirements:** `getDigestForOrganization` must be
  scoped by `organizationId` directly at every internal call (inherits
  this by construction from the functions it composes, but requires its
  own cross-tenant unit test, matching every prior phase's convention).
- **Test requirements:** unit tests for composition/ordering/gating
  (vitest, real Postgres, matching existing convention); Playwright E2E
  covering (a) empty state for a brand-new org, (b) a digest with only
  raw-change items (pre-90-day org), (c) a digest with at least one
  pattern-qualified item, (d) tenant isolation (Org B never sees Org A's
  items); mobile check at 375px (measured, not just visual, matching
  Phase 7.1/8's precedent).
- **Explicit non-goals:** no AI summarization, no importance score, no
  "top 5" truncation of real items, no promotion-pattern content, no
  cross-competitor product/plan matching, no notification/email changes
  (Phase 4's daily report is a separate, already-existing surface and is
  out of scope for this phase).

---

## 15. Risks / Open Questions

- **Digest ordering discipline risk:** the single largest risk to this
  direction is scope creep from "recency-first" into an implicit
  importance score (e.g. "let's put HIGH severity first, then recency" is
  fine and documented; "let's compute a relevance score" is not — this
  boundary must be enforced in code review, not just in the design doc).
- **Open question — digest read/dismissed state:** whether a customer
  needs to mark digest items as seen/handled is a real product question
  this audit does not resolve; flagged as a separate scoping decision for
  Phase 10's design phase, not assumed.
- **Open question — digest scope vs. Phase 4's daily report:** Phase 4
  already emails a daily report; Phase 10's digest is an in-app,
  always-current view of the same underlying facts, but the two surfaces
  should not silently diverge in vocabulary or inclusion rules — Phase
  10's design phase should explicitly decide whether the daily report
  should eventually be re-derived from the same digest composition
  function, or remain independent. Not decided here.
- **No implementation inconsistency was found that changes this
  recommendation.** Phase 7.1's own validation report already documents
  the one real bug found and fixed in that phase (the `qualifyingWindows`
  diagnostic-field bug) and the one pre-existing, unrelated Playwright
  strict-mode failure (reproduced identically on unmodified `main`,
  confirmed again in Phase 8's own validation report). Both are already
  fixed or already correctly triaged as out-of-scope; neither was
  re-investigated beyond re-reading the existing reports, per this
  phase's instruction not to re-audit prior phases without a concrete
  reason. Re-confirmed by direct code read (not just report-reading) in
  this audit: `EntityType.PROMOTION`/`PLAN` are schema-only (grep of
  `packages/extraction/src` for `PROMOTION` returns zero matches;
  `structuredData.ts` only ever emits `type: "PRICE"` or `type:
  "GENERIC"`), matching every prior phase's documented conclusion exactly.

---

## 16. Final Conclusion

CMA's deterministic ladder through Phase 8 is sound and genuinely
defensible — the moat is real accumulated, evidenced, per-customer history,
not the arithmetic. The next capability that most increases that moat's
value **without** touching AI, schema, or extraction is composing the
already-existing pattern and derived-fact layer into one recency-ordered,
evidence-linked digest per organization. This is not a new tier of
intelligence — it is Tier 3.5, a disciplined aggregation of Tier 2/3 facts
already proven correct — and it is the natural, minimal-risk foundation
the *actual* Tier 4 (AI interpretation) should be built on next, once a
digest gives that future AI call a coherent, multi-signal, per-organization
input to interpret (rather than one isolated pattern at a time, which
Phase 8's own "Future AI Readiness" section already flagged as too thin to
justify an AI call on its own).

---

## PHASE 9 AUDIT STATUS

```
Status:
PASS WITH FINDINGS

Report:
PHASE9-PRODUCT-DIRECTION-AUDIT.md

Code changed:
NO

Tests run:
NONE (analysis-only phase; no test suite executed, per Section 22 —
no concrete implementation contradiction was discovered that required
verification against a running test)

Historical phases re-audited:
NO (Phase 7/7.1/8 reports and the underlying schema/repository/extraction
source were read for grounding; no prior architectural decision was
reopened, and the one prior bug/one prior known E2E flake were only
re-cited from their own validation reports, not re-investigated)

Key conclusion:
CMA's deterministic pattern layer is sound and defensible; the highest-
leverage next step is composing already-existing facts into one
evidence-linked digest, not adding AI, schema, or new extraction.

Proposed next implementation phase:
Phase 10 — Deterministic Digest (Notable Changes Across All Tracked
Competitors)

Reason:
It is the only candidate that is a complete, shippable customer-facing
surface using 100% already-implemented, already-tested data and pattern
functions; it directly answers the "what should I look at across
everything I track" question the customer question matrix (Section 4)
shows CMA cannot yet answer; and it is the correct foundation for the
future AI-interpretation tier, which needs a multi-signal composed input
to be worth its cost rather than interpreting one isolated pattern at a
time.
```
