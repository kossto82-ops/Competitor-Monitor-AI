# Phase 18 — Cross-Competitor Sustained Context Distribution

**Type:** Implementation. Plumbing only — propagates an already-computed, already-tested,
tenant-isolated DB value through two previously-missing layers.

## 1. Status

```
PASS
```

## 2. Scope

```
Implementation phase.
```

## 3. Historical phases re-audited

```
NO
```

No prior phase's formula, threshold, window model, entity-identity decision, or architecture was
revisited. `getActivityPattern`, `getRepeatedPriceChangePatterns`, and `getSustainedActivityTrend`
were not touched, read for information only where needed to confirm the existing shape of
`DigestCrossCompetitorContext`.

## 4. Implementation

Three production files changed, mirroring the existing `aboveBaselineCount` wiring at both layers
exactly as recommended by Phase 17 Section 12 Candidate 1:

- **`packages/ai/src/digestTypes.ts`** — added `sustainedCount: number` (required, non-optional) to
  `crossCompetitorContext` on both `DigestForInterpretation` and `EvidenceBundle`, immediately after
  `aboveBaselineCount` and before `totalTrackedCompetitors`, matching the field ordering already
  used by `packages/db/src/repositories/intelligence.ts`'s `DigestCrossCompetitorContext`.
- **`packages/ai/src/buildDigestContext.ts`** — `buildDigestInterpretationInput` now copies
  `digest.crossCompetitorContext.sustainedCount` verbatim into the returned `EvidenceBundle`, one
  line added directly beside the existing `aboveBaselineCount` copy. No new query, no recomputation,
  no derivation from `digest.items`.
- **`apps/web/src/app/(app)/digest/page.tsx`** — the existing destructure now also pulls
  `sustainedCount` from `digest.crossCompetitorContext`; a second neutral sentence was added to the
  existing summary `Card`, directly beneath the `aboveBaselineCount` sentence, using the same
  typography and the existing `data-testid` naming convention
  (`digest-sustained-cross-competitor-context`).

## 5. AI

- `DigestForInterpretation.crossCompetitorContext.sustainedCount` and
  `EvidenceBundle.crossCompetitorContext.sustainedCount` are both now **required** fields — a
  deterministic integer the DB layer has always produced (`packages/db/src/repositories/
  intelligence.ts:770`), so making it required (never optional/undefined) is correct and matches
  `aboveBaselineCount`'s own required-ness.
- `buildDigestInterpretationInput` performs a straight passthrough — verified in Phase 18 Test A/B/C
  (Section 13) that the bundle's `sustainedCount` is exactly what the input digest specified, with
  no re-derivation from `digest.items` and no interaction with the item-selection/truncation logic.
- **Zero case:** confirmed the value `0` is copied through as the number `0`, never `null`,
  `undefined`, or omitted (Test B).
- **No prompt changes:** `packages/ai/src/digestPrompt.ts:101` already serializes the entire
  `bundle.crossCompetitorContext` object generically via `jsonLine("Cross-competitor context",
  bundle.crossCompetitorContext)` — confirmed by direct read, unchanged in this phase. Adding the
  field to the type/mapping is sufficient for the model to see it; no prompt-template edit was
  needed or made.
- **No provider changes:** `packages/ai/src/providers/*` untouched.
- **No claim-safety changes:** `packages/ai/src/validateDigestClaimSafety.ts` untouched — 0 new
  categories, 0 new phrase patterns. The field is a plain deterministic integer with no page-derived
  text, structurally identical to `aboveBaselineCount`, and introduces no new evidence or
  prompt-injection surface.
- **No new AI calls:** the existing single-call-plus-one-retry pipeline is completely unchanged;
  Phase 18 Test A/B/C exercise `buildDigestInterpretationInput` directly and do not invoke a
  provider. The pre-existing `analyzeAndValidateDigest`-level tests (retry, timeout, end-to-end fake
  provider) all continued to pass unmodified in behavior — only their `crossCompetitorContext`
  fixtures gained the new required field.

## 6. UI

- The `/digest` summary card now renders two sentences: the existing "N of M ... above their own
  historical baseline" line, and a new "N of M ... currently show(s) a sustained activity pattern (2
  or more consecutive tracked periods)" line, in a `data-testid="digest-sustained-cross-competitor-
  context"` paragraph directly below the existing one.
- **Wording deviates intentionally from the phase brief's suggested "sustained above-baseline
  activity pattern" phrasing.** `sustainedCount` (`packages/db/src/repositories/intelligence.ts:770`)
  counts competitors where `SustainedActivityTrend.sustained === true` for **either** direction
  (`ABOVE_BASELINE` or `BELOW_BASELINE` — see `intelligence.ts:742`), not above-baseline only.
  Saying "above-baseline" would misdescribe a competitor whose sustained streak is currently
  `BELOW_BASELINE`. Per the brief's own Section 10 instruction ("inspect the existing UI terminology
  ... integrate ... rather than introducing inconsistent wording"), the neutral, direction-agnostic
  phrasing "a sustained activity pattern (2 or more consecutive tracked periods)" was used instead —
  it describes only what CMA actually knows, matches the direction-agnostic nature of the underlying
  count, and introduces no causality/intent/importance/ranking language.
