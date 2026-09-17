# Phase 20 Validation Report — Sustained + Repeated Price Co-occurrence

## 1. Status

**PASS.**

## 2. Scope

Implementation of the competitor-level `sustainedActivityTrend.sustained === true AND repeatedPricePatterns.some(p => p.qualifies)` composition on `SustainedActivityTrendDigestItem`, exactly as recommended by `docs/phases/PHASE19-INTELLIGENCE-COMPOSITION-ATTENTION-AUDIT.md` Section 15. Nothing beyond this single deterministic boolean fact was added.

## 3. Historical Phases Re-audited

**NO.** Phases 0–19 are treated as established context, per instruction. The only prior-phase code paths this implementation depends on directly — `getSustainedActivityTrend`, `getRepeatedPriceChangePatterns`, and the existing digest → AI → UI propagation pipeline (Phase 10/11/16/18) — were re-read to confirm their exact current return types and semantics before writing the composition, but none were modified, re-derived, or found to contradict Phase 19's account of them.

## 4. Implementation

### Exact boolean semantics

```ts
repeatedPriceChangeCoOccurs =
  sustainedActivityTrend.sustained === true &&
  repeatedPricePatterns.some((p) => p.qualifies === true)
```

Always a real `boolean` (never `null`/`undefined`/a third state) on `SustainedActivityTrendDigestItem` at the DB layer, because both underlying computations (`getSustainedActivityTrend().sustained`, `getRepeatedPriceChangePatterns()[].qualifies`) are already deterministic and always resolved by the time this field is set. On the `packages/ai` duck-typed interface it stays `optional` (matching every other sibling field on that shared union type, e.g. `consecutiveQualifyingWindows?`), because a `CHANGE_EVENT`-kind item never carries it — that is a shape constraint of the union, not a third value for the field itself.

### Where computed

`packages/db/src/repositories/intelligence.ts`, inside `getDigestForOrganization`'s existing per-competitor `Promise.all` (`intelligence.ts:667-671`), at the exact site where the `SUSTAINED_ACTIVITY_TREND` digest item is already constructed (`intelligence.ts:731-751` after the change). No new call to `getSustainedActivityTrend` or `getRepeatedPriceChangePatterns` was added — both are already resolved in that same `Promise.all` for every other purpose the item construction needs.

### How existing outputs are reused

`sustainedActivityTrend` and `repeatedPricePatterns` are the exact same two objects `getDigestForOrganization` already had in scope for building the `REPEATED_PRICE_CHANGE` items (step 2) and the `SUSTAINED_ACTIVITY_TREND` item (step 3.5) a few lines above/below. The composition is a one-line, in-memory `.some()` call over an array already produced. Because the `SUSTAINED_ACTIVITY_TREND` item itself is only ever pushed inside `if (sustainedActivityTrend.sustained && events.length > 0)`, the `sustained === true` half of the AND is already guaranteed by that branch — the field body only needs to express the `repeatedPricePatterns.some(...)` half; the two together are still exactly the specified composition.

### Whether a new digest field/type was required

Yes, minimally: `SustainedActivityTrendDigestItem` (an existing interface, `intelligence.ts`) gained one new required field, `repeatedPriceChangeCoOccurs: boolean`. No new `DigestItemKind` was created — Phase 19 explicitly anticipated that the existing item shape could carry this fact, and direct inspection confirmed it (the item already carries `consecutiveQualifyingWindows`/`direction`, two other derived facts about the same underlying trend). No Prisma model, no migration.

### How AI propagation works

Followed the exact Phase 16/18 pattern:
1. `SustainedActivityTrendDigestItem.repeatedPriceChangeCoOccurs` (DB) →
2. `DigestItemForInterpretation.repeatedPriceChangeCoOccurs?: boolean` (new optional field, `packages/ai/src/digestTypes.ts`) →
3. `factsForItem()`'s `SUSTAINED_ACTIVITY_TREND` case in `packages/ai/src/buildDigestContext.ts` adds `repeatedPriceChangeCoOccurs: item.repeatedPriceChangeCoOccurs ?? null` to the item's `facts` bag (the same `?? null` passthrough idiom every other optional field in that function already uses) →
4. `EvidenceBundleItem.facts` (unchanged type — `facts: Record<string, string | number | boolean | null>` already accepts booleans) →
5. `digestPrompt.ts`'s `buildDigestUserPrompt` serializes `facts` generically via `JSON.stringify` (`jsonLine`/inline `facts=${JSON.stringify(item.facts)}`) — **zero changes needed to the prompt or system prompt**, since the serialization mechanism was already field-agnostic.

