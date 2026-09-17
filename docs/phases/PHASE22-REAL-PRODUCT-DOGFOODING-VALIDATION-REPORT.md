# Phase 22 — Real Product Dogfooding & Customer-Value Validation

## STATUS

**C — CONCRETE PRODUCT PROBLEM FOUND AND FIXED**

Two concrete, customer-visible defects were found by actually using the product against real
public websites and fixed with targeted, tested changes. No fabricated data was used anywhere
in this report. Real long-term historical intelligence (sustained trends, repeated price
changes across weeks) could **not** be observed in a single session — that is stated honestly
in the Historical Intelligence section rather than simulated.

## OBJECTIVE

Use Competitor Monitor AI (CMA) the way a real customer would — real signup, real competitors,
real public websites, real scans, real UI — and fix concrete problems actually observed, not
theoretical ones. This is the seventh validation pass on this codebase (Phases 14B, 16, 18, 19,
20, 21 preceded it) but the first one that is not a code/architecture audit: it is a hands-on
usage session.

## REAL ENVIRONMENT

| Component | State |
|---|---|
| Postgres 5432 | Already running (native process, `.local-infra/`), verified via `netstat` before touching anything |
| Redis 6379 | Already running (native process), verified via `netstat` |
| `apps/web` | Started via `npm run --workspace apps/web dev` (Next.js, Turbopack), `http://localhost:3000` |
| `apps/worker` | Started via `npx tsx --env-file=.env src/index.ts` (BullMQ monitoring/AI/report/digest-interpretation workers) |
| `.env` | Pre-existing, real `OPENAI_API_KEY` / `CMA_AI_ENCRYPTION_KEY` / `CMA_AI_PROVIDER=openai` / `CMA_AI_MODEL=gpt-4o-mini`, `NODE_ENV=development`, `CMA_ALLOW_PRIVATE_TARGETS=true` (irrelevant here — no private/localhost targets were used) |
| `npm run db:migrate` | "Already in sync, no schema change or pending migration was found" |
| `npm run build` (root, pre-session) | Succeeded, confirming a clean baseline before any change |

**Infra friction encountered and resolved (documented for future dogfooding sessions, not a
product bug):** neither `apps/worker` nor Prisma CLI auto-load the repo-root `.env` — Next.js
does this itself for `apps/web` via `apps/web/.env.local`, but the worker process and bare
`prisma`/`node` invocations do not. Used Node 20+'s built-in `--env-file=` flag pointed directly
at the root `.env` rather than copying it into package directories. **One copy of `.env` was
briefly left in `apps/worker/` and `packages/db/` as a workaround; both were deleted before
finishing** — see "Test-Environment Contamination" under Concrete Problems Found. A stray,
pre-existing `dump.rdb` (Redis's own on-disk snapshot, written to the process's working
directory by the already-running native Redis instance, not created by anything in this
session) sits untracked at the repo root; left untouched since it predates this session and
isn't a Phase 22 artifact.

Two stale worker processes from earlier launch attempts (missing `DATABASE_URL`) were found
still running via `netstat`/`tasklist` after `kill` on their shell-reported PIDs didn't actually
stop them (Windows `npm run` spawns via `cmd.exe`, so the PID bash sees isn't always the PID
holding the port) and were killed with `taskkill /F` — a real observation about this
environment's dev-loop friction, not a CMA defect.

## DATA CLASSIFICATION

| Data | Classification |
|---|---|
| Organization "CMA Dogfood Phase22", its 4 competitors, 4 monitored URLs | **REAL** — created via the real signup UI and real Add-Competitor/Add-URL UI/API flows |
| Basecamp, Dropbox, Buffer, Namecheap page content and prices | **REAL** — live public production websites, fetched by the real crawler over the real internet, not fixtures |
| ChangeEvents, Snapshots, ExtractedEntities for this org | **REAL** — produced by real scans of the real sites above |
| AI interpretation output (per-change and digest-level) | **REAL** — actual billed OpenAI `gpt-4o-mini` calls, not the `fake` provider |
| The other ~437 organizations / ~400 competitors present in this dev database | **TEST_FIXTURE** — pre-existing E2E/Playwright fixture data from Phases 1–21, untouched, not used as evidence for any claim in this report |
| Any historical trend, sustained-activity, or repeated-price-change claim | **UNKNOWN / not observed** — no such pattern existed for the dogfood org in this session; see Historical Intelligence section. None is claimed as evidence of product value here. |