- **Zero case:** the sentence unconditionally renders (never conditionally hidden) whenever the
  digest has at least one tracked competitor, following the same convention as the existing
  `aboveBaselineCount` sentence — "0 of N ... currently show a sustained activity pattern..." is a
  coherent, deterministic statement, not an omission.
- **Mobile:** the two sentences are wrapped in a `min-w-0 flex-1 space-y-1` container, following the
  exact `min-w-0`/flex-child convention already used elsewhere in this same file (line 34) and across
  `/changes`, `/competitors`, `/dashboard`, `/reports` for text that must wrap inside a flex row
  rather than overflow. This is the same pattern the existing single-sentence card already relied on
  implicitly (the paragraph's own inline text wrapping); the new wrapper only makes that same
  behavior explicit for two stacked paragraphs.

## 7. Schema

```
NONE
```

`packages/db/prisma/schema.prisma` was not read for write purposes and was not modified.

## 8. Extraction

```
NONE
```

`packages/extraction/` was not touched.

## 9. Compare

```
NONE
```

`/compare` and `getCompetitiveContext` were not touched. `apps/web/src/app/(app)/compare/page.tsx`
was not modified in this phase.

## 10. Tenant isolation

The DB-layer `sustainedCount` computation itself was already tenant-isolation-proven by Phase 16
(`packages/db/src/repositories/intelligence.test.ts`, unmodified in this phase). This phase adds
zero new computation, so the only isolation property to verify is that the **passthrough** doesn't
leak or mix values across organizations:

- `buildDigestInterpretationInput` is a pure function of its single `digest` argument — it has no
  access to any other organization's data, no global state, and no cross-request cache. The Phase 18
  propagation tests (Test A/B/C) construct two digests with different `sustainedCount` values
  (`2`/`3`, `0`/`2`, `5`/`5`) in the same test run and confirm each produces exactly its own value in
  the resulting bundle, with no cross-contamination between calls.
- `/digest/page.tsx` reads `digest.crossCompetitorContext` from `getDigestForOrganization(session.
  organizationId, ...)` — the same per-request, per-organization call that already backs
  `aboveBaselineCount`'s tenant isolation (Phase 10's `PHASE10-VALIDATION-REPORT.md` tenant-isolation
  section, unmodified). No new data source, no new query, no shared/cached value across
  organizations was introduced.
- Extended `apps/web/e2e/digest.spec.ts` test 5 ("cross-competitor context") to also assert the new
  sustained-context sentence renders `0 of 2` for that fixture (neither seeded competitor there has
  120+ days of tracked history), and added a new test 12 that seeds one organization with one
  sustained competitor and one fresh competitor and asserts `1 of 2` — same single-organization
  shape as the existing `aboveBaselineCount` cross-competitor test, proving the count reflects only
  that organization's own competitors. The existing tenant-isolation test (test 6) already proves
  Organization B never sees Organization A's digest card at all; this phase did not need to duplicate
  that infrastructure since the new sentence is part of the same card already covered by that test.