No new provider method, no new AI call, no new prompt architecture, no new hypothesis type, no new claim-safety category (`packages/ai/src/validateDigestClaimSafety.ts` inspects the AI's OUTPUT text for prohibited phrases; it does not inspect input facts, so nothing there needed to change).

### How UI renders it

`apps/web/src/app/(app)/digest/page.tsx`'s `DigestItemRow`: a new conditional `<span data-testid="digest-sustained-repeated-price-cooccurrence">` rendered only when `item.kind === "SUSTAINED_ACTIVITY_TREND" && item.repeatedPriceChangeCoOccurs`, appended after the existing "Sustained for N consecutive tracked periods" text. Wording: *"Repeated price changes are also occurring for this competitor in this period."* — neutral, factual, no causal/importance/priority language (audited against the brief's explicit forbidden-word list in Section 11: no "important", "priority", "threat", "because", "therefore", "likely to", "responding to", etc.). No new card, no new page, no badge with a warning-implying color (rendered as plain `text-slate-500`, matching the file's existing neutral secondary-text convention, not a `Badge` component at all — avoiding any implied urgency from color).

## 5. Intelligence

```text
New intelligence:
ONE deterministic competitor-level co-occurrence fact.
```

This is genuinely new information, not merely re-presented data, because **no existing field, item, or count in the digest ever expressed the conjunction of these two specific facts for the same competitor in the same window.** Before this phase, a customer viewing the digest could see a `SUSTAINED_ACTIVITY_TREND` item and, separately, a `REPEATED_PRICE_CHANGE` item for the same competitor, but nothing stated whether they were correlated — the customer had to notice both items belonged to the same competitor and infer the connection themselves (or miss it entirely if the items were far apart in the recency-sorted feed). The new boolean makes that correlation an explicit, computed, evidence-traceable fact rather than an implicit pattern the customer would have to reconstruct by eye. Per Phase 19 Section 12 (generic-AI differentiation test), this fact is also **not reproducible by a generic LLM given only the current page content** — it strictly requires `getSustainedActivityTrend`'s multi-period baseline computation, which itself requires CMA's own accumulated snapshot history.

## 6. Evidence

The composition creates **no new web evidence**. `changeEventIds` on the `SUSTAINED_ACTIVITY_TREND` item is completely unchanged — it still carries exactly the same current-window `ChangeEvent` ids it carried before this phase (`events.map((e) => e.id)`, unmodified). The `repeatedPriceChangeCoOccurs` boolean is a **derived fact about two existing evidence-backed computations**, not itself a claim requiring separate evidence: its truth is fully reconstructible from `getSustainedActivityTrend`'s and `getRepeatedPriceChangePatterns`' own already-tested, already-evidenced outputs. No duplicate `ChangeEvent` ids were introduced, no raw HTML, no new excerpts, no change to evidence selection logic, no entity-history evidence mechanism. Verified by DB Test F (`intelligence.test.ts`, "Test F — evidence") and unaffected by the composition per Test A/E's assertion that `REPEATED_PRICE_CHANGE` items remain exactly as before.

## 7. Schema

```text
NONE.
```

`packages/db/prisma/schema.prisma` was not opened for editing. `npm run db:migrate` was run against the real local Postgres before starting DB-test execution and reported "Already in sync, no schema change or pending migration was found" — independent confirmation that the schema is unchanged by this phase.

## 8. Extraction

```text
NONE.
```

`packages/extraction/` and `packages/detection/` were not touched. `packages/extraction`'s and `packages/detection`'s own test suites (11 and 13 tests respectively) were re-run as part of the full regression sweep and pass unchanged.

## 9. Entity Identity

**No cross-period entity identity is used anywhere in this composition.** The field is computed entirely at the **competitor level**: it answers "does at least one of this competitor's repeated-price-change groups qualify in the current window, while this competitor's own overall activity is independently sustained across multiple historical windows" — it never asks "is the SAME product's repeated price-changing itself sustained across periods," which would require reconciling `entityKey` identity across historical windows (the capability Phase 19 Section 11 and this phase's brief Section 3 explicitly forbid attempting here). `getRepeatedPriceChangePatterns` was called with its existing, unmodified single-window semantics; `getSustainedActivityTrend` was called with its existing, unmodified multi-offset semantics; the two results were combined only as competitor-scoped booleans, never by matching `entityKey` values between them or across `getSustainedActivityTrend`'s internal offsets.

## 10. AI

- **New provider calls:** 0. No `AiProvider` interface method was added or modified.
- **Prompt architecture changes:** 0. `digestPrompt.ts` was not modified — its existing generic `facts` serialization already covers the new field without any change.
- **Structured field propagation:** confirmed end-to-end. DB unit tests (Test A–E, H) assert the DB-computed value; `packages/ai` unit tests (Phase 20 Test G) assert `DigestForInterpretation`/`EvidenceBundle` carry the value verbatim with no recomputation; a real E2E run (`digest-ai-interpretation.spec.ts`, 5/5 passing) exercises the full pipeline through a real (fake-provider) worker process end to end, confirming the field survives serialization into the actual prompt text and back through the persisted `DigestAiInterpretation` round-trip without breaking any existing assertion.
- **Claim-safety changes:** 0. `validateDigestClaimSafety.ts`'s `PROHIBITED_CLAIM_PATTERNS` list is unmodified — no category was added, none was needed, since the new field is a plain boolean on the *input* evidence bundle, not text the AI produces.

```text
0 new provider calls
0 new claim-safety categories
```

## 11. Query / Performance

```text
0 new Prisma queries
```

- **Query-count test:** `packages/db/src/repositories/intelligence.test.ts`, "Test I — query bound" (nested under `repeatedPriceChangeCoOccurs composition (Phase 20)`). Rather than asserting an arbitrary numeric ceiling (which, as discovered during implementation — see Section 17 — is fragile across differently-shaped fixtures for reasons unrelated to this phase), the test compares the SAME 160-day-tracked, 3-offset-sustained fixture with and without the extra repeated-price `PRICE_CHANGE` events and asserts the Prisma query counts are **exactly equal**. This is a stronger proof than "under some ceiling": it demonstrates that adding the repeated-price-qualifying data does not add a single additional query, because `getRepeatedPriceChangePatterns` (2 fixed queries: urls + price events) and `getActivityPattern`/`getSustainedActivityTrend` (a fixed query count per offset, independent of event volume — the same O(competitors)-not-O(events) invariant Phase 7/12/14B already established) are both volume-independent by construction.
- **Digest query ceiling:** unchanged. The pre-existing "Phase 12: issues a query count bounded by competitor count, not by ChangeEvent volume" test (measured at 23 queries for a single competitor, ceiling 26) continues to pass unmodified, confirming the composition added no per-competitor query overhead to that baseline fixture either.
- **Complexity:** O(1) in-memory work per competitor (a single `.some()` call over an already-materialized array), added inside an already-`O(competitors)` loop. No new database reads, joins, additional repository calls, or ChangeEvent-volume-dependent loops.

## 12. Tenant Isolation

- **DB unit test:** "Test H — tenant isolation" seeds Organization A with a sustained-only fixture (`repeatedPriceChangeCoOccurs: false` expected) and Organization B with a sustained-plus-repeated-price fixture (`repeatedPriceChangeCoOccurs: true` expected) in the same test run, and asserts each organization's `getDigestForOrganization` call returns only its own value — proving Org B's `true` result cannot leak into or influence Org A's `false` result. **Result: PASS.**
- **E2E test:** "E2E 4 - tenant isolation" seeds Organization A with a co-occurring fixture and asserts Organization B (zero competitors of its own) never sees Organization A's competitor name, evidence, or the literal co-occurrence annotation text in its own `/digest` page body. **Result: PASS.**
- No global state, shared cache, cross-org query, or global competitor map was introduced anywhere in the implementation — the composition reads only the `repeatedPricePatterns`/`sustainedActivityTrend` values already scoped to the current competitor inside the existing per-organization, per-competitor loop.

```text
Tenant isolation: PASS
```

## 13. UI / Mobile

- **Desktop:** verified via E2E 1 (annotation renders with exact expected wording when both signals are true), E2E 2 (absent when sustained-only), E2E 3 (absent when repeated-price-only, and no `SUSTAINED_ACTIVITY_TREND` item exists at all in that case, matching the brief's Section 12 requirement).
- **Mobile (375px):** E2E 5 asserts the annotation is visible at a 375×812 viewport and introduces no new `document.documentElement.scrollWidth > window.innerWidth` overflow, using the exact same overflow-detection convention as every other mobile test in this file (e.g. the pre-existing "11 - sustained activity trend: mobile" and "7 - mobile" tests).
- **False-case discipline:** confirmed by E2E 2/3 and DB Test B/C/D — the annotation never renders for a `false` value, and no `SUSTAINED_ACTIVITY_TREND` item is ever fabricated merely because a `REPEATED_PRICE_CHANGE` item exists (Test C explicitly asserts this: `sustained === false` produces zero `SUSTAINED_ACTIVITY_TREND` items regardless of repeated-price qualification).

```text
Mobile: PASS
```

## 14. Tests

All numbers below are from actual executed runs against the real local Postgres (`.local-infra/pgdata`, started for this session) and Redis (`.local-infra/redis`), not estimated.

| Suite | Result | Notes |
|---|---|---|
| `packages/db` (full suite, incl. `intelligence.test.ts`, `patterns.test.ts`) | **210 PASS / 0 FAIL** | Was 202 before Phase 20 (per Phase 18's own report); +8 new Phase 20 tests (Test A–I, minus Test G which lives in `packages/ai`) |
| `packages/db` `intelligence.test.ts` alone | **57 PASS / 0 FAIL** | Includes all 8 new Phase 20 `describe("repeatedPriceChangeCoOccurs composition (Phase 20)")` tests |
| `packages/ai` (full suite, incl. `digestInterpretation.test.ts`) | **124 PASS / 0 FAIL** | Was 123 before Phase 20; +1 net (Test G added, one existing exact-shape assertion updated to include the new field, no test removed) |
| `apps/web` (vitest unit suite) | **68 PASS / 0 FAIL** | Unchanged from Phase 18's baseline — no new unit tests were needed (all new coverage is DB/AI unit + E2E) |
| `apps/worker` (vitest unit suite) | **60 PASS / 0 FAIL** | Unaffected — no worker code was touched |
| `packages/core` | **32 PASS / 0 FAIL** | Unaffected |
| `packages/security` | **53 PASS / 0 FAIL** | Unaffected |
| `packages/extraction` | **11 PASS / 0 FAIL** | Unaffected |
| `packages/detection` | **13 PASS / 0 FAIL** | Unaffected |
| `packages/queue` | **10 PASS / 0 FAIL** | Unaffected |
| `packages/notifications` | **9 PASS / 0 FAIL** | Unaffected |
| E2E `digest.spec.ts` (real Postgres + Redis + real browser) | **16 PASS / 1 FAIL** | All 5 new Phase 20 E2E tests PASS. The 1 failure (test "5 - cross-competitor context...") is a **pre-existing, unrelated** flake — see Section 17 |
| E2E `sustained-trend.spec.ts` | **3 PASS / 0 FAIL** | Regression check — competitor-detail-page `SustainedTrendCard` is untouched by this phase |
| E2E `digest-ai-interpretation.spec.ts` (real worker, `CMA_AI_PROVIDER=fake`) | **5 PASS / 0 FAIL** | Regression + confirms the new field survives the real AI-interpretation round trip end to end |
| E2E `competitive-context.spec.ts` (`/compare`) | **6 PASS / 0 FAIL** | Regression check confirming `/compare` is completely unaffected, as required by Section 19 |

**SKIPPED:** none of the above were skipped — every suite listed ran against a real, reachable Postgres for this session (all `describe.skipIf(!reachable)` guards evaluated `reachable: true`).

**NOT RUN:** `e2e/ai-openai-smoke.spec.ts` (the dedicated real-OpenAI-billed smoke test) was not run — it is gated behind `OPENAI_API_KEY` for the Playwright process by design and is explicitly out of scope per Section 18 of the brief ("A real provider call is NOT required for this phase"). No billed OpenAI calls were made anywhere in this validation; the AI regression above used `CMA_AI_PROVIDER=fake` exclusively.

**FAILED:** 1 test, pre-existing and unrelated (see Section 17). Never converted to a pass, never silently retried into a pass — reported here exactly as observed.

## 15. Regression

Summarized above (Section 14) — every existing suite this phase could plausibly affect was re-run: `packages/db` (full), `packages/ai` (full), `apps/web` (unit + relevant E2E), `apps/worker` (full), plus every other workspace's unit suite for completeness (`core`, `security`, `extraction`, `detection`, `queue`, `notifications`). Zero regressions found in any of them; the single failing test is pre-existing (confirmed via `git stash` bisection against the pristine pre-Phase-20 code — see Section 17).

## 16. Files Changed

```text
packages/db/src/repositories/intelligence.ts          (+32 lines: field, computation, doc comments)
packages/db/src/repositories/intelligence.test.ts      (+169 lines: Test A-F, H, I)
packages/ai/src/digestTypes.ts                          (+10 lines: optional field + doc comment)
packages/ai/src/buildDigestContext.ts                   (+4 lines: factsForItem passthrough)
packages/ai/src/digestInterpretation.test.ts            (+20/-1 lines: factory default, Test G, updated exact-shape assertion)
apps/web/src/app/(app)/digest/page.tsx                  (+6 lines: conditional annotation)
apps/web/e2e/digest.spec.ts                             (+124 lines: E2E 1-5)
```

No file outside this list was modified. `apps/web/next-env.d.ts` was transiently touched by running `next dev` locally for E2E verification and was reverted (`git checkout --`) before finishing — see Section 17.

## 17. Known Findings

1. **Pre-existing, unrelated E2E flake:** `apps/web/e2e/digest.spec.ts` test "5 - cross-competitor context: 'N of M tracked competitors above baseline' reflects only qualifying, currently-above-baseline competitors" fails on the CURRENT `main` branch's code, **before any Phase 20 change is applied** — confirmed by `git stash`-ing every Phase 20 file, rebuilding `packages/db`, and re-running the exact same test in isolation against the pristine code, which produced the identical failure (`"1 of 2"` where `"0 of 2"` is expected for the `sustainedCount` assertion at line 163). This is unrelated to `repeatedPriceChangeCoOccurs` and is not touched by this phase's diff. Root cause is outside this phase's scope to investigate (the brief explicitly forbids modifying `getSustainedActivityTrend`/`getActivityPattern`), but the symptom is consistent with the fixture's 150-day `backdateCreatedAtDays` now sitting past the boundary needed for a second sustained offset to also qualify, given how much real wall-clock time has elapsed since the fixture was authored (Phase 10/16/18) relative to `Date.now()`-based seeding — i.e., a date-relative fixture drifting across a threshold over time, not a Phase 20 regression. Flagged here rather than silently worked around, per the brief's Section 20/23 instruction to report exact findings rather than paper over them.
2. **Incidental fixture interaction (informational only, not a bug):** the pre-existing `digest.spec.ts` test "8 - sustained activity trend..." fixture (`seedPatternEvents(id, [{5},{5},{35},{65}]}, 160)`) seeds its events with no explicit `entityKey`/`changeType`, so `seedPatternEvents.mjs`'s defaults (`changeType: "PRICE_CHANGE"`, `entityKey: "pro-plan"`) apply uniformly — meaning the two current-window events at `daysAgo: 5` already happen to form a qualifying repeated-price-change group. After this phase, that pre-existing fixture therefore now also (correctly, per the composition's own logic) satisfies `repeatedPriceChangeCoOccurs: true`, and Phase 20's own E2E "E2E 1" test deliberately reuses this exact fixture for that reason (documented inline in the new test's comment). This did not break test 8's own assertions (it only checks `SUSTAINED_ACTIVITY_TREND`-specific test ids, never the absence of a `REPEATED_PRICE_CHANGE` item), so no fix was required, but it is recorded here for the next person reading `digest.spec.ts` who might otherwise be surprised.

No other findings. No schema drift, no accidental provider/extraction/detection/`/compare` changes, no test silently downgraded from FAIL to SKIP or PASS.

## 18. Final Product Assessment

**Question:** Does this phase create a new customer-observable fact from CMA's accumulated historical memory without introducing scoring, ranking, speculation, or fragile identity assumptions?

**Answer: Yes**, on the evidence gathered in this validation:

- **New customer-observable fact:** the `repeatedPriceChangeCoOccurs` boolean and its `/digest` annotation are new — verified by DB Test A/E (renders `true` only when both signals independently qualify) and E2E 1–3 (the annotation is visibly present/absent exactly as the underlying data dictates, confirmed in a real browser against a real Postgres-backed digest).
- **From CMA's accumulated historical memory:** the `sustained` half of the composition strictly requires `getSustainedActivityTrend`'s multi-offset, multi-window baseline computation, which is only possible because CMA persists `ChangeEvent` history over time — a fact independently established by Phase 19 Section 12 and unchanged by this phase (the composition adds no new historical dependency, but does not weaken this one either).
- **No scoring:** the field is a plain `boolean`, never a number, percentage, or weighted combination. No new comparison operator, threshold, or magnitude was introduced beyond the two thresholds (`MIN_SUSTAINED_WINDOWS`, `MIN_REPEATED_PRICE_CHANGES`) that already existed, unmodified, in `getSustainedActivityTrend`/`getRepeatedPriceChangePatterns`.
- **No ranking:** the fact is computed and displayed per-competitor, independently; no cross-competitor ordering, "top N," or comparison was introduced. `compareDigestItems`' existing recency-first tie-break ordering (`intelligence.ts:520-528`) is completely unmodified.
- **No speculation:** the UI wording ("Repeated price changes are also occurring for this competitor in this period") states only what was computed — no cause, intent, strategy, or forecast language, verified against the brief's explicit forbidden-word list in Section 11 and consistent with `validateDigestClaimSafety.ts`'s own prohibited-phrase categories (none of which needed extension, because the new field never reaches AI-generated free text — it is input evidence, not output).
- **No fragile identity assumptions:** confirmed in Section 9 — the composition is strictly competitor-scoped and never attempts cross-period `entityKey` reconciliation, the exact hazard Phase 19 Section 11 flagged as unsolved and out of scope.

## Repository Cleanliness

```text
$ git status --short
 M apps/web/e2e/digest.spec.ts
 M apps/web/src/app/(app)/digest/page.tsx
 M packages/ai/src/buildDigestContext.ts
 M packages/ai/src/digestInterpretation.test.ts
 M packages/ai/src/digestTypes.ts
 M packages/db/src/repositories/intelligence.test.ts
 M packages/db/src/repositories/intelligence.ts

$ git diff --stat
 apps/web/e2e/digest.spec.ts                       | 124 ++++++++++++++++
 apps/web/src/app/(app)/digest/page.tsx            |   6 +
 packages/ai/src/buildDigestContext.ts             |   4 +
 packages/ai/src/digestInterpretation.test.ts      |  20 ++-
 packages/db/src/repositories/intelligence.test.ts | 169 ++++++++++++++++++++++
 packages/db/src/repositories/intelligence.ts      |  32 ++++
 packages/ai/src/digestTypes.ts                    |  10 ++
 7 files changed, 364 insertions(+), 1 deletion(-)
```

No accidental unrelated changes, no generated files, no schema changes, no migrations, no dependency changes (`package.json`/`package-lock.json` untouched), no provider changes, no extraction changes, no `/compare` changes. Two transient local-only side effects from running the real stack for E2E verification (`apps/web/next-env.d.ts`, regenerated by `next dev`; `dump.rdb`, written by `redis-server`'s default save behavior at the repo root) were identified and reverted/removed before finishing — neither is part of this phase's diff. The repository was clean (per Phase 19's own final check) before this phase began; no pre-existing unrelated dirty state was found or needed to be preserved.

## Final Conclusion

Phase 20 implements exactly the single composition Phase 19 recommended: a deterministic, competitor-level `repeatedPriceChangeCoOccurs` boolean, computed with zero new Prisma queries from two already-computed signals, propagated through the existing Digest → AI → UI pipeline using the same additive patterns Phase 16 and Phase 18 already established, verified by 9 new deterministic unit tests (DB + AI) and 5 new E2E tests, all passing, with zero regressions across every other suite in the repository. One pre-existing, unrelated E2E flake was discovered and is documented (Section 17) rather than silently fixed or hidden, in keeping with the phase's strict scope boundary.
