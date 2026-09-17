# Phase 14A — Historical Intelligence Design Audit

**Type:** Analysis / product-technical design phase. **No code changes.**
**Status:** PASS WITH FINDINGS
**Historical phases re-audited:** NO

---

## 1. Executive Summary

The exact capability this phase was asked to scope — "sustained historical competitive
patterns" — already has a name in the existing project history: **Candidate B, "Sustained
(Multi-Window) Trend Pattern,"** first identified as a gap in `PHASE9-PRODUCT-DIRECTION-AUDIT.md`
and explicitly re-confirmed as not-yet-built in `PHASE10-VALIDATION-REPORT.md`. It was never
touched in Phases 11–13 (those built the AI-interpretation and claim-safety layers on top of
the Digest, not this pattern). This audit inherits that gap analysis, verifies it against the
current code (not just the reports), and turns it into an implementation-ready Phase 14B
specification.

**Core finding:** CMA's two existing pattern functions each answer a *single-window* question:

- `getActivityPattern` — "is the competitor's current window unusually active **relative to its
  own historical baseline**?" (one comparison, one moment in time)
- `getRepeatedPriceChangePatterns` — "did this specific product reprice **≥2 times inside the
  current window**?" (one window, no memory of prior windows)

Neither function currently answers: *"has this behavior held up over more than one window, or
was it a one-off?"* That is the sustained-pattern question, and it is answerable **today**,
**deterministically**, **without new extraction, without a schema change, and without any AI
call**, by composing the existing functions at multiple consecutive time offsets and comparing
their qualification/direction across those offsets.

