# Phase 24 — Deterministic Promotion Coverage

**Date:** 2026-09-18

## 1. STATUS

**PASS WITH FINDINGS**

A second, independent promotion source — bounded, deterministic HTML pattern matching — is
implemented, unit-tested, typecheck-clean, and build-clean, and closes the exact coverage gap
Phase 23 identified: on three real, live, currently-monitored-shape competitor pages
(Hostinger, ExpressVPN, Mailchimp), a visible "X% off"/"Save X%" promotion is now captured with
usable evidence and correct per-plan association, where the existing JSON-LD-only extractor
produces zero or an unrelated promotion signal. The findings are the same class as Phase 23's:
(1) DB-touching tests could not be executed against a live Postgres in this session (infra
unreachable — unchanged from Phase 23, no new DB code was added); (2) coverage is still real but
narrow — of seven real pages sampled, three produced a genuine HTML promotion signal, three
produced none (either no promotion existed, or the page is a client-rendered SPA shell HTML
extraction cannot see into), and false-positive testing surfaced one real, concrete false-positive
pattern (a bundled permanent feature phrased "{feature} - free for 1 year") that was found and
fixed during this phase's own dogfooding, not merely anticipated.

## 2. WHY THIS PHASE EXISTS

Phase 23's own Section 13/14 stated the concrete problem this phase addresses: JSON-LD-only
promotion extraction found a qualifying signal on only 1 of 5 real dogfooded competitor pages, and
that one signal was a `priceValidUntil` date, not the `discount`/"20%-off" case the product actually
cares about. Phase 23's recommendation was explicit: *"extending Tier 3 extraction to a bounded,
deterministic set of common promotional HTML patterns... would need its own careful
false-positive-avoidance design... before being trusted as evidence"* — that is exactly this
phase's scope, and nothing more.

## 3. REAL HTML PATTERNS OBSERVED

Fetched live (this session, `curl` with a real browser User-Agent) and inspected directly — not
hypothetical:

- **Hostinger** (`/web-hosting`) — a discount **badge** (`class="...h-pricing-card__discount-tag"`)
  containing exactly `"75% off"` / `"79% off"` / `"71% off"`, sitting inside a per-plan
  `h-pricing-card__container` alongside the plan's title (`"Premium"`/`"Unlimited"`/
  `"Cloud Startup"`), struck-through old price, and current price (`$11.99` → `$2.99`).
- **ExpressVPN** (`/order`) — a **badge with generic, non-semantic classes**
  (`class="bg-leaf-bg rounded-full ..."`, no "discount"/"promo" in the class name at all)
  containing `"Save 80%"` / `"Save 76%"` / `"Save 73%"`, next to a plan heading (`<h3>Basic</h3>`),
  a duration label (`"2 Years + 4 Months"`), and old/new prices (`$419.72` → `$83.72`). This was the
  key real finding motivating a **structural proximity gate** (price-in-ancestor-scope) rather than
  a class-name gate: real badges are not reliably named `discount`/`promo` in `class`.
- **Mailchimp** (`/pricing/marketing/`) — the promo text is embedded directly **inside a heading**
  (`<h2>Try our Standard plan for <em>50% off</em>!</h2>`), split across the `<h2>` and a nested
  `<em>`, requiring own-text matching on the innermost element (`<em>`) rather than the whole
  heading. Separately, a comparison-table heading elsewhere on the page cleanly names the plan
  (`"Standard"`, `"Premium"`).
- **Hostinger, false-positive pattern found live**: `"Domain - free for 1 year"` and
  `"AI email marketing - free for 1 year"` inside the plan's bundled features list — a *permanent*,
  standard-issue perk on every plan, not a promotion, reliably marked by a `" - "` (space-dash-space)
  separator before the phrase (see Section 6).
- **Audible**: `"30% discount on purchases"` exists in the raw HTML **only inside a
  `FAQPage`/`Question`/`Answer` JSON-LD block** (a benefits bullet list, HTML-encoded inside the
  JSON string) — it never appears in the rendered/visible DOM at all. Confirmed by running
  `extractVisibleText` against the real page: the phrase is absent from the visible-text output.
- **Squarespace / Grammarly**: `"save up to 36%"` / `"Save up to 60%"` exist in visible text but as
  a **billing-toggle label** ("Pay annually to save up to X%") not tied to one specific plan card —
  no price sits in its bounded ancestor scope; the actual per-plan prices are in a sibling section.
