# Phase 12 — AI Interpretation Safety Hardening & Regression Guards

**Type:** Hardening phase. Closes two concrete gaps Phase 11 documented
in its own report (`PHASE11-VALIDATION-REPORT.md`, Section 15, Findings
#2 and #3) - a deterministic claim-safety defense for the Digest AI
interpretation layer, and a query-count regression guard for the new
repository path it depends on.

---

## 1. Status

```
PASS WITH FINDINGS
```

All new and existing unit/integration tests pass in every workspace
that could actually be exercised in this session (`packages/ai`:
116/116, +21 new; `apps/worker`: 60/60, +1 new). Typecheck and
production build both succeed. Real-provider validation was actually
performed against a live `gpt-4o-mini` call using the `OPENAI_API_KEY`
already present in this local `.env`, and it concretely proves the new
claim-safety validator rejects the EXACT recorded Phase 11 real-model
output that motivated this phase.

This is `PASS WITH FINDINGS`, not a clean `PASS`, for one honest reason:
**Postgres and Redis are unreachable in this session** (`127.0.0.1:5432`
and `127.0.0.1:6379` both refuse connections; no `docker` CLI and no
local Postgres binary are available on this machine) - so the new
query-count regression test added to `packages/db` and the full
Playwright E2E suite could not actually be *executed* against real
data, only added, code-reviewed, and confirmed to load/typecheck
correctly (the whole `packages/db` suite - 181 tests, including the
pre-existing 42 in `intelligence.test.ts` plus the 2 new ones this phase
adds - shows as "skipped", exactly matching that suite's own documented
"skip if unreachable, never fabricate a pass" convention; see Section 6
for the resulting numbers this makes honest vs. what it does not).

---

## 2. Objective

Phase 11's own report identified two hardening gaps in its Section 15/18
("Known Findings" / "Future Work"):

- **Finding #2**: a real `gpt-4o-mini` run produced a schema-valid,
  evidence-linked, correctly-hedged `interpretations[]` entry that still
  brushed against the system prompt's own "ABSOLUTELY PROHIBITED"
  causal/market-condition category: *"The introduction of 'Starter Plan'
  by Beta Competitor Co may indicate a response to market demand."*
  Prompt instructions alone are not a guaranteed defense against
  probabilistic model behavior on borderline phrasing.
- **Finding #3**: no query-count regression guard existed for
  `getDigestForOrganization` or the other new repository functions in
  the Phase 11 interpretation path (the same limitation Phase 10 had
  already flagged for `getDigestForOrganization` itself).

Phase 12 closes both with small, deterministic, independently-testable
additions - not a prompt rewrite, not a bigger model, not a merge of the
two existing validation layers into one.

---

## 3. Changes

| File | Change |
|---|---|
| `packages/ai/src/validateDigestClaimSafety.ts` | **New.** The deterministic claim-safety validator - phrase-level pattern matching across 7 prohibited-claim categories, independent of evidence-id validation. |
| `packages/ai/src/validateDigestClaimSafety.test.ts` | **New.** 21 unit tests: 7 safe-must-pass cases (including 2 explicit false-positive-avoidance cases for the bare words "market" and "strategy"), 9 must-reject cases (one per category plus a summary-field case and a "only one of several claims is bad" case), and 6 independence/interaction tests proving evidence-id validation and claim-safety validation are separate, both-enforced defenses. |
| `packages/ai/src/analyzeAndValidateDigest.ts` | Wires `validateDigestClaimSafety` in as a **third, independent** step, after schema validation (`parseDigestInterpretationOutput`, which itself does evidence-id provenance validation) and before persistence. |
| `packages/ai/src/index.ts` | Exports the new module. |
| `apps/worker/src/digestInterpretationPipeline.test.ts` | **+1 test.** Proves the pipeline-level `FAILED` transition end-to-end for a provider response with *valid* evidence ids but a prohibited phrase - mirrors the existing "marks FAILED when the provider returns output citing an evidence id outside the supplied bundle" test, for the other defense layer. |
| `packages/db/src/repositories/intelligence.test.ts` | **+2 tests.** Query-count regression guard for `getDigestForOrganization`: (a) same single competitor, 3 vs. 60 ChangeEvents -> identical query count; (b) 1 vs. 5 competitors (1 event each) -> query count does not scale ~5x, plus a tenant-isolation assertion under the same measurement path. Added, not executed against real Postgres in this session (Section 1/6). |
| `scripts/validation/phase12RealProviderSmoke.mjs` | **New.** Real-provider validation script (kept separate from, not a replacement for, `phase11RealProviderSmoke.mjs`). See Section 8. |

**Files NOT changed:** `packages/ai/src/digestPrompt.ts` (the prompt's
own prohibited-claim instructions are untouched - this phase adds a
*second*, independent layer, not a rewrite of the first),
`packages/ai/src/digestSchema.ts`, `packages/ai/src/validateDigestInterpretation.ts`
(evidence-id validation logic itself is untouched), `packages/db/src/repositories/intelligence.ts`,
`packages/db/src/repositories/patterns.ts`, `apps/worker/src/digestInterpretationPipeline.ts`
(no changes needed - throwing from `analyzeAndValidateDigest` already
flows into the existing `catch` block that marks the row `FAILED`),
`apps/web/**` (no UI changes - the existing "Analysis unavailable" /
error / "Retry interpretation" UX already handles any `FAILED` row
regardless of which validator produced it), `scripts/validation/phase11RealProviderSmoke.mjs`
(kept, unmodified).

**Schema changed:** NO. Zero Prisma/migration changes.

---

## 4. Claim-Safety Validator

### 4.1 Categories covered (7)

| Category | Example prohibited phrase forms |
|---|---|
| `causal-explanation` | "because of", "due to", "caused by", "in response to", "driven by", "as a result of" |
| `competitor-intent` | "intends to", "is trying to", "wants to", "aims to", "plans to", "is attempting to" |
| `competitor-strategy` | "strategic move", "competitive strategy", "positioning strategy", "aggressive strategy", "as a/part of a strategy" |
| `market-demand` | "market demand", "customer demand", "consumer demand", "increased/declining demand", "market conditions/pressure/trend" |
| `forecast` | "will likely", "will probably", "expected to", "likely to increase/decrease", "forecast(s/ed/ing)", "predict(s/ed/ing/ion)", "projected" |
| `financial-inference` | "market share", "revenue", "sales growth/decline", "customer acquisition", "conversion rate" |
| `win-loss` | "winning customers", "losing customers", "taking market share", "gaining customers" |

### 4.2 Validation order (see `analyzeAndValidateDigest.ts`)

```
provider.interpretDigest() raw text
   |
JSON.parse (parseDigestInterpretationOutput)
   |
zod schema validation (aiInterpretationOutputSchema)
   |
evidence-id provenance validation (against allowedEvidenceChangeEventIds)
   |
[Phase 12] validateDigestClaimSafety - scans summary + every
   observation/interpretation/hypothesis text against the 7 categories
   |
trusted AiInterpretationOutput -> persistence
```

Each step is a genuinely separate function call; a failure at any step
throws the same `AiOutputValidationError` type, and the caller
(`digestInterpretationPipeline.ts`'s existing `catch` block) treats all
of them identically - no new failure state was introduced (see Section
5's answer to the brief's own Q3/Q6).

### 4.3 False-positive strategy

Every pattern targets a **specific multi-word phrase form**, never a
bare common word. The two explicit anti-false-positive tests
(`validateDigestClaimSafety.test.ts`) prove:

- `"The competitor changed its market-facing pricing page."` - **passes**
  (the bare word "market" inside a compound adjective is never matched).
- `"The plan is labeled 'Enterprise Strategy Tier' on the pricing page."`
  - **passes** (the bare word "strategy" as a neutral noun/product-name
  fragment is never matched; only "strategic move" / "competitive
  strategy" / etc. phrase forms are).

Where a genuine tradeoff exists, the validator is **conservative in the
rejecting direction**: it is intentionally acceptable to reject a
borderline-but-arguably-safe claim (a false positive) rather than allow
an unsupported causal/intent/market claim through (a false negative) -
per the product brief's own Section 39 stance and Phase 11's Finding #2.
A rejected response is **never partially edited or silently rewritten**:
the entire interpretation is rejected, exactly like a schema violation
or a fabricated evidence id.

### 4.4 Failure semantics

Identical to every other `AiOutputValidationError` in this codebase: the
`DigestAiInterpretation` row transitions to `FAILED` with the validator's
message as `errorMessage` (verified end-to-end by the new
`digestInterpretationPipeline.test.ts` case, not just at the `@cma/ai`
unit level). No new enum value, no new error class, no partial
persistence.

---

## 5. Evidence Validation — Proven Independent

Both validators are separate functions (`parseDigestInterpretationOutput`
vs. `validateDigestClaimSafety`), called sequentially, neither one's
logic reads the other's inputs or outputs. Four interaction tests in
`validateDigestClaimSafety.test.ts` prove all four quadrants:

| # | Evidence ids | Claim text | Result | Test |
|---|---|---|---|---|
| 13 | invalid | safe | **REJECTED** by evidence validation | "Interaction 13" |
| 14 | valid | prohibited | **REJECTED** by claim-safety validation | "Interaction 14" |
| 15 | invalid | prohibited | **REJECTED** (evidence validator fires first in the real pipeline order) | "Interaction 15" |
| 16 | valid | safe | **ACCEPTED**, end-to-end via `analyzeAndValidateDigest` with a fake provider | "end-to-end: ... accepted" |

Plus a fifth, full end-to-end case ("Interaction 16" in the test file)
proving a fake-provider response with valid evidence but a prohibited
claim is rejected by `analyzeAndValidateDigest` itself, not just the
standalone validator function. And the real-provider script (Section 8)
proves the same thing against an actual `gpt-4o-mini` response, not a
fake one.

---

## 6. Query-Count Regression Guard

**Added** (not executed against real Postgres this session - see Section
1): two tests in `packages/db/src/repositories/intelligence.test.ts`,
inside the existing `getDigestForOrganization (Phase 10)` describe block,
following `getCompetitiveContext`'s own established
`countPrismaQueries()` pattern verbatim (same helper, same file, same
"skip if Postgres unreachable" convention already governing every other
test in that file):

1. **Event-volume test**: one competitor, 3 ChangeEvents vs. one
   competitor (different org), 60 ChangeEvents -> asserts
   `largeQueryCount === smallQueryCount` (not merely "under some
   threshold" - an exact equality assertion is the strongest possible
   proof that query count does not scale with event volume at all) and
   `smallQueryCount <= 20`.
2. **Competitor-count test**: 1 competitor vs. 5 competitors (1 event
   each) -> asserts `fiveCompQueryCount < oneCompQueryCount * 5`
   (proving the fixed per-competitor overhead itself is not hiding an
   N+1 over events), plus a same-measurement-path tenant-isolation
   assertion.

**Why this proves the right thing even unexecuted**: reading
`getDigestForOrganization`'s implementation (`intelligence.ts` lines
596-680+) confirms the shape these tests lock in: one
`prisma.competitor.findMany` for all competitors, one batched
`listRecentChangeEventsForDigest` call for **all** competitors' raw
events together (not per-competitor), then `Promise.all` over
`competitors.map(...)` running `getActivityPattern` +
`getRepeatedPriceChangePatterns` per competitor - i.e. the query count
is `O(1) + O(1) + O(competitors)`, never `O(events)`. The tests are
written to assert exactly this, matching `getCompetitiveContext`'s own
already-passing regression guard's structure and threshold style
(`<=16` there; `<=20` here, since `getDigestForOrganization` does
somewhat more per-competitor work than `getCompetitiveContext`).

**What is honestly NOT claimed**: an actual measured query count number
from a real run in this session. `packages/db`'s entire suite - all 181
tests, the 2 new ones included - reports as **skipped**, not passed,
because Postgres is unreachable here (see Section 1). This is the same
honest gap the report's Section 1 already states; repeating it here
rather than inflating Section 6 with invented numbers.

**Tenant isolation**: the pre-existing `"enforces organization isolation:
another organization's digest never contains this organization's
competitors or evidence"` test in the same file (unmodified, already
passing before this phase whenever Postgres is reachable) plus the new
competitor-count test's own same-measurement-path assertion both cover
this; no isolation logic was touched.

---

## 7. AI Cost Validation

No change to the cost-control mechanisms Phase 11 already put in place -
verified unchanged by the full `packages/ai`/`apps/worker` test suites
(Section 9) and by direct code inspection of
`digestInterpretationPipeline.ts` (untouched this phase):

| Scenario | Provider calls | Evidence |
|---|---|---|
| Successful interpretation | **1** | `digestInterpretation.test.ts` "the fake provider's canned response is itself accepted..." asserts `provider.digestCallCount === 1`; confirmed again live in Section 8's Case A (one real `gpt-4o-mini` call, `durationMs: 4983`). |
| Transient failure then success | **2** (1 + 1 retry) | `digestInterpretation.test.ts` "retries exactly once on a timeout, then succeeds" asserts `provider.digestCallCount === 2`; `digestInterpretationPipeline.test.ts` "makes at most 2 provider calls total..." (unmodified, still passing). |
| Every attempt fails (incl. the new claim-safety rejection, which throws exactly like any other validation failure) | **at most 2** | `interpretDigestWithRetry.ts` is untouched - claim-safety validation happens strictly AFTER the retry loop has already produced a raw response, so a claim-safety rejection is never itself retried as if it were a transient provider error (there is exactly 1 provider call in the new pipeline test for this case, since `respondDigest` here always returns the same prohibited text on the first call and `analyzeAndValidateDigest` throws before any retry logic could apply - retries in `interpretDigestWithRetry` only ever trigger on `AiProviderTimeoutError`/`AiProviderRequestError`, never on `AiOutputValidationError`). |
| Empty bundle | **0** | `digestInterpretationPipeline.test.ts`'s pre-existing "Section 18 (cost control): an empty bundle... completes WITHOUT any provider call" test, unmodified, still passing. |

**No new automatic scheduler, no interpretation trigger on GET or page
load** - `digestInterpretationPipeline.ts`, `apps/web/src/app/api/digest/interpretation/route.ts`,
and `DigestAiInterpretationPanel.tsx` are all untouched this phase.

---

## 8. Real-Provider Validation

**Provider/model:** `openai` / `gpt-4o-mini`, via the `OPENAI_API_KEY`
already present in this local `.env` (same key Phase 3.1/Phase 11 used;
never printed or logged by the script). **The script actually called the
live provider** - not a fake/mocked run - `scripts/validation/phase12RealProviderSmoke.mjs`,
executed once in this session. Full recorded result (secrets excluded,
token/timing numbers are the real API response metadata):

### Case A — safe interpretation (fresh real call)

Single-competitor bundle (`ACTIVITY_PATTERN` + `REPEATED_PRICE_CHANGE`,
no cross-competitor `PRODUCT_ADDED` event - the ingredient behind Phase
11's speculative-language run). **Result: PASS** through the entire
pipeline (schema + evidence + claim-safety). `inputTokens=1559,
outputTokens=205, durationMs=4983`. Model output: two observations, one
interpretation ("The activity level of Acme Rivals Inc is significantly
higher than their historical baseline average of 1."), zero hypotheses -
no prohibited phrase.

### Case B — live repeat of the exact Phase 11 bundle

Same 3-item, 2-competitor bundle from `PHASE11-VALIDATION-REPORT.md`
Section 12 (the one whose earlier real run produced the "market demand"
interpretation). **This run's live model output did not reproduce that
phrasing** (`inputTokens=1664, outputTokens=249, durationMs=2933`) -
reported honestly rather than claimed as a repeat, since real-model
output on borderline phrasing is inherently probabilistic (exactly
Finding #2's own point - this script does not assert a specific wording
will recur on demand).

**Deterministic replay of the exact recorded Phase 11 output** (the real
`gpt-4o-mini` JSON verbatim from that report's Section 12, not
fabricated for this script) run through the SAME validation pipeline:

```
rejectedBy: "AiOutputValidationError"
error: "openai returned invalid output: claim contains a prohibited
        unsupported-claim phrase (category=market-demand,
        matched=\"market demand\"): \"The introduction of 'Starter
        Plan' by Beta Competitor Co may indicate a response to market
        demand.\""
```

**This is the core proof Phase 12 exists to provide**: the exact
real-model output that passed Phase 11's validation (because Phase 11
had no claim-safety layer) is now deterministically rejected.

### Case C — fabricated evidence id, real response as the base

Case A's own real raw model response was JSON-mutated (one
`evidenceChangeEventIds` entry replaced with `"ce-FABRICATED-DOES-NOT-EXIST"`)
and re-validated. **Result: REJECTED**, independent of claim-safety:

```
rejectedBy: "AiOutputValidationError"
error: "openai returned invalid output: cited evidenceChangeEventIds
        not present in the supplied evidence bundle:
        ce-FABRICATED-DOES-NOT-EXIST"
```

**Overall script result:** `ok: true` (Case A passed, the deterministic
Phase-11-output replay was correctly rejected, Case C was correctly
rejected; Case B's live call is reported for transparency and does not
gate the overall pass/fail, since it is explicitly non-deterministic by
design).

---

## 9. Regression Validation

### Unit/Integration (vitest)

```
packages/ai:     116/116 passed (was 95 before Phase 12 - +21 new, 0 regressions)
apps/worker:      60/60 passed (was 59 before Phase 12 - +1 new, 0 regressions)
packages/core, detection, extraction, notifications, queue, security:
                  unchanged, all still passing (32/32, 13/13, 11/11, 9/9, 10/10, 53/53)
apps/web:         68/68 passed (unchanged this phase - no apps/web files touched)
packages/db:      181/181 SKIPPED (Postgres unreachable this session - see Section 1/6;
                  0 new failures, 2 new tests added and confirmed to load/parse correctly)
```

Full monorepo `npm test`: **exit code 0**, every executable suite
passes, `packages/db` skips cleanly (its own documented, pre-existing
behavior when Postgres is unreachable - not a new gap this phase
introduced) and `packages/queue`'s 3 real-Redis tests skip identically
for Redis.

### Typecheck

```
packages/ai (tsc -p tsconfig.json --noEmit):     PASS
apps/worker (tsc -p tsconfig.json --noEmit):     PASS
packages/db (tsc -p tsconfig.json --noEmit):     PASS
```

### Build

```
apps/web: npm run build --workspace apps/web -> PASS (exit 0)
/digest and /api/digest/interpretation both present in the route manifest (unchanged from Phase 11).
```

### E2E (Playwright)

**Not executed this session.** `apps/web/e2e/digest-ai-interpretation.spec.ts`
and the rest of the Playwright suite require a real Postgres + Redis +
worker process, all of which are unreachable here (Section 1). No
Playwright changes were made this phase (no `apps/web` files were
touched), so there is no new code path for that suite to exercise -
but per Rule 20, this is stated as "not executed," not "passes," since
it was not actually run.

---

## 10. Security Validation

- **Tenant isolation**: unchanged (`digestAiInterpretation.ts`,
  `intelligence.ts` untouched this phase); the pre-existing
  organization-scoped queries and the new query-count test's own
  same-path isolation assertion (Section 6) both cover it. Not
  independently re-verified against real Postgres this session (Section
  1) - not newly at risk either, since no isolation-relevant code
  changed.
- **Evidence provenance**: `validateDigestInterpretation.ts` is
  byte-for-byte unchanged - still cross-checks every
  `evidenceChangeEventIds` entry against `bundle.allowedEvidenceChangeEventIds`,
  independently of the new claim-safety check (Section 5).
- **Prompt injection boundary**: `digestPrompt.ts`'s
  `<UNTRUSTED_WEB_CONTENT>` isolation is unchanged this phase. The new
  claim-safety validator operates on the MODEL'S OWN output text, never
  on page-derived input, so it introduces no new surface for untrusted
  content to influence anything.
- **Output rendering safety**: no `apps/web` files were touched this
  phase - `dangerouslySetInnerHTML` grep-confirmed absent from
  `DigestAiInterpretationPanel.tsx` (unchanged from Phase 11).
- **Credential handling**: `phase12RealProviderSmoke.mjs` reads
  `OPENAI_API_KEY` from the environment exactly like
  `phase11RealProviderSmoke.mjs` and never logs it; the JSON it prints
  contains only model output, token counts, and validation error
  messages.

---

## 11. Known Findings

1. **Postgres/Redis unreachable in this session** (Section 1/6/9) - the
   new query-count regression test and the full Playwright E2E suite
   were added/reviewed but not executed against real infrastructure.
   Probed directly: `127.0.0.1:5432` and `127.0.0.1:6379` both refuse
   connection; no `docker` CLI, no local Postgres binary found on
   `PATH`. This is an environment limitation of this session, not a
   Phase 12 regression - re-run `packages/db`'s and the Playwright
   suites in an environment with reachable Postgres/Redis (per
   `DevRunbook.md` Section 3) to get the actual measured query-count
   numbers and E2E confirmation.
2. **Case B's live real-provider call did not reproduce Phase 11's
   exact prohibited phrasing this run** (Section 8) - reported honestly
   rather than treated as a failure, since real-model output on
   borderline phrasing is inherently probabilistic (this IS Finding #2's
   own point). The deterministic replay of the actual recorded Phase 11
   output in the same script proves the fix works regardless of what
   any single live call happens to say.
3. **`ai-analysis.spec.ts` pre-existing flake** (documented in
   `PHASE11-VALIDATION-REPORT.md` Finding #1) was not re-investigated or
   re-verified this phase - no files in its causal chain were touched,
   and E2E was not executed at all this session (Finding #1 above), so
   there is nothing new to report about it either way.

---

## 12. Historical Phases Re-Audited

```
NO
```

`PHASE9-PRODUCT-DIRECTION-AUDIT.md`, `PHASE10-VALIDATION-REPORT.md`, and
`PHASE11-VALIDATION-REPORT.md` were read only for grounding and to
extract the exact contract this phase extends (the prohibited-claim
category list already in `digestPrompt.ts`, the recorded Finding #2
output, the `getCompetitiveContext` query-count test pattern to mirror).
The actual `analyzeAndValidateChange.ts`/`analyzeAndValidateDigest.ts`/
`validateDigestInterpretation.ts`/`errors.ts`/`digestInterpretationPipeline.ts`/
`intelligence.ts` files were read to reuse their exact conventions, not
to re-validate their prior conclusions. No prior architectural decision
was reopened.

---

## 13. Final Architectural Test (Phase 12's own seven questions)

**Q1. Can a model-generated causal/market/intent statement now be
rejected deterministically even when its evidence IDs are valid?**
**YES.** Proven three ways: the unit test "Interaction 14" (prohibited
text + valid evidence ids -> rejected), the pipeline-level test (Section
4.4), and - most concretely - Section 8's real-provider replay of the
exact recorded Phase 11 output, which has genuinely valid evidence ids
and is still rejected.

**Q2. Can a model-generated response with fabricated evidence IDs still
be rejected independently?**
**YES.** `parseDigestInterpretationOutput` (unchanged) still rejects any
such response before claim-safety ever runs - proven by "Interaction 13"
and "Interaction 15" (unit), and by Section 8's real-provider Case C
(fabricated id mutated into a genuine real model response, rejected).

**Q3. Does the deterministic Digest remain fully useful when AI
interpretation fails?**
**YES.** No files in `packages/db/src/repositories/intelligence.ts` or
`apps/web/src/app/(app)/digest/page.tsx`'s feed rendering were touched
this phase; a claim-safety rejection produces exactly the same `FAILED`
row and existing "Analysis unavailable" / "Retry interpretation" UX
Phase 11 already built and validated end-to-end.

**Q4. Does query volume remain bounded independently of ChangeEvent
volume?**
**Not fully demonstrated this session** - the test asserting this was
added and is structurally sound (reading `getDigestForOrganization`'s
implementation confirms the O(competitors)-not-O(events) shape it
locks in), but it could not be *executed* against real Postgres here
(Section 1/6/9). This is the one honest gap keeping this phase at `PASS
WITH FINDINGS` rather than a clean `PASS`.

**Q5. Did Phase 12 increase the maximum provider-call budget?**
**NO.** `interpretDigestWithRetry.ts` is untouched; claim-safety
validation runs strictly after a raw response is already obtained and
is never itself retried (Section 7).

**Q6. Can the system still distinguish Observation / Interpretation /
Hypothesis without making the AI the source of truth?**
**YES.** `digestSchema.ts`/`digestTypes.ts` are unchanged; the new
validator inspects all three categories' text fields identically and
rejects the WHOLE response (never edits a single category) on a
violation - it never converts, say, an interpretation into a hypothesis
or otherwise reclassifies AI content.

**Q7. Did Phase 12 introduce any hidden ranking, score, forecast, market
estimate, or competitor-intent inference?**
**NO.** The new validator only ever REJECTS claims that already assert
one of those things - it computes nothing, ranks nothing, and adds no
new field to `AiInterpretationOutput`/`DigestAiInterpretation`. Confirmed
by direct inspection: `validateDigestClaimSafety.ts` has no return value
other than `void`/throw.

**Assessment:** 6 of 7 answers match the desired outcome exactly; Q4 is
the one honest gap - the guard exists and is structurally sound but
unexecuted against real infrastructure in this session. Per this phase's
own instructions ("if any answer cannot be demonstrated, do not hide it
... use PASS WITH FINDINGS"), this phase is reported as **PASS WITH
FINDINGS**, not `PASS`.

---

## 14. Future Work (not implemented here)

- Execute the new query-count regression test and the full Playwright
  E2E suite in an environment with reachable Postgres/Redis, and record
  the actual measured query-count numbers (Finding #1/Q4).
- Consider whether the claim-safety phrase list should be
  organization-configurable or centrally versioned alongside
  `DIGEST_PROMPT_VERSION`, if false positives are observed in real usage
  at scale (not needed for this phase's scope).
- Reconciling the Digest's AI interpretation with Phase 4's daily report
  email remains untouched, as in Phase 11.

---

## PHASE 12 FINAL OUTPUT

```
PHASE 12 — AI INTERPRETATION SAFETY HARDENING & REGRESSION GUARDS

Status:
PASS WITH FINDINGS

Implementation:
A new, deterministic claim-safety validator (packages/ai/src/validateDigestClaimSafety.ts)
runs as a third, independent step in analyzeAndValidateDigest.ts, after schema
validation and evidence-id provenance validation. It scans every claim's text
across 7 prohibited-claim categories (causal explanation, competitor intent,
competitor strategy, market demand/conditions, forecast, financial inference,
win/loss) using specific multi-word phrase patterns - never a bare-keyword
blacklist - and rejects the ENTIRE response on any match, exactly like a schema
or evidence-provenance failure. A query-count regression guard was added for
getDigestForOrganization, mirroring getCompetitiveContext's existing pattern.

Claim-safety validation:
7 categories, phrase-level patterns, runs after schema+evidence validation,
independent of both. False positives preferred over false negatives per the
product brief. Entire response rejected on any single violation - no partial
edits, no silent rewriting.

Evidence validation:
Unchanged, proven independent via 4 interaction-test quadrants (valid/invalid
evidence x safe/prohibited claim) plus a real-provider fabricated-id case.

Query-count guard:
Added (2 new tests in intelligence.test.ts, mirroring getCompetitiveContext's
pattern) but NOT executed against real Postgres this session - unreachable
(127.0.0.1:5432 refused; no docker/pg binary available). This is the one gap
keeping this phase at PASS WITH FINDINGS.

AI calls:
Unchanged: 1 call per successful interpretation, at most 2 (1 retry) on
transient failure, 0 for an empty bundle. Claim-safety rejection is never
retried as a transient error.

Real-provider validation:
PASS. A real gpt-4o-mini call (Case A) passed the full pipeline. The exact
recorded Phase 11 real-model output (Case B replay) is now deterministically
REJECTED by the new validator (category=market-demand). A fabricated evidence
id mutated into a real model response (Case C) is independently REJECTED.
Case B's fresh live call this run did not reproduce the exact prior phrasing -
reported honestly, not asserted as guaranteed (real-model output on borderline
phrasing is inherently probabilistic).

Tenant isolation:
Unchanged; no isolation-relevant code touched this phase. Not re-verified
against real Postgres this session (infra unreachable).

Prompt injection:
Unchanged; digestPrompt.ts's <UNTRUSTED_WEB_CONTENT> boundary untouched. The
new validator inspects only the MODEL's own output, never page-derived input.

Tests:
packages/ai: 116/116 passed (+21 new)
apps/worker:  60/60 passed (+1 new)
packages/db: 181/181 SKIPPED (Postgres unreachable; 2 new tests added, not executed)
Full monorepo `npm test`: exit code 0, every executable suite passes

E2E:
Not executed this session (Postgres/Redis unreachable; no apps/web files changed
this phase, so no new E2E surface exists to exercise).

Typecheck:
PASS (packages/ai, apps/worker, packages/db)

Build:
PASS (apps/web production build; /digest and /api/digest/interpretation both
present in the route manifest, unchanged from Phase 11)

Known findings:
(1) Postgres/Redis unreachable in this session - query-count test added but not
    executed, E2E not executed; (2) Case B's live real-provider call did not
    reproduce Phase 11's exact prior phrasing this run (reported honestly,
    expected given probabilistic model behavior); (3) ai-analysis.spec.ts's
    pre-existing flake (Phase 11 Finding #1) neither re-investigated nor
    newly relevant, since E2E did not run at all this session.

Next logical phase:
Execute the new query-count test and full Playwright suite in an environment
with reachable Postgres/Redis to close this phase's one open finding (Q4);
otherwise no further AI-safety hardening is indicated by anything found here.

Historical phases re-audited:
NO
```
