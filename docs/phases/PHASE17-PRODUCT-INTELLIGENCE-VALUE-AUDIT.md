# Phase 17 — Product / Intelligence Value Audit

**Type:** Analysis only. No code, schema, extraction, AI, or UI changed in this phase.
**Status:** PASS WITH FINDINGS
**Historical phases re-audited:** NO (one concrete, current-code inconsistency was found and is reported in Section 8/11 — not a re-litigation of any prior phase's decision, but a Phase-16-scope gap confirmed directly against the shipped code)

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
No UI changes.
```

`git status --short` / `git diff --stat` were run before and are re-confirmed empty at the end of
this report (Section 19).

---

## 3. Historical Phases Re-Audited

```
NO
```

Phase 9's product-direction gap analysis, Phase 14A/14B's sustained-trend design and
implementation, and Phase 15's signal-value audit are treated as approved context and are not
re-litigated. Phase 16's implementation is treated as approved and correct for everything it
claims to have done. This audit did, however, verify Phase 16's own claims directly against the
current repository (not restated from the report) while building the signal-utilization inventory
in Section 9 — that verification surfaced one concrete, narrow gap **inside Phase 16's own stated
scope** (Section 8), which is reported because it is a fact about the current codebase, not a
second-guess of an approved decision. No contradiction with any earlier phase's approved formula,
threshold, or window model was found.

---

## 4. Current Intelligence Model

Reconstructed directly from `packages/db/src/repositories/{intelligence,patterns}.ts` and
`packages/ai/src/{buildDigestContext,digestTypes}.ts` as they exist today (all read in full for
this audit):

```
Tier 1 — Observation
  ChangeEvent (packages/detection/src/compare.ts writes it)
  Fields used downstream: changeType, severity, entityKey, detectedAt, oldValue/newValue,
  percentageChange, evidenceExcerpt, changeEventId

Tier 2 — Derived Facts (single window, no baseline)
  getOrgActivityMetrics / getCompetitorActivityMetrics — counts, current vs. previous period
  getProductLifecycleSummary — added/removed counts
  compareCompetitors — descriptive cross-competitor counts, no ranking

Tier 2.5 — Historical Entity Intelligence
  getPriceHistoryForCompetitor — per-(monitoredUrlId, entityKey) price series
  getEntityHistoryForCompetitor — full add/reprice/remove chain per entity
  Both restricted to entities with a non-null entityKey (JSON-LD PRICE only — see Section 10)

Tier 3 — Patterns (single window vs. own baseline)
  getActivityPattern — current window vs. mean of 2-3 prior windows, own history only
  getRepeatedPriceChangePatterns — >=2 price changes on the same entity inside one window

Tier 3.5 — Sustained Pattern (multi-window persistence) [Phase 14B]
  getSustainedActivityTrend — getActivityPattern called at 2-3 consecutive offsets,
  consecutiveQualifyingWindows + sustained boolean, reused verbatim by Phase 16

Tier 3.75 — Cross-Competitor Context
  aboveBaselineCount (Phase 8/10) — count of competitors currently ABOVE_BASELINE
  sustainedCount (Phase 16) — count of competitors currently sustained
  Both are DB-layer-only `.filter().length` counts, see Section 8 for which of the two actually
  reaches the customer/AI today

Tier 4 — Digest (composition, zero new formula)
  getDigestForOrganization — 5 item kinds: CHANGE_EVENT, REPEATED_PRICE_CHANGE, ACTIVITY_PATTERN,
  SUSTAINED_ACTIVITY_TREND (Phase 16), LIFECYCLE. Recency-ordered, evidence-linked, never truncated
  by an importance score.

Tier 5 — Evidence-Grounded AI Interpretation
  buildDigestInterpretationInput → EvidenceBundle (facts + untrustedText, kept structurally
  separate) → AI provider → AiInterpretationOutput (observations/interpretations/hypotheses) →
  validateDigestClaimSafety (7 categories, unmodified since Phase 12)
```

This ladder is unchanged in shape from Phase 15's description; Phase 16 populated the
`SUSTAINED_ACTIVITY_TREND` slot at Tier 4 exactly as Phase 15 recommended. The ladder itself is
complete, internally consistent, and — per this audit's own re-verification — every formula
(`BASELINE_RATIO_THRESHOLD = 1.5`, `MIN_QUALIFYING_BASELINE_WINDOWS = 2`, `MIN_SUSTAINED_WINDOWS =
2`, `MIN_REPEATED_PRICE_CHANGES = 2`) is exactly as documented in Phase 7/14A, unmodified.

---

## 5. Customer Question Matrix

Reconfirmed against the current, Phase-16-updated code (not restated from Phase 15 — every
"ANSWERED" claim below was checked against the actual UI/repository files listed in Section 19).

| Customer question | Status | How |
|---|---|---|
| What changed on my competitors' websites? | ANSWERED | `CHANGE_EVENT` digest items, `/changes` timeline |
| Which competitor changed something recently? | ANSWERED | Digest, recency-ordered, per-item competitor link |
| What exactly changed? | ANSWERED | `evidenceExcerpt` on the linked `/changes/[id]` page |
| Has this competitor been changing more often recently? | ANSWERED | `ACTIVITY_PATTERN` item, `/compare` |
| Is this behavior persistent, or was it a one-off blip? | ANSWERED (per-competitor, since Phase 16) | `SUSTAINED_ACTIVITY_TREND` digest item, `SustainedTrendCard` on competitor detail |
| What has changed repeatedly over the last few months? | ANSWERED | `REPEATED_PRICE_CHANGE` digest item |
| Has a competitor's pricing *behavior* persisted across periods (not just one product's price)? | PARTIALLY | Competitor-level persistence is answered (`SUSTAINED_ACTIVITY_TREND`); entity-level "this specific product has repriced repeatedly across 2+ consecutive windows" does not exist — correctly blocked (Section 10) |
| Are several competitors showing similar activity right now? | ANSWERED (single-window) | `aboveBaselineCount`, rendered on `/digest`'s summary card |
| Are several competitors showing a *sustained* pattern right now? | **PARTIALLY — this is this audit's primary finding** | The individual fact exists and is even visible per-competitor (scan the feed for `SUSTAINED_ACTIVITY_TREND` badges), but the aggregate count (`sustainedCount`) is computed and tested at the DB layer only — it is not rendered on `/digest`'s summary card and not present in the AI evidence bundle's `crossCompetitorContext`. See Section 8. |
| Which products have changed price? | ANSWERED | `RepeatedPriceChangePattern`, `getPriceHistoryForCompetitor` |
| How often has a tracked price changed? | ANSWERED | `changeCount` on the pattern |
| Can I reliably compare the same product across competitors? | NOT_ANSWERED (by design) | No cross-competitor product/plan equivalence — correctly out of scope (Section 15) |
| What deserves my attention today? | PARTIALLY (by design) | Digest surfaces everything that qualifies, recency-ordered; there is deliberately no ranking/score — the AI interpretation summary is the closest thing to a synthesized "what matters" answer |
| What changed that is actually important? | PARTIALLY | `severity` is stored and shown as a badge on every `CHANGE_EVENT` item but is never used to filter, sort, or gate anything (unchanged since Phase 9) |
| Is something becoming persistent rather than temporary? | ANSWERED (competitor level) / NOT_ANSWERED (entity level, blocked) | See rows above |
| Is a competitor repeatedly changing the same product? | ANSWERED | `RepeatedPriceChangePattern` is entity-scoped |
| Are multiple competitors moving in a similar, *sustained* direction? | **PARTIALLY — same gap as above** | Data exists (`sustainedCount`); not customer-visible or AI-visible today |
| What evidence supports that something unusual is happening? | ANSWERED | Every digest item carries non-empty `changeEventIds`, linked to `/changes/[id]` |
| What should I discuss with my team? | PARTIALLY | The AI interpretation `summary` is the intended answer to this; it is grounded only in what the evidence bundle contains, which today under-represents the sustained-persistence aggregate (Section 8) |

---

## 6. Current Digest Intelligence

`/digest/page.tsx` (read in full) shows, per item: competitor name/link, a kind-specific badge, a
one-line description, a timestamp, and an evidence link. It shows exactly one cross-competitor
summary line today:

```
"{aboveBaselineCount} of {totalTrackedCompetitors} tracked competitors are currently above
their own historical baseline."
```

`digest.crossCompetitorContext` (the object returned by `getDigestForOrganization`) actually
contains **three** fields — `aboveBaselineCount`, `sustainedCount`, `totalTrackedCompetitors` — but
the page destructures only `{ aboveBaselineCount, totalTrackedCompetitors }` (confirmed at
`apps/web/src/app/(app)/digest/page.tsx:133`). `sustainedCount` is computed, correctly tenant-
isolated, and covered by three dedicated DB-layer tests (`intelligence.test.ts:918/930/934`), but
never reaches this page.

The Digest already answers "what happened" and "what's a qualifying single-window pattern" (both
per-competitor and, for `aboveBaselineCount`, in aggregate) and, since Phase 16, "what's a
persistent pattern" **per competitor** — but not "how many of my competitors are showing a
persistent pattern right now" in one glance. A customer can still get that number, but only by
manually counting `Sustained trend` badges across the full item list — exactly the kind of
manual-aggregation burden the Digest itself exists to remove (this was Phase 9's original framing
for `aboveBaselineCount`, and it applies identically to `sustainedCount`).

---

## 7. Historical Value Curve

Unchanged in shape from Phase 15 — Phase 16 did not alter any formula, threshold, or window
model, so the floors below are identical; only the "what's visible" column is updated to reflect
where the signal is now surfaced vs. still stranded.

| Horizon (D=30) | Knowable | Where it's visible today |
|---|---|---|
| 0–7 days | Raw `ChangeEvent`s; a `RepeatedPriceChangePattern` with `changeCount: 1` (not yet qualifying) | Digest, Timeline |
| 30–90 days | First qualifying `REPEATED_PRICE_CHANGE`; `getActivityPattern` reports `INSUFFICIENT_HISTORY` | Digest |
| 90 days | `getActivityPattern` first qualifies (2/3 historical windows) | Digest `ACTIVITY_PATTERN` items begin appearing |
| 120 days | Full 3-window `ActivityPattern` baseline; **first day `getSustainedActivityTrend` can report `sustained: true`** | Digest `SUSTAINED_ACTIVITY_TREND` item (per competitor), competitor detail page — **not** the aggregate summary card or AI evidence (Section 8) |
| 150 days | 3-window sustained streak (ceiling, `MAX_SUSTAINED_LOOKBACK = 2`) | Same surfaces as 120 days |
| 180+ days | Multiple competitors independently cross the 120-day floor at different times | This is exactly the moment `sustainedCount` stops being "0 or 1" and starts being genuinely informative as an aggregate — and it is exactly the moment this audit's Section 8 finding starts costing the customer real information, because the aggregate still isn't rendered |
| 365+ days | Deep, multi-cycle, multi-competitor history | A generic AI session started today has none of this; the gap only widens with account age |

**Conclusion, updated from Phase 15:** the product's differentiated-value threshold (120 days) was
already reached by `getSustainedActivityTrend` itself before this phase. What this audit adds is
the observation that the 180-day aggregate threshold (multiple competitors independently sustained)
is *also* already reached by the code — `sustainedCount` is already correct at that horizon — but
the product does not yet show it to anyone.

---

## 8. Signal Utilization Audit

| Signal | Stored? | Derived? | Surfaced (UI)? | In AI evidence? | Actionable? | Notes |
|---|---|---|---|---|---|---|
| `ChangeEvent.severity` | Yes | N/A | Yes (badge on `CHANGE_EVENT` items only) | Yes (`facts.severity`) | Display-only — never filters/sorts/gates anything (unchanged since Phase 9) | Confirmed by grep: only 3 references in `packages/db/src/repositories`, none in pattern/digest logic |
| `ChangeEvent.confidence` (Float, extraction-detection confidence) | Yes | N/A | **No** | **No** | **No** | Newly noted in this audit (not mentioned in Phase 9 or 15's inventories) — written at ingestion (`monitoringPipeline.ts`), read nowhere downstream of that. Distinct from `AiAnalysis.confidence` (a separate String field on a different, currently-unused-by-Digest model). No concrete customer question in Section 5 depends on it; flagged for awareness only, not a candidate (Section 12) |
| `ActivityPattern` (single window) | No (live) | Yes | Yes (`/digest`, `/compare`, competitor detail) | Yes | Yes | Fully distributed |
| `RepeatedPriceChangePattern` | No (live) | Yes | Yes | Yes | Yes | Fully distributed |
| `SustainedActivityTrend` (per competitor) | No (live) | Yes | Yes (Digest item + competitor detail card, since Phase 16) | Yes (`factsForItem` case) | Yes | Fully distributed at the per-competitor level |
| `aboveBaselineCount` (cross-competitor) | No (live) | Yes | Yes (`/digest` summary card) | Yes (`EvidenceBundle.crossCompetitorContext.aboveBaselineCount`, rendered in the prompt via `digestPrompt.ts:101`'s `jsonLine("Cross-competitor context", ...)`) | Yes | Fully distributed |
| **`sustainedCount` (cross-competitor)** | No (live) | Yes, tested (`intelligence.test.ts`) | **No** — not read by `digest/page.tsx` | **No** — absent from `DigestForInterpretation.crossCompetitorContext` and `EvidenceBundle.crossCompetitorContext` in `packages/ai/src/digestTypes.ts` (both types hard-code only `aboveBaselineCount`/`totalTrackedCompetitors`) | **No** | **This is the concrete finding of this audit.** Same shape, same test rigor, same tenant-isolation guarantee as `aboveBaselineCount` — but the parallel wiring into the AI bundle type and the UI render was not done. Not a regression (nothing broke — it simply never shipped the last two hops), and not a violation of anything Phase 16 explicitly promised (Phase 15 Section 16 item 4 only specified the DB-layer field; Phase 16's report accurately describes exactly what it did). It is, however, a genuine, verifiable "signal computed but stranded" finding, and it is the *same* structural gap this whole Phase 9→15→16 arc has been closing one layer at a time. |
| `EntityType.PROMOTION` / `EntityType.PLAN` | Schema-only | No producer | No | No | No | Unchanged since Phase 9/14A/15 — `structuredData.ts` (re-grepped this phase) still emits only `"PRICE"` and `"GENERIC"` |
| `entityKey` (JSON-LD) | Yes | N/A | Yes (price series, repeated-price pattern) | Yes | Yes, with the documented identity-fragility caveat | `jsonld:${name}.toLowerCase()`, no normalization beyond case-folding — reconfirmed by direct read of `structuredData.ts` this phase; unchanged since Phase 14A |

---

## 9. Phase 16 Product Effect

Evaluated directly, not re-validated (Phase 16's own test suite is accepted as-is):

1. **What customer question did `SUSTAINED_ACTIVITY_TREND` newly enable?** "Is this competitor's
   elevated/reduced activity a one-off, or has it held for 2+ consecutive tracked periods?" — a
   materially stronger claim than `ACTIVITY_PATTERN` alone, because it requires a second,
   independently-computed prior qualification, not just the current window.
2. **How different is that from `ACTIVITY_PATTERN`?** Qualitatively different: `ACTIVITY_PATTERN`
   is a snapshot; `SUSTAINED_ACTIVITY_TREND` is a claim about persistence across time, reusing the
   snapshot mechanism at multiple independent offsets.
3. **Meaningful incremental information?** Yes, confirmed by this audit's own read of the gating
   logic (`sustained === true && events.length > 0`) — it is strictly additive and never fabricates
   a claim the underlying data doesn't support.
4. **Does the Digest presentation make the distinction clear?** Yes, at the item level: "Sustained
   trend" + "Above/Below baseline" badges, "Sustained for N consecutive tracked periods" text,
   verified in `digest/page.tsx`.
5. **Does `sustainedCount` add useful context?** It would, but currently does not reach the
   customer (Section 8) — its value is real but unrealized today.
6. **Does the AI evidence bundle have enough information to interpret the per-competitor signal
   safely?** Yes for individual items (`consecutiveQualifyingWindows`/`direction` are present in
   `factsForItem`'s `SUSTAINED_ACTIVITY_TREND` case). Not yet for the aggregate (Section 8).
7. **Is sustained activity alone sufficient, or is a first composition already justified?** Sustained
   activity alone already answers a real, standalone customer question (row 5 of Section 5) and
   does not require composition to be useful. The next composition (sustained + repeated-price,
   Phase 15's Composition B) is real but adds a second, harder-to-phrase claim — this audit does
   not find new evidence that it is more urgent than finishing sustained's own distribution
   (Section 11).

---

## 10. CMA vs Generic AI

**What can CMA know after monitoring the same competitors for 90–120+ days that a generic
ChatGPT/Claude/Gemini session cannot know unless fed CMA's own accumulated data?**

- That a specific competitor's activity has stayed above (or below) its own historical baseline for
  2 or 3 consecutive tracked periods — a claim that requires having independently computed and
  stored `getActivityPattern` at 2-3 non-overlapping historical offsets, which requires the
  monitoring history itself to have existed that long. A generic AI session has no such memory; it
  can only reason over whatever the user manually pastes in, and cannot independently verify "this
  also held N periods ago."
- That N of M tracked competitors are *currently* in that state, computed identically across every
  competitor the same way, with tenant isolation guaranteed by construction (this is the
  `sustainedCount` fact — real, computed, correct, but see Section 8 for why it currently cannot yet
  be *told* to the customer or the AI layer).
- Every claim above is evidence-linked to specific `ChangeEvent` rows a customer can click through
  to, not a re-derived or hallucinated summary.

**Is this advantage currently exposed sufficiently in the UI?** Partially. Per-competitor
persistence is exposed well (Digest item + competitor detail card). The aggregate, multi-competitor
version of the same advantage — arguably the more "wow, it noticed something across my whole
market" moment — is not yet exposed, which is this audit's central finding.

---

## 11. Remaining Intelligence Gap

The deterministic ladder itself (Section 4) has no missing rung that blocks a concretely-askable
customer question from Section 5, except the two explicitly-accepted, deliberate exclusions
(cross-competitor product equivalence, entity-level sustained repricing — both correctly out of
scope per Sections 10/15 of the brief and Phase 14A's unchanged identity-fragility argument).

The actual gap this audit identifies is **not a missing signal** — it is the same "signal computed,
not distributed" pattern that Phase 9→15→16 has now closed three times in a row (raw events →
Digest in Phase 10; per-competitor sustained trend → Digest in Phase 16) recurring a fourth time,
one level up: **the cross-competitor aggregate of the signal Phase 16 just shipped is itself
stranded**, exactly the way the per-competitor version was stranded before Phase 16. This is a
**Category C/D gap** (contextualization/presentation, per Section 8 of the brief), not a Category A
(new primitive signal) or B (composition) gap — no new detection logic is required; the number
already exists, is already tested, and is already tenant-isolation-verified.

---

## 12. Candidate Next Capabilities

Bounded to 8 candidates, following directly from Sections 8/9/11 above and Phase 15's own
un-actioned "Strong Candidate" / "Deferred" list (re-evaluated, not merely copied):

1. **Cross-competitor sustained context distribution** — wire the already-computed, already-tested
   `sustainedCount` into (a) `EvidenceBundle`/`DigestForInterpretation`'s `crossCompetitorContext`
   in `packages/ai/src/digestTypes.ts`, and (b) the `/digest` summary card in
   `apps/web/src/app/(app)/digest/page.tsx` — same shape as the existing `aboveBaselineCount` wiring
   in both places, literally reusing the same pattern twice.
2. **Composition B** — a conjunction sentence for a competitor whose `RepeatedPriceChangePattern`
   and `SustainedActivityTrend` are both qualifying in the same window ("repriced repeatedly during
   a period of sustained above-baseline activity"), phrased strictly as a conjunction, never causal
   (Phase 15 Section 10.B).
3. **Composition C** — lifecycle (`added`/`removed`) + sustained co-occurrence, same shape, weaker
   customer-value justification (Phase 15 Section 10.C, unchanged).
4. **`/compare` integration of `SustainedActivityTrend`** — add a "Sustained" column to the compare
   table, same shape as the existing "Activity vs. own baseline" column, via
   `getCompetitiveContext`.
5. **Entity-level sustained repeated price-change pattern** — genuinely new information, but blocked
   by `entityKey` identity fragility (Section 8 above; Phase 14A Section 7, unchanged).
6. **Severity- or confidence-aware digest ordering/highlighting** — `severity` is display-only;
   `ChangeEvent.confidence` (newly noted, Section 8) is entirely unused downstream of ingestion. No
   concrete customer question in Section 5 currently depends on either.
7. **Promotion pattern intelligence** — no extractor produces `PROMOTION`/`PLAN` entities; still a
   genuinely absent capability, not a current bottleneck (Phase 15 Section 12, reconfirmed).
8. **Org-wide `getRepeatedPriceChangePatterns` union** (Phase 9 Candidate C) — real, cheap, no new
   evidence in this audit elevates it above candidate 1.

---

## 13. Candidate Evaluation

| Candidate | Customer question | Existing data sufficient? | New detector? | Evidence quality | Incremental value | Complexity | Risk | Recommendation |
|---|---|---|---|---|---|---|---|---|
| 1. Sustained context distribution | "Are several competitors showing a sustained pattern right now?" | Yes — `sustainedCount` already computed, tested, tenant-isolated | No | High — same `.filter().length` provenance as the already-shipped `aboveBaselineCount` | Moderate-high — closes the exact gap this audit's evidence points at | Very low — two files, mirrors existing code exactly | Very low — additive optional field, no schema/prompt/claim-safety change needed | **READY** |
| 2. Composition B | "Has this competitor's pricing persisted, not just its overall activity?" | Yes — both facts already computed per competitor in the same digest loop | No | High, but requires disciplined conjunction phrasing (not causal) | Moderate-high | Low-moderate — touches item description generation + AI fact composition | Low-moderate — phrasing risk, mitigated by existing 7-category claim-safety gate | STRONG CANDIDATE — defer until candidate 1 ships and its real usage is assessed |
| 3. Composition C | "Were product changes concentrated during an elevated period?" | Yes | No | High | Low-moderate — narrower, less immediately actionable than 1/2 | Low | Low | DEFER |
| 4. `/compare` sustained column | "Which of my selected competitors show a sustained pattern?" | Yes | No | High | Moderate — same info as scanning the digest feed, in table form | Low | Low | DEFER — no new finding elevates it above candidate 1 |
| 5. Entity-level sustained repricing | "Has this specific product's pricing behavior itself persisted?" | No — blocked by identity | Yes (new composition logic), but on fragile ground | Would be high if identity were solid | Would be high | Moderate | High — silent identity resets on label changes | **BLOCKED** |
| 6. Severity/confidence-aware ordering | "What deserves attention?" | Data exists but unused for this purpose | No | Fields already stored | Low — no concrete customer question currently depends on it | Low | Low, but risks drifting toward an opaque relevance score if not done carefully | NOT CURRENTLY JUSTIFIED |
| 7. Promotion pattern | "What promotions changed?" | No — no extractor | Yes | N/A | Would be high if built, but nothing today references it | High (new extraction tier) | Moderate | NOT CURRENTLY JUSTIFIED |
| 8. Org-wide repeated-price union | "Which products across ALL competitors are repricing repeatedly?" | Yes | No | High | Low-moderate | Low | Low | DEFER |

---

## 14. Recommended Next Phase

**Phase 18 (proposed name: "Cross-Competitor Sustained Context Distribution") should implement
exactly:**

1. Add `sustainedCount: number` to `DigestForInterpretation.crossCompetitorContext` and
   `EvidenceBundle.crossCompetitorContext` in `packages/ai/src/digestTypes.ts`, alongside the
   existing `aboveBaselineCount`/`totalTrackedCompetitors` — additive, no field removed or renamed.
2. Update `buildDigestInterpretationInput` in `packages/ai/src/buildDigestContext.ts` to copy
   `digest.crossCompetitorContext.sustainedCount` through verbatim, mirroring the existing
   `aboveBaselineCount` line exactly.
3. Update `/digest/page.tsx` to destructure and render `sustainedCount` on the existing summary
   card, as a second sentence alongside the existing `aboveBaselineCount` sentence — same neutral,
   purely-descriptive vocabulary convention already used there ("N of M tracked competitors
   currently show a sustained above-baseline activity pattern (2 or more consecutive tracked
   periods)" — the exact phrasing Phase 14A Section 15 already pre-approved for this purpose).
4. Tests: extend `packages/ai/src/digestInterpretation.test.ts` and
   `packages/ai/src/validateDigestClaimSafety.test.ts`'s fixtures with `sustainedCount` (mirroring
   every existing `aboveBaselineCount` assertion); extend the `/digest` E2E suite
   (`digest.spec.ts`) with one assertion that the new sentence renders when `sustainedCount > 0` and
   is absent/zero-stated when it is not.

**Customer question closed:** "Are several of my tracked competitors showing a sustained pattern
right now?" — currently PARTIALLY_ANSWERED (Section 5), becomes ANSWERED.

**Why current data supports it:** every value involved is already computed, already correct,
already tenant-isolation-tested at the DB layer (Section 8) — this phase is pure plumbing across
two already-established, already-approved wiring conventions (the `aboveBaselineCount` precedent at
both the AI-bundle and UI layers).

**Smallest implementation surface:** 3 files touched (`digestTypes.ts`, `buildDigestContext.ts`,
`digest/page.tsx`), zero new functions, zero new formulas.

**AI required?** No new AI call, prompt, provider, or output-schema change. Only the input the
existing AI call already receives gets one more, already-safe field.

**Schema/extraction/entity-identity changes required?** None.

**`/compare` changes required?** None (candidate 4 is explicitly deferred, see Section 15).

---

## 15. Non-Goals

Explicit exclusions for the recommended Phase 18:

```
No Composition B (sustained + repeated-price conjunction sentence) - candidate 2, deferred until
  candidate 1 ships and its real customer usage is assessed.
No Composition C (lifecycle + sustained co-occurrence) - candidate 3, deferred.
No /compare integration of SustainedActivityTrend - candidate 4, deferred.
No entity-level sustained repeated price-change pattern - candidate 5, still blocked by entityKey
  identity fragility.
No severity- or confidence-weighted ordering, highlighting, or scoring of any kind.
No promotion-pattern intelligence or any new extraction.
No cross-competitor product/plan equivalence matching.
No generic AI chat, battlecards, CRM features, win/loss analysis, market-share/revenue estimation,
  competitor scoring/ranking, sentiment scoring, forecasts, or opaque relevance scores.
No modification to getActivityPattern, getRepeatedPriceChangePatterns, or getSustainedActivityTrend
  themselves - every one of them continues to be reused verbatim.
No new claim-safety category - the existing seven already cover this field's vocabulary risk (it
  is a plain integer count, structurally identical to the already-approved aboveBaselineCount).