- **Note:** the E2E additions (test 5's added assertion and new test 12) were written and reviewed
  against the existing helper/fixture conventions in `digest.spec.ts` but were **not executed** in
  this environment — no local Postgres/Redis/Docker was available to run the Playwright suite (see
  Section 13). They are ready to run in an environment with the project's normal Postgres/Redis
  setup per `DevRunbook.md`.

## 11. Query / performance

```
0 new Prisma queries
```

`sustainedCount` was already computed and returned by `getDigestForOrganization` before this phase
(`packages/db/src/repositories/intelligence.ts:770`, Phase 16). This phase's entire job was to stop
discarding that already-returned field at the two points where it was previously dropped
(`buildDigestInterpretationInput`'s mapping, and `/digest/page.tsx`'s destructure). No repository
function was called an additional time, no new `WHERE`/`JOIN` was added, and no new round-trip to
the database was introduced anywhere in `packages/ai` or `apps/web`.

## 12. AI calls

```
0 real provider calls required
0 new AI calls introduced
```

All new/updated AI-layer tests (Section 13) exercise `buildDigestInterpretationInput` directly
(a pure, provider-free function) or reuse the existing `createFakeAiProvider()` fixture already used
by pre-existing tests — no billed provider call was made to validate this phase.

## 13. Tests

**`packages/ai` (`npm test --workspace packages/ai`):**
```
Test Files  12 passed (12)
     Tests  123 passed (123)
```
Includes 3 new tests in `digestInterpretation.test.ts` (Phase 18 Test A/B/C: exact non-zero
propagation, zero propagation, straight-passthrough-with-no-side-effects) plus updated fixtures in
`digestInterpretation.test.ts` and `validateDigestClaimSafety.test.ts` (both now supply
`sustainedCount` on every `crossCompetitorContext` fixture, since the field is required).

**`apps/worker` (`npm test --workspace apps/worker`):**
```
Test Files  5 passed (5)
     Tests  60 passed (60)
```
`digestInterpretationPipeline.test.ts`'s two `DigestForInterpretation` fixtures
(`digestWithOneCompetitor`, `emptyDigest`) updated to include `sustainedCount` — required by the
now-stricter type; no test logic changed.

**Typecheck (`npm run typecheck`, all workspaces):**
```
PASS — @cma/web, @cma/worker, @cma/ai, @cma/core, @cma/db, @cma/detection, @cma/extraction,
@cma/notifications, @cma/queue, @cma/security all clean.
```
Note: `packages/ai` had to be rebuilt (`npm run build --workspace packages/ai`) mid-phase so that
`apps/worker`'s typecheck (which resolves `@cma/ai` via its published `dist/index.d.ts`, not source)
picked up the new required `sustainedCount` field — this is a build-artifact refresh, not a
production behavior change, and is expected whenever a workspace package's public type changes.

**Build (`npm run build`):**
```
PASS — apps/web (Next.js production build, all routes including /digest compiled), apps/worker,
packages/ai, packages/core, packages/db (prisma generate + tsc), packages/detection,
packages/extraction, packages/notifications, packages/queue, packages/security all built clean.
```

**`packages/db` (`npm test --workspace packages/db`):**
```
Test Files  12 skipped (12)
     Tests  202 skipped (202)
```
Skipped in this environment because these are real-Postgres integration tests and no local Postgres
was available (consistent with this phase making zero changes to `packages/db`, so no new coverage
was needed there — Phase 16's existing `sustainedCount` DB-layer tests, unmodified, remain the
source of truth for that computation).

**E2E (`apps/web/e2e/digest.spec.ts`):** extended (Section 10) but **not executed** — no local
Postgres/Redis/Docker available in this environment. Not run, not claimed as passing.

## 14. Regression

Full existing suites for the two packages actually touched (`packages/ai`, `apps/worker`) were
rerun in full (not just the new tests) and pass: 123/123 and 60/60 respectively, including every
pre-existing digest-interpretation test (retry/timeout/end-to-end fake-provider paths,
`SUSTAINED_ACTIVITY_TREND` item-level fact propagation from Phase 16, competitor-selection/item-cap
logic, untrusted-text isolation). No pre-existing test's assertions were altered — only fixture
literals gained the new required field where the type demanded it.

## 15. Known findings

None.

## 16. Files changed

```
packages/ai/src/digestTypes.ts
packages/ai/src/buildDigestContext.ts
apps/web/src/app/(app)/digest/page.tsx
packages/ai/src/digestInterpretation.test.ts
packages/ai/src/validateDigestClaimSafety.test.ts
apps/worker/src/digestInterpretationPipeline.test.ts
apps/web/e2e/digest.spec.ts
```

`git diff --stat`:
```
apps/web/e2e/digest.spec.ts                        | 18 +++++++++
apps/web/src/app/(app)/digest/page.tsx             | 25 ++++++++----
apps/worker/src/digestInterpretationPipeline.test.ts |  4 +-
packages/ai/src/buildDigestContext.ts              |  1 +
packages/ai/src/digestInterpretation.test.ts       | 44 ++++++++++++++++++++--
packages/ai/src/digestTypes.ts                     |  2 +
packages/ai/src/validateDigestClaimSafety.test.ts  |  1 +/-1
7 files changed, 81 insertions(+), 15 deletions(-)
```
No production, schema, extraction, or Compare file outside the three intended production files was
touched.

## 17. Final output

```
PHASE 18 — CROSS-COMPETITOR SUSTAINED CONTEXT DISTRIBUTION

Status:
PASS

Primary change:
sustainedCount is now propagated from the existing DB Digest result into
DigestForInterpretation/EvidenceBundle and rendered on /digest.

New intelligence:
NONE

New formulas:
NONE

New Prisma queries:
0

Schema:
NONE

Extraction:
NONE

Compare:
NONE

New AI provider calls:
0

New claim-safety categories:
0

Tenant isolation:
PASS - passthrough is a pure function of the caller's own per-organization digest; no new query,
no shared/cached cross-org state. E2E assertions added (test 5 zero-case, new test 12 non-zero
case) but not executed in this environment (no local Postgres/Redis available).

Mobile:
PASS (static/CSS review) - same min-w-0/flex-child wrapping convention used elsewhere in this file
and across the app; E2E mobile-overflow assertion (test 11) unmodified and not re-executed here for
the same infra reason as above.

Tests:
packages/ai: 123/123 passed (3 new). apps/worker: 60/60 passed. packages/db: 202/202 skipped (no
local Postgres, unmodified by this phase). E2E: extended, not executed (no local Postgres/Redis/
Docker in this environment).

Typecheck:
PASS (all workspaces)

Build:
PASS (all workspaces, including apps/web production build)

Known findings:
None.

Historical phases re-audited:
NO

Report:
docs/phases/PHASE18-VALIDATION-REPORT.md
```
