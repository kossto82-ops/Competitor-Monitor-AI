# Phase 6 — Data Audit

**Purpose:** what historical data already exists after Phases 1–5, what can be
computed from it without any schema change, and what would require inventing
semantics the current data does not defensibly support. Written before any
Phase 6 code was implemented, per the brief's Section 2.

## 1. What already exists (Prisma schema as of Phase 5)

`packages/db/prisma/schema.prisma` — the historical event stream is the
`ChangeEvent` table, written once per verified, deterministic change by
`packages/detection/src/compare.ts`. Every ChangeEvent carries:

| Field | Type | Notes |
|---|---|---|
| `organizationId` | String | denormalized on every tenant table — see schema header |
| `monitoredUrlId` | String | → `MonitoredUrl` → `Competitor` |
| `changeType` | enum | `PRICE_CHANGE` \| `PRODUCT_ADDED` \| `PRODUCT_REMOVED` \| `PROMOTION_CHANGE` \| `CONTENT_CHANGE` |
| `severity` | enum | `LOW` \| `MEDIUM` \| `HIGH`, derived from `%` magnitude |
| `entityKey` | String? | **the stable product/plan identity — see Section 3** |
| `oldValue` / `newValue` | String? | raw extracted values (usually a price string) |
| `currency` | String? | |
| `percentageChange` | Float? | already computed at detection time |
| `evidenceExcerpt` | String | human-readable evidence line |
| `detectedAt` | DateTime | the historical timestamp everything below is indexed on |
| `currentSnapshot` / `previousSnapshot` | → `Snapshot` | full before/after page content |

Indexes already in place: `@@index([organizationId])` and
`@@index([monitoredUrlId, detectedAt])` — the exact shape needed for
time-windowed, tenant-scoped aggregation. **No new index was required for
Phase 6's query patterns** (verified against the actual `EXPLAIN` behavior
implicitly via the query-count-bounding tests in
`intelligence.test.ts` — see PHASE6-VALIDATION.md).

`AiAnalysis` (Phase 3) carries one *optional* AI interpretation per
ChangeEvent (`facts`/`interpretations`/`speculation`/`confidence`), already
enrichment, never the source of truth.

`Report` / `ReportItem` (Phase 4) group ChangeEvents into daily digests, one
row per organization-day, denormalized counts already computed once at
generation time.

## 2. What Phase 6 could compute with zero schema changes

Everything in Section 4 (activity metrics), Section 6 (product lifecycle),
most of Section 7 (price history — see the caveat in Section 3 below), and
Section 10 (descriptive cross-competitor comparison) of the Phase 6 brief is
a pure aggregation over the existing `ChangeEvent` table:

- **"How active has a competitor been"** → `COUNT(*) WHERE organizationId=? AND monitoredUrlId IN (competitor's urls) AND detectedAt BETWEEN ? AND ?`, once for the current window and once for the previous equal-length window.
- **"What types of changes"** → the same query `GROUP BY changeType`.
- **"Products added/removed"** → the same query filtered to `PRODUCT_ADDED` / `PRODUCT_REMOVED`.
- **Cross-competitor comparison** → the same per-competitor query run for N competitors, no new table.

None of this required a new table, a persisted metric row, or an AI call.
This is why `packages/db/src/repositories/intelligence.ts` (Section 17 of the
brief: "prefer calculated queries over persisted metrics") contains **zero**
new Prisma models — see `schema.prisma`, unchanged by Phase 6 except for this
audit's own read of it.

## 3. Price history — what is and isn't defensible

Section 7 of the brief explicitly forbids inventing a unified price series
when the underlying identity isn't stable. Investigating
`packages/detection/src/compare.ts` (`detectPriceChanges` /
`detectProductAddedOrRemoved`) resolved this precisely:

> `entityKey` is `ExtractedEntity.key`, and (per that function's own doc
> comment) is **"restricted to JSON-LD-sourced PRICE entities on purpose:
> their `key` is derived from a product name, so it is stable across
> scans."** Regex/GENERIC-sourced entities key off surrounding text context
> and are explicitly *not* used for this in the existing detection code.

Conclusion: a PRICE_CHANGE ChangeEvent's `(monitoredUrlId, entityKey)` pair
**is** a defensible series identity — it is literally the same identity the
existing deterministic detection pipeline already uses to decide "this is
the same product's price changing" one scan later. Phase 6's
`getPriceHistoryForCompetitor` groups on exactly that pair (never just
`entityKey` alone, since the same product name could coincidentally collide
across two different monitored URLs of the same competitor) and **excludes**
any PRICE_CHANGE event with a null `entityKey` from every series, rather than
falling back to a weaker heuristic.

What is explicitly **not** built, because the data does not support it:

- **Cross-competitor product/plan normalization** ("Competitor A's Basic" ==
  "Competitor B's Starter"). There is no shared taxonomy or embedding-based
  matching anywhere in the codebase (checked `packages/extraction`,
  `packages/detection`, `packages/ai`) — `entityKey` is derived independently
  per monitored URL from that page's own JSON-LD product name. Building this
  would mean inventing a semantic-equivalence model the brief (Section 11)
  explicitly says not to fake. **Deferred, documented, not attempted.**

## 4. Timestamps and timezone

`Organization.timezone` (Phase 4) already exists and is read by
`packages/core/src/reportWindow.ts`'s day-window logic. Phase 6's new
`packages/core/src/period.ts` reuses that module's `normalizeOrgTimezone`
(same UTC-safe-fallback behavior) rather than duplicating offset arithmetic,
but deliberately implements **rolling** N-day windows (`now - N days`), not
calendar-day-aligned ones — see `period.ts`'s doc comment for why a rolling
activity window is the conventional shape for "last 7/30/90 days" (unlike a
daily report's "yesterday's calendar day", which genuinely needs day
alignment).

## 5. What requires new schema (none, for this phase)

Nothing in the implemented scope required a schema change. The one thing
that *would* require a new table — persisted historical AI interpretations
(a summary of "this competitor's last 30 days" cached so it isn't
regenerated on every page load) — is the AI enrichment layer deferred in
this phase; see PHASE6-VALIDATION.md's Deferred Features section for why and
what it would need if picked up later (an idempotency key of
`organizationId + competitorId + periodStart + periodDays + promptVersion`,
mirroring `AiAnalysis`'s existing `changeEventId @unique` pattern).

## 6. Summary table

| Question | Derivable now, no schema change | Needs new schema | Deliberately not built |
|---|---|---|---|
| Activity counts, current vs. previous period | ✅ | | |
| Breakdown by change type | ✅ | | |
| Products added/removed, current vs. previous | ✅ | | |
| Price history per (competitor, product) | ✅ (see Section 3 caveat) | | |
| Descriptive cross-competitor comparison | ✅ | | |
| Cross-competitor product/plan normalization | | | ✅ (no defensible identity exists) |
| Persisted/cached historical AI interpretation | | ✅ (deferred) | |
| Competitor ranking / "winner" score | | | ✅ (explicitly out of scope, Section 11) |