```

---

## 16. Implementation Readiness

```
READY FOR IMPLEMENTATION
```

Justification against the brief's own readiness criteria:
- Customer question is explicit (Section 5, the "sustained... right now?" row).
- Deterministic semantics are already fully specified and already tested — nothing new to design.
- Evidence is traceable end to end (the count is a `.filter().length` over already-cited
  per-competitor `SustainedActivityTrend.sustained` values, each backed by its own
  `changeEventIds`).
- Required data already exists in full; no new data collection, no new extraction, no schema
  change.
- No fragile assumption is introduced (unlike candidate 5, which depends on entity identity).
- Scope is tightly bounded (3 files, additive fields only).
- No speculative AI behavior is required — the AI layer receives one more trustworthy integer.

---

## 17. Future Validation Strategy

For whoever implements the recommended Phase 18:

**Deterministic tests**
- `sustainedCount` in `EvidenceBundle.crossCompetitorContext` equals
  `DigestResult.crossCompetitorContext.sustainedCount` verbatim, for a fixture with a known mix of
  sustained/non-sustained competitors.
- Zero-competitor and zero-sustained-competitor cases both report `sustainedCount: 0`, never
  omitted or `null`.

**Evidence tests**
- The rendered UI sentence and the AI-bundle field must agree exactly with the DB-layer
  `sustainedCount` for the same digest call (no drift between the two consumers).

**Tenant isolation**
- Reuse the existing Organization-A/Organization-B fixture from `intelligence.test.ts` (already
  proves `sustainedCount` isolation at the DB layer); add one assertion that Organization B's AI
  evidence bundle and Organization B's rendered `/digest` page never reflect Organization A's
  `sustainedCount`.

**Query bounds**
- None — this phase adds zero new Prisma queries; it only threads an already-computed number
  through two more layers.

**Historical boundaries**
- Confirm the rendered sentence and the AI-bundle field both correctly show `sustainedCount: 0` for
  an organization whose tracked competitors are all below the 120-day sustained floor (reuse
  Phase 16's Scenario-B fixture).

**Regression**
- Full `packages/ai` suite (mirrors `aboveBaselineCount`'s existing coverage pattern).
- Full `packages/db` suite is unaffected (no DB-layer change is proposed).
- `digest.spec.ts` E2E — add one assertion, do not re-derive the whole suite.

**E2E minimum scenario**
- Seed 2+ competitors, at least one crossing the 120-day sustained floor; load `/digest`; assert
  the new sentence renders with the correct count and links resolve.

**AI**
- No real provider calls required to validate this phase — `buildDigestInterpretationInput` is pure
  and deterministic; the existing fake-provider E2E regression check (`digest-ai-interpretation.spec.ts`)
  is sufficient to confirm the pipeline still runs end to end with the new field present.
- No new claim-safety category or prompt-injection surface is introduced — the field is a plain
  server-computed integer, never page-derived text.

---

## 18. Final Conclusion

CMA's deterministic ladder (Observation → Derived Fact → Pattern → Sustained Pattern →
Cross-Competitor Context → Digest → Evidence-Grounded AI) is complete, internally consistent, and
verified directly against the current repository in this audit — no new detector is justified right
now, and none of the previously-rejected directions (volatility metric, promotion pattern, product
equivalence, scoring/ranking, generic AI chat) gained new justification in this pass.

The product's actual, present-tense bottleneck is not detection — it is that the single most
recently shipped signal's aggregate form (`sustainedCount`) stops one hop short of the customer and
the AI layer, exactly the same "computed but stranded" pattern this project has now closed twice
before (Phase 10 for raw events, Phase 16 for per-competitor persistence). Finishing that third,
much smaller hop is the highest-value, lowest-risk, most defensible next increment: it requires no
new formula, no new query, no schema change, no new AI category, and closes a customer question
this audit found to be only partially answered today. Composition B (sustained + repeated-price)
is real and queued as the logical next step after that, but this audit finds no evidence that it is
more urgent than finishing the distribution of what Phase 16 already built — consistent with Phase
16's own closing recommendation to "assess real customer/product value... before considering any
further composition."

---

## 19. Validation / Repository Evidence

Analysis-only phase; no test suite was executed. Evidence gathered via direct repository
inspection (Read/Grep/Bash, read-only):

- `packages/db/src/repositories/intelligence.ts` — read in full (781 lines): confirms the 5-item
  `DIGEST_ITEM_KIND_ORDER`, the `sustainedCount` computation (`.filter((r) =>
  r.sustainedActivityTrend.sustained).length`), and its presence in `DigestCrossCompetitorContext`.
- `packages/db/src/repositories/patterns.ts` — read in full (541 lines): confirms
  `getActivityPattern`/`getSustainedActivityTrend`/`getRepeatedPriceChangePatterns` formulas and
  thresholds are unchanged from Phase 7/14A/14B.
- `packages/ai/src/buildDigestContext.ts`, `packages/ai/src/digestTypes.ts` — read in full: confirm
  `crossCompetitorContext` on both `DigestForInterpretation` and `EvidenceBundle` carries only
  `aboveBaselineCount`/`totalTrackedCompetitors` — `sustainedCount` is absent from both types and
  from `buildDigestInterpretationInput`'s mapping.
- `apps/web/src/app/(app)/digest/page.tsx` — read in full: confirms line 133 destructures only
  `{ aboveBaselineCount, totalTrackedCompetitors }` from `digest.crossCompetitorContext`.
- `apps/web/src/app/(app)/compare/page.tsx` — read in full: confirms no `SustainedActivityTrend`
  column exists (matches Phase 16's own "Compare changes: NONE").
- `packages/ai/src/digestPrompt.ts` — grepped: confirms `bundle.crossCompetitorContext` (whatever it
  contains) is rendered into the prompt via `jsonLine("Cross-competitor context", ...)` — i.e. the
  missing field genuinely would reach the model if added, it is simply not populated yet.
- `packages/db/prisma/schema.prisma` — grepped for `EntityType`/`ChangeType`/`confidence`: confirms
  `PROMOTION`/`PLAN` remain enum-only, and surfaces `ChangeEvent.confidence` (Float) as a
  previously-unremarked, currently fully-unused-downstream-of-ingestion field (Section 8).
- `packages/extraction/src/structuredData.ts` — read in full: confirms only `"PRICE"` (JSON-LD) and
  `"GENERIC"` (regex fallback) are ever emitted, and confirms `entityKey` derivation
  (`jsonld:${name}.toLowerCase()`) is unchanged since Phase 14A.
- `packages/db/src/repositories/intelligence.test.ts` — grepped for `sustainedCount`: confirms it is
  tested at the DB layer (7 assertions) with no corresponding assertion anywhere in `packages/ai` or
  `apps/web`'s test suites.
- `docs/phases/PHASE15-INTELLIGENCE-VALUE-AUDIT.md`, `PHASE16-VALIDATION-REPORT.md`,
  `PHASE14A-HISTORICAL-INTELLIGENCE-DESIGN-AUDIT.md` — read in full as approved context, not
  re-litigated.

No production, schema, extraction, AI, or UI file was modified during this phase.

```bash
git status --short
git diff --stat
```

Both empty before and after this phase; the only expected change is this report file itself.

---

## Final Decision

```
PHASE 17 — PRODUCT / INTELLIGENCE VALUE AUDIT

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

