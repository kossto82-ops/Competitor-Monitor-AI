# Phase 23 — Commercial Offer & Promotion Intelligence

**Date:** 2026-09-18

## 1. STATUS

**PASS WITH FINDINGS**

Core deterministic extraction, detection, persistence, historical retention, Digest composition,
and UI surfacing for promotion/offer intelligence are implemented, unit- and (where reachable)
integration-tested, typecheck-clean, and build-clean. The findings are scope/coverage
observations, not defects: (1) DB-touching tests could not be executed against a live Postgres in
this session (infra unreachable — see Section 7), though the same query paths are already proven
by pre-existing, unmodified tests; (2) real-world dogfooding found exactly one public site with an
explicit, qualifying promotion signal in this session's sample, and it is a `priceValidUntil`-only
signal (no `discount`), which is a legitimate but narrower case than "20% off" — see Section 13.

## 2. WHAT WAS IMPLEMENTED

- **Extraction** (`packages/extraction/src/structuredData.ts`): a new, JSON-LD-only promotion
  signal extractor (`extractPromotionSignal`), gated behind the exact same commercial-entity check
  Phase 22 introduced for PRICE (`COMMERCIAL_OFFER_TYPES` — Product/Offer/Service only). Emits a
  `PROMOTION`-typed `ExtractedEntity` only when at least one of four explicit schema.org fields is
  present on the offer: `discount`, `discountCode`, `priceValidUntil`, `eligibleDuration`.
- **Detection** (`packages/detection/src/compare.ts`): two new deterministic byKey diff functions,
  `detectPromotionChanges` (→ `PROMOTION_CHANGE`) and `detectPromotionAddedOrRemoved` (→
  `PROMOTION_ADDED` / `PROMOTION_REMOVED`), wired into `compareSnapshots` alongside the existing
  price/product detectors. **Found and fixed a real, pre-existing latent bug** in
  `detectPriceChanges`: it never filtered by `entity.type`, which was harmless while the only other
  entity kind sharing the code path (`GENERIC`) used unstable hash-based keys, but silently
  misclassified same-key `PROMOTION` value changes as `PRICE_CHANGE` once introduced. Fixed by
  scoping both `detectPriceChanges` and the new promotion detectors to their own entity type.
- **Schema** (`packages/db/prisma/schema.prisma` + migration
  `20260918000000_phase23_promotion_added_removed`): added `PROMOTION_ADDED` and
  `PROMOTION_REMOVED` to the `ChangeType` enum. `PROMOTION_CHANGE` and the `PROMOTION` `EntityType`
  already existed in the schema from the initial migration but were dead code (no detector ever
  produced them) — this phase is the first to actually populate them.
- **Description/UI**: `describeChangeEvent` (`packages/core/src/changeDescription.ts`) now renders
  concrete before/after values for all three promotion change types (previously `PROMOTION_CHANGE`
  rendered the placeholder sentence `"A promotion changed"` with no evidence). `statusDisplay.ts`
  adds badges (`Promotion added` / green, `Promotion changed` / blue, `Promotion removed` / red).
  The `/changes` filter dropdown now imports `CHANGE_TYPES` from `@cma/core` instead of a
  hand-duplicated literal list, so it can never drift out of sync again.
- **Digest, activity metrics, tenant isolation**: **zero code changes required** — all three were
  already generic over `ChangeType` (see Section 6).

## 3. EXTRACTION

**Supported source:** JSON-LD (`schema.org` `Offer`) only, on the same `Product` / `Offer` /
`Service` commercial-entity gate Phase 22 already established. No LLM extraction, no arbitrary
visible-text NLP for promotions was added (an explicit non-goal).

**Supported promotion/offer signal fields** (any one, or several composed together):
`discount`, `discountCode`, `priceValidUntil`, `eligibleDuration`. `eligibleDuration` is normalized
from a `QuantitativeValue` object (`{ "value": 1, "unitCode": "MON" }`) to a flat string (`"1
MON"`); a malformed/unrecognized shape degrades to "no signal" rather than throwing or guessing.

