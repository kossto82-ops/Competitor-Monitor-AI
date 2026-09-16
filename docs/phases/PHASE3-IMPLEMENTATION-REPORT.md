# PHASE 3 IMPLEMENTATION REPORT — AI Analysis Pipeline

## Status

**PASS**

All 18 numbered sections of the brief were implemented. The deterministic monitoring core from
Phases 1–2.1 was not modified. No Phase 4 scope (reports, notifications, multi-provider,
autonomous agents, etc.) was started.

## Architecture

```
ChangeEvent (already persisted, deterministic)
  │
  │ POST /api/change-events/{id}/analysis (apps/web)
  │   - re-validates the ChangeEvent belongs to the caller's org
  │   - 422 if changeType has no AI analysis context
  │   - idempotent: creates/gets a PENDING AiAnalysis row (unique on changeEventId)
  │   - no-ops (200, no enqueue) if already COMPLETED or RUNNING
  ▼
BullMQ queue "ai-analysis-jobs" (packages/queue/src/aiAnalysisQueue.ts)
  - jobId = the AiAnalysis row's own id (dedup, mirrors the manual-scan pattern from Phase 2)
  - attempts: 1 (no BullMQ-level retry - cost control; see below)
  ▼
apps/worker's second Worker → aiPipeline.ts:runAiAnalysisJob
  - skip if AiAnalysis already COMPLETED (idempotency against duplicate delivery)
  - re-fetch the ChangeEvent org-scoped; refuse FAILED_TO_VERIFY snapshots (defense-in-depth)
  - buildChangeAnalysisInput (@cma/ai) - bounded, per-changeType context only
  - mark RUNNING
  - analyzeChangeWithRetry(provider, input) - exactly one retry on a transient failure
  - mark COMPLETED (structured output + provider/model + tokens) or FAILED (error message)
  ▼
AiAnalysis row (packages/db) ← read by GET /api/change-events/{id}/analysis
  ▼
AiAnalysisPanel (apps/web, client component) - polls GET, same pattern as ScanButton.tsx
```

**Provider abstraction** (`packages/ai`, new package, zero dependency on `@cma/db`/`@cma/queue`):
- `AiProvider` interface: `analyzeChange(input) → { output, provider, model, usage }`.
- `AnthropicProvider`: plain `fetch` against the Messages API (no SDK dependency added), one HTTP
  attempt, `AbortController`-based timeout (20s default), classifies HTTP 429/5xx as retryable.
- `createFakeAiProvider`: deterministic test double, injectable failure/delay/malformed-output
  behavior, used by every automated test and by `apps/worker` itself when
  `CMA_AI_PROVIDER=fake` (dev/E2E only - see Security).
- `analyzeChangeWithRetry`: the one retry-on-transient-failure policy, applied uniformly to any
  provider rather than duplicated per implementation.
- `buildChangeAnalysisInput`: the only place a `ChangeEvent` is turned into what the model sees -
  per-changeType (`PRICE_CHANGE`/`PRODUCT_ADDED`/`PRODUCT_REMOVED`), every string truncated per
  `limits.ts`.
- `buildSystemPrompt`/`buildUserPrompt`: fixed instructions (FACT/INTERPRETATION/SPECULATION
  split, strict evidence rule, prompt-injection defense) + the untrusted content, kept in
  clearly-delimited, separate sections.
- `parseAiOutput`: JSON parse + zod schema validation shared by every provider, so "reject
  malformed output" and "reject schema-invalid output" behave identically regardless of backend.

**Lifecycle**: `AiAnalysisStatus` now mirrors `JobStatus` exactly (`PENDING → RUNNING →
COMPLETED/FAILED`), replacing the unused Phase-1 placeholder enum (`SUCCESS/FAILED/TIMEOUT/
SKIPPED`) that nothing had ever written to.

## Implemented

- New `packages/ai` package: types, zod schema, limits, context builder, prompt builder, output
  parser, retry wrapper, `AnthropicProvider`, `createFakeAiProvider`.