## REAL CUSTOMER WORKFLOW

1. **Signup** — real UI at `/signup`: organization "CMA Dogfood Phase22", a dedicated test
   email (`dogfood-phase22@cma-internal-test.com`), real password. Landed on `/dashboard`.
2. **Add competitors** — via the real "Add competitor" modal (Competitors page) and, for one
   (Buffer), via the same JSON API the UI itself calls (`POST /api/competitors`,
   `POST /api/competitors/{id}/urls`), exercised directly from the authenticated browser tab to
   confirm the API contract matches what a real integration would see.
3. **Real competitors and URLs added** (all reachable without login/CAPTCHA/paywall, chosen
   for visible, changeable commercial content):
   - **Basecamp** — `https://basecamp.com/pricing` (SaaS pricing page)
   - **Dropbox** — `https://www.dropbox.com/plans` (SaaS pricing page)
   - **Buffer** — `https://buffer.com/pricing` (SaaS pricing page)
   - **Namecheap** — `https://www.namecheap.com/hosting/shared/` (ecommerce/hosting pricing) —
     **kept as a documented real-world limitation**, see below; not silently dropped.
4. **Real scans** — triggered via the real `POST /api/monitored-urls/{id}/scan` endpoint (the
   same one the UI's scan button calls), consumed by the real `apps/worker` BullMQ monitoring
   worker, which really fetched each URL over the internet.
5. **Real UI inspection** — Dashboard, Competitors list, Competitor detail (Activity, Products
   & plans, Pricing, Patterns), Digest (7d/30d/90d), an individual Change detail page (raw
   snapshot comparison + evidence), and both AI-interpretation entry points (per-change
   "Analyze this change" and digest-level "Interpret this digest") — all driven via the Chrome
   browser MCP as a real user would click through them, not by querying the database directly.

## REAL OBSERVATIONS

### Monitoring / crawl outcomes

| Target | Outcome | Detail |
|---|---|---|
| Basecamp `/pricing` | **Success** | HTTP 200, 12.3 KB normalized text, 6 prices extracted via generic regex ($25, $59, $99, $299, $300, $100) — matches Basecamp's real published tiers |
| Dropbox `/plans` | **Success**, but produced a false-signal entity (fixed, see below) | HTTP 200; JSON-LD extraction picked up a `$0` price from unrelated SEO schema markup |
| Buffer `/pricing` | **Success** | HTTP 200, 4 prices extracted ($5, $60/yr, $10, $120/yr) — matches Buffer's real published tiers |
| Namecheap `/hosting/shared/` | **Failed cleanly** | `Unexpected HTTP status 403` — Namecheap's edge is blocking the crawler's request. Per the hard constraints, no attempt was made to bypass this (no header spoofing, no CAPTCHA solving). The product's own behavior here is correct: it recorded a clean `FAILED` `MonitoringJob` with the real HTTP status as the error message, did **not** fabricate a snapshot, and the competitor detail page for Namecheap correctly shows "Not scanned" rather than any invented data. This is an honest real-world limitation of Tier-1 HTTP+Cheerio extraction against sites with bot-detection edges, not a CMA bug — flagged here as a known limitation, not fixed (fixing it would mean adding browser-fingerprint evasion, out of scope and arguably against the spirit of "don't bypass WAFs"). |

### Evidence quality (Basecamp / Buffer — the two clean successes)

The Change detail page (`/changes/{id}`) is genuinely well designed for evidence transparency:
it shows the previous and current snapshot's raw extracted page text side by side, states
explicitly "This is evidence, not an inference," and separates the deterministic
previous/current/percentage-change values from any AI content. Confidence, extraction method,
and fetch timestamps are all shown per snapshot. This matches the product's stated design intent
well and is a genuine strength, not just marketing copy — verified by reading the actual
rendered evidence, not by reading the source code's doc comments.

One minor, **not fixed** observation on evidence *label* quality: the generic (non-JSON-LD)
price extractor's `label` field is a raw 25-characters-before / 10-characters-after character
slice around the matched price (e.g. `"min features Freelancer, $25/mo Get or"`), which is
truthful evidence but reads as a mid-sentence text fragment rather than a clean label. This is
cosmetic, not a correctness issue (the underlying price/currency values are extracted
correctly), and changing the context-window heuristic risks behavior changes across every other
page already relying on it — flagged as a **known limitation**, not touched, consistent with
"prefer the smallest fix" and staying within the observed-defect boundary.

## CONCRETE PROBLEMS FOUND

### Problem 1 — JSON-LD extractor captured an unrelated SEO schema field as a tracked price (FIXED)

**Observation:** Scanning `https://www.dropbox.com/plans` produced exactly one
`ExtractedEntity`: `{ type: PRICE, key: "jsonld:dropbox", label: "Dropbox", value: "0", currency:
"USD" }`. Dropbox's real plans start at $9.99/mo — there is no $0 plan on that page.

**Reproduction:** The page embeds a `schema.org/SoftwareApplication` JSON-LD block (a common
app-store/rich-snippet SEO pattern, unrelated to the visible paid plans):
```json
{"@type":"SoftwareApplication","name":"Dropbox","offers":{"category":"free","price":0,"priceCurrency":"USD"}}
```
`collectProductLikeEntities` in `packages/extraction/src/structuredData.ts` accepted **any**
JSON-LD node that had a `name`, regardless of `@type` (`type === "Product" || type === "Offer"
|| name`), so this generic "the app is free to download" marker was captured as if it were a
real, trackable plan price.

**Customer impact:** Materialized live in this same session — see Problem 2. Once the bogus
entity stopped being extracted (correctly), the detector produced a `PRODUCT_REMOVED`
ChangeEvent ("Product/plan no longer detected on page: Dropbox (was 0 USD)"), which would render
in the customer's Digest as "Dropbox — Product removed" with zero indication that "the product"
was never a real plan. This is precisely the false-positive class the phase was scoped to hunt
for.

**Root cause:** `packages/extraction/src/structuredData.ts`, `collectProductLikeEntities` — the
`|| name` fallback let any schema.org node type through as long as it had a name and an
`offers` sub-object, including types with no commercial meaning (`SoftwareApplication`,
`Organization`, etc.).

**Fix:** Restrict capture to schema.org types that genuinely represent something for sale
(`Product`, `Offer`, `Service`); drop the generic `name`-only fallback.
`packages/extraction/src/structuredData.ts`.

**Tests added:** `packages/extraction/src/structuredData.test.ts` (new file, 6 tests) —
reproduces the exact Dropbox `SoftwareApplication`/`category: "free"` case, confirms
`Product`/`Offer`/`Service` are still captured, confirms `Organization` nodes are ignored,
confirms the `@graph` recursion path applies the same filter, confirms malformed JSON-LD still
degrades gracefully. `packages/extraction` full suite: **17/17 pass**.

### Problem 2 — Digest rendered a single ChangeEvent as two duplicate cards (FIXED)

**Observation:** After Problem 1's fix (and thus after Dropbox's bogus `$0` entity correctly
stopped appearing, which the detector — correctly, given its inputs — reported as one
`PRODUCT_REMOVED` `ChangeEvent`), the real `/digest` page rendered **two** cards for it:
1. `Dropbox — Product removed — Medium — "An item is no longer listed (was USD0)"`
2. `Dropbox — Product lifecycle — "Removed 1 product"`