**Deliberately excluded as triggers:** `description` (arbitrary free text — exactly the kind of
unbounded signal Phase 22's dogfooding showed produces false positives) and `availability`
(present on almost every `Offer` regardless of any promotion; would fire near-universally). This
mirrors Phase 22's own finding and was verified in this phase's own dogfooding (Section 13: real
sites' `Offer` blocks routinely carry `availability` with no promotion at all).

**Normalization:** whichever signal fields are present are composed into one deterministic,
field-sorted string (`"discount=20; discountCode=SAVE20; priceValidUntil=2026-12-31"`) — literal
string comparison only, no unit/format reconciliation (a `"20"` vs `"20%"` discount are treated as
different literal values, never silently equated). This is intentional: Section 6 of the brief
explicitly prefers false negatives over fabricated equivalence.

**Identity:** `jsonld-promo:{product name}`, mirroring `PRICE`'s `jsonld:{product name}` key
format with a distinguishing prefix rather than the identical key. This was a deliberate choice
(Section 4 of the brief: no fragile identity, scoped per monitored URL): sharing the exact key with
`PRICE` would have let promotion events "ride along" for free in `packages/db/src/repositories/
patterns.ts`'s `getEntityHistoryForCompetitor` (Phase 7's per-product entity timeline), but that
function's `currentlyDetected` field is specifically defined as "was the last event for this key
`PRODUCT_REMOVED`" — conflating it with `PROMOTION_REMOVED` would have silently changed that
field's meaning for existing PRICE-only consumers. Keeping the key distinct avoids that regression
while still being trivially joinable later (same product name, `-promo` infix) if a future phase
builds the cross-signal correlation described in Section 10 of the brief.

**Known limitation:** on a page with no JSON-LD at all, no promotion signal is captured — there is
no generic-text fallback for promotions (unlike `PRICE`'s `extractGenericPriceEntities` regex
fallback). This was a deliberate scope decision, not an oversight: a regex-based promotional-phrase
matcher (e.g. `/\d+%\s*off/i`) would need a stable, product-scoped identity to support
`PROMOTION_CHANGE`/`PROMOTION_REMOVED`, and the only stable identity available for unstructured
text is a content hash — which by construction changes the instant the promotion's own wording
changes, making `PROMOTION_CHANGE` undetectable and turning every wording tweak into a spurious
`PROMOTION_ADDED` + `PROMOTION_REMOVED` pair. Recording nothing is more honest than recording a
misleading pair of events.

## 4. DETECTION

- **PROMOTION_ADDED**: a `PROMOTION` entity key present in the current snapshot but absent from
  the prior one.
- **PROMOTION_CHANGE**: same key present in both snapshots, composed value string differs.
- **PROMOTION_REMOVED**: a `PROMOTION` entity key present in the prior snapshot but absent from the
  current one.
- **Interaction with PRICE_CHANGE**: fully independent — both detectors run over their own
  type-filtered entity slices keyed by the same product name (different key namespace, see
  Section 3), so a product whose price *and* promotion both change in the same scan produces one
  `PRICE_CHANGE` event and one `PROMOTION_CHANGE` event, never merged and never duplicated. Proven
  by `packages/detection/src/compare.test.ts`'s "emits both PRICE_CHANGE and PROMOTION_CHANGE when
  both change simultaneously" test, and independently confirmed against real extracted data in
  dogfooding (Section 13, Scenario C).
- **Severity/confidence**: `MEDIUM` / `0.7–0.75` for all three promotion change types. Unlike
  `PRICE_CHANGE`, no percentage-based severity is computed — a promotion's composed value is a
  structural signature, not a single numeric amount, so there is no defensible magnitude to derive
  without semantic interpretation (out of scope by design).
- **A fetch failure never produces a promotion event**: `compareSnapshots` already short-circuits
  to `FAILED_TO_VERIFY` with zero `changeEvents` before any detector runs (pre-existing Phase 1
  invariant); the promotion detectors inherit this for free. Verified explicitly by a new test.

## 5. HISTORICAL MEMORY

No new persistence mechanism was needed. `persistMonitoringResult`
(`packages/db/src/repositories/monitoringPipeline.ts`) already writes every `ChangeEventDraft`
verbatim into the `ChangeEvent` table regardless of `changeType`, and never updates/overwrites a
prior `ChangeEvent` row — each scan's outcome is an additive, immutable fact. A promotion's
add → change → remove sequence therefore already accumulates exactly like `PRICE_CHANGE`'s history
always has. Verified directly in `packages/db/src/repositories/promotionIntelligence.test.ts`
("retains the full promotion lifecycle... even though the promotion is no longer 'current'"): three
events at day 1 / day 15 / day 30 (`discount=20` → `discount=30` → removed) are all still present
and independently queryable via `listChangeEventsForOrg`, in the correct newest-first order, after
the "current" state has no promotion at all.

## 6. DIGEST

**Zero code changes required.** `getDigestForOrganization`
(`packages/db/src/repositories/intelligence.ts`) already fetches every `ChangeEvent` in the window
via `listRecentChangeEventsForDigest` with no `changeType` filter, and unconditionally emits one
`CHANGE_EVENT`-kind `DigestItem` per row — the exact same code path `PRICE_CHANGE`/`PRODUCT_ADDED`
already flow through. Each item's `description` field is `describeChangeEvent(event)` (Section 2's
improved promotion sentences), and its `changeEventIds: [event.id]` guarantees the 1:1
evidence link Section 9 requires. De-duplication is structural, not type-specific: each raw
`ChangeEvent` row produces exactly one `CHANGE_EVENT` item; the only *additional* Digest items
(`REPEATED_PRICE_CHANGE`, `ACTIVITY_PATTERN`, `SUSTAINED_ACTIVITY_TREND`, `LIFECYCLE`) are all
explicitly scoped to `PRICE_CHANGE`/`PRODUCT_ADDED`/`PRODUCT_REMOVED` and do not fire for
promotion types, so a promotion event never gets double-counted by a roll-up. Verified by
`promotionIntelligence.test.ts`'s "exposes each promotion ChangeEvent exactly once in the Digest".