- Prisma migration `20260915120247_ai_analysis_phase3`: redesigned `AiAnalysis` (added
  `organizationId`, `promptVersion`, `provider`, `model`, `interpretations`, `confidence`,
  `inputTokens`/`outputTokens`/`costUsd`/`durationMs`, `errorMessage`, `startedAt`/`completedAt`,
  `updatedAt`; new `AiAnalysisStatus` values). Applied and verified against real Postgres.
- `packages/db/src/repositories/aiAnalysis.ts`: `getOrCreatePendingAiAnalysis` (idempotent,
  race-safe via the unique-constraint catch), `getAiAnalysisForChangeEvent`,
  `markAiAnalysisRunning`, `markAiAnalysisCompleted`, `markAiAnalysisFailed` (the last two only
  transition out of PENDING/RUNNING - never overwrite a COMPLETED row). Also fixed the pre-existing
  Phase-1 `getAiAnalysisForOrg` (in `reports.ts`) to scope by the new direct `organizationId`
  column instead of a join through `ChangeEvent`.
- `packages/queue/src/aiAnalysisQueue.ts`: second queue, `attempts: 1` (see Cost controls).
- `apps/worker/src/aiPipeline.ts` + `aiProvider.ts`: the orchestrator and the provider-selection
  factory (env-gated fake-provider opt-in). Second `Worker` + defensive `failed` handler wired
  into `apps/worker/src/index.ts`, mirroring the Phase 2.1 monitoring-worker pattern exactly.
- `apps/web`: `POST`/`GET /api/change-events/[changeEventId]/analysis`; `AiAnalysisPanel` client
  component wired into the existing change-detail page, polling the same way `ScanButton` does.
- `DevRunbook.md` §7b: how to run with the fake provider vs. a real `ANTHROPIC_API_KEY`.

## Security

- **Prompt injection**: all page-derived content (evidence excerpt, snapshot excerpts) is placed
  inside a single `<UNTRUSTED_WEB_CONTENT>...</UNTRUSTED_WEB_CONTENT>` block, separate from the
  deterministic facts (price/currency/source URL) which sit outside it. The system prompt tells
  the model this content is data only and that "ignore previous instructions"-style text inside
  it must never be treated as a command. Regression-tested (`prompt.test.ts`,
  `aiPipeline.test.ts`) with literal hostile strings, asserting they stay inside the delimiters and
  never change which deps/functions get called or their argument shapes. The strict output schema
  is the second line of defense: even a model that complied with injected instructions could only
  ever produce a JSON object matching `AiAnalysisOutput` - anything else is rejected before
  persistence.
- **Tenant isolation**: `AiAnalysis` carries its own `organizationId` (denormalized, same
  convention as every other table); every repository function requires it. Both API routes
  re-validate the `ChangeEvent` belongs to the caller's org (via `getChangeEventForOrg`) before
  touching any `AiAnalysis` row - a `changeEventId` from another org 404s before an `AiAnalysis`
  row is even looked up. Verified with a real-Postgres repository test
  (`aiAnalysis.test.ts`) and route-level tests.
- **Secrets**: `ANTHROPIC_API_KEY` is read only in `apps/worker` (never in `apps/web` - the
  browser never talks to the provider or sees a credential). `CMA_AI_PROVIDER=fake` is a no-op
  whenever `NODE_ENV=production`, mirroring `CMA_ALLOW_PRIVATE_TARGETS`'s existing convention, so
  a misconfigured production deployment fails loudly (missing key throws) instead of silently
  faking output.

## Cost controls

- Hard character caps (`packages/ai/src/limits.ts`): evidence excerpt 500 chars, each snapshot
  excerpt 800 chars, provider response capped at 8000 chars before even attempting `JSON.parse`.
  Full snapshots/HTML are never sent - only the bounded, per-changeType fields `buildContext.ts`
  selects.
- No BullMQ-level automatic retries (`attempts: 1`) - the one retry that does happen
  (`analyzeChangeWithRetry`) is deliberate and bounded, so a job can cost at most 2 provider calls.
- **Idempotency as a cost control**: `runAiAnalysisJob` returns immediately without calling the
  provider if the `AiAnalysis` row is already `COMPLETED` - verified with a dedicated duplicate-
  delivery test asserting the fake provider's call count stays at 0/1 in that case. The API's
  `POST` route applies the same short-circuit before ever enqueueing.