Both cards carried the identical timestamp and, on inspection of their `href`s, **linked to the
exact same `ChangeEvent` id** (`cmu5fognw000dmekect0go1xc`) — confirmed by reading the DOM's
`href` attributes for both "View evidence →" links.

**Root cause:** `getDigestForOrganization` in `packages/db/src/repositories/intelligence.ts`
deliberately (per its existing doc comments) emits a `LIFECYCLE` roll-up item alongside every
raw `PRODUCT_ADDED`/`PRODUCT_REMOVED` `CHANGE_EVENT` item whenever the window has *any*
add/remove activity — a genuinely useful design when there are several such events (e.g. "Added
2 products · Removed 1 product" saves the reader from tallying 3 separate raw lines). But with
exactly one add/remove event, the roll-up restates the single raw item verbatim with no new
information, just different wording, and the same evidence link.

**Customer impact:** A customer reading the Digest sees what looks like two separate pieces of
activity for the same competitor at the same moment, when there is only one real fact. This is
exactly the "noise/repetition" failure mode the phase brief asked to evaluate for, and directly
contradicts the Digest's own stated design goal ("purely descriptive... no importance score" —
implicitly, no double-counting either).

**Fix:** Gate the `LIFECYCLE` roll-up item on `addedEvents.length + removedEvents.length > 1` —
i.e. only emit it when it is actually aggregating more than one underlying event.
`packages/db/src/repositories/intelligence.ts`.

