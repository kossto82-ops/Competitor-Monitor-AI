# Phase 5 Validation — Customer-Ready Competitive Intelligence MVP

**Scope:** turn the technically validated monitoring/AI/reporting engine (Phases 1–4) into a
product a real customer can sign up for, configure, and understand without ever seeing the
codebase — while keeping the provider-agnostic architecture intact and laying groundwork for
future historical/comparative intelligence, plans, and entitlements.

---

## 1. Product Depth Audit

*(Required before implementation — Section "Important Product Question". This is an honest
assessment of the actual system, not generic startup advice.)*

### 1.1 Already valuable, genuinely differentiated

- **Verified, evidence-backed change detection.** Every reported change traces back to a real
  `previousSnapshot`/`currentSnapshot` pair with an `evidenceExcerpt` — never an LLM guess. The
  UI explicitly labels this ("This is evidence, not an inference"). Most "AI competitor monitor"
  products on the market skip this and let the LLM both detect *and* narrate the change, which
  invites hallucination. Deterministic-first is a real, structural advantage, not a slogan.
- **Explicit `FAILED_TO_VERIFY` vs `NO_CHANGE` distinction.** A blocked/failed fetch is never
  silently reported as "nothing changed" — this sounds small but is the single most common
  correctness bug in naive scrapers-as-monitors, and it's enforced at the schema level
  (`VerificationState`), not just in UI copy.
- **Provider-agnostic AI, truly.** Provider/model/credential all come from the organization's own
  `AiConnection`; nothing in the codebase can silently substitute a vendor or model (verified
  live in Section 4 below). This is a real architectural commitment, not a marketing claim.
- **AI as enrichment, never authority.** A missing or failed AI analysis never hides or weakens a
  deterministic finding. Structurally guaranteed (no code path lets AI output touch a
  `ChangeEvent`), not just a UI convention.
- **Multi-tenant isolation is real and re-tested every phase**, including this one, across every
  new surface (competitors, URLs, AI connections, reports, usage, settings).

### 1.2 Currently basic (real limitations, not hidden)