**Recommended minimum scope for Phase 14B:** one new repository function,
`getSustainedActivityTrend(organizationId, competitorId, days, now)`, that calls the *existing*,
*unmodified* `getActivityPattern` at two (extendable to three) consecutive prior offsets and
reports how many consecutive windows, immediately preceding and including the current one, share
the same qualifying direction. This is chosen over the entity-level alternative (a "sustained
repeated price-change" signal built on `getRepeatedPriceChangePatterns`) because the
competitor-level signal does not depend on the fragile `entityKey` identity model (Section 7),
while the entity-level version does. The entity-level version is real, useful, and cheap to add
later — it is explicitly deferred to a follow-up phase, not rejected.

No schema change. No new extraction. No AI calls. Bounded, O(competitors) query cost (same shape
already measured and proven in Phase 13 for `getDigestForOrganization`, just with a larger fixed
per-competitor constant).

---

## 2. Current Data Inventory

Verified directly against `packages/db/prisma/schema.prisma` and the repository/extraction code
(not assumed from prior reports).

| Structure | Fields relevant to historical patterns |
|---|---|
| `ChangeEvent` | `id`, `organizationId`, `monitoredUrlId`, `changeType` (`PRICE_CHANGE`/`PRODUCT_ADDED`/`PRODUCT_REMOVED`/`PROMOTION_CHANGE`/`CONTENT_CHANGE`), `severity`, `confidence`, `entityKey` (nullable), `fieldPath`, `oldValue`/`newValue`, `percentageChange`, `evidenceExcerpt`, `detectedAt` (the **sole** timestamp used by every window computation). Indexed on `(monitoredUrlId, detectedAt)` and `organizationId` separately — no composite `(organizationId, detectedAt)` index exists today.
- `ExtractedEntity.key` — JSON-LD-derived stable identity string (`jsonld:{name.toLowerCase()}`), or `text-price:{hash}` for GENERIC (regex-matched) entities. This is copied onto `ChangeEvent.entityKey` at detection time.
| `Competitor.createdAt` | The anchor used by `getActivityPattern` to decide whether a historical window is "in range" of actual tracked history — critical to every time-to-value calculation in this report. |
| `MonitoredUrl` | `organizationId`, `competitorId` — the scoping join used by every pattern query (`urlIds = monitoredUrl.findMany({organizationId, competitorId})`). |
| `ActivityPatternDirection` | **Not a Prisma enum** — a TypeScript-only union (`"ABOVE_BASELINE" | "BELOW_BASELINE" | "AT_BASELINE" | "INSUFFICIENT_HISTORY"`) defined in `patterns.ts`. Patterns are never persisted; every one is computed live, per request, from `ChangeEvent` rows. |
| `DigestAiInterpretation` | One row per `(organizationId, days)` — only stores the AI's own prose interpretation, never a pattern's numeric fields. Not relevant to a deterministic sustained-pattern feature except as the eventual Tier 4 consumer (Section 12). |

**No `PROMOTION`/`PLAN`-typed entities are ever produced** by the extraction layer today
(`structuredData.ts` only emits `PRICE` from JSON-LD and `GENERIC` from regex fallback) — this
forecloses any "sustained promotion strategy" candidate before it is even considered (Section 6,
row for promotions).

---

## 3. Existing Intelligence Capabilities (verified against code)

### 3.1 `getActivityPattern(organizationId, competitorId, days, now)` — `packages/db/src/repositories/patterns.ts`

Exact algorithm (verbatim constants):

```ts
const BASELINE_WINDOW_COUNT = 3;
const MIN_QUALIFYING_BASELINE_WINDOWS = 2;
const BASELINE_RATIO_THRESHOLD = 1.5;
```

- `Current = [now - D, now)`.
- Historical windows, most-recent-first: `Historical i = [now-(i+2)D, now-(i+1)D)` for `i = 0,1,2`
  → Historical 1 = `[now-2D, now-D)`, Historical 2 = `[now-3D, now-2D)`, Historical 3 =
  `[now-4D, now-3D)`.
- A historical window "qualifies" only if `window.start >= Competitor.createdAt` — no partial
  window ever counts.
- `qualifies: true` requires **≥ 2 of 3** historical windows to qualify → requires **≥ 3D** of
  tracked history (not 2D — documented Phase 7.1 correction). Full 3-window baseline requires
  **4D**.
- `ratio = current / baselineAverage`, rounded to 2dp. `ratio ≥ 1.5` → `ABOVE_BASELINE`;
  `ratio ≤ 1/1.5` → `BELOW_BASELINE`; else `AT_BASELINE`.
- `baselineAverage === 0` special-case: `ratio = null` (never a fabricated "Infinity%"),
  `direction = current === 0 ? AT_BASELINE : ABOVE_BASELINE`, `strongEvidence = current === 0`
  (a `0 → N` jump is flagged `strongEvidence: false` — this is exactly the guard against the
  brief's "1 vs 0 = dramatic" anti-pattern).
- Query cost: ≤ 6 Prisma calls (1 competitor lookup + 1 monitoredUrl lookup + 1 current-window
  count + up to 3 historical-window counts, run via `Promise.all`).
- Test-proven qualification floor (with `D=30`, `patterns.test.ts` window-boundary matrix): first
  qualifies at **90 tracked days** (2 of 3 historical windows), full baseline at **120 days**.

### 3.2 `getRepeatedPriceChangePatterns(organizationId, competitorId, days, now)` — same file

- Groups `PRICE_CHANGE` events with non-null `entityKey` by `${monitoredUrlId}::${entityKey}`
  inside a **single** window `[now-D, now)`.
- `MIN_REPEATED_PRICE_CHANGES = 2` → `qualifies: true` iff `changeCount >= 2`.
- Groups below threshold are still returned (`qualifies: false`), never silently dropped.
- **No baseline concept, no `INSUFFICIENT_HISTORY` state** — it is a pure single-window count. It
  makes no claim about history depth or persistence across windows. This is the load-bearing fact
  for Section 7 and Section 24: this function currently has *zero* memory of any window other than
  the one it was called with.

### 3.3 `getEntityHistoryForCompetitor`, `getPriceHistoryForCompetitor`

Both build full chronological per-entity series (unbounded lookback, not window-sliced) —
already-existing, cheap, org-scoped, but purely descriptive (no qualification/threshold, no
pattern claim). Useful raw material, not a "pattern" in the Tier 3 sense.

### 3.4 `getCompetitiveContext` / `compareCompetitors`

Descriptive cross-competitor rows only: reuses `getActivityPattern` and
`getRepeatedPriceChangePatterns` verbatim per competitor; computes no aggregate statistic beyond
`aboveBaselineCount` "N of M" in the digest. No ranking, no score, no cross-competitor identity
matching.

### 3.5 `getDigestForOrganization` — Phase 10

Deterministic composition across active competitors: `CHANGE_EVENT` (always eligible),
`REPEATED_PRICE_CHANGE` (only if `.qualifies`), `ACTIVITY_PATTERN` (only if `.qualifies &&
events.length > 0`), `LIFECYCLE` (only if `added>0 || removed>0`). Fixed deterministic ordering
(`detectedAt DESC, competitorId ASC, fixed kind order, stable id`) — never an importance score.
`now` is injected and threaded through every sub-call. Query shape empirically measured in Phase
13: O(1) w.r.t. event volume, ~8 fixed queries/competitor overhead → O(competitors) total.

### 3.6 AI interpretation (Phase 11) + claim-safety (Phase 12)

`buildDigestInterpretationInput` extracts only the already-qualification-gated summary fields of
each pattern (`direction`, `ratio`, `current`, `baselineAverage`, `qualifyingWindows`,
`strongEvidence`, `changeCount`) into `EvidenceBundle.facts` — never raw historical window counts
beyond what the pattern functions already expose. `AiInterpretationOutput` requires
`evidenceChangeEventIds` on every claim; a 7-category regex claim-safety gate
(`causal-explanation`, `competitor-intent`, `competitor-strategy`, `market-demand`, `forecast`,
`financial-inference`, `win-loss`) rejects the entire AI response on any match. This gate already
covers the exact vocabulary risk a "sustained"/"escalating" trend claim would create (Section 12).

---

## 4. Signal Inventory

| Signal | Existing data | Deterministic? | Historical (multi-window)? | Evidence available? | New schema? | New extraction? | Existing helper reused |
|---|---|---|---|---|---|---|---|
| Sustained activity-vs-baseline trend (competitor-level) | `ChangeEvent.detectedAt` via `getActivityPattern` | Yes | Yes — calls at 2–3 consecutive offsets | Yes — same `ChangeEvent` ids each offset call would already expose if extended | No | No | `getActivityPattern` (unmodified) |
| Sustained repeated price-change entity (product-level) | `ChangeEvent.entityKey` via `getRepeatedPriceChangePatterns` | Yes | Yes — calls at N consecutive offsets, matched by `(monitoredUrlId, entityKey)` | Yes — `changeEventIds` per window | No | No | `getRepeatedPriceChangePatterns` (unmodified) |
| Lifecycle persistence (added → survives → repriced → survives) | `getEntityHistoryForCompetitor` | Yes | Partially — already a full timeline, but no windowed "sustained" claim defined | Yes | No | No | `getEntityHistoryForCompetitor` |
| Event-type persistence (e.g. 3 consecutive windows each with ≥1 `PRICE_CHANGE`) | `ChangeEvent.changeType` + `detectedAt` | Yes | Yes | Yes | No | No | Would duplicate the sustained-activity-trend signal, filtered by type — REPACKAGING risk (Section 5) |
| Direction persistence / reversal (ABOVE → ABOVE → BELOW) | `getActivityPattern` at 3 offsets | Yes | Yes | Yes | No | No | Same base call as row 1 — a richer taxonomy on top of it, not a separate data source |
| Volatility (variance of window-to-window counts) | `ChangeEvent` counts per window | Only if a specific, justified variance formula is picked | Yes | Weak — a variance number has no single supporting `ChangeEvent` set | No | No | None — **no defensible customer-facing definition identified; see Section 6** |
| Cross-competitor sustained-activity count ("N of M sustained ≥2 windows") | Row 1 applied per competitor + `aboveBaselineCount`-style count | Yes | Yes | Yes | No | No | `getActivityPattern` × N competitors, same shape as existing `aboveBaselineCount` |
| Sustained promotion behavior | — | N/A | N/A | N/A | Yes (new `PROMOTION` entity type is *declared* in the `EntityType` enum but never emitted) | **Yes — no extractor produces it** | **NOT AVAILABLE FROM CURRENT DATA — reject** |
| Cross-competitor product/plan equivalence sustained over time | — | No defensible identity | N/A | N/A | — | — | **DEFERRED — insufficient defensible identity (Section 7)** |

---

## 5. Novel-vs-Repackaging Analysis

- **"Competitor had 8 changes in the last 30 days"** → existing derived fact (`getOrgActivityMetrics`/`getCompetitorActivityMetrics`). REPACKAGING if re-presented as a "pattern."
- **"Competitor had above-baseline activity in 2 (or 3) consecutive windows"** → **NEW SIGNAL.**
  `getActivityPattern` alone cannot express this; it only ever knows about the current window and
  a rolled-up baseline average. Seeing the same qualifying direction repeat across *independent*
  calls at different `now` offsets is new derived information not visible anywhere in the current
  UI or Digest.
- **"Competitor had 3 price changes on Product X this month"** → existing (`getRepeatedPriceChangePatterns`, single window). REPACKAGING if re-labeled "sustained."
- **"Product X repriced ≥2 times in each of the last 2 (or 3) consecutive windows"** → **NEW
  SIGNAL.** Distinguishes a habitually-repriced SKU from a one-time promotional adjustment — not
  derivable from any existing single-call output.
- **"Event-type persistence" (row 4 of the signal table)** → mostly REPACKAGING of row 1's
  underlying counts sliced by `changeType`; it does not answer a materially different customer
  question than "sustained activity trend, filtered to price changes," which is already covered
  by combining rows 1 and 2. Not recommended as a separate third pattern function.
- **Volatility** → REJECTED as a candidate in this phase specifically because no defensible,
  non-arbitrary formula for "volatility" was identified from the current data without inventing a
  threshold that would be tuned on judgment rather than derived (same reasoning `PHASE7-DATA-AUDIT.md`
  already applied to reject a "burst" z-score pattern on sparse product-lifecycle data).

---

## 6. Pattern Qualification Definitions

### 6.1 Sustained Activity Trend (recommended primary candidate)

- **Observation:** the same `ChangeEvent` rows `getActivityPattern` already reads (org-scoped,
  `monitoredUrlId`-scoped, `detectedAt`-windowed).
- **Window:** the existing `getActivityPattern` window model, called at offsets
  `now, now-D, now-2D, …` up to a bounded maximum of `MAX_SUSTAINED_LOOKBACK = 3` calls (i.e.
  offsets 0, -D, -2D — "current window" plus up to two immediately-preceding "current windows").
- **Baseline:** each offset call computes **its own independent baseline** using the existing
  3-historical-window model relative to *that* offset's `now`. The current window (offset 0) is
  never mixed into any offset's historical baseline (this falls out for free — `getActivityPattern`
  already excludes its own current window from its baseline by construction).
- **Minimum history:** the outermost offset call used must itself have `qualifies: true`
  (≥2/3 historical windows) — i.e. a 2-window sustained check needs the offset `-D` call to
  qualify, which needs `Competitor.createdAt <= now - D - 3D = now - 4D` → **120 days at D=30**,
  confirming Phase 9's Candidate B arithmetic exactly. A 3-window sustained check needs the
  `-2D` call to qualify → `now - 5D` → **150 days at D=30**.
- **Qualification rule:** `consecutiveQualifyingWindows` = the count of consecutive offset calls,
  starting from offset 0 and moving backward, that (a) individually `qualifies: true` and (b) share
  the **same** non-`AT_BASELINE` `direction` as the offset-0 call. The count stops at the first
  offset that breaks either condition. `sustained: true` iff `consecutiveQualifyingWindows >= 2`.
- **Non-qualification:** offset-0's own `qualifies` is `false` (no sustained claim can start from
  an unqualified base), or the immediately preceding offset call's direction differs from offset 0
  (a single reversal breaks the streak — no averaging across a reversal).