UI changes:
NONE

Primary finding:
CMA's deterministic intelligence ladder is complete and internally consistent; no new detector is
justified. The concrete, code-verified gap is distributional, not detectional: Phase 16's
sustainedCount cross-competitor aggregate is computed, correctly tenant-isolated, and tested at the
DB layer, but is not propagated into the AI evidence bundle's crossCompetitorContext
(packages/ai/src/digestTypes.ts) or rendered on the /digest summary card
(apps/web/src/app/(app)/digest/page.tsx) - the same "computed but stranded" pattern this project has
already closed twice before (Phase 10 for raw ChangeEvents, Phase 16 for the per-competitor
sustained signal itself), now recurring one level up at the aggregate.

Recommended next phase:
Phase 18 - "Cross-Competitor Sustained Context Distribution": add sustainedCount to
DigestForInterpretation/EvidenceBundle.crossCompetitorContext, thread it through
buildDigestInterpretationInput, and render it on /digest's existing summary card - 3 files, zero
new formulas, zero new queries, zero schema/AI-prompt/claim-safety changes, mirroring the existing
aboveBaselineCount wiring exactly at both layers.

Implementation readiness:
READY FOR IMPLEMENTATION

Deferred:
Composition B (sustained + repeated-price conjunction sentence) and Composition C (lifecycle +
sustained co-occurrence) - both valid, lower priority than finishing candidate 1's distribution;
/compare integration of the sustained signal; org-wide repeated-price-change union (Phase 9
Candidate C, unchanged priority).

Blocked:
Entity-level sustained repeated price-change pattern - still blocked by entityKey identity
fragility, unchanged since Phase 14A.

Not currently justified:
Severity- or confidence-weighted digest ordering (both fields exist but neither is gated by any
current customer question); promotion-pattern intelligence (no extractor); cross-competitor
product/plan equivalence; any scoring/ranking/forecasting/sentiment/CRM/chat feature.

Historical phases re-audited:
NO

Report:
docs/phases/PHASE17-PRODUCT-INTELLIGENCE-VALUE-AUDIT.md
```