- Token/cost metadata (`inputTokens`, `outputTokens`, `costUsd`, `durationMs`, `provider`, `model`,
  `promptVersion`) is persisted on every completed row, `null` when a provider doesn't report it
  (never fabricated).

## Tests

| Suite | Passed | Failed | Skipped | Not run |
|---|---|---|---|---|
| `packages/ai` (unit) | 27 | 0 | 0 | 0 |
| `apps/worker` (unit incl. new `aiPipeline.test.ts`) | 24 | 0 | 0 | 0 |
| `apps/web` (unit incl. new analysis route test) | 23 | 0 | 0 | 0 |
| `packages/db` (real Postgres, incl. new `aiAnalysis.test.ts`) | 36 | 0 | 0 | 0 |
| `packages/queue` (incl. real-Redis suite) | 5 | 0 | 0 | 0 |
| `packages/detection` | 13 | 0 | 0 | 0 |
| `packages/extraction` | 11 | 0 | 0 | 0 |
| `packages/security` | 40 | 0 | 0 | 0 |
| **Unit/integration total** | **179** | **0** | **0** | **0** |
| Playwright E2E (18 specs, incl. new `ai-analysis.spec.ts`, 3 tests) | 18 | 0 | 0 | 0 |
| **Grand total** | **197** | **0** | **0** | **0** |

Typecheck: PASS (all 9 workspaces). Prisma `validate`: PASS. Prisma `migrate status`: up to date
(2 migrations). Production build (`next build` + all package builds): PASS.

All of it ran against real infrastructure: real PostgreSQL 17, real Redis, a real BullMQ worker
process (both queues, in-process), the real Next.js app, real Playwright/Chromium, and the real
deterministic fixture server - with the AI provider set to the fake, deterministic implementation
per the brief's explicit "do not use a live paid model for the automated test suite" instruction.