- **Insufficient history:** if offset 0 qualifies but the second offset call (`-D`) does not
  qualify (not enough tracked history yet to look one more window back), the function must return
  an explicit `INSUFFICIENT_SUSTAINED_HISTORY`-equivalent state (`consecutiveQualifyingWindows: 1,
  sustained: false, sustainedDataAvailable: false`), distinct from "the trend broke" (`sustained:
  false, sustainedDataAvailable: true`, direction differed).
- **Evidence:** the union of `ChangeEvent` ids from every window the caller actually needs to cite
  — practically, the current window's events (already returned by the digest's raw event fetch);
  the prior windows' own `ChangeEvent` ids are not strictly required as evidence for the *sustained*
  claim itself (the claim is about a repeated *pattern-level* qualification, not new raw facts),
  but the function should still expose window-level counts so a UI/AI layer can show "this also
  held N periods ago" with a citable number, not just an assertion.
- **Timestamp:** `windowEnd` of the offset-0 window (`now`), consistent with how `ActivityPattern`
  is already timestamped implicitly via the digest's shared `now`.
- **Reversal:** the pattern stops qualifying as soon as any offset in the lookback chain has a
  different direction or fails to qualify — there is no smoothing or hysteresis.
- **Identity:** competitor-level, scoped by the same `monitoredUrlId` set `getActivityPattern`
  already resolves — no product/entity-level identity dependency at all.
- **Tenant boundary:** identical to `getActivityPattern`'s existing `organizationId`-scoped
  `competitor.findFirst`/`monitoredUrl.findMany` calls — no new isolation surface introduced.

### 6.2 Sustained Repeated Price-Change Entity (deferred secondary candidate — fully specified for a later phase, NOT recommended for 14B)

- **Observation:** `PRICE_CHANGE` events with non-null `entityKey`, as already read by
  `getRepeatedPriceChangePatterns`.
- **Window:** same function, called at offsets `now, now-D, now-2D` (bounded, same 3-call cap).
- **Baseline:** none — this signal has no baseline concept; it is pure repeated qualification.
- **Minimum history:** none imposed by the underlying function itself (unlike Activity Pattern,
  `getRepeatedPriceChangePatterns` has no `INSUFFICIENT_HISTORY` state) — but a sustained claim
  spanning `N` windows still requires `N*D` days of *any* history to have produced qualifying
  event counts, so the practical floor is `2D` (60 days at D=30) for a 2-window sustained claim,
  **not gated on `Competitor.createdAt`** the way Activity Pattern is. This is a materially
  different (weaker) minimum-history guarantee than Section 6.1, and is one reason this candidate
  is deferred rather than folded into 14B — it needs its own, separately-reasoned
  minimum-sample rule before shipping (see Section 7 for the deeper identity risk).