- **Single-URL-at-a-time monitoring per competitor**, no cross-page correlation (e.g. "this
  competitor changed pricing on 3 pages in the same week" is not surfaced as one story).
- **No trend or magnitude context.** A price increase is reported the same way whether it's the
  competitor's first change in a year or their fifth this month. There is no "this competitor
  changes prices unusually often" signal yet (Section 1.4 below).
- **Text-only evidence.** No screenshots, no visual diff — a customer must trust the extracted
  text excerpt.
- **No cross-competitor view.** Nothing today answers "how does Competitor A's pricing compare
  to Competitor B's" — everything is scoped to one competitor at a time.
- **Onboarding is empty-state copy, not a guided wizard.** A new customer sees a clear explainer
  and a natural next step, but there's no multi-step "1 of 5" onboarding flow with progress
  tracking.

### 1.3 Commoditized (a generic scraper + LLM wrapper could replicate)

- Fetching a page, diffing text, asking an LLM to summarize the diff. Alone, this is table
  stakes — dozens of "AI website monitor" side projects do exactly this.
- A daily digest email listing what changed. Also commoditized on its own.

**What keeps this from being "just" that:** the verification semantics (Section 1.1), the
enrichment-not-authority AI contract, and — starting this phase — persistent, evidence-linked
history (the timeline) rather than a disposable daily email. None of those are hard to *describe*,
but they are easy to get subtly wrong, and this codebase has them enforced structurally rather
than by convention.

### 1.4 Potential differentiation (evaluated, NOT built this phase)

| Idea | Verdict this phase |
|---|---|
| Competitor timeline (chronological, evidence-linked) | **Built** (Section 5 below) — the clearest, lowest-risk step from "digest" toward "history" |
| Basic filtering (competitor/type/date) | **Built** — makes the timeline/changes feed usable |
| Change frequency / "how active is this competitor" | **Deferred** — the data (`ChangeEvent.detectedAt`) supports a simple count-over-time, but no metric is invented this phase; a future phase can compute this directly from existing rows without new tables |
| Price history chart (`ChangeEvent` filtered to `PRICE_CHANGE`) | **Deferred** — the timeline already surfaces these events; a dedicated chart is a presentation choice for a later phase, not a data-model gap |
| Cross-competitor comparison | **Deferred** — needs a normalized "what is comparable" concept (e.g. matching plan tiers across competitors) that does not exist yet and would be invented, not derived, if built now |
| Category/industry intelligence (aggregating across customers) | **Explicitly not built** — would require cross-tenant data use, a genuine privacy/consent question, not an engineering one |
| Confidence/source-reliability scoring beyond what exists | **Deferred** — `Snapshot.confidence` and AI `confidence` already exist; a combined "reliability score" would currently be invented, not measured |
| Alerts (real-time push on a specific change) | **Explicitly deferred to a later phase** per the brief (Section 18: "future alerts belong to a later phase") |

**The single highest-leverage next step for genuine differentiation** (recommended, not built
this phase): make the timeline the primary surface instead of the daily email — i.e., treat
"persistent competitive intelligence history" as the product's spine, with the daily report as
one view onto it. Phase 5 takes the first concrete step (the timeline + filters) without
overreaching into trend/forecast territory the data can't yet support honestly.

---

## 2. Implemented Features

### 2.1 AI provider security & correctness (Sections 6–9, 32, 33)

- **Regression found and fixed:** `AiConnectionsManager.tsx`'s "Add AI connection" form
  pre-filled the Model field with `"gpt-5.6-luna"` via `useState("gpt-5.6-luna")` — a genuine **UI
  default** violation (the exact class of bug Phase 4's audit was written to catch, found in a
  different location this phase). Fixed: the field now starts empty with an illustrative,
  multi-vendor placeholder (`"e.g. gpt-4o-mini, gpt-4.1, llama-3.3-70b"` — deliberately showing
  three different vendors so no single one reads as "the" default) and `required` blocks empty
  submission. No other regression was found (see Section 4, full audit).
- **New: customer-facing "Test connection"** (`packages/ai/src/testConnection.ts`,
  `runConnectionTest`/`testAiConnection`). Makes exactly one real, un-retried provider call with a
  small synthetic input, and classifies the outcome into `SUCCESS`, `INVALID_CREDENTIALS`,
  `MODEL_UNAVAILABLE`, `PROVIDER_UNAVAILABLE`, or `INVALID_CONFIGURATION` — never surfacing the
  vendor's raw error text (which can contain the submitted key echoed back, e.g. "Incorrect API
  key provided: sk-...")|. Two entry points:
  - `POST /api/ai-connections/test` — tests not-yet-saved form values (the same apiKey the Save
    button would send; nothing new is persisted).
  - `POST /api/ai-connections/[id]/test` — tests an existing connection; the credential is
    decrypted server-side only for this one call (`getDecryptedAiConnectionForOrg`, new,
    tenant-scoped) and never serialized into the response.
- **Model audit re-run, zero new production violations** (full table in Section 4).

### 2.2 Competitor & monitored URL management (Sections 3–5)

- `updateCompetitor` / `deleteCompetitorIfSafe` (new): edit name/website/notes, deactivate/
  reactivate via `isActive`, delete only when zero monitored URLs exist (`ConflictError` → HTTP
  409 otherwise — "deactivate instead of deleting" surfaced verbatim to the customer).
  Deactivating **never** touches `MonitoredUrl`/`ChangeEvent` rows — history stays fully
  auditable.
- `updateMonitoredUrl` / `deleteMonitoredUrlIfSafe` (new): edit label/category/
  `scanFrequencyMinutes`, pause/resume via `isActive`, delete only when zero `Snapshot` rows exist.
- **`scanFrequencyMinutes` is now a real, backend-enforced setting**, not a decorative field
  (Section 5 explicitly asked for this over a fake UI control): `listDueMonitoredUrls` (new)
  computes which URLs are actually due (never scanned, or last successful scan older than their
  own frequency), and `apps/worker/src/enqueueAll.ts` now enqueues only due URLs — also excluding
  URLs whose competitor was deactivated. A URL scanned an hour ago with a daily frequency is
  correctly skipped on the next scheduler tick.
- UI: `CompetitorActions` (edit/deactivate/reactivate/delete) and `MonitoredUrlActions`
  (pause/resume, frequency dropdown) — both real, both wired to the endpoints above.

### 2.3 Onboarding & first-run experience (Sections 1, 2, 10)

- `FirstRunExplainer`: shown on the dashboard the moment an organization has zero competitors.
  Plain product language, only the four capabilities the system actually has (pricing, products/
  services, offers/promotions, plans/features), a 4-step "how it works" list, and the same
  `NewCompetitorForm` used elsewhere (no parallel onboarding-specific competitor form). Verified
  live (Playwright): the explainer renders and contains **zero** occurrences of `ChangeEvent`,
  `BullMQ`, `AiAnalysis`, or `snapshot`.
- No fabricated report or fake data is ever shown — "no report yet" and "no changes detected"
  states are honest, matching Section 10's explicit instruction.

### 2.4 Email preferences & real notification path (Sections 17, 18)

- `Organization.reportRecipientEmail` (new, nullable): an optional override recipient for the
  daily report. `getReportRecipientEmailForOrg` now checks this first, falling back to the
  Phase 4 behavior (the OWNER's email) when unset or cleared (empty string).
- `/settings/notifications` (new page + `NotificationSettingsForm`): daily-report enabled/
  disabled, recipient override, timezone — exactly Section 18's three settings, nothing more
  (no alert rules, no per-competitor notification config).
- **Production email provider:** NOT implemented this phase. `@cma/notifications`'s
  `EmailProvider` interface (Phase 4) is unchanged; `ConsoleEmailProvider` remains the only
  implementation. No SMTP/API vendor credential was available or requested for this phase, and
  Section 17 is explicit: "do not fake production delivery" if none is available. This is a
  genuine, documented gap (Section 6, Known Gaps), not a silent shortcut — the architecture
  (idempotent reservation, failure isolation) already works unchanged the day a real adapter is
  added.

### 2.5 Usage visibility (Sections 19, 20, 21)

- `getProductUsageSummaryForOrg` (new): competitors, monitored URLs, changes this month, AI
  analyses this month, reports generated, emails sent — **computed on read** from existing tables
  (`Competitor`, `MonitoredUrl`, `ChangeEvent`, `AiAnalysis`, `Report`, `NotificationLog`), not a
  new write-time ledger. This was a deliberate choice: a second, separately-written "usage event"
  table would be a second source of truth that can drift from the first (Section 28: no
  duplication) — every number here already equals exactly what its own table records.
- `/settings/usage` (new page): the plain numbers, explicitly **not** a billing page, and no
  monetary figure — `costUsd` is still `null` for any unpriced model (Phase 3.1/4's rule,
  unchanged), and this phase does not attempt to estimate it.
- **Future plan readiness (Section 21):** no entitlement/limit is enforced anywhere this phase.
  Documented, for future work, where each future limit would attach:
  - *Number of competitors / URLs* → `createCompetitor` / `createMonitoredUrl` (packages/db) —
    a count check before insert.
  - *Monitoring frequency floor* → `updateMonitoredUrlInputSchema`'s `scanFrequencyMinutes` min
    (currently 15) is already the mechanical enforcement point; a plan-based floor would change
    that schema's `min()` per plan tier.
  - *AI usage* → `resolveAiProviderForOrg` / `runAiAnalysisJob` (apps/worker) — the natural
    checkpoint before a paid call is made.
  - *History retention* → would need a retention job reading `ChangeEvent.detectedAt` /
    `Report.reportDate` — no such job exists yet, nothing deletes history today.
  - *Email recipients* → `reportRecipientEmail` is a single field today; a list would replace it
    directly in `updateOrganizationSettings`.
  No `Plan`-conditional logic exists in any of these paths today — this section is a map for
  Phase 6+, not code shipped this phase.

### 2.6 Historical intelligence foundation (Sections 14–16)

- **Competitor timeline** (`listChangeEventsForCompetitor`, new — thin wrapper over
  `listChangeEventsForOrg`, no parallel query logic): every verified change across all of a
  competitor's monitored URLs, grouped by calendar day, each linking to its evidence. Rendered on
  the competitor detail page beneath the existing URL list.
- **Basic filtering** on `/changes`: competitor, change type, date range — a plain GET form, no
  client JS, no search engine. `listChangeEventsForOrg`'s options were extended
  (`competitorId`, `changeType`, `detectedAfter`, `detectedBefore`) rather than adding a second
  query function.
- Deliberately **not** built: change-frequency metrics, trend lines, predictive anything (Section
  14 explicit).

### 2.7 Information architecture & product language (Sections 11, 12, 25)

- Sidebar: Dashboard, Competitors, Changes, Reports, Account, AI Provider, **Notifications**
  (new), **Usage** (new). "Dashboard" was deliberately left as-is rather than renamed to
  "Overview" — the existing `auth.spec.ts`/`smoke.spec.ts` assert on that exact heading, and
  renaming it would be pure churn with no product value (Section 36: don't modify stable systems
  unnecessarily).
- UI copy audit: every customer-facing string is produced by an existing display helper
  (`summarizeChangeEvent`, `changeTypeDisplay`, `aiAnalysisStatusDisplay`, `reportStatusDisplay`,
  etc.) — none of them render the literal words `ChangeEvent` or `AiAnalysis`; those terms appear
  only in code identifiers and comments, never in rendered text (verified by grep, Section 4).

---

## 3. Customer Journey (Section 30)

Proven live, in this order, in a single Playwright test
(`apps/web/e2e/phase5-customer-journey.spec.ts`) against the real stack (see Section 5 for
infrastructure details):

```
Signup (no developer knowledge required)
  ↓
First-run dashboard: plain-language product explainer, zero internal terms
  ↓
Add first competitor
  ↓
Add first monitored URL
  ↓
Run first scan → "No changes detected" (honest baseline, Section 10)
  ↓
Real fixture price change → second scan → verified PRICE_CHANGE
  ↓
Configure the organization's OWN AI connection (provider=openai, model=env-configured,
real API key) via /settings/ai
  ↓
Test connection (real provider call) → "Connection successful" → Save
  ↓
Trigger AI analysis on the verified change → COMPLETED with a real summary
  ↓
Persisted AiAnalysis.provider == "openai", AiAnalysis.model == the exact configured
model (never "gpt-5.6-luna") - asserted via the real API response
  ↓
Deterministic evidence (EUR59.00) still visible, unchanged by the AI step
  ↓
Competitor timeline shows the change, linking back to evidence
```

This is the single required E2E scenario (Section 30) plus the real-AI proof (Section 31) in one
test - not two separate suites - since the same real browser session naturally covers both.

---

## 4. AI Provider Audit (Sections 7, 32)

**No production code path selects an AI model implicitly. Provider and model are resolved from
the organization's explicit AI configuration.**

### 4.1 The one regression found this phase

`apps/web/src/components/app/AiConnectionsManager.tsx` — `useState("gpt-5.6-luna")` pre-filled the
"Add AI connection" form's Model field. **Fixed** (Section 2.1). This was a **UI default**, one of
the eight forbidden categories listed in this phase's brief and in Phase 4's own audit — Phase 4's
grep-based audit did not catch it because it searched for the *string* everywhere, correctly
classified every other occurrence as an acceptable test fixture, but did not distinguish "used as
a placeholder/example" from "used as `useState`'s initial value" for this one file. This phase's
audit re-read every occurrence's *code context*, not just its presence, which is what caught it.

### 4.2 Every occurrence of `gpt-5.6-luna` in the repository (Section 32)

| Location | Classification | Why acceptable |
|---|---|---|
| `apps/web/e2e/ai-connections.spec.ts` (×4) | TEST | Arbitrary string typed into a form field to prove the UI round-trips whatever the customer types |
| `apps/web/src/app/api/ai-connections/route.test.ts`, `[id]/route.test.ts` | TEST | Arbitrary model string in a mocked `AiConnection` row |
| `apps/worker/src/aiPipeline.test.ts`, `resolveAiProvider.test.ts` | TEST | Arbitrary `AiConnectionConfig.model` in unit tests; one test (added Phase 4) specifically proves this string is NEVER a default |
| `apps/worker/src/resolveAiProvider.ts` (comment only) | DOCUMENTATION | Explains why the removed constant is gone - no executable reference |
| `packages/ai/src/pricing.ts`, `pricing.test.ts` | PRICING DATA / TEST | Proves an unpriced model correctly returns `costUsd: null`; doc comment explicitly states "NOT a product default" |
| `packages/ai/src/providers/openaiProvider.test.ts` (×11), `registry.test.ts` (×2) | TEST | Arbitrary model string in provider-adapter/registry unit tests |
| `packages/db/src/repositories/aiConnections.test.ts` (×10) | TEST | Arbitrary model value in test `AiConnection` rows |
| `PHASE3.1-VALIDATION.md` | HISTORICAL RECORD | Frozen prior-phase report, not current guidance |
| `PHASE4-VALIDATION.md` | HISTORICAL RECORD | Frozen prior-phase report documenting the Phase 4 regression fix |

**Zero** occurrences in a production execution path.

### 4.3 Every occurrence of `gpt-4o-mini`

| Location | Classification |
|---|---|
| `apps/worker/src/aiPipeline.test.ts`, `resolveAiProvider.test.ts` | TEST |
| `apps/web/src/app/api/ai-connections/test/route.test.ts`, `[id]/test/route.test.ts` | TEST |
| `apps/web/src/components/app/AiConnectionsManager.tsx` | UI PLACEHOLDER TEXT (one of three example models shown as grayed-out ghost text; never submitted unless the customer types it themselves - the field's actual value starts empty) |
| `packages/ai/src/pricing.ts`, `pricing.test.ts` | PRICING DATA (a real, published OpenAI price lookup entry - not a selector) |
| `packages/ai/src/testConnection.test.ts` | TEST |
| `packages/db/src/repositories/aiConnections.test.ts` | TEST |
| `DevRunbook.md` | DOCUMENTATION (an example value for the **dev-only** bootstrap env var, which the codebase requires to be set explicitly - never a fallback) |
| `PHASE3.1-VALIDATION.md`, `PHASE4-VALIDATION.md` | HISTORICAL RECORD |

**Zero** occurrences as a production default or fallback.

### 4.4 `DEFAULT_OPENAI_MODEL`

Zero matches anywhere in the repository. The constant was deleted in Phase 4 and never
reintroduced.

### 4.5 `CMA_AI_MODEL` / `CMA_AI_PROVIDER` / `OPENAI_API_KEY` — every place actually read

```
apps/worker/src/resolveAiProvider.ts        ← the ONLY production code path (dev/test bootstrap,
                                               gated by NODE_ENV !== "production")
apps/worker/src/resolveAiProvider.test.ts   ← test
apps/web/e2e/ai-openai-smoke.spec.ts        ← test (Phase 3.1's real-OpenAI Playwright suite)
apps/web/e2e/phase5-customer-journey.spec.ts← test (this phase's own real-AI Playwright spec -
                                               reads them only to FILL THE BROWSER FORM, never
                                               to configure the app itself)
scripts/validation/dailyReportE2E.mjs       ← test (Phase 4's own validation script)
```

No other file in `apps/worker`, `apps/web`, `packages/ai`, `packages/db`, or
`packages/notifications` reads any of these three variables. Live-verified: the Phase 5 customer
journey test asserts `AiAnalysis.model === REAL_MODEL` (the env value used only to type into the
browser form) and `AiAnalysis.model !== "gpt-5.6-luna"`, both passing against the real, running
system.

---

## 5. Security Audit (Section 33)

| Requirement | Status | Evidence |
|---|---|---|
| SSRF protection active for openai-compatible URLs | ✅ unchanged | `openaiCompatibleProvider.ts` still routes through `@cma/security`'s `safePostJson`; `testAiConnection` reuses the same provider, so the new "Test connection" feature is protected identically, not a new bypass |
| AI credentials encrypted at rest | ✅ unchanged | `encryptCredential`/`decryptCredential` (Phase 3.1) untouched |
| Browser cannot retrieve decrypted credentials | ✅ verified | `testConnection` route tests assert the JSON response never contains the key; `getDecryptedAiConnectionForOrg` is called only server-side and its result is never serialized back |
| Queue payloads contain no secrets | ✅ unchanged | `DailyReportJobPayload`/`AiAnalysisJobPayload`/`MonitoringJobPayload` carry only ids and dates |
| Logs contain no credentials | ✅ verified | No new `console.log`/`console.error` call in this phase's code references an apiKey or credential field |
| Report/email content contains no credentials | ✅ unchanged | `buildDailyReportEmail` (Phase 4) untouched |
| Tenant isolation on every new surface | ✅ verified | Repository + route tests for competitors, monitored URLs, AI-connection testing, organization settings, and usage — every one scoped by `organizationId`; see Section 6 |

---

## 6. Tests (Section 29, 34)

| Suite | Files | Tests |
|---|---|---|
| `packages/ai` | 10 | 76 (was 67; +9 `testConnection.test.ts`) |
| `packages/core` | 2 | 20 (unchanged) |
| `packages/db` | 9 | 85 (was 63; +6 `competitors.test.ts`, +10 `monitoredUrls.test.ts`, +6 `organizationSettings.test.ts`, +2 `aiConnections.test.ts` decrypt-for-test) |
| `packages/detection` | 1 | 13 (unchanged) |
| `packages/extraction` | 2 | 11 (unchanged) |
| `packages/notifications` | 2 | 9 (unchanged) |
| `packages/queue` | 3 | 10 (unchanged) |
| `packages/security` | 6 | 53 (unchanged) |
| `apps/worker` | 4 | 50 (unchanged - `resolveAiProvider.ts` change didn't need new test files, just assertions on existing ones) |
| `apps/web` | 12 | 59 (was 38; +7 `ai-connections/test` route tests, +3 `ai-connections/[id]/test` route tests, +7 competitor `[competitorId]` PATCH/DELETE, +6 monitored-url `[urlId]` PATCH/DELETE) |
| **Unit/integration total** | **51 files** | **386 tests, all passing** |

**Real-infrastructure validation (Section 34):**

- `npm run typecheck` — clean across all 10 workspaces.
- `npm run test` — 386/386 passing (real Postgres for every `packages/db` suite; skipped
  automatically, not silently ignored, only if Postgres is unreachable — it was reachable
  throughout this session).
- `npm run build` — clean production build, all 10 workspaces, all `/reports`, `/settings/*`
  routes compile.
- **Real Playwright E2E, real stack** (Postgres + Redis + BullMQ + `apps/worker` + Next.js dev
  server + Chromium, `apps/web/e2e/*.spec.ts`): **23/23 passing**, including the new
  `phase5-customer-journey.spec.ts` (real OpenAI call) and every pre-existing suite
  (`smoke`, `auth`, `ai-connections`, `ai-analysis`, `monitoring-workflow`, `competitor-workflow`,
  `evidence`, `tenant-isolation`). Two pre-existing specs (`evidence.spec.ts`,
  `ai-analysis.spec.ts`) needed a one-line locator fix each (`.first()` → `.last()`) because the
  new `/changes` filter `<select>` legitimately added competitor-name text to the page that a
  loose `getByText` matched ambiguously — a real, necessary, minimal fix caused by a real UI
  change, not a design flaw.
- `ai-openai-smoke.spec.ts` (Phase 3.1's own real-OpenAI suite) was **not** re-run this session to
  avoid a redundant paid call — `phase5-customer-journey.spec.ts` exercises the identical real
  path (and more) as part of this phase's own validation.
- Nothing was skipped silently: the only conditional skip anywhere is
  `phase5-customer-journey.spec.ts`'s own `test.skip(!OPENAI_API_KEY || !CMA_AI_MODEL, ...)`,
  which did **not** trigger this session (both were set) — documented here for a future run
  where they might not be.

---

## 7. Known Gaps (genuine, not padding)

1. **No production email provider.** `ConsoleEmailProvider` remains the only implementation. No
   real SMTP/API vendor credential was available this phase. The adapter interface, idempotent
   send-reservation, and failure isolation (all Phase 4) are unchanged and ready for a real
   adapter without touching report generation.
2. **No cross-competitor comparison, no change-frequency metric, no price-history chart.**
   Evaluated in the Product Depth Audit (Section 1.4) and deliberately deferred - the underlying
   `ChangeEvent` data supports simple versions of these without new tables, but building them now
   would mean inventing a first metric/UX without a validated customer need yet.
3. **No usage-based entitlement enforcement.** `/settings/usage` is read-only visibility; nothing
   in the codebase limits competitor count, URL count, frequency, or AI usage by plan. Enforcement
   points are documented (Section 2.5) for Phase 6+, but no code path checks them.
4. **`Organization.plan` exists but is decorative** (unchanged from Phase 1) - still no logic
   anywhere reads it to gate a feature.
5. **No dedicated onboarding wizard/progress tracker.** The first-run dashboard explainer plus the
   existing competitor/URL/AI-settings pages form a complete, honest funnel, but there is no
   "step 2 of 5" state machine. Adding one was judged lower-value than the CRUD/AI/usage work
   actually shipped, given Section 36's instruction to avoid a large redesign for its own sake.
6. **Frequency scheduling assumes the scheduler script itself runs periodically** (e.g. a cron
   calling `enqueueAll` every 15 minutes) - `listDueMonitoredUrls`'s due-check is only as accurate
   as how often that script actually runs; this phase does not add a process supervisor or
   guarantee the script's own cadence.

---

## 8. Final Verdict

**READY FOR PHASE 6**
