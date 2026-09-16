# Phase 7 — Intelligence Model

Conceptual model for how CMA turns raw evidence into intelligence. Written
before implementation per the brief's Section 3. Every term below maps to a
concrete function in `packages/db/src/repositories/` — this is not aspirational.

## The five tiers

```
OBSERVATION            "Product X's price changed from €49 to €59 on 2026-09-01."
      │                 = one ChangeEvent row, already existed since Phase 1.
      ▼
DERIVED FACT            "Product X had 3 price changes in the last 30 days."
      │                 = a deterministic COUNT/GROUP BY over ChangeEvent rows.
      │                 Already exists (Phase 6: getPriceHistoryForCompetitor,
      │                 getCompetitorActivityMetrics).
      ▼
PATTERN                 "Product X's price-change count (3) exceeds the
      │                 'repeated activity' threshold (≥2) for this window."
      │                 = a derived fact evaluated against a formally defined,
      │                 documented threshold AND a minimum-sample-size gate.
      │                 NEW in Phase 7: packages/db/src/repositories/patterns.ts.
      ▼
AI INTERPRETATION       "This may indicate more active price experimentation
      │                 than usual for this product." (hedged, sourced)
      │                 = an AI call whose ONLY input is the pattern + derived
      │                 fact objects above (never raw page content), never
      │                 authoritative for the number itself.
      │                 NOT implemented in Phase 7 (see PHASE7-VALIDATION.md
      │                 Section on deferred scope) — same status as Phase 6.
      ▼
HYPOTHESIS               "Perhaps the competitor is testing price elasticity."
                          = explicitly labeled speculation, never asserted as
                          fact, never computed deterministically. Would only
                          ever appear inside an AI interpretation's own
                          "speculation" field (mirroring AiAnalysis.speculation's
                          existing Json array), never in a deterministic
                          repository return type.
```

## Why the boundary between PATTERN and AI INTERPRETATION matters

A **pattern** is a number plus a rule, both fully inspectable and
reproducible without any network call: "3 ≥ 2, therefore this qualifies as
'repeated'." Every pattern function in this phase returns enough structure
(`qualifies: boolean`, the raw counts, the threshold used, the window) that
a customer — or a future AI call — can verify the claim by re-deriving it.

An **AI interpretation** is language generated *about* a pattern that
already exists. It is optional, costs money, can fail, and must never be
the only place a number lives. This mirrors the existing `AiAnalysis`
relationship to `ChangeEvent` exactly (Phase 3): the deterministic fact
(`ChangeEvent.oldValue`/`newValue`/`percentageChange`) exists and is usable
with zero AI calls; `AiAnalysis` is a separate, optional row that explains
it.

## What each tier is allowed to claim

| Tier | May say | May NOT say |
|---|---|---|
| Observation | "X changed from A to B on date D, evidence: …" | anything not directly in the ChangeEvent |
| Derived fact | "N events of type T in window W" | any qualitative judgment ("a lot," "concerning") |
| Pattern | "N meets/exceeds threshold K for pattern P, given M qualifying historical windows" | why it happened, whether it's good/bad/strategic |
| AI interpretation | "This may indicate …" (hedged, cites the pattern/fact it's interpreting) | new numbers not present in the fed-in facts; certainty language |
| Hypothesis | "One possible explanation, unconfirmed, is …" | ever being rendered without the word "possible"/"may"/equivalent hedge |

## Entity identity and entity history

See `PHASE7-DATA-AUDIT.md` Sections 1–3 for the full justification. In this
model, an "entity" is exactly the pair `(monitoredUrlId, entityKey)` where
`entityKey` originates from a JSON-LD `PRICE` extraction. An entity's
**history** is the ordered list of every ChangeEvent (not just price
changes) sharing that pair — this is the closest thing CMA has to "this
identifiable product's story," and it requires no new persistence: it is a
`WHERE (monitoredUrlId, entityKey) = (?, ?) ORDER BY detectedAt` query.

An entity's **lifecycle state** is derived, not stored: `currentlyDetected`
is true unless the most recent ChangeEvent for that pair is a
`PRODUCT_REMOVED`. This is deliberately the same weak, honest semantics
Phase 6 already established for `getProductLifecycleSummary` — "no longer
detected" is a fact about the monitor's observation, not a claim about the
competitor's business decision (see the disclaimer already rendered on
`ProductLifecycleCard` in `apps/web`).

## Minimum sample size discipline

Every pattern function returns a `qualifies: boolean` (or equivalent
gating field) computed from an explicit, documented rule — never an
implicit "if truthy" check on a raw count. A pattern that does not qualify
must be rendered (or interpreted by AI) as "insufficient history," not
omitted silently and not downgraded into a soft claim. This directly
implements the brief's Section 9 worked example (1 change this month vs. 0
last month must never be described as "dramatically increased").

## Baseline / anomaly

Phase 7 implements exactly one baseline concept — activity-vs-own-history
(Section 4.1 of the data audit) — using the organization's own accumulated
`ChangeEvent` history as the sole comparison, never a cross-tenant or
cross-competitor baseline (which would require assumptions about
comparable monitoring cadence that the current schema cannot verify). No
ML, no opaque scoring — the baseline is a mean over N explicit prior
windows, fully reproducible by any reader of the code.

## Sequence / co-occurrence

Temporal proximity between two differently-typed ChangeEvents is
*observable* (both have `detectedAt`) but is deliberately **not** promoted
to a named "pattern" in this phase — see Data Audit Section 4.3. The
existing Timeline UI (calendar-day grouping) already gives a customer this
information without asserting any relationship stronger than "these things
were both true around the same time," which is exactly the honest
boundary the brief requires.

## Cross-competitor context

Not extended in this phase beyond what Phase 6 already built
(`compareCompetitors` — independent per-competitor counts, no ranking).
Once a per-competitor pattern exists (Section 4.1 of the data audit), a
purely descriptive cross-competitor pattern comparison ("Competitor A
recorded 3 qualifying activity-pattern windows in the last 90 days,
Competitor B recorded 1") is a natural, low-risk next step — deferred here
to keep this phase's diff reviewable, not because the data doesn't support
it. See `PHASE7-PRODUCT-ASSESSMENT.md`, Recommended Next Direction.

## Customer-specific relevance

Existing customer context usable today, without inventing new semantics:
`Organization.timezone` (already used for window alignment),
`Competitor.name`/`notes` (freeform, not structured enough to drive
relevance filtering), and which `MonitoredUrl`s + `UrlCategory` a customer
chose to track (a real signal of what they care about — e.g. a customer
who only tracks `PRICING_PAGE` URLs implicitly cares about pricing
patterns more than content patterns). No new "industry" or "relevance
profile" concept is introduced — the data to support one does not exist
yet (documented as a genuine gap, not built as a guess).
