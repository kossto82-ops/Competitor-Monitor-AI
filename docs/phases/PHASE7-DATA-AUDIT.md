# Phase 7 — Data / Semantic Audit

**Purpose:** what identity, history, and pattern claims the current data
defensibly supports, written *before* any Phase 7 schema or repository code,
per the brief's Section 2. This extends (does not repeat) `PHASE6-DATA-AUDIT.md`,
which already established the `entityKey` identity rule this document relies on.

## 1. What entities CMA can identify reliably today

The only extraction path that produces a **stable** entity identity is
JSON-LD structured data (`packages/extraction/src/structuredData.ts`,
`extractJsonLdEntities`):

```ts
key: `jsonld:${name ?? "unknown"}`.toLowerCase()
```

- **Source:** `<script type="application/ld+json">` `Product`/`Offer` nodes.
- **Identifier:** `jsonld:{product name, lowercased}`.
- **Stability across scans:** stable *as long as the competitor's own JSON-LD
  keeps using the same product `name`*. If the competitor renames the
  product, this key changes and the system will see it as
  PRODUCT_REMOVED + PRODUCT_ADDED, not a rename. This is a real, known
  limitation — not silently glossed over.
- **Tenant scope:** entity rows (`ExtractedEntity`) live on `Snapshot`,
  which is scoped by `organizationId` and `monitoredUrlId`.
- **URL scope:** the key is derived purely from that page's own JSON-LD; it
  is **never** deduplicated or matched across two different `monitoredUrlId`s,
  even for the same competitor (confirmed in `intelligence.ts`'s price-series
  grouping, which keys on `(monitoredUrlId, entityKey)`, never `entityKey`
  alone — see `PHASE6-DATA-AUDIT.md` Section 3 for why).
- **Evidence:** every use of the key is backed by a `ChangeEvent` row with
  `evidenceExcerpt`, `oldValue`/`newValue`, and a link to the `Snapshot`
  that produced it.
- **Known failure modes:** product renames (see above); two distinctly
  different products that happen to share a name on the same page (the key
  would collide — not observed as a real extraction path today since
  `collectProductLikeEntities` pushes one entity per JSON-LD node, so a
  genuine same-name collision on one page is already a pre-existing,
  unaddressed edge case, not something Phase 7 introduces).

The other extraction path, `extractGenericPriceEntities` (regex/text-price),
produces a key of `text-price:{sha256(surrounding context).slice(0,16)}`.
This key is **not** a stable identity — it changes if the surrounding text
shifts by even a few characters (pagination, added whitespace, an unrelated
copy edit near the price). `detectProductAddedOrRemoved` in
`packages/detection/src/compare.ts` already excludes `GENERIC` entities from
add/remove diffing for exactly this reason (its own doc comment says so).
**Phase 7 makes no changes to this and treats `GENERIC`-sourced entities as
having no defensible identity for history/pattern purposes**, same as Phase 6.

There is no extraction path today that produces `PLAN` or `PROMOTION`
typed entities (`EntityType` has these values in the schema, but grep across
`packages/extraction` and `packages/detection` shows zero code that emits
them). `ChangeType.PROMOTION_CHANGE` is defined in the schema/enums and has a
display label in `packages/core/src/changeDescription.ts`, but
`compare.ts` never constructs one. **Conclusion: promotion data does not
exist in this codebase today.** Any "promotion pattern" work is out of scope
until an extractor actually produces `PROMOTION` entities — inventing one now
would violate the brief's own prohibition on manufacturing semantics the data
doesn't support.

## 2. Which existing identifiers are genuinely stable