**Tests added:** `packages/db/src/repositories/intelligence.test.ts` — one new test asserting no
`LIFECYCLE` item is emitted for a single `PRODUCT_REMOVED` event (and that the single event is
still fully represented via its own `CHANGE_EVENT` item). The pre-existing test covering the
multi-event roll-up case (2 added + 1 removed = 3 total) was left unchanged and continues to
pass, confirming the roll-up still fires when it adds real value. `packages/db` full suite
(including the real-Postgres `tenantIsolation.test.ts`): **211/211 pass**.

**Verified live, not just in tests:** re-ran `/digest` in the browser against the same
already-existing `ChangeEvent` after restarting the worker/web with the fix — the duplicate
"Product lifecycle" card disappeared; the single "Product removed" card with its evidence link
remained, screenshot-confirmed.

### Test-Environment Contamination (self-caused, fixed before finishing)

While getting `apps/worker` running locally (it has no `.env` loader of its own — see Real
Environment above), a copy of the root `.env` was placed in `apps/worker/` and `packages/db/` as
a workaround. Running the full root `npm test` afterward caused one real, reproducible failure:
`apps/worker/src/resolveAiProvider.test.ts`'s "fails cleanly with `NoAiProviderConfiguredError`
when nothing is configured at all" test started **resolving a real provider instead of
rejecting**, because Vitest auto-loads a package-local `.env` and the copied file's real
`OPENAI_API_KEY`/`CMA_AI_PROVIDER` leaked into that specific "nothing configured" test scenario.
This was **not a product bug** — deleting the two stray `.env` copies and re-running
immediately restored a clean `apps/worker` suite (60/60). Documented here in full rather than
silently cleaned up, per the Boy Scout Rule, and because it is a legitimate DevRunbook gap worth
knowing about: neither `apps/worker` nor bare Prisma CLI invocations load `.env` automatically
on this stack, unlike `apps/web` (Next.js does this itself). No `.env` copies remain in the
tree — `git status --short` confirms.

### API response-shape note (observed, not a defect)

`POST /api/competitors` and `POST /api/competitors/{id}/urls` both wrap their created resource
in an envelope (`{ "competitor": {...} }` / `{ "monitoredUrl": {...} }`) rather than returning
the resource directly. This tripped up an ad-hoc API call made during this session (using
`comp.id` instead of `comp.competitor.id`), but it is a consistent convention across both
endpoints and the real UI clearly already unwraps it correctly (competitor creation via the UI
worked without issue) — not a defect, just noted as an API-contract detail worth documenting for
future direct integrators.

## PRODUCT VALUE OBSERVATIONS