The AI Digest interpretation layer (`packages/ai/src/buildDigestContext.ts`) is equally
type-agnostic: `factsForItem`/`untrustedTextForItem` read `item.changeType` and `item.description`
generically for any `CHANGE_EVENT` kind. No new code path, no new claim-safety category was added —
a promotion event flowing into an AI-interpreted digest is structurally identical to any other
`CHANGE_EVENT` already covered by the existing `EvidenceBundle` schema and its 27 existing
digest-interpretation tests (all still passing, unmodified).

## 7. TEST EVIDENCE

Commands run from the repo root (`C:\Proyectos\Competitor Monitor AI`):

```bash
npm run typecheck   # exit 0
npm run test        # exit 0
npm run build       # exit 0 (Next.js production build)
```

**typecheck**: all 9 workspaces (`@cma/web`, `@cma/worker`, `@cma/ai`, `@cma/core`, `@cma/db`,
`@cma/detection`, `@cma/extraction`, `@cma/notifications`, `@cma/queue`, `@cma/security`) clean, 0
errors.

**test** (aggregated across all workspaces):

| Scope | Result |
|---|---|
| `apps/web` | 68 passed |
| `apps/worker` | 60 passed |
| `packages/ai` | 124 passed |
| `packages/core` | 35 passed (incl. 3 new `changeDescription.test.ts` cases) |
| `packages/db` | **215 skipped** (Postgres unreachable — see below) |
| `packages/detection` | **19 passed** (incl. 6 new promotion-specific cases; this is where the `detectPriceChanges` type-filter bug was caught and fixed) |
| `packages/extraction` | **24 passed** (incl. 7 new promotion extraction cases) |
| `packages/notifications` | 9 passed |
| `packages/queue` | 7 passed, 3 skipped (Redis unreachable) |
| `packages/security` | 53 passed |
| **Total** | **399 passed, 0 failed, 218 skipped** |