| Identifier | Stable? | Basis |
|---|---|---|
| `(monitoredUrlId, entityKey)` where `entityKey` comes from a `PRICE`-typed, JSON-LD-sourced `ExtractedEntity` | **Yes** | Same conclusion as Phase 6 audit — the detection pipeline itself uses this pair to decide "same product" one scan later; nothing new invented here. |
| `entityKey` alone (no `monitoredUrlId`) | **No** | Two different monitored URLs of the same competitor (e.g. two country pricing pages) can produce the same product name and hence the same `entityKey`; they are not proven to be the same catalog entry. |
| `ChangeEvent.entityKey` on a `GENERIC`-sourced price | **No** | Context-hash based, not name-based; see Section 1. |
| `MonitoredUrl.id` | Yes (trivially — it's a DB primary key) | Used as the scoping half of every price/entity series. |
| `Competitor.id` | Yes | Primary key; all activity/pattern queries are scoped by it plus `organizationId`. |

No new identifier is introduced in Phase 7. Every "entity" referenced below
is exactly the `(monitoredUrlId, entityKey)` pair Phase 6 already validated.

## 3. Which relationships can be established without semantic invention

Defensible, built entirely from existing `ChangeEvent` rows:

- **Same product across scans** → `(monitoredUrlId, entityKey)` pair, as above.
- **Full lifecycle of one identified product** → every `ChangeEvent` (not
  just `PRICE_CHANGE`, also `PRODUCT_ADDED`/`PRODUCT_REMOVED`) sharing that
  pair, ordered by `detectedAt`. **This is new in Phase 7** — Phase 6's
  `getPriceHistoryForCompetitor` only looked at `PRICE_CHANGE` events; it
  never showed a product's `PRODUCT_ADDED` origin or a later
  `PRODUCT_REMOVED` end, even though both already carry the same
  `entityKey` (confirmed in `compare.ts`'s `detectProductAddedOrRemoved`,
  which sets `entityKey: current.key` / `entityKey: previous.key`
  respectively — no schema change needed to join these into one history).
- **Same competitor across time** → `Competitor.id`, trivially.
- **Same organization's own historical baseline** → `organizationId` +
  `Competitor.createdAt` (when monitoring of this competitor effectively
  began, used below as the "do we have enough history" gate).

Not defensible, and **not built**:

- **Cross-competitor product/plan equivalence** ("Competitor A's Basic" ==
  "Competitor B's Starter") — reconfirmed: no shared taxonomy, no embedding
  matching, no normalization table anywhere in `packages/extraction`,
  `packages/detection`, or `packages/ai`. Same conclusion as
  `PHASE6-DATA-AUDIT.md` Section 3. **Deferred, per Section 13 of the brief.**
- **Causal relationships between two different ChangeEvents** (e.g. "the
  promotion caused the price change") — temporal proximity is observable
  (`detectedAt` deltas), causation is not. See Section 5 below.

## 4. What historical patterns can be calculated from existing data

Formal definitions (implemented in `packages/db/src/repositories/patterns.ts`):

### 4.1 Activity-vs-baseline

- **Required data:** `ChangeEvent.detectedAt` for the competitor's monitored
  URLs; `Competitor.createdAt`.
- **Formula:** current = count of events in `[now - days, now)`. Baseline =
  mean count over up to 3 consecutive, non-overlapping `days`-length windows
  immediately preceding the current window (i.e. `[now-4·days, now-days)`
  sliced into 3 equal windows). `ratio = current / baselineAverage` when
  `baselineAverage > 0`.
- **Minimum sample size:** requires **at least 2 of the 3 HISTORICAL
  windows** (never counting the current window as a "baseline window") to
  be "in range" of the competitor's actual monitoring history. Because
  windows are evaluated most-recent-first, reaching 2 qualifying windows
  always means "historical window 1 AND 2 both qualify," which requires
  `Competitor.createdAt <= now - 3·days` — **NOT** `now - 2·days` (a
  documentation error corrected in Phase 7.1; the implementation itself
  was already correct). The full 3-window baseline requires
  `Competitor.createdAt <= now - 4·days`. See
  `PHASE7.1-VALIDATION-REPORT.md`, "Window Semantics," for the complete
  worked table. Fewer than 2 usable historical windows →
  `qualifies: false`, `direction: "INSUFFICIENT_HISTORY"`; the caller MUST
  render that as "not enough history yet," never as a claimed trend.
- **Edge cases:** `baselineAverage === 0` and `current === 0` →
  `"AT_BASELINE"`. `baselineAverage === 0` and `current > 0` → flagged
  `strongEvidence: false` even though `qualifies` may be true, because a
  ratio against zero cannot be expressed as a multiplier — the brief's
  worked example (Section 9: "1 this month vs 0 last month" must not be
  called "dramatic") is handled by this flag, not by inventing a number.
- **What the system is allowed to say:** "current-period count vs.
  historical baseline average, computed over N qualifying prior periods."
- **What it must NOT say:** "increasing," "strategy," "aggressive," any
  causal or intentional language.

### 4.2 Repeated price-change activity (per entity)

- **Required data:** `ChangeEvent` rows of type `PRICE_CHANGE` with
  non-null `entityKey`, grouped by `(monitoredUrlId, entityKey)`.
- **Formula:** count of such events within `[now - days, now)` per group.
- **Minimum sample size:** `count >= 2` to qualify as "repeated" (a single
  price change is just a price change, not a pattern — Section 9's
  "manufactured significance" warning applies directly here).
- **What the system is allowed to say:** "N price changes recorded for this
  product in the last `days` days" (N ≥ 2).
- **What it must NOT say:** anything about why, or about competitive
  strategy.

### 4.3 What is explicitly deferred as a "pattern" in this phase

- **Product-addition/removal bursts** — the raw counts already exist via
  `getProductLifecycleSummary` (Phase 6); a formal "burst" pattern (e.g.
  z-score against a longer baseline) is not implemented this phase because
  product add/remove events are far sparser than price events in the seed
  data available for testing, and a threshold tuned on sparse data would be
  guessing, not deriving. Documented as deferred, not silently dropped.
- **Cross-competitor pattern comparison ("Competitor A had more price
  activity than B")** — the underlying per-competitor pattern *is*
  implemented (4.1), so this is a thin, purely descriptive layer (no
  ranking) that Phase 7 leaves for the `/compare` page as a documented
  next step rather than building now, to keep this phase's surface
  reviewable. See `PHASE7-PRODUCT-ASSESSMENT.md`.
- **Sequence/co-occurrence detection** — temporally proximate but
  differently-typed ChangeEvents (e.g. a PRICE_CHANGE and a PRODUCT_ADDED
  within days of each other) are visible today in the existing Timeline
  view (grouped by calendar day). A dedicated "these N events happened in
  the same window" pattern function is not implemented separately this
  phase — it would duplicate the Timeline's existing grouping without adding
  a new deterministic claim, and the brief explicitly warns against implying
  causation from proximity. Deferred as a UI-only enhancement, not a data
  model gap.

## 5. What cannot currently be supported

Explicitly unsupported, and not implemented anywhere in Phase 7:

- Market share, competitor revenue/traffic, hiring/sales intelligence.
- Competitor intent or strategy ("panicking," "aggressive," "responding to
  X").
- Causal explanation of *why* two changes happened close together.
- Cross-competitor product/plan equivalence (Section 3).
- Sentiment, news/social monitoring.
- Any forecasting of future competitor behavior.
- A "winner"/ranking score across competitors.

## 6. Provider/model audit (repeated per Section 26 of the brief)

Re-ran the grep from `PHASE6-VALIDATION.md` Section 6 (`gpt-4o-mini`,
`gpt-5.6-luna`, `DEFAULT_OPENAI_MODEL`, `DEFAULT_MODEL`, `CMA_AI_MODEL`,
`CMA_AI_PROVIDER`) against the current tree. Same 29 files, same
classifications as Phase 6 (test fixtures, the `AiConnectionsManager.tsx`
placeholder string, `pricing.ts`'s cost-lookup table, and
`resolveAiProvider.ts`'s dev-only, explicitly-gated env bootstrap with its
own "no hard-coded fallback" doc comment). **No new hits, no new hidden
default.** Phase 7's pattern code (`packages/db/src/repositories/patterns.ts`)
makes zero AI calls and imports nothing from `@cma/ai`.

## 7. Summary table

| Question | Derivable now, no schema change | Needs new schema | Deliberately not built |
|---|---|---|---|
| Full per-entity lifecycle (added → price changes → removed) | ✅ | | |
| Activity-vs-own-historical-baseline pattern, with minimum-sample gate | ✅ | | |
| Repeated price-change pattern per entity | ✅ | | |
| Cross-competitor product/plan normalization | | | ✅ (no defensible identity) |
| Promotion patterns | | | ✅ (no extraction path produces promotion data at all) |
| Causal/sequence claims between events | | | ✅ (temporal proximity ≠ causation) |
| Persisted/cached historical AI interpretation | | ✅ (deferred, same as Phase 6) | |