Mapped against the brief's 17-item test list (Section 14): all 17 are covered - 1–3 (per-type
analysis) and 16–17 (promptVersion/provider metadata persisted) in `aiAnalysis.test.ts` +
`aiPipeline.test.ts`; 4–5 (NO_CHANGE/FAILED_TO_VERIFY never trigger analysis) structurally (no
ChangeEvent exists for NO_CHANGE) plus an explicit defense-in-depth test for a hand-built
FAILED_TO_VERIFY fixture; 6–10 (malformed JSON, schema-invalid, timeout, retry, failure) in
`parseOutput.test.ts`/`analyzeChangeWithRetry.test.ts`/`aiPipeline.test.ts`; 11 (duplicate
delivery) in both `aiAnalysis.test.ts` and `aiPipeline.test.ts`; 12 (prompt injection) in
`prompt.test.ts`/`buildContext.test.ts`/`aiPipeline.test.ts`; 13 (tenant isolation) in
`aiAnalysis.test.ts` and the route tests; 14 (AI failure doesn't hide the ChangeEvent) in
`aiAnalysis.test.ts`; 15 (limits enforced) in `buildContext.test.ts`.

## Bugs found

No defects were found in newly-written Phase 3 product code during verification. Three
pre-existing/self-introduced issues were caught and fixed while building the test suite itself:

1. **Symptom**: `packages/db/src/tenantIsolation.test.ts`'s full-chain fixture failed to typecheck
   after the schema change (`status: "SUCCESS"` no longer a valid `AiAnalysisStatus`, and the new
   required `organizationId`/`promptVersion` columns were missing from the fixture).
   **Root cause**: this Phase-1 test fixture directly constructed an `AiAnalysis` row via raw
   Prisma and had never been touched since, so it still encoded the old placeholder shape.
   **Fix**: updated the fixture to `status: "COMPLETED"` with `organizationId`/`promptVersion`
   set. **Regression test**: the suite itself (`tenantIsolation.test.ts`, 9 tests, all passing).

2. **Symptom**: `reports.ts`'s pre-existing `getAiAnalysisForOrg` scoped tenant access via a join
   through `ChangeEvent` (`changeEvent: { organizationId }`), which was correct for the old schema
   but inconsistent with every other repository function's direct-column convention once
   `AiAnalysis.organizationId` was added.
   **Root cause**: Phase 1 added this function before `AiAnalysis` had its own `organizationId`
   column, and it was never revisited. **Fix**: switched to `{ id, organizationId }`, matching the
   rest of the codebase. **Regression test**: `tenantIsolation.test.ts`'s existing
   `getAiAnalysisForOrg` cross-tenant assertions still pass against the new implementation.

3. **Symptom**: an E2E test (`ai-analysis.spec.ts`, "re-opening the change detail page...") failed
   intermittently, landing on the competitor list page instead of the change-detail page.
   **Root cause**: the test read `page.url()` immediately after `.click()` without first awaiting
   navigation, capturing the pre-navigation URL. **Fix**: added
   `await expect(page).toHaveURL(/\/changes\//)` before reading the URL, matching the pattern
   already used elsewhere in the suite. **Regression test**: the test itself, now passing
   consistently across repeated runs.

Additionally, while setting up the real-infrastructure validation run, two **environment**
(not code) issues were found and corrected: several stale processes from a prior session (an old
`apps/worker`, four duplicate `concurrencyCheck.mjs` runs, a stale `next dev`) were still holding
the Prisma native client DLL open on Windows, blocking `prisma generate`; and the freshly-started
`apps/web` dev server was initially missing `CMA_ALLOW_PRIVATE_TARGETS=true`, causing 10
pre-existing (non-Phase-3) E2E specs to fail with "URL not visible after Add URL" until restarted
with the correct environment. Neither reflects a defect in Phase 3 (or any) product code.

## Remaining risks

- **`AnthropicProvider` has never been exercised against the live Anthropic API** - only its
  interface conformance is unit-tested (against a mocked `fetch`-free path via the fake provider).
  A real first call could surface response-shape surprises (refusals, different content-block
  ordering, rate-limit headers) not covered by the fake provider. Recommend a manual smoke test
  with a real `ANTHROPIC_API_KEY` before enabling in production.
- **`costUsd` is always `null` in practice** - the Anthropic Messages API returns token counts,
  not a dollar cost; no pricing table has been added to convert `inputTokens`/`outputTokens` into
  `costUsd`. Token counts alone are persisted and are enough for now, but real cost dashboards
  need that conversion added later.
- **Single-process, two-worker model**: `apps/worker` runs both the monitoring and AI-analysis
  BullMQ workers in one Node process, same as Phase 2.1 documented for the monitoring worker alone.
  A full process crash mid-AI-job relies on BullMQ's own stalled-job detection to eventually fire
  the `failed` handler and mark the row `FAILED` - there is a window where a crashed job could sit
  `RUNNING` until that timeout elapses (same class of residual risk as Phase 2.1's monitoring-job
  crash-safety note, not a new one).
- **Snapshot excerpting is naive** - `buildChangeAnalysisInput` takes the first N characters of
  `normalizedContent`, not a window centered on the actual change. For a long page, the truncated
  excerpt sent to the model may not include the part that actually changed, which could weaken the
  analysis quality (it can never widen the exposed data beyond the caps, only occasionally miss
  useful context).
- **No versioned re-analysis yet** (explicitly out of scope per Section 15) - if `PROMPT_VERSION`
  is bumped later, existing `COMPLETED` rows keep their old `promptVersion` stamp and are not
  automatically re-run; a future re-analysis feature would need to decide how to handle that.
- Retry is capped at one attempt uniformly; under a sustained partial provider outage this means
  roughly 2x call volume (and cost) for the duration, which is an intentional trade-off but worth
  watching in production metrics once usage grows.

## Recommendation

**Ready for approval.** All 18 sections of the brief are implemented, the full regression suite
(197 automated tests across unit, integration-against-real-Postgres/Redis, and Playwright E2E
against the real stack) passes with zero failures/skips, and the deterministic monitoring core
from Phases 1–2.1 is untouched. The one open item before enabling this in production is the
manual smoke test against a real `ANTHROPIC_API_KEY` noted above, since automated tests
deliberately never call the live model.