- **Canva**: correctly detected as a JS-shell page (`extractVisibleText` returns 0 characters) — a
  `"Get 50% off*"` string exists only inside an inline Next.js JSON data blob in a `<script>` tag,
  never in the rendered DOM Cheerio can see.

## 4. IMPLEMENTATION

**New module** (`packages/extraction/src/htmlPromotions.ts`), wired into `CheerioExtractor`
alongside (never instead of) JSON-LD extraction:

- **Candidate detection**: scans a bounded selector list (`h1–h6, span, div, p, li, strong, em, b,
  a, button, label`) for elements with ≤2 element children and ≤80 characters of own text, matching
  one of four fixed, deterministic patterns: `\d{1,3}%\s*(off|discount)` / `save (up to )?\d{1,3}%`
  → **percentOff**; `{N} {day|week|month|year}(s) free` / `free for {N} ...` / `first {unit} free`
  → **freeDuration** (normalized to schema.org UN/CEFACT unit codes `DAY`/`WEE`/`MON`/`ANN`, the
  same convention Phase 23's `eligibleDuration` normalization already uses); `use code {CODE}` →
  **discountCode**; `save [€$£]{amount}` → **saveAmount**. Innermost-match deduplication removes an
  outer element's match when an inner one already matched the same phrase.
- **Contextual gating (structural, not class-name-based)**: for each candidate, ancestors are
  climbed up to 8 levels, tracking the **largest ancestor whose text stays ≤900 characters and
  contains a price pattern** (the same currency-symbol regex `extractGenericPriceEntities` already
  uses). No price within the climb/size bound → the candidate is **discarded**, never emitted. This
  is the single most important false-positive control in the module — it is what correctly excludes
  ExpressVPN's unrelated hero headline ("Get up to 80% off", no price nearby) and Squarespace's
  billing-toggle label, while still capturing badges with completely generic, non-"discount"-named
  CSS classes (ExpressVPN's real badge).
- **Identity/association**: within the resolved commercial container, the first short (`≤60` char)
  heading (`h1`–`h6`) or class-name-flagged (`title`/`plan-name`/`product-name`) element is used as
  the plan/product label, keyed as `html-promo:{label}`. **A label is rejected if it contains the
  matched promotional text itself** (found and fixed during this phase's own testing on the
  Mailchimp shape — see Section 6) to avoid coupling the entity's identity to its own value, which
  would silently break `PROMOTION_CHANGE` detection the same way Phase 23 warned against for
  content-hash keys. No resolvable label → **no entity is fabricated**.
- **Normalization/composition**: multiple signals resolved to the same plan label compose into one
  deterministic, field-sorted `field=value; field=value` string, exactly mirroring
  `extractJsonLdEntities`'s `extractPromotionSignal` composition so both sources produce values in
  the same shape.
- **Evidence**: `raw` is a bounded JSON blob — the exact matched phrase(s) plus a ≤300-character
  excerpt of the container's visible text — never the page's full HTML.
- **JSON-LD deduplication** (`mergeHtmlPromotionsWithJsonLd`): the ONLY equivalence this function
  asserts is narrow and mechanical — same plan label AND a JSON-LD `discount=N` field whose bare
  number exactly equals an HTML `percentOff=N` value. Anything less exact (a `priceValidUntil` date
  vs. a percent-off badge — the real Hostinger case) is deliberately kept as two distinct entities;
  Section 6/7 of the brief explicitly forbid inventing semantic equivalence beyond what's mechanical.

## 5. DETECTION

No changes to `packages/detection/src/compare.ts`. `detectPromotionChanges` /
`detectPromotionAddedOrRemoved` (Phase 23) are already generic over any `PROMOTION`-typed
`ExtractedEntity` regardless of source — HTML-derived promotions flow through the identical byKey
diff, produce identical `PROMOTION_ADDED`/`PROMOTION_CHANGE`/`PROMOTION_REMOVED` drafts, and inherit
the same `FAILED_TO_VERIFY` short-circuit (a fetch failure never produces a promotion event) for
free. Verified by re-running the full `packages/detection` suite unmodified (19/19 passing) and by
tracing the real Hostinger/ExpressVPN entities through `compareSnapshots` manually (see Section 7).

## 6. FALSE POSITIVES

**Found live, fixed in this phase (not hypothetical):**
- `"Domain - free for 1 year"` / `"AI email marketing - free for 1 year"` (Hostinger's bundled
  features list) — initially matched the free-duration pattern (since it sits inside the same
  price-bearing pricing card). Fixed by rejecting a free-duration match when the candidate text
  contains a `" - "` separator, the reliable real-world marker of a "{feature name} - {qualifier}"
  line item rather than a promotional headline.
- A label that embeds the matched promo phrase itself (Mailchimp's `<h2>` shape) — initially
  produced an entity keyed on the full sentence (`html-promo:try our standard plan for 50% off!`),
  which would silently misreport every future discount-value change as REMOVED+ADDED. Fixed by
  rejecting any label candidate whose own text contains the matched phrase.

**Tested and confirmed correctly excluded** (real text, real or realistic-synthetic containers):
- `"100% satisfied"` (Hostinger's guarantee copy) — no `off`/`discount`/`save` keyword attached.
- `"141% more revenue"` / `"58% Higher Click Rate"` / `"(266%)"` (Mailchimp's marketing stats).
- `"30% discount on purchases"` (Audible) — never reaches the extractor at all; it lives only
  inside a JSON-LD `FAQPage` answer string, not visible DOM (see Section 3).
- `"free account"` / `"free support"` / `"free shipping"` mentions with no numeric pattern attached.
- A promotional phrase with no price in structural proximity (ExpressVPN's hero headline;
  Squarespace's/Grammarly's billing-toggle "save up to X%" label).
- Transaction-fee/APR-style percentages (Squarespace's `2%`/`0.15%` fee table) — no promo keyword.
- Malformed/unclosed HTML and a fully empty document — both return `[]`, no throw.

## 7. REAL-WORLD VALIDATION

Ran the actual compiled code (`packages/extraction/dist/htmlPromotions.js` +
`extractJsonLdEntities`), not a mock, against real HTML fetched live in this session
(`curl` with a standard desktop Chrome User-Agent; the four sites that 403'd without one — GoDaddy,
Namecheap, NordVPN — are pre-existing, documented bot-detection limitations, unchanged from Phase
23/not evidence of anything new):

| URL | HTTP | JSON-LD promotion | HTML promotion | Detected | Evidence | Notes |
|---|---:|---:|---:|---:|---|---|
| `hostinger.com/web-hosting` | 200 | `priceValidUntil=2027-09-17` (Web hosting) | `percentOff=75` (Premium), `percentOff=79` (Unlimited), `percentOff=71` (Cloud Startup) | Yes — 3 distinct HTML entities, correctly per-plan | `"75% off"` badge text + bounded container excerpt | Different fact than the JSON-LD signal (date vs. percentage) → kept as 4 distinct promotion entities total, not merged |
| `expressvpn.com/order` | 200 | none | `percentOff=80` (Basic), `percentOff=76` (Advanced), `percentOff=73` (Express Pro) | Yes — 3 distinct entities | `"Save 80%"` etc. + container excerpt | **Zero JSON-LD entities on this page at all** — this is the clean "JSON-LD misses it entirely, HTML catches it" proof point |
| `mailchimp.com/pricing/marketing/` | 200 | none | `percentOff=50` (Standard), `percentOff=50` (Premium) | Yes — 2 distinct entities | `"50% off"` + container excerpt | Same result |
| `audible.com` | 200 | none | none | No (correctly) | — | The one live `%` mention is inside JSON-LD script text, never visible DOM |
| `squarespace.com/pricing` | 200 | none | none | No (correctly) | — | "save up to 36%" is a billing-toggle label with no plan-scoped price nearby |
| `canva.com/pricing/` | 200 | none | none | No (correctly) | — | JS-shell page; `looksLikeJsShell` already flags this, confirmed 0 visible-text length |
| `grammarly.com/premium` | 200 | none | none | No (correctly) | — | "Save up to 60%" is a billing-toggle label, same shape as Squarespace |

**Controlled comparison** (real extracted Hostinger data, `compareSnapshots` run against two
snapshots to demonstrate the change-detection path — not a synthetic fixture, the real Premium-plan
entity from the table above):

- Snapshot A: `{ key: "html-promo:premium", value: "percentOff=75" }`
- Snapshot B (simulated next scan, badge updated to 60% off): `{ key: "html-promo:premium",
  value: "percentOff=60" }`
- Result: `verificationState: CHANGED`, one `PROMOTION_CHANGE` event, `oldValue: "percentOff=75"`,
  `newValue: "percentOff=60"` — exactly the `discountPercentage` product-facing story the Phase 24
  brief's motivating example describes, now backed by a real page shape.

## 8. TEST EVIDENCE

Commands run from the repo root (`C:\Proyectos\Competitor Monitor AI`):

```bash
npm run typecheck   # exit 0
npm run test        # exit 0
npm run build        # exit 0
```

**typecheck**: all 9 workspaces clean, 0 errors.

**test** (aggregated across all workspaces):

| Scope | Result |
|---|---|
| `apps/web` | 68 passed |
| `apps/worker` | 60 passed |
| `packages/ai` | 124 passed |
| `packages/core` | 35 passed |
| `packages/db` | **215 skipped** (Postgres unreachable — unchanged from Phase 23, no new DB code) |
| `packages/detection` | 19 passed (unmodified — no detection code changed this phase) |
| `packages/extraction` | **46 passed** (24 pre-existing + **22 new** `htmlPromotions.test.ts` cases) |
| `packages/notifications` | 9 passed |
| `packages/queue` | 7 passed, 3 skipped (Redis unreachable) |
| `packages/security` | 53 passed |
| **Total** | **421 passed, 0 failed, 218 skipped** |

**Probed infra before claiming "unreachable"** (same convention as Phase 23):
`Test-NetConnection 127.0.0.1:5432` → unreachable, `Test-NetConnection 127.0.0.1:6379` → unreachable
(the `enqueueAllJobId.realRedis.test.ts` stderr confirms `ECONNREFUSED 127.0.0.1:6379` in the actual
test run). No Docker/local Postgres/Redis binaries available in this session. Since this phase adds
zero new Prisma queries and zero new schema (Section 10/11), the DB-layer risk here is strictly
narrower than Phase 23's — the untested paths are 100% pre-existing, already-covered-elsewhere code.

**E2E (Playwright)**: not run — same infra gap, and no E2E spec asserts on promotion display
(unchanged from Phase 23, confirmed by `grep`).

## 9. PERFORMANCE

Measured directly (Node `performance.now()`, actual compiled code, real downloaded HTML):

| Page | Size | JSON-LD + HTML promotion extraction time |
|---|---:|---:|
| Hostinger | 896 KB | 14.0 ms |
| ExpressVPN | 668 KB | 8.0 ms |
| Mailchimp | 520 KB | 26.9 ms |
| Squarespace | 708 KB | 16.4 ms |
| Audible | 405 KB | 11.0 ms |
| Grammarly | 410 KB | 6.8 ms |
| Canva | 132 KB | 0.4 ms |

No new database query path, no new network request, no per-candidate query — the whole module is a
single bounded in-memory DOM pass reusing the already-parsed Cheerio tree from `extractVisibleText`.
Candidate selection is restricted to leaf-ish elements (≤2 children, ≤80 chars own text), keeping
cost near-linear in the DOM's text-bearing node count rather than O(n²) over nested wrapper divs;
the innermost-match dedup and ancestor climb are both bounded (climb ≤8 levels, container ≤900
chars), so worst case is a small constant multiple of the candidate count, not proportional to page
size. All measurements above are well under 30ms even on the largest real page tested.

## 10. TENANT ISOLATION

No new query path, no new API route, no new `organizationId`-scoping logic — HTML-derived
`PROMOTION` entities are just more rows in the same generic `ExtractedEntity[]`/`ChangeEventDraft[]`
arrays that `persistMonitoringResult` already writes through the exact same
`organizationId`-scoped path Phase 23's tenant-isolation test already covers. No new test was
required or added; the claim rests on "no new code touches organization scoping," which is
inspectable directly (`git diff` shows zero changes to `packages/db`).

## 11. AI

**Zero provider calls occurred.** `extractHtmlPromotionEntities`/`mergeHtmlPromotionsWithJsonLd`
have no dependency on `@cma/ai` (confirmed by inspection — no import of `@cma/ai` anywhere in
`packages/extraction`) and are pure, synchronous DOM/regex functions. No new AI change-type support,
no new claim-safety category, no speculative interpretation was added — HTML-derived promotion
`ChangeEvent`s flow into the exact same evidence-only Digest path Phase 23 already established.

## 12. KNOWN LIMITATIONS

1. **Coverage is real but still partial.** 3 of 7 live pages produced a genuine signal; 2 more had
   real visible "save X%" text that was correctly excluded because it was a page-wide billing-toggle
   claim, not tied to one plan (Squarespace, Grammarly) — a legitimate promotion in spirit, but one
   this deterministic layer cannot safely attribute to a specific product/plan without fabricating
   identity, per Section 5's explicit instruction not to.
2. **JS-shell pages remain uncovered** (Canva) — this was already a known Tier 3 limitation before
   this phase (`looksLikeJsShell`); HTML pattern matching cannot see content that only exists inside
   client-rendered JavaScript state, by construction (Cheerio never executes JS).
3. **The word list for free-duration/save-amount phrasing is intentionally small.** Real phrasings
   like `"Save over 80%"` (found live on Audible, outside a commercial container anyway) or the
   `" - free for"` feature-list shape are deliberately excluded/unsupported rather than guessed at.
4. **JSON-LD/HTML deduplication is narrow by design.** Only an exact same-label + same-bare-number
   `discount`↔`percentOff` match is treated as a duplicate. A `priceValidUntil`-only JSON-LD
   promotion and an HTML percent-off badge for the same real plan (Hostinger) are — correctly, per
   the brief's own "prefer distinguishable over silently merged" instruction — kept as separate
   entities, which means a customer reading the Digest could see what looks like two promotion
   events for one plan in one scan. This is the honest, conservative choice, not an oversight.
5. **DB-touching persistence paths were not executed against a live database in this session**
   (Section 8) — an execution gap, not a code-correctness gap, and strictly narrower than Phase 23's
   since zero new query paths were added.
6. **Severity/confidence for HTML-sourced promotions inherit Phase 23's existing constants**
   (`MEDIUM`/0.7–0.75) — no new severity logic was added, and none was needed since
   `detectPromotionChanges`/`detectPromotionAddedOrRemoved` are entity-type-generic, not
   source-aware.

## 13. PRODUCT VALUE

**Does this phase materially increase the number of real-world competitor promotions CMA can
preserve historically compared with Phase 23's JSON-LD-only approach?**

**Yes, demonstrably, on real pages.** ExpressVPN's `/order` page produces **zero** JSON-LD entities
of any kind, yet visibly displays three real, per-plan "Save X%" promotions — Phase 23's pipeline
would have recorded nothing at all for this page; Phase 24's pipeline correctly records three
distinct, evidenced `PROMOTION` entities tied to the right plans. Mailchimp shows the same pattern.
Hostinger shows a third, more nuanced case: JSON-LD *did* carry a promotion signal
(`priceValidUntil`), but a completely different, arguably more useful one (the "75%/79%/71% off"
number a customer would actually recognize as "the deal"), which JSON-LD never exposed at all — so
even on the one page where Phase 23 found *something*, Phase 24 finds the more commercially relevant
fact JSON-LD was silent on.

Section 20's success bar — *"demonstrate at least one real public commercial page where a
meaningful promotion is visibly present in HTML but is not available through the existing JSON-LD
promotion extractor, and show that Phase 24 detects it deterministically with usable evidence"* —
is met **three times over** in this session's small sample (ExpressVPN, Mailchimp, and Hostinger's
percentage signal specifically), not once. Given that 3 of 7 real, unrelated pages (spanning
hosting, VPN, and email-marketing SaaS) produced a genuine new signal, and the two "misses" that
weren't JS-shells were both due to a deliberately conservative identity-safety decision rather than
a missed pattern, this phase's evidence is stronger than Phase 23's own "1 of 5" sample and directly
answers the coverage question that phase left open.

## 14. RECOMMENDATION

The evidence in this session supports **neither** "stop, coverage is sufficient" nor "immediately
build another intelligence layer on top." Two concrete, narrower next steps are better justified by
what was actually observed than a new speculative feature:

1. **Run this exact extractor against real, currently-monitored customer URLs** (not blindly chosen
   public sites) to get a coverage number that matters for the actual product, the same
   recommendation Phase 23 made and this phase partially answered with a slightly larger but still
   small sample.
2. **Consider a bounded, narrowly-scoped extension for the "billing-toggle" shape** (Squarespace/
   Grammarly's "save up to X% (pay annually)" pattern) if it recurs often in the real customer
   sample — but only after that sample exists; inventing an attribution rule for this shape without
   more real examples risks exactly the fabricated-identity problem Section 5 warns against.

No Phase 25 feature is recommended from this session's evidence alone.

## Appendix: File changes

```
packages/extraction/package.json                 modified (added domhandler as a direct dependency for type-only AnyNode import)
packages/extraction/src/cheerioExtractor.ts       modified (wires HTML promotion extraction alongside JSON-LD)
packages/extraction/src/index.ts                  modified (exports the two new functions)
packages/extraction/src/htmlPromotions.ts         added
packages/extraction/src/htmlPromotions.test.ts    added
```
