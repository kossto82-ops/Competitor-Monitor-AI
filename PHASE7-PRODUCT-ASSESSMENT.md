# Phase 7 — Product Assessment

## What CMA can now know that a generic AI cannot know without it

A generic AI (ChatGPT, Claude, whatever a customer pastes data into) can
summarize or reason over information it is *given*. It cannot, on its own:

1. **Continuously observe** a competitor's pages over weeks/months and
   notice a change the moment it happens, with a diff and a timestamp.
2. **Maintain a stable identity** for "this specific product" across dozens
   of independent observations, so that "price changed 3 times" is a
   verifiable count over real rows, not a guess from whatever screenshots
   a customer happened to paste in.
3. **Compare a competitor's current activity to its own accumulated
   history** — Phase 7's activity-vs-baseline pattern requires at least 60
   days of actual monitoring data (2 qualifying 30-day baseline windows) to
   even produce an answer. No amount of prompting a generic AI can conjure
   that history if it was never collected.

This is the moat: not the arithmetic (which is trivial), but the fact that
the arithmetic is running over evidence nobody else was collecting.

## Value growth over time

| Age of monitoring | What becomes possible |
|---|---|
| Day 1 | Nothing yet — a baseline snapshot, no ChangeEvents |
| 7–30 days | First verified changes, basic activity counts (Phase 6) |
| 30–60 days | Product lifecycle counts become meaningful (added/removed with a real "previous period" to compare against) |
| 60–90 days | **Activity-vs-baseline patterns start qualifying** (2 baseline windows) — the first genuinely new Phase 7 capability |
| 90–120 days | Full 3-window baseline; entity histories long enough to show a product's full added→repriced→(maybe removed) arc |
| 180 days+ | Multiple qualifying pattern windows across several products; a customer can see whether a competitor's pricing cadence has been consistent or has shifted |
| 1 year+ | Enough history that a future cross-competitor pattern comparison (deferred this phase, see below) would itself have a defensible baseline on both sides |

## What is still commoditized

- Reading a single competitor page and noticing "the price is €59" — any
  scraper or AI-with-browsing does this.
- Summarizing one ChangeEvent's before/after (Phase 3's per-event AI
  analysis) — useful, but not hard to replicate with a generic tool if you
  already have the diff.