- **Qualification rule:** for each `(monitoredUrlId, entityKey)` group that qualifies
  (`changeCount >= 2`) in the offset-0 window, check whether the **same** `(monitoredUrlId,
  entityKey)` key also qualified in the immediately preceding window(s). `sustainedEntityCount`
  = count of consecutive qualifying windows for that key.
- **Non-qualification / reversal:** the key does not appear as a qualifying group in a preceding
  window (either zero or one price change that period).
- **Evidence:** `changeEventIds` per window per key — already returned by the underlying function.
- **Identity:** `(monitoredUrlId, entityKey)` — subject to every fragility documented in Section 7.
  A JSON-LD label change (e.g. "Pro Plan" → "Pro") produces a **new** `entityKey`, silently
  resetting any sustained streak with no signal that this happened — this is the primary reason
  this candidate is not recommended for the first implementation.

---

## 7. Entity Identity Constraints

Verified against `packages/extraction/src/structuredData.ts` and `packages/detection/src/compare.ts`:

- Stable identity exists **only** for JSON-LD-sourced `PRICE` entities:
  `entityKey = "jsonld:" + name.toLowerCase()` — no whitespace normalization, no punctuation
  stripping, no uniqueness enforcement beyond scoping by `(monitoredUrlId, entityKey)` together.
- `GENERIC` (regex-fallback) entities are keyed by a hash of surrounding text context
  (`text-price:{sha256(context).slice(0,16)}`) — these are explicitly excluded from
  `detectProductAddedOrRemoved` (add/remove diffing) by a documented code comment, and any
  identity-based historical pattern must likewise exclude them.
- **Rename limitation:** any change to the JSON-LD product/offer name — even a whitespace or
  casing difference the lowercasing doesn't absorb — produces a different `entityKey`, which
  looks to every downstream consumer like the old entity vanished and a new one appeared. There is
  no reconciliation logic anywhere in the codebase.
- **URL migration limitation:** identity is additionally scoped by `monitoredUrlId`; if a
  competitor's product moves to a different monitored URL, its identity resets even if the
  `entityKey` string is unchanged.
- **Missing identity:** any non-JSON-LD price mention has no defensible identity at all.
- **Removal/re-addition semantics:** `getEntityHistoryForCompetitor`'s `currentlyDetected` flag is
  derived (true unless the chronologically last event for the key is `PRODUCT_REMOVED`) — a
  removed-then-re-added product under the *same* JSON-LD name produces a continuous history under
  the same key; under a *changed* name, it is indistinguishable from an unrelated new product.

**Conclusion applied to Section 6:** the competitor-level Sustained Activity Trend (6.1) has zero
dependency on this fragile identity model — it counts raw events per `monitoredUrlId` set, never
per `entityKey`. The entity-level Sustained Repeated Price-Change (6.2) inherits every limitation
above. This materially changes the risk profile between the two candidates and is the deciding
factor in Section 17's recommendation.

Cross-competitor or cross-page entity matching (e.g. "the same SKU across two competitor sites")
is **not attempted anywhere in the current codebase** and remains explicitly out of scope for this
phase (`DEFERRED — insufficient defensible identity`), consistent with every prior phase's
findings.

---

## 8. Time-to-Value Model

Anchored to `D = 30` (the product default), using `Competitor.createdAt` as day 0 and the
verbatim window math from Section 3.1/6.1.

| Customer history (days tracked) | What CMA can defensibly know today | What Phase 14B's Sustained Activity Trend adds |
|---|---|---|
| Day 1 | Raw `ChangeEvent`s as they occur; single-window `getRepeatedPriceChangePatterns` counts (no baseline needed) | Nothing yet — `sustainedDataAvailable: false` |
| 7 days | Same as above, thinner history | Nothing yet |
| 30 days | First full current-window activity count | Nothing yet |
| 60 days | 1 historical window exists but `getActivityPattern` still reports `INSUFFICIENT_HISTORY` (needs 2 of 3) | Nothing yet |
| 90 days | `getActivityPattern` first qualifies (2 of 3 historical windows) | Nothing yet — a 2-window sustained check needs the *previous* offset call to ALSO qualify, which needs 120 days |
| **120 days** | Full 3-window baseline for the current offset | **First day `getSustainedActivityTrend` can report `sustained: true/false` with `consecutiveQualifyingWindows: 2`** |
| **150 days** | — | First day a 3-consecutive-window sustained claim (`consecutiveQualifyingWindows: 3`) is possible |
| 180 days | Richer history, same mechanics | Deeper `consecutiveQualifyingWindows` ceiling (still capped at the bounded lookback, e.g. 3, by design — Section 19) |
| 365 days | Multiple distinct competitors likely to show sustained trends simultaneously; cross-competitor "N of M sustained" count becomes meaningful | Same shape as `crossCompetitorContext.aboveBaselineCount`, applied to the sustained signal |

More tracked days does not automatically mean more value — the qualification floor is a hard
120-day cliff (not a gradual ramp) because the underlying calls are themselves gated by the
existing 90-day cliff. This is the correct, non-inflated way to describe the timeline; no smaller
number should be marketed.

---

## 9. Customer-Question Test