- **Setup-to-first-scan friction is low.** Signup → add competitor → add URL → scan took under
  a minute per competitor through the real UI, with clear in-product guidance ("Add a
  competitor and one of their pages... Run a scan... The next scan compares against that
  baseline...").
- **Evidence-first design holds up under real use.** The Change detail page's raw
  previous/current snapshot text side-by-side, with an explicit "not an inference" framing, is a
  genuine, verifiable strength — not just something claimed in prior audits' code reading.
- **Failure handling is honest.** Namecheap's 403 was recorded as a clean failure with the real
  HTTP status, not silently swallowed or faked into a false "no change" result.
- **Real AI interpretation is evidence-grounded but still speculates in its "interpretation"
  half.** See below — a genuine, generalizable observation, not fixed (explicitly out of scope
  per this phase's hard constraints: "do not redesign prompts/safety architecture").
- **The Dropbox false positive, once produced, is legible rather than opaque.** Even before any
  fix, the evidence page showed the two snapshots' visible text as near-identical, which — for a
  careful reader — is itself a signal that "Product removed" here doesn't correspond to any
  visible page change. This doesn't excuse the false positive (most customers won't diff the raw
  text by eye), but it means the product isn't hiding the discrepancy.

### AI interpretation — real observation, not fixed

Both AI interpretation surfaces were exercised with the real OpenAI provider (`gpt-4o-mini`,
confirmed via the "Generated by openai (gpt-4o-mini) · N tokens · Ns" footer on both the
per-change and digest-level panels — real billed calls, not the `fake` dev provider):

- **Per-change interpretation** (`/changes/{id}` → "Analyze this change"): FACTS section
  correctly restated only what the ChangeEvent actually said (`"item 'dropbox' no longer
  detected"`, `"last known value... was 0"`) — no fabricated numbers. The INTERPRETATION section,
  however, speculated about competitor *intent/strategy* ("could signify a strategic shift in
  product offerings", "an attempt to simplify the product lineup or focus on more profitable
  services") for what was, in fact, a page-schema extraction artifact with zero real signal.
- **Digest-level interpretation** ("Interpret this digest"): noticeably better-hedged —
  `"may indicate a shift in its product lineup"` — and both its OBSERVATION and INTERPRETATION
  bullets each carry their own "View evidence →" link resolving to the correct, real
  ChangeEvent id. Evidence-ID correspondence holds up correctly.

This is reported as an observation, per the explicit instruction to observe grounding/evidence
correspondence without redesigning the AI prompt/safety architecture. It is also a second-order
confirmation of Problem 1's impact: a noisy raw signal produces confident-sounding causal
language downstream, which is one more reason the extraction-layer fix in Problem 1 matters
beyond the Digest itself.

## HISTORICAL INTELLIGENCE

**Stated honestly: no real multi-day or multi-week history exists for the dogfood org.** This
session spans roughly 20 minutes of wall-clock monitoring activity against real websites. The
dogfood org's Competitor detail pages correctly show "This competitor has not been monitored
long enough yet to establish a reliable historical baseline" and "No product or plan has had 2
or more price changes in the selected period" — both true statements, both what a genuinely
new, honest customer would see on day one. The cross-competitor context strip on `/digest`
correctly reports "0 of 4 tracked competitors are currently above their own historical baseline"
and "0 of 4... show a sustained activity pattern" — again, accurate for a brand-new org, not
fabricated to look more mature.

No attempt was made to backdate ChangeEvents, seed synthetic history, or otherwise simulate
weeks of monitoring to test the sustained-trend/repeated-price-change features documented in
Phases 16/18/20 — that would have violated the explicit "no fabricated events, no backdated
timestamps" constraint. Those features remain validated only by the earlier phases' own test
suites and synthetic-fixture validation reports, not by this session's real data. **This is a
real limitation of the "dogfood in one sitting" approach, not evidence the features don't
work.**

## CHANGES IMPLEMENTED

| File | Change | Why |
|---|---|---|
| `packages/extraction/src/structuredData.ts` | JSON-LD price capture restricted to `Product`/`Offer`/`Service` schema.org types | Problem 1 |
| `packages/extraction/src/structuredData.test.ts` | New file, 6 tests | Locks in Problem 1's fix |
| `packages/db/src/repositories/intelligence.ts` | `LIFECYCLE` digest roll-up item gated on `> 1` underlying event | Problem 2 |
| `packages/db/src/repositories/intelligence.test.ts` | 1 new test (single-event no-roll-up case) | Locks in Problem 2's fix |

No other production files were changed. No schema migrations. No new dependencies. No feature
additions (no scoring, ranking, threat levels, forecasts, sentiment, or any of the explicitly
prohibited speculative additions).

## TESTS

| Suite | Result |
|---|---|
| `packages/extraction` (`npm test --workspace packages/extraction`) | **17/17 pass** |
| `packages/db` (`npm test --workspace packages/db`, real Postgres) | **211/211 pass**, including real `tenantIsolation.test.ts` (10/10, not skipped) |
| `apps/worker` (`npm test --workspace apps/worker`) | **60/60 pass** (after removing the self-caused `.env` contamination — see above) |
| `apps/web` (`npm test --workspace apps/web`) | **68/68 pass** |
| Root `npm test` (all 12 workspaces) | All pass |
| Root `npm run typecheck` (all 10 workspaces) | 9/10 clean; `packages/db` reports a Windows-only `EPERM` renaming the Prisma native binary because `apps/worker` was running and holding it open at the time — a pre-documented DevRunbook §10 issue, not a real type error. Confirmed clean separately via `npx tsc -p packages/db/tsconfig.json --noEmit` (exit 0) with the dev server briefly stopped. |
| `npm run build --workspace apps/web --workspace apps/worker --workspace packages/extraction` | Succeeds |

## TENANT ISOLATION

Verified two ways:
1. **Automated:** `packages/db`'s real-Postgres `tenantIsolation.test.ts` suite — 10/10 pass.
2. **Manual, with real data:** the dogfood organization (`cmu5f7zhi0001a9rl4wyg34h6`) has exactly
   4 competitors; a direct query confirms 400 competitors exist across all *other* organizations
   in this shared dev database and were never visible anywhere in the dogfood org's UI
   (Competitors list, Dashboard, Digest) throughout this session.

## PERFORMANCE

Not a focus of this session (no load/perf testing performed — out of scope for a 3-competitor
dogfooding pass). One incidental observation: an errant `npx tsx src/enqueueAll.ts` invocation
made early in this session (before the worker had valid `DATABASE_URL`) queued monitoring jobs
for the full ~400-URL historical E2E fixture backlog across all orgs, all of which correctly
failed fast (`FAILED_TO_VERIFY`, since those fixture URLs point at long-gone local test servers)
in well under a minute once a properly-configured worker picked them up — not a performance
concern, but it did transiently delay the two real on-demand scans queued right after it (they
sat `PENDING` behind the backlog for under a minute). This is an artifact of the ad-hoc
dogfooding session's ordering, not a scheduling defect in the product itself (in real operation,
`enqueueAll` runs once a day via cron, not concurrently with a customer's own on-demand scan
button).

## MOBILE

Attempted a 375×812 viewport resize via the Chrome MCP's `resize_window` tool; the tool resized
the OS-level browser window but did not reliably force a narrow-viewport render in the captured
screenshot (still rendered at desktop width), so mobile-viewport rendering could **not** be
conclusively verified live in this session with the tools available. This is a tooling
limitation of this session, not a claim that the product is or isn't responsive — left as an
open item rather than asserting either outcome without evidence.

## KNOWN LIMITATIONS

- Namecheap (and, by extension, any site behind similar bot-detection) cannot be monitored by
  the current Tier-1 HTTP+Cheerio extractor without a JS-rendering tier or more sophisticated
  request fingerprinting — neither attempted, per the hard constraints.
- The generic (non-JSON-LD) price extractor's evidence `label` is a raw character-window slice,
  which is truthful but not always readable as a clean plan name — cosmetic, not fixed.
- The AI per-change interpretation's "INTERPRETATION" section can produce competitor-intent/
  strategy speculation language even when clearly labeled as interpretation-not-evidence and
  even when the underlying signal is itself noise (as it was here) — observed, not
  redesigned, per explicit scope.
- No real multi-day/multi-week history exists to validate sustained-trend or repeated-price-
  change detection against real data; those remain validated only by earlier phases' synthetic
  fixtures.
- Mobile viewport rendering was not conclusively verified live this session (tooling
  limitation).

## FINAL PRODUCT STATE

The dogfood organization "CMA Dogfood Phase22" remains in the shared dev database with its 4
real competitors, real scans, and the one real (now correctly-explained) ChangeEvent, left
uncommitted/unremoved for inspection. All three code changes are staged as uncommitted working-
tree changes, as instructed, for review — `git status --short` shows exactly the two modified
production files, their two corresponding test files, and the pre-existing unrelated `dump.rdb`.

## RECOMMENDATION

Both fixes found in this session are narrow, real, and already implemented and tested — no
further action needed on them. Beyond that, the honest next step is **not** a new feature
roadmap: it is running this same dogfood organization's monitored URLs on a recurring schedule
(daily `enqueueAll` + a few days of real wall-clock time) so that the sustained-activity and
repeated-price-change intelligence layers validated synthetically in Phases 16/18/20 can be
re-validated against this session's real competitors with real accumulated history, rather than
E2E fixtures. Keep collecting real history before drawing further product-value conclusions.