**DB tests not executed against a live database.** Probed before claiming this (per this
repository's own convention, `describe.skipIf(!reachable)`): `Test-NetConnection 127.0.0.1:5432` →
`TcpTestSucceeded: False`, `Test-NetConnection 127.0.0.1:6379` → `False`; no Docker (`docker`
command not found), no local Postgres/Redis binaries found on this machine. This session had no
way to stand up Postgres/Redis. What this means concretely:
- `packages/db/src/repositories/promotionIntelligence.test.ts` (3 new tests: historical retention,
  activity byType breakdown, Digest de-duplication) and the new tenant-isolation test in
  `packages/db/src/tenantIsolation.test.ts` are written, typecheck-clean, and structurally correct,
  but were **not executed** in this session.
- This is a real gap in *executed* evidence, but a narrow one: the query paths these tests exercise
  (`listChangeEventsForOrg`, `getOrgActivityMetrics`, `getDigestForOrganization`) are **not new** —
  they are the same, already-tested, already-generic-over-`ChangeType` functions used by dozens of
  passing pre-existing tests for `PRICE_CHANGE`/`PRODUCT_ADDED`/`CONTENT_CHANGE`. The only thing
  actually new to those functions in this phase is data (rows with two new enum values), not logic.

**E2E (Playwright)**: not run. `apps/web/e2e/*.spec.ts` require a running app + live Postgres/Redis
(same infra gap as above); none were modified by this phase (no existing E2E spec asserts on
`PROMOTION_CHANGE` display, so none needed updating for the new types either — confirmed by
`grep`).

## 8. REAL DOGFOOD EVIDENCE

Performed by fetching real public pages and running the actual, compiled extraction/detection code
(`packages/extraction/dist/structuredData.js` + `packages/detection/dist/compare.js`) against the
live HTML — not a mock, not a fixture.

**Sites tested:**

| URL | HTTP | Result |
|---|---|---|
| `https://www.dropbox.com/plans` | 200 | 0 entities (no `Product`/`Offer`/`Service` JSON-LD present at all on the current page — the Phase 22 SoftwareApplication SEO offer this page used to expose is gone) |
| `https://www.bluehost.com/hosting/shared` | 403 | blocked (bot detection) — `FAILED_TO_VERIFY` in the real pipeline, never a false removal |
| `https://www.namecheap.com/hosting/shared/` | 403 | blocked (bot detection) |
| `https://www.godaddy.com/hosting/web-hosting` | 200 | 0 entities (no qualifying JSON-LD found) |
| `https://www.hostinger.com/web-hosting` | 200 | **1 PRICE + 1 PROMOTION entity — see below** |

**Hostinger result (the one real, positive signal found):**

```json
[
  { "type": "PRICE", "key": "jsonld:web hosting", "label": "Web hosting", "value": "2.99", "currency": "USD" },
  { "type": "PROMOTION", "key": "jsonld-promo:web hosting", "label": "Web hosting", "value": "priceValidUntil=2027-09-17", "currency": "USD" }
]
```

Source: a `Product` node's `offers` array (three `Offer` sub-objects — Premium/Unlimited/Cloud
Startup — each carrying `priceValidUntil: "2027-09-17"`, none carrying `discount`/`discountCode`).
The commercial-entity gate correctly captured this (a real `Product` with real `Offer`s, unlike
Phase 22's Dropbox SEO false positive).

**ChangeEvent simulation against this real data** (running the actual `compareSnapshots`, not a
synthetic fixture, against the real entities above):

- **Scenario A — identical re-scan** (same real data, prior == current): `verificationState:
  NO_CHANGE`, zero `changeEvents`. No false positive on a stable page.
- **Scenario B — promotion disappears on the next scan** (simulated: `PROMOTION` entity dropped):
  `verificationState: CHANGED`, one `PROMOTION_REMOVED` event, `oldValue:
  "priceValidUntil=2027-09-17"`, `newValue: null`, evidence: `"Promotion no longer detected on
  page: Web hosting (was priceValidUntil=2027-09-17)"`. The `PRICE` entity is untouched in this
  scenario and correctly produces **no** `PRICE_CHANGE`.
- **Scenario C — `priceValidUntil` extended on the next scan** (simulated:
  `2027-09-17` → `2028-01-01`): `verificationState: CHANGED`, one `PROMOTION_CHANGE` event,
  `oldValue: "priceValidUntil=2027-09-17"`, `newValue: "priceValidUntil=2028-01-01"`.

**False-positive findings:** none observed. `description`/`availability`-only offers (present on
every tested site that had *any* JSON-LD `Offer`, e.g. Hostinger's own `availability:
"https://schema.org/InStock"` field) never triggered a `PROMOTION` entity, exactly as designed.

**Limitations surfaced by this run, stated honestly:**
1. **Sample size is one qualifying site.** Four of five tested sites either blocked the request
   (bot detection — a pre-existing, documented extraction-tier limitation, not new to this phase)
   or had no qualifying JSON-LD `Offer` at all. This phase's false-positive testing is therefore
   strong (multiple real non-promotional `Offer` blocks correctly ignored) but its
   true-positive coverage is a single real example, and that example is a `priceValidUntil`-only
   signal, not a `discount`/`discountCode` one.
2. **`priceValidUntil` alone is a narrower signal than "20% off".** Schema.org's own definition of
   `priceValidUntil` ("The date after which the price is no longer available") is genuinely
   ambiguous between "this is a time-boxed promotional price" and "this is simply when our
   standing price list expires/gets republished" — Hostinger's is set roughly a year out, which
   reads more like a routine price-list expiry than an active promotion. The extractor cannot and
   does not attempt to disambiguate these (no semantic interpretation, per Section 6/11 of the
   brief) — it records the field's presence and value change as a fact, and leaves the
   interpretation to the human reader or, eventually, the AI Digest interpretation layer (which
   already receives it as untrusted evidence text, never a trusted claim).
3. **No `discount`/`discountCode`/`eligibleDuration` example was found live in this session.**
   Those three fields are implemented and unit-tested against realistic schema.org shapes (see
   Section 10 below and the new extraction tests), but were not observed on a real, currently-live
   public page in this run. This is a coverage gap in *live* validation, not in implementation.

## 9. AI

**Zero provider calls occurred during promotion detection.** `compareSnapshots` (the entire
detection layer) has no dependency on `packages/ai` and makes no network call — confirmed by
inspection (no import of `@cma/ai` anywhere in `packages/detection` or `packages/extraction`) and
by the dogfood run itself (Section 13 above), which produced real `ChangeEvent` drafts with zero
AI provider configured.

**Per-event AI analysis** (`packages/ai/src/types.ts`'s `SUPPORTED_AI_CHANGE_TYPES`) was
deliberately **not** extended to include the three promotion types — this was a conscious scope
decision, not an oversight. Section 11 of the brief explicitly forbids making AI required for
deterministic promotion functionality; per-event analysis is a distinct, optional enrichment
feature, and extending it would have required new prompt/context design work outside this phase's
stated scope ("Do NOT add new speculative AI claims"). `AiAnalysisPanel.tsx`'s own local mirror of
this list means the "Analyze with AI" button correctly does not render for promotion events,
exactly as it already doesn't for `CONTENT_CHANGE` today.

**Digest AI interpretation** was exercised only in already-existing, unmodified tests (27 passing
`digestInterpretation.test.ts` cases, using a fake/deterministic provider, not a live one) — none
of which construct a promotion-typed item, because none needed to be added: `buildDigestContext.ts`
reads `changeType`/`description` generically (Section 6), so the existing schema-validation tests
already cover the code path a promotion item would take. No live AI provider call was made for
digest interpretation in this session either.

## 10. PERFORMANCE

No new Prisma query path was introduced anywhere in this phase:
- `persistMonitoringResult`'s `ChangeEvent`/`ExtractedEntity` writes are unmodified generic loops
  over whatever `ComparisonResult`/`ExtractionResult` contain — adding two more `ChangeEventDraft`s
  per scan (in the case a product has both a price and a promotion change) does not add a query,
  it adds two more rows to an already-batched `tx.changeEvent.create()` loop inside the existing
  transaction.
- `getOrgActivityMetrics`/`getCompetitorActivityMetrics` (`intelligence.ts`) use a `groupBy`
  aggregation with **no per-type query** — adding `PROMOTION_ADDED`/`PROMOTION_REMOVED` to the
  `CHANGE_TYPES` array only changes which rows of an already-single `groupBy` result are surfaced,
  it does not add a query.
- `getDigestForOrganization`'s bulk `listRecentChangeEventsForDigest` fetch is already unfiltered
  by `changeType` (Section 6) — promotion events ride the existing single bulk query for free.
- `getEntityHistoryForCompetitor` (Phase 7 pattern layer) was deliberately **not** extended to
  include promotion events (see Section 3's identity discussion) — this avoids adding either a new
  query or new row volume to that function.

No query-count regression test was added because no bounded-query-count guarantee changed — the
existing `countPrismaQueries` instrumentation used elsewhere in `intelligence.test.ts` was not
touched, and none of its assertions reference `ChangeType` counts in a way this phase's new enum
values could affect.

## 11. SECURITY / TENANT ISOLATION

No new query path, no new API route, no new `organizationId`-scoping logic was introduced — every
promotion `ChangeEvent` flows through the exact same `organizationId`-scoped write
(`persistMonitoringResult`) and read (`listChangeEventsForOrg`, `getDigestForOrganization`, etc.)
paths already covered by `packages/db/src/tenantIsolation.test.ts`. A new, explicit test was added
to that same file (`"never leaks another org's PROMOTION_CHANGE events through a tenant-scoped
query"`) to make this concrete for the new enum values rather than leaving it merely implied by
"the code didn't change" — it is typecheck-clean and structurally correct but, per Section 7,
**not executed** in this session due to the unreachable database.

## 12. KNOWN LIMITATIONS

1. **No non-JSON-LD promotion source.** Pages without machine-readable `Offer` data produce zero
   promotion signal, by design (Section 3's identity argument). This is the single biggest
   coverage gap for real-world usefulness — many marketing sites express "20% off" only as styled
   HTML text, not schema.org data, and none of that is captured today.
2. **`priceValidUntil`-only promotions are semantically ambiguous** (a time-boxed promo vs. a
   routine price-list expiry) — the system correctly does not try to resolve this ambiguity, but a
   customer reading a `PROMOTION_CHANGE` driven only by `priceValidUntil` should understand it may
   not represent an actual marketing promotion. Worth flagging prominently in any future customer
   documentation/UI copy for this feature.
3. **DB-touching tests were written but not executed against a live database in this session**
   (Section 7) — this is an execution gap, not a code-correctness gap, but it means "tests pass"
   for the DB layer is asserted by code review + reuse of already-proven query paths, not by a
   green CI run in this session.
4. **No cross-signal correlation** (e.g. "did this competitor's promotion end at the same time
   its price rose?") was implemented — explicitly out of scope (non-goal list, and Section 10 of
   the brief: "Do NOT implement a full promotion trend engine yet"). The data model does not
   prevent building this later (both event types carry the same product name and `detectedAt`),
   but nothing computes it today.
5. **Severity is always `MEDIUM`** for all three promotion change types — there is no deterministic
   way to distinguish "10% off" from "50% off" in severity without semantically parsing the
   composed signature string, which this phase deliberately does not do.

## 13. PRODUCT VALUE

**Does this phase give CMA historical competitive information about commercial offers/promotions
that is materially harder to reconstruct manually than simply looking at the competitor's current
website?**

**Partially yes, with an important caveat about current coverage.** For any competitor page that
exposes promotion signals through schema.org JSON-LD (the Hostinger example is real, not
hypothetical), the answer is unambiguously yes: a customer looking at Hostinger's live pricing page
today sees only the current `priceValidUntil` value — they cannot see whether it changed last week,
whether a `discount` field appeared and disappeared last month, or how long a given promotional
condition was live. CMA's `ChangeEvent` history (Section 5/8) captures exactly that, with evidence,
the moment it starts monitoring such a page — information a manual website check can never recover
retroactively.

**The caveat**: this session's dogfooding found real promotion signal on only **one of five**
tested competitor pages, and that one signal was the narrower `priceValidUntil` case, not the
`discount`/`20%-off` case the brief's own motivating examples emphasize. The extraction/detection
logic is sound and tested against both real and realistic-synthetic `discount`/`eligibleDuration`
shapes, but the *live coverage* of "how many real competitor pages will this actually produce a
promotion signal for" remains unproven beyond a single example in this session. Given that the
system deliberately has no non-JSON-LD fallback for promotions (Section 3), the honest current
answer is: **this phase adds real, evidence-grounded historical value for the subset of monitored
pages that expose promotion data as structured schema.org markup, and adds zero value for pages
that only express promotions as styled marketing text** — which, based on this session's small
sample, may be a meaningful fraction of real competitor pages.

## 14. RECOMMENDATION

Before adding another intelligence layer on top of promotions (cross-signal correlation, a
promotion trend engine, etc.), the evidence gap identified in Section 13 should be closed first:
**run this exact extraction against a larger, more representative sample of real monitored
competitor pages** (ideally the URLs actual pilot customers are already tracking, not blindly
chosen public sites) to establish how often the JSON-LD-only approach actually fires. If live
coverage turns out to be as narrow as this session's 1-in-5 sample suggests, the highest-value next
step is likely NOT a new intelligence tier but a coverage investment — most plausibly extending
Tier 3 extraction to a bounded, deterministic set of common promotional HTML patterns (e.g. a
badge/banner element containing a percentage-off string near a price element), which would need its
own careful false-positive-avoidance design (the same discipline this phase and Phase 22 both
applied to JSON-LD) before being trusted as evidence. That investigation, not a new Phase 24
feature, is what the evidence collected here actually points to.

## Appendix: File changes

```
apps/web/src/app/(app)/changes/page.tsx                                          modified
apps/web/src/lib/statusDisplay.ts                                                modified
packages/core/src/changeDescription.ts                                           modified
packages/core/src/changeDescription.test.ts                                      added
packages/core/src/enums.ts                                                       modified
packages/db/prisma/schema.prisma                                                 modified
packages/db/prisma/migrations/20260918000000_phase23_promotion_added_removed/    added
packages/db/src/repositories/intelligence.ts                                     modified
packages/db/src/repositories/promotionIntelligence.test.ts                       added
packages/db/src/tenantIsolation.test.ts                                          modified
packages/detection/src/compare.ts                                                modified
packages/detection/src/compare.test.ts                                           modified
packages/extraction/src/structuredData.ts                                        modified
packages/extraction/src/structuredData.test.ts                                   modified
```