- Descriptive cross-competitor counts (Phase 6's `/compare`) — a table of
  numbers; valuable but not defensible against replication once the raw
  events exist.

## What is becoming defensible

- **Entity lifecycle history** (`getEntityHistoryForCompetitor`): the joined
  added → repriced → repriced → (possibly removed) story for one specific,
  identifiably-named product. This literally cannot exist without weeks of
  prior observation under a stable identity.
- **The activity-vs-baseline pattern**: by construction, it is *undefined*
  (returns `INSUFFICIENT_HISTORY`) without 60+ days of real monitoring. A
  competitor cannot buy their way into having this data any faster than a
  customer's own monitoring accumulates it.
- **Evidence provenance**: every pattern traces back to specific
  `ChangeEvent` ids (`changeEventIds` on `RepeatedPriceChangePattern`,
  `events` on `EntityHistory`) — a customer (or a future AI layer) can
  always drill from "pattern" to "the exact evidence," which a
  paste-into-ChatGPT workflow cannot offer because there is no persistent
  record to drill into.

## What requires new data CMA does not have

- Promotion patterns — no extractor produces `PROMOTION`-typed entities
  today (Data Audit Section 1). Building this pattern before the
  extraction gap is closed would be inventing data, not deriving it.
- Cross-competitor product/plan equivalence — would require either a human
  confirmation step or a much larger corpus to train/verify a matching
  model; neither exists (Data Audit Section 3).
- Anything about competitor intent, revenue, or market position.

## What a competitor product could copy easily

The individual formulas (activity-vs-baseline math, repeated-change
threshold) are not secret and are simple enough to reimplement in an
afternoon. **What cannot be copied quickly is the accumulated per-customer
history** — a competing tool starting today has zero ChangeEvents for any
of CMA's existing customers' tracked competitors. The formulas are
commodity; the dataset is not.

## The "ChatGPT test"

Five representative questions, evaluated honestly:

1. **"What has Competitor A changed in the last 90 days?"**
   Generic AI: cannot answer without being given the data first (no
   memory, no monitoring). CMA: direct query, with evidence, zero AI cost.

2. **"Has Competitor A become more active recently?"**
   Generic AI: cannot answer without a supplied history *and* a
   supplied definition of "more active than what baseline." CMA: this is
   exactly `getActivityPattern` — a defined baseline, a defined threshold,
   and an explicit "not enough history yet" answer when the data doesn't
   support a claim (which a generic AI, without CMA's discipline, would be
   tempted to answer anyway from a small sample).

3. **"How has Competitor A's pricing evolved?"**
   Generic AI: only as good as whatever screenshots/text the customer
   manually collected and pasted, which in practice means sporadic,
   incomplete, undated. CMA: `getEntityHistoryForCompetitor` — a
   chronological, dated, evidenced series per identifiable product.

4. **"Which of my competitors changed their pricing most recently?"**
   Generic AI: cannot answer without being manually fed every competitor's
   current state. CMA: `compareCompetitors` (Phase 6) already answers this
   with real timestamps, descriptively (no ranking).

5. **"What patterns have appeared in Competitor A's behavior?"**
   Generic AI: could produce a plausible-*sounding* answer from a short
   pasted excerpt, but with no way to verify it against real historical
   sample sizes — this is precisely the failure mode the brief's Section 9
   worked example warns about (small samples described as "dramatic").
   CMA: `getActivityPattern` / `getRepeatedPriceChangePatterns` explicitly
   refuse to answer with confidence below the documented minimum sample
   size, which a naive prompt-based tool has no mechanism to enforce.

**Where CMA adds unique value across all five:** continuous, dated,
evidenced observation with an enforced minimum-sample-size discipline — not
the arithmetic itself, which any tool could replicate given the same input
data. The value is having the input data at all, verified and historical.

## The "customer value test"

**Persona 1 — SaaS company monitoring 3–5 competing SaaS products' pricing
pages.**
*Before CMA:* a team member manually checks competitor pricing pages every
few weeks, keeps a spreadsheet, misses changes between checks.
*With CMA:* every price/plan change on tracked pages is caught and dated
automatically, with before/after evidence.
*After 90 days:* the activity-vs-baseline pattern starts working — the team
can see "Competitor X has had more pricing activity in the last 30 days
than its own recent norm" without manually reconstructing a timeline from
the spreadsheet. This is the point at which the team would notice CMA
telling them something their spreadsheet never could (the spreadsheet has
no concept of "normal for this competitor").

**Persona 2 — Ecommerce company monitoring competing stores.**
*Before CMA:* ad-hoc, someone notices a competitor's promo by chance.
*With CMA:* systematic product add/remove and price-change tracking per
monitored page (promotions specifically are out of reach until an
extractor exists — an honest limitation, not hidden).
*After 90 days:* entity histories show which specific products a
competitor repeatedly reprices vs. which are stable — informs which SKUs
deserve closer manual attention.

**Persona 3 — Agency monitoring multiple clients' competitors.**
*Before CMA:* effort scales linearly with number of clients × competitors
— unsustainable past a handful.
*With CMA:* the same deterministic pipeline scales to any number of
organizations (multi-tenant by construction since Phase 1); the pattern
layer adds per-client, per-competitor "what's actually different from
normal" without extra manual analyst time.
*After 90 days:* the agency can report "no material change from baseline"
for most clients most weeks and focus manual review time only where
`getActivityPattern` flags `ABOVE_BASELINE` — a genuine time-saving
workflow, not a demo feature.

**Why they'd keep using it:** the value compounds — day-1 CMA is barely
better than manual checking (nothing to compare against yet); day-90 CMA
has a real historical baseline no manual process maintains as reliably.
Switching to a competing tool means starting that clock over at zero.

## Recommended next direction

Of everything deferred in this phase (Data Audit Section 4.3, Intelligence
Model), the single highest-leverage next step is the **cross-competitor
pattern comparison** — not because it's exciting, but because the hard
part (a per-competitor pattern with a defensible baseline) already exists
after this phase; extending it to "Competitor A had N qualifying
activity-pattern windows in the last 90 days, Competitor B had M" is a
thin, purely descriptive layer (no ranking, matching the existing
`compareCompetitors` discipline) that turns an already-defensible
per-competitor signal into the comparative view customers actually asked
for in Section 12 of the brief. The historical-AI-interpretation layer
(Sections 14–16) should come *after* that, once there are at least two
kinds of qualifying pattern (this phase ships one) worth an AI explaining
in prose — interpreting a single pattern type in isolation would add cost
without adding much beyond what `PatternsCard`'s plain-language rendering
already says.