| Candidate | Customer question | Generic AI substitution possible? |
|---|---|---|
| Sustained Activity Trend | "Has this competitor's activity level held up for more than one period, or was last month a blip?" | No — see Section 10 |
| Sustained Repeated Price-Change | "Is this specific product a habitual repricer, or did it just happen to change price twice this month?" | No — see Section 10 |
| Volatility | (rejected — no defensible question was found that isn't already answered by the ratio/direction fields `getActivityPattern` already returns) | N/A |

---

## 10. Generic-AI Substitution Test

A generic ChatGPT/Claude/Gemini session, given nothing but a single webpage or a user's verbal
description, cannot compute either candidate, because both require:

1. **Accumulated, tenant-scoped observation history** the model was never shown (multiple
   independent snapshots taken over weeks by CMA's own scanning infrastructure).
2. **A specific, reproducible windowing/threshold rule** (the 1.5x ratio, the 2-of-3 qualifying
   window rule, the `(monitoredUrlId, entityKey)` grouping) that is CMA's own deterministic
   definition, not a fact available on the public web.
3. **Evidence traceability** — every claim must cite real `ChangeEvent` ids the model has no way
   to have observed independently.

A generic assistant *could* produce a plausible-sounding sentence like "this competitor seems
consistently active," but it would be an unsupported guess, not a reproducible, evidence-linked
computation — exactly the gap CMA's deterministic layer exists to close. This is a genuine
information asymmetry (customer-specific accumulated history), not a generic capability gap, so
**both surviving candidates pass this test.**

---

## 11. Digest Integration Options

Three options were compared for surfacing Section 6.1:

1. **New `DigestItemKind` value (e.g. `SUSTAINED_ACTIVITY_TREND`)** — a new top-level item,
   ordered by the existing fixed-kind-order rule (would need a documented insertion point, e.g.
   immediately after `ACTIVITY_PATTERN` in the tie-break list). Pro: visible in the main digest
   feed alongside other qualifying items, same evidence/ordering discipline. Con: grows the
   `DigestItemKind` union that `@cma/ai`'s `digestTypes.ts` duck-types — requires a corresponding,
   additive (non-breaking) update to that mirror type if the AI layer is to see it (Section 12).
2. **Enrichment field on the existing `ACTIVITY_PATTERN` item** (e.g. add
   `consecutiveQualifyingWindows`/`sustained` directly onto the `ActivityPattern` object the digest
   already renders). Pro: zero new item kind, zero new sort-order decision, smallest UI diff. Con:
   conflates two logically distinct qualification rules (single-window baseline vs. multi-window
   persistence) into one object, and — because `ACTIVITY_PATTERN` items are only included in the
   digest when the *current* window has events (`events.length > 0`), the sustained field would be
   silently absent from the digest whenever the current window happens to have zero raw events even
   though the *pattern itself* still qualifies as sustained. This is a real correctness risk.
3. **Competitor-detail-page-only surface (no Digest change at all)** — render
   `getSustainedActivityTrend` only on `apps/web/src/app/(app)/competitors/[competitorId]/page.tsx`
   via a new card next to the existing `PatternsCard`, using the exact same
   `patternDisplay.ts`-style neutral-language helper pattern already established for
   `ActivityPattern`.

**Recommendation:** Option 3 for Phase 14B's first cut (smallest, lowest-risk, no Digest
composition-function changes, no `DigestItemKind` changes, no AI-bundle changes required at all —
consistent with the "smallest coherent scope" principle in Section 17). Option 1 (new
`DigestItemKind`) is the correct target for a **follow-up** phase once the signal has been
validated on the detail page; it is not required to prove the pattern's value.

---

## 12. AI Integration Contract (future-facing only — not implemented in 14B)

If a later phase decides to feed `getSustainedActivityTrend` into the Tier 4 AI interpretation
layer, the following contract already exists and must be reused, not redesigned:

- `EvidenceBundleItem.pattern` (in `@cma/ai/digestTypes.ts`) would need one additive, optional
  field set (e.g. `sustained?: { consecutiveQualifyingWindows: number; direction: string }`) —
  duck-typed, non-breaking, mirroring how `ActivityPattern`'s own fields were added.
- `buildDigestContext.ts`'s `factsForItem` would extract only the numeric/structural sustained
  fields into `facts`, never free text — same discipline already applied to every existing item
  kind.
- The existing 7-category claim-safety validator (Phase 12) already prohibits exactly the
  vocabulary a naive "sustained trend" description would reach for
  (`forecast`: "will likely," "expected to"; `competitor-strategy`: "aggressive strategy";
  `causal-explanation`: "in response to"). **No new claim-safety category is needed** — the
  existing seven already cover this signal's risk surface. The only new prompt-guidance needed
  (a later phase's concern, not this one) is to explicitly instruct the model that "sustained" or
  "persisted across N periods" describes only backward-looking, already-observed windows, never a
  prediction.
- **AI calls required for Phase 14B: NO.** The sustained-pattern computation itself is 100%
  deterministic and must remain fully usable with zero AI provider configured, per the existing
  "if the AI provider disappears tomorrow, does CMA still have a useful deterministic product?"
  test (Phase 11/12).

---

## 13. Query Complexity

| Candidate | Complexity | Notes |
|---|---|---|
| `getSustainedActivityTrend` (2-offset lookback) | O(1) extra `getActivityPattern` calls per competitor (2× the existing ≤6-query cost = ≤12 queries/competitor) | Same shape class as the already-measured `getDigestForOrganization` (Phase 13: ~8 queries/competitor fixed overhead) — bounded, no N+1 over raw events |
| `getSustainedActivityTrend` (3-offset lookback) | ≤18 queries/competitor | Still O(competitors), just a larger constant; recommend capping the lookback at exactly this to avoid unbounded growth (Section 19) |
| Entity-level sustained repricing (deferred) | O(competitors) × O(offsets), each `getRepeatedPriceChangePatterns` call is 2 queries (`monitoredUrl.findMany` + `changeEvent.findMany`) | Cheaper per call than Activity Pattern, but the in-memory join across offsets (matching `(monitoredUrlId, entityKey)` keys across N result arrays) is O(entities × offsets), still bounded but a distinct correctness surface from Section 7's identity fragility |

No candidate requires scanning/querying individual events one at a time — every query is a bulk
`count`/`findMany` scoped by `organizationId` + `monitoredUrlId IN (...)` + `detectedAt` range,
consistent with the existing pattern in `patterns.ts`/`intelligence.ts`.

---

## 14. Schema Decision

**NO SCHEMA CHANGE REQUIRED.** Every field needed by `getSustainedActivityTrend` (Section 6.1) is
already derivable from `ChangeEvent.detectedAt`, `MonitoredUrl.competitorId`/`organizationId`, and
`Competitor.createdAt` via the *existing, unmodified* `getActivityPattern` function called at
different `now` values. The recommended implementation is a **new repository function that
composes an existing one**, not a new persisted structure. No migration, no new Prisma model, no
new enum.

---

## 15. Competitive-Context Safety

Allowed descriptive statement (matches the existing `aboveBaselineCount` precedent):

> "N of your M tracked competitors currently show a sustained above-baseline activity pattern
> (2 or more consecutive tracked periods)."

This is a plain count over an already-defined, per-competitor deterministic qualification — not a
ranking, not a score, not a causal claim. It is the same shape as the digest's existing
`crossCompetitorContext.aboveBaselineCount`.

**Not allowed, and not proposed:** any statement implying one competitor's sustained trend
explains, responds to, or competes against another's ("Competitor A is reacting to Competitor B's
pricing" — forbidden by the `causal-explanation` and `competitor-strategy` claim-safety
categories already in force); any ranking of competitors by "most sustained"; any inference that
a sustained trend indicates the competitor is "winning" or "losing."

---

## 16. Anti-Features (explicitly rejected/deferred)

- Battlecards, sales intelligence, CRM integration, win/loss tracking — never considered; no
  candidate here resembles them.
- Opaque scoring, "sustained score 87," priority tiers — rejected; every candidate returns
  explainable integers (`consecutiveQualifyingWindows`) and a boolean, never a composite score.
- Forecasting a future window's likely trend continuation — explicitly rejected per Phase 9's
  Candidate B non-goal, reaffirmed here.
- Volatility metric — rejected in Section 5/6 for lack of a defensible, non-arbitrary formula.
- Sustained *promotion* strategy — rejected in Section 2/6: no extractor produces `PROMOTION`
  entities; would require new extraction, out of scope by design.
- Cross-competitor product/plan equivalence sustained over time — deferred, insufficient
  defensible identity (Section 7).

---

## 17. Recommended Implementation Scope

**Smallest coherent next implementation for Phase 14B:**

1. One new repository function, `getSustainedActivityTrend(organizationId, competitorId, days,
   now)`, in `packages/db/src/repositories/patterns.ts` (co-located with `getActivityPattern`,
   which it calls verbatim and unmodified at 2–3 consecutive prior offsets).
2. One evidence/qualification model exactly as specified in Section 6.1.
3. One presentation surface: a new card on the competitor detail page only (Option 3, Section 11)
   — no Digest composition changes, no `DigestItemKind` changes, no AI-bundle changes.
4. Strong test coverage mirroring `patterns.test.ts`'s existing window-boundary matrix style
   (Section 25/Phase 14B spec).

This was chosen over the entity-level alternative (Section 6.2) specifically because it has no
dependency on the fragile `entityKey` identity model (Section 7), reuses an already-tested,
already-hardened function verbatim (no risk of subtly changing `getActivityPattern`'s existing
behavior), and requires the smallest possible new surface area: one function, one card, zero
schema, zero AI, zero Digest changes.

---

## 18. Explicit Non-Goals for Phase 14B

- Do **not** modify `getActivityPattern` or `getRepeatedPriceChangePatterns` themselves — both are
  called verbatim, unmodified, at different `now` offsets.
- Do **not** add a new `DigestItemKind` or change `getDigestForOrganization`'s composition,
  ordering, or item-inclusion rules.
- Do **not** implement the entity-level "sustained repeated price-change" candidate (Section 6.2)
  — real, useful, and specified, but deferred to its own phase given the entity-identity risk.
- Do **not** add any AI call, prompt change, or claim-safety category.
- Do **not** persist the sustained-trend result anywhere (it stays live-computed, like every other
  pattern).
- Do **not** attempt cross-competitor product/plan identity matching.
- Do **not** build a volatility metric or any z-score/burst-detection formula.
- Do **not** change the `Competitor`/`MonitoredUrl`/`ChangeEvent` Prisma schema.

---

## 19. Acceptance Criteria for Phase 14B

1. `getSustainedActivityTrend` returns `{ competitorId, days, current: ActivityPattern,
   consecutiveQualifyingWindows: number, sustained: boolean, sustainedDataAvailable: boolean,
   lookback: ActivityPattern[] }` where `lookback` holds the raw `ActivityPattern` results at each
   offset actually evaluated (bounded to `MAX_SUSTAINED_LOOKBACK = 3`).
2. A window-boundary test matrix (mirroring `patterns.test.ts` lines 349–369) proves the exact
   day-count floor: `sustainedDataAvailable: false` below 120 tracked days (D=30);
   `consecutiveQualifyingWindows` correctly capped and non-negative; `sustained: true` only when
   `consecutiveQualifyingWindows >= 2` **and** all evaluated offsets share the same non-`AT_BASELINE`
   direction as offset 0.
3. A reversal test: offset-0 `ABOVE_BASELINE`, offset `-D` `BELOW_BASELINE` → `sustained: false`,
   `consecutiveQualifyingWindows: 1` (streak breaks immediately, no averaging).
4. A tenant-isolation test mirroring `patterns.ts`'s existing "never leaks another organization's
   activity into the pattern" test, applied to the new function.
5. A query-count regression test asserting the total Prisma call count per invocation stays
   `<= 6 * MAX_SUSTAINED_LOOKBACK` (bounded, matching Section 13).
6. UI: a new card on the competitor detail page, using neutral language
   ("Sustained for 2 consecutive tracked periods" / "Not enough history yet" / "Trend did not
   hold" — no "aggressive"/"escalating"/"winning" language anywhere), consistent with the existing
   `patternDisplay.ts` tone conventions.
7. Mobile: the new card must render correctly at 375×812 (no horizontal scroll, no truncated
   badge text) alongside the existing `PatternsCard`.
8. **AI calls required: NO** — verified by a test asserting the new function makes zero imports
   from `@cma/ai` and zero network calls (mirroring the existing `patterns.ts` module boundary).

---

## 20. Open Questions

- Should `MAX_SUSTAINED_LOOKBACK` be 2 (simplest, matches Phase 9's original Candidate B spec
  exactly) or 3 (slightly richer, costs one more `getActivityPattern` call per competitor)? This
  audit recommends starting at 2 and treating 3 as a low-risk follow-up increment, but the decision
  is a genuine open product call, not a technical blocker.
- Should the competitor-detail-page card eventually also appear on `/compare`
  (`getCompetitiveContext`)? Deferred — not required to prove the initial signal's value, and adding
  it later is a small, additive change once `getSustainedActivityTrend` exists.
- The unresolved digest-window-vs-daily-report-window reconciliation question (carried unresolved
  since Phase 9) is unrelated to this feature and remains genuinely open elsewhere in the codebase.

---

## 21. Historical Phases Re-Audited

```
NO
```

No prior phase's approved implementation was re-litigated. `getActivityPattern`,
`getRepeatedPriceChangePatterns`, `getDigestForOrganization`, the Phase 11 AI interpretation
contract, and the Phase 12 claim-safety validator were read to confirm their exact current
behavior (required to design a correct composition on top of them), not re-designed or
second-guessed. No contradiction with any prior phase's approved decision was found.

---

## Phase 14B Specification

### Data inputs (exact existing structures — no new ones)

- `packages/db/src/repositories/patterns.ts`: `getActivityPattern` (unmodified, called verbatim).
- `ChangeEvent.detectedAt`, `Competitor.createdAt`, `MonitoredUrl.{organizationId,competitorId}` —
  read only through the existing function, never queried directly by the new one.

### Repository/API changes (minimal, additive)

- New export in `patterns.ts`:

```ts
const MAX_SUSTAINED_LOOKBACK = 2; // number of PRIOR offsets checked, in addition to offset 0
const MIN_SUSTAINED_WINDOWS = 2;  // consecutiveQualifyingWindows threshold for `sustained: true`

export interface SustainedActivityTrend {
  competitorId: string;
  days: number;
  current: ActivityPattern;             // offset-0 result, unchanged shape
  lookback: ActivityPattern[];          // offset-0 first, then -D, then -2D, ... (only offsets actually evaluated)
  consecutiveQualifyingWindows: number; // 0 if offset-0 itself does not qualify
  sustained: boolean;                   // consecutiveQualifyingWindows >= MIN_SUSTAINED_WINDOWS
  sustainedDataAvailable: boolean;      // false if history too short to evaluate the next offset
}

export async function getSustainedActivityTrend(
  organizationId: string,
  competitorId: string,
  days: number,
  now: Date = new Date(),
): Promise<SustainedActivityTrend> { /* pseudocode below */ }
```

- No changes to `getActivityPattern`, `getRepeatedPriceChangePatterns`, `intelligence.ts`, or
  `digestTypes.ts`/`buildDigestContext.ts` in this phase.

### Pattern algorithm (pseudocode)

```
function getSustainedActivityTrend(orgId, competitorId, days, now):
    msPerDay = 86_400_000
    offsets = [0, 1, 2][0 .. MAX_SUSTAINED_LOOKBACK]   // offset index i => now - i*days

    current = getActivityPattern(orgId, competitorId, days, now)  // offset 0, always computed

    if not current.qualifies:
        return { current, lookback: [current], consecutiveQualifyingWindows: 0,
                 sustained: false, sustainedDataAvailable: false }

    lookback = [current]
    streak = 1  // offset 0 itself counts as the first window in the streak

    for i in 1 .. MAX_SUSTAINED_LOOKBACK:
        offsetNow = new Date(now.getTime() - i * days * msPerDay)
        prior = getActivityPattern(orgId, competitorId, days, offsetNow)
        lookback.push(prior)

        if not prior.qualifies:
            // not enough tracked history to look this far back yet
            return { current, lookback, consecutiveQualifyingWindows: streak,
                     sustained: streak >= MIN_SUSTAINED_WINDOWS,
                     sustainedDataAvailable: false }

        if prior.direction != current.direction or current.direction == "AT_BASELINE":
            // streak broken by a reversal, or offset-0 itself was only AT_BASELINE
            return { current, lookback, consecutiveQualifyingWindows: streak,
                     sustained: streak >= MIN_SUSTAINED_WINDOWS,
                     sustainedDataAvailable: true }

        streak += 1

    return { current, lookback, consecutiveQualifyingWindows: streak,
             sustained: streak >= MIN_SUSTAINED_WINDOWS,
             sustainedDataAvailable: true }
```

### Evidence model

- `SustainedActivityTrend` itself carries no new `changeEventIds` array — the claim is a
  pattern-of-patterns (each `ActivityPattern` in `lookback` is itself evidence-adjacent via the
  existing digest's raw-event listing for the *current* window). The UI card must render the
  `current` window's supporting events exactly as `PatternsCard` already does for
  `ActivityPattern`, plus a plain-language note of how many consecutive periods (with counts)
  preceded it, each number directly traceable to the corresponding `lookback[i].current`/
  `.baselineAverage` values (no new hidden number).

### UI surface

- New component, e.g. `SustainedTrendCard`, rendered on
  `apps/web/src/app/(app)/competitors/[competitorId]/page.tsx` immediately below the existing
  `PatternsCard`, reusing `patternDisplay.ts`'s tone conventions. Not added to `/digest` or
  `/compare` in this phase (Section 11, Option 3).

### Tests

- Unit (`patterns.test.ts`, extended): window-boundary matrix at 119/120/121/149/150/151 tracked
  days (D=30) proving the 120-day and 150-day cliffs exactly; reversal test; `AT_BASELINE`-at-offset-0
  never counts as sustained; query-count bound test (`<= 12` Prisma calls for
  `MAX_SUSTAINED_LOOKBACK=2`).
- Integration: tenant-isolation test mirroring the existing "never leaks another organization's
  activity" pattern-level test.
- E2E: competitor detail page renders the new card correctly with a seeded 120+/150+-day fixture,
  and renders "not enough history yet" correctly with a <120-day fixture.

### Tenant isolation

- Exact same `organizationId`-scoped `competitor.findFirst`/`monitoredUrl.findMany` calls,
  inherited for free by calling `getActivityPattern` (already tenant-safe) rather than querying
  `ChangeEvent` directly.

### Query-count expectations

- `<= 6 * MAX_SUSTAINED_LOOKBACK` Prisma calls per invocation (12 for the recommended default of 2
  offsets beyond current). Guard test required per Acceptance Criterion 5.

### Mobile

- Verify the new card at **375 × 812** — no horizontal scroll, badge/label text wraps rather than
  truncating illegibly.

### AI

```
AI calls required: NO.
```
The function is deterministic and must remain fully functional and independently testable with
`@cma/ai` never imported.

---

## Validation Principles Preserved

```
Deterministic facts are authoritative.
Historical baselines use explicit windows.
Current windows are not silently mixed into historical baselines.
Insufficient history is not equivalent to no pattern.
Every pattern is explainable.
Every pattern is evidence-linked.
Tenant boundaries are mandatory.
No global customer baseline.
No opaque scoring.
No causal inference.
No competitor-intent inference.
No forecasting.
No market-share/revenue estimation.
AI remains downstream interpretation.
```

---

## Final Architectural Test — Answers

1. **What genuinely new historical intelligence can CMA derive today?** Whether a competitor's
   activity-vs-baseline qualification has persisted across 2+ consecutive tracked periods
   (Section 6.1), and separately, whether a specific priced entity has repriced repeatedly across
   consecutive periods (Section 6.2, deferred).
2. **Which candidate creates the clearest new customer information advantage?** The competitor-level
   Sustained Activity Trend (6.1) — same information value as 6.2, but without inheriting the
   entity-identity fragility of Section 7.
3. **Can it be derived deterministically from existing data?** Yes — pure composition of
   `getActivityPattern` at multiple `now` offsets.
4. **Can it avoid new extraction?** Yes.
5. **Can it avoid schema changes?** Yes.
6. **Can it remain evidence-grounded?** Yes — via the current window's existing `ChangeEvent`
   evidence, plus fully-inspectable prior-window `ActivityPattern` numbers.
7. **Can it be computed without event-level N+1 behavior?** Yes — bounded, ≤6 queries per offset,
   ≤2–3 offsets, same O(competitors) shape already measured in Phase 13.
8. **Does it become materially more useful after 90–120 days?** Yes — it has a hard, testable
   120-day floor (for a 2-window check at D=30), consistent with (and one tier deeper than) the
   existing 90-day floor for `getActivityPattern` itself.
9. **Can it integrate with the existing Digest without redesigning it?** Yes, but the recommended
   Phase 14B scope deliberately does **not** integrate it into the Digest yet (Section 11) —
   integration is a small, additive follow-up once the standalone signal is validated.
10. **Can future AI interpret it without becoming the source of truth?** Yes — the existing
    evidence-bundle and 7-category claim-safety contract already cover this signal's vocabulary
    risk with no new category required (Section 12); AI involvement is explicitly out of scope
    for 14B itself.
11. **What should Phase 14B implement?** `getSustainedActivityTrend` (Section 6.1/Phase 14B spec
    above) + one competitor-detail-page card. Nothing else.
12. **What should Phase 14B explicitly NOT implement?** Everything listed in Section 18 — the
    entity-level sustained repricing candidate, any Digest/AI wiring, any volatility metric, any
    promotion pattern, any cross-competitor identity matching, any schema change.

---

## Final Output

```
PHASE 14A — HISTORICAL INTELLIGENCE DESIGN AUDIT

Status:
PASS WITH FINDINGS

Code changes:
NONE

Report:
docs/phases/PHASE14A-HISTORICAL-INTELLIGENCE-DESIGN-AUDIT.md

Current historical intelligence:
getActivityPattern (single-window activity-vs-own-3-window-baseline, ratio thresholds 1.5x/0.667x,
qualifies at >=2/3 historical windows / >=90 tracked days at D=30) and
getRepeatedPriceChangePatterns (single-window, >=2 price changes per (monitoredUrlId, entityKey))
are implemented, deterministic, org-scoped, and evidence-grounded, composed into a deterministic
Digest (Phase 10) with an evidence-gated, claim-safety-validated AI interpretation layer on top
(Phase 11/12, verified against real infra in Phase 13). Neither pattern function currently
compares its own qualification across more than one window — there is no existing "sustained /
persisted over time" signal.

Key finding:
The exact target capability was already identified and deferred across Phases 9-10 as
"Candidate B - Sustained (Multi-Window) Trend Pattern" and never built. It is fully derivable
today by composing the existing, unmodified getActivityPattern at 2-3 consecutive time offsets;
no new extraction or schema is needed. A parallel entity-level "sustained repeated price-change"
signal is equally derivable from getRepeatedPriceChangePatterns but inherits the fragile
JSON-LD-name-derived entityKey identity model and is therefore deferred in favor of the
competitor-level signal, which has no identity dependency at all.

Recommended Phase 14B:
Implement getSustainedActivityTrend(organizationId, competitorId, days, now) in
packages/db/src/repositories/patterns.ts, calling the existing getActivityPattern verbatim at up
to 2 prior offsets (bounded MAX_SUSTAINED_LOOKBACK=2), returning
{ current, lookback, consecutiveQualifyingWindows, sustained, sustainedDataAvailable }.
Surface it only on the competitor detail page as a new card next to the existing PatternsCard.
Do NOT wire it into the Digest, the AI interpretation bundle, or /compare in this phase.

AI calls required for Phase 14B:
NO

Schema changes required:
NO

New extraction required:
NO

Evidence model:
Reuses the current window's existing ChangeEvent evidence (already surfaced for ActivityPattern);
prior-window numbers are fully inspectable via the returned lookback array, no hidden number.

Query model:
Bounded, O(competitors), <=6 Prisma calls per offset x <=2 offsets beyond current = <=12 total per
invocation - same shape class as the Phase-13-measured getDigestForOrganization cost.

Time-to-value:
Hard floor at 120 tracked days (D=30) for the minimal 2-consecutive-window sustained claim, one
tier deeper than getActivityPattern's own existing 90-day floor; 150 days for a 3-window claim if
MAX_SUSTAINED_LOOKBACK is later raised to 3.

Main deferred items:
Entity-level "sustained repeated price-change" pattern (Section 6.2, identity-fragility risk);
Digest/DigestItemKind integration; AI-bundle wiring; /compare integration; cross-competitor
sustained-count statement; volatility metric (rejected, no defensible formula found); sustained
promotion pattern (rejected, no extractor produces PROMOTION entities).

Historical phases re-audited:
NO

Next step:
Phase 14B implementation, scoped exactly as specified above.
```
