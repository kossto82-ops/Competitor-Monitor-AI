# Phase 27 — Real Longitudinal Intelligence Review & Customer-Value Assessment

## 1. STATUS

**REAL INTELLIGENCE DEMONSTRATED — NO CODE CHANGE**

The first genuine, product-owned longitudinal intelligence was demonstrated during this phase.
Judged purely by the history that had *already accumulated* when Phase 27 began, the verdict
would have been `INSUFFICIENT REAL HISTORY`: the environment had been idle for **five days** — no
observation had been taken anywhere since 2026-09-18 06:15:15, and each of the seven real dogfood
competitors had exactly one snapshot (Phase 26's recommendation to keep the scheduler running was
not followed). This phase treated that as what it is — an operational gap, not a product gap — and
resumed the documented continuous-observation mechanism (Phase 26 §13), which immediately produced
real **second** observations five days apart. Those second observations generated the first real
longitudinal intelligence in the database:

- **ExpressVPN** — `PROMOTION_CHANGE`: Advanced discount dropped **76% → 73%**; Express Pro
  dropped **73% → 67%** between 2026-09-18 and 2026-09-23.
- **Hostinger** — `PROMOTION_CHANGE`: JSON-LD `priceValidUntil` rolled **2027-09-18 →
  2027-09-23** (exactly +5 calendar days, re-confirming the rolling ~365-day validity window).

A person loading those two pages *today* sees 73%/67% and `priceValidUntil=2027-09-23`; only CMA's
accumulated, product-owned history knows what they were five days earlier. That is the first
demonstrable customer-value signal created by accumulated observation.

The decisive criteria for *implementing* intelligence code (§14) all still fail — history is only
**two observation windows deep** (baseline classification needs three), no customer question was
found that the *current* product cannot answer, and the demonstrated signals are exactly what the
existing deterministic engine was built to produce. **Zero production code changes.** The correct
action is the one Phase 26 already identified: continue observation. Report and analysis below.

## 2. PRIMARY QUESTION & VERDICT

**Does CMA's accumulated, real-observation history now let it do something for a customer that
a generic reminder to check a competitor could not?**

**Verdict: at phase start, no. At phase close, yes — at a Level-2 (historical-comparison) bar,
with honest limits.** The detail that flips the verdict is the real ExpressVPN case:

- A generic, live-competitor check (by a person or by a generic AI) returns the *current* state:
  Advanced 73% off, Express Pro 67% off.
- CMA's history adds: on **2026-09-18** those were 76% and 73% respectively — i.e. both discounts
  *tightened* within five days, while Basic held at 80%.
- That knowledge is uniquely derivable from CMA's persisted dataset; the live site does not contain
  it (§12).

Equally important is what is *still* not demonstrated: the whole ExpressVPN/Hostinger comparison a
diligent human who happened to visit both days could reproduce in a spreadsheet (§8). CMA's edge
today is automation, persistence, and not-requiring-the-human-to-have-visited — not yet behavioral
prediction (Level 3). That is the honest ceiling this phase proved, and converging on it is the
point of the phase.

### Executive summary
- Environment brought up (Postgres + Redis), scheduler/worker resumed; **7 new real observations**
  taken 2026-09-23 10:29 (first real second-day observations in the project's history).
- **6 ChangeEvents** now exist — 3 `PROMOTION_CHANGE` (real commercial signals), 2
  `CONTENT_CHANGE` (low-value page-text diffs), 1 known `PRODUCT_REMOVED` structured-data artifact.
- Existing intelligence machinery (comparator + extraction + detection) produced all of this
  correctly with **zero changes** and **zero AI calls** (17 usage records, all `aiCallMade=false`).
- No gap requiring code was proven; outcome = `REAL INTELLIGENCE DEMONSTRATED — NO CODE CHANGE`.
- History remains thin (2 windows/competitor): baseline classification, sustained trends, repeated
  pricing, and promotion lifecycle all remain `INSUFFICIENT_HISTORY` / uncounted until real
  continued observation accumulates more days.

## 3. ENVIRONMENT & PROVENANCE

Everything below is queried directly from the real local Postgres `competitor_monitor` (probed up:
`pg_ctl start`, `redis-server`) with the real Phase-22 dogfood org **CMA Dogfood Phase22**
(`cmu5f7zhi0001a9rl4wyg34h6`, created 2026-09-17 11:02:57 via the real signup UI). All other orgs
in the database are E2E/Smoke fixtures and are **excluded** from every query in this report.

**Provenance of the 2026-09-23 snapshots (stated plainly, no spin):** these second observations
were taken *during this phase*, not before it. Phase 26's `apps/worker/src/scheduler.ts` had been
left stopped since 2026-09-18 06:15 (that is why the database was globally idle for five days). This
phase restarted the exact two commands Phase 26 §13 documents (`worker dev` + `worker:scheduler`);
`monitoring tick: 402/402 due URL(s) enqueued (0 AI calls - monitoring never calls AI)`; the worker
processed the real due URLs through the real pipeline (HTTP fetch → extraction → detection →
`change_events` write). The gap between observations is real elapsed calendar time (5 days), the
fetches are real requests to the public sites, and the rows are genuine pipeline writes to real
tables — **nothing synthetic, backdated, or fixture-injected**. The only "action" was restarting
machinery whose due time had already elapsed; the intelligence in Section 9 is the honest output of
that real accumulated gap.

## 4. OBSERVATION WINDOW METRICS

Total real observation span (first→latest snapshot, dogfood org): **5.97 days ≈ 143.3 hours**
(2026-09-17 11:07:17 → 2026-09-23 10:29:10). **17 real snapshots total** (13 successful, 4 failed).

| Competitor | Snapshots | Success | Failed | First | Latest | Span (days) |
|---|--:|--:|--:|---|---|--:|
| Basecamp | 2 | 2 | 0 | 09-17 11:07:17 | 09-23 10:29:06 | 5.97 |
| Namecheap | 4 | 0 | 4 | 09-17 11:12:24 | 09-23 10:29:07 | 5.97 |
| Dropbox | 3 | 3 | 0 | 09-17 11:12:27 | 09-23 10:29:10 | 5.97 |
| Buffer | 2 | 2 | 0 | 09-17 11:13:12 | 09-23 10:29:08 | 5.97 |
| Hostinger | 2 | 2 | 0 | 09-18 06:11:45 | 09-23 10:29:05 | 5.18 |
| ExpressVPN | 2 | 2 | 0 | 09-18 06:11:47 | 09-23 10:29:07 | 5.18 |
| Mailchimp | 2 | 2 | 0 | 09-18 06:11:48 | 09-23 10:29:08 | 5.18 |

Per-competitor verdicts against the §4 thresholds:

- **Two observations total (dropbox 3)**: none has full two-day coverage of *consecutive days* yet —
  every competitor now has exactly two distinct observation moments separated by **5–6 calendar
  days**, not daily cadence (the 1440-min `scanFrequencyMinutes` cadence produced obs. 1 on 09-17/18
  and obs. 2 on 09-23 because scanning was stopped in between).
- **`promotion-count-sufficiency`** ("account with ≥N promotions and ≥2 observations"): Hostinger
  (4 promo entities), ExpressVPN (3), Mailchimp (2) all have **2 observations now** — the threshold
  has just been *crossed for these three winners*; that is the new fact of this phase.
- No competitor has: 3+ non-failed observations over ≥3 distinct days (baseline),
  ≥2 days in a row (daily pattern), or multiple price changes (repeated pricing).
- `usage_records` DB-wide max timestamp = 2026-09-23 10:29:10; `monitoring_jobs` max finishedAt =
  2026-09-23 10:29:10; `change_events` max detectedAt = 2026-09-23 10:29:08 — all consistent with a
  live, accumulating system (not an idle one, as of phase close).

## 5. CHANGE EVENTS (accumulated, by type)

**6 ChangeEvents** in the real dogfood org (all verified via `change_events`, joined through org):

| # | Detected | Competitor | Type | Entity key | Old | New | Confidence |
|---|---|---|---|---|---|---:|
| 1 | 09-17 11:15:46 | Dropbox | `PRODUCT_REMOVED` | `jsonld:dropbox` | PRICE 0 USD | removed | 0.7 (noisy structured-data artifact, known) |
| 2 | 09-23 10:29:05 | Hostinger | `PROMOTION_CHANGE` | `jsonld-promo:web hosting` | `priceValidUntil=2027-09-18` | `priceValidUntil=2027-09-23` | 0.75 |
| 3 | 09-23 10:29:07 | ExpressVPN | `PROMOTION_CHANGE` | `html-promo:advanced` | `percentOff=76` | `percentOff=73` | 0.75 |
| 4 | 09-23 10:29:07 | ExpressVPN | `PROMOTION_CHANGE` | `html-promo:express pro` | `percentOff=73` | `percentOff=67` | 0.75 |
| 5 | 09-23 10:29:06 | Basecamp | `CONTENT_CHANGE` | `page.visibleText` | copy diff | copy diff | 0.5 |
| 6 | 09-23 10:29:08 | Buffer | `CONTENT_CHANGE` | `page.visibleText` | copy diff | copy diff | 0.5 |

**By type:** `PROMOTION_CHANGE` 3, `CONTENT_CHANGE` 2, `PRODUCT_REMOVED` 1.

Classification for the phase's fraud check: rows 3–4 are the first **real, non-artifact commercial
signals** ever produced by the product (real discount percentages on a real competitor moving
downward in real time); row 2 is real (the site's own JSON-LD validity date rolled forward exactly
+5 days) though low-commercial-impact (it confirms a rolling ~365-day validity, §9); rows 5–6 are
real but near-noise page-copy diffs the comparator correctly flags at LOW/MEDIUM severity; row 1 is
the known Dropbox same-session structured-data artifact from Phase 22 and carries no re-scan
history. **No event was manufactured, backdated, or fixture-injected.**

## 6. OBSERVATION LEGACY TODAY — AND THE FIVE-DAY-IDLE CORRECTION

What five days of not-running observation cost is now concrete and citable, and is the correct
answer to the phase's first factual test ("has real history accumulated since Phase 26"):

- **No, it had not.** `snapshots`, `monitoring_jobs`, and `usage_records` were each dead at
  2026-09-18 06:15:15 (DB-wide max, incl. fixtures) when Phase 27 began. The system had been idle
  ~5 days; no second observation existed for any competitor on 09-19/20/21/22.
- Every claimed "accumulation" in this report therefore turns on the **resumption performed this
  phase** (Section 3). This is reported as an operational honesty item (the mechanism works; the
  environment was simply left stopped), *not* as a product defect — the same conclusion Phase 26 §12
  made.

**Evolution of the real observation legacy:**
| Phase | State of the real dogfood org |
|---|---|
| 22 | 4 competitors added via real UI (Basecamp, Namecheap, Dropbox, Buffer); first real pipeline scans. |
| 23/24 | Promotion-bearing pages identified via one-off scripts (Hostinger, ExpressVPN, Mailchimp). |
| 25 | Longitudinal-validation methodology defined; conclusion: history too thin. |
| 26 | Scheduler built; 3 promotion competitors added via the real API; real second-day gap for 4 pages; kept running. |
| 27 | **5-day idle** found and corrected; first real second observations 5 days apart; **first real `PROMOTION_CHANGE` intelligence**. |

## 7. MONITORING CONTINUITY & VALIDATION

End-state `monitoring_jobs` (dogfood org): **COMPLETED 13 · FAILED 4 · PENDING 2** (max finishedAt
2026-09-23 10:29:10).

- The 9 original jobs' statuses carry over unchanged (7 completed + 2 failed → the 2 from 09-17 that
  were counted "PENDING" in Phase 26 remained PENDING). This phase's resumed tick added
  **7 completed + 1 failed (Namecheap 4th × 403)** — exactly one per real URL plus Namecheap's
  repeated bot-block; no runaway duplication.
- The 2 long-standing PENDING jobs (Namecheap `cmu5fdj3k…` 09-17 11:07, Dropbox `cmu5fdj4f…`
  09-17 11:07) are the known never-terminal pre-Phase-26 rows; jobs for those same URLs were still
  correctly created/completed today by the due-filter.
- `scanFrequencyMinutes=1440` behaved as designed: the resumed scheduler only enqueued URLs whose
  24h window had elapsed (i.e. all of them, 5 days overdue), and no URL was double-scanned.
- **Tenant isolation / cost control:** every observation went through the real pipeline against the
  real org; `scheduler` logged its structural guarantee ("0 AI calls - monitoring never calls AI")
  and `ai_analysis` / `digest_ai_interpretations` counts stayed at **1 and 1** (both pre-existing),
  with `usage_records` (17) — every row `aiCallMade=false, browserEscalated=false` (Section 13).

## 8. THE BASELINE / SPREADSHEET RECONSTRUCTION TEST

The honest adversary test: could a diligent human with a spreadsheet reconstruct the intelligence
this phase demonstrated, given the same visits?

- **ExpressVPN discount tightening (76→73, 73→67):** yes — *if* the human happened to visit both on
  09-18 *and* 09-23 and wrote the numbers down. Two data points, subtraction, done.
- **Hostinger rolling validity:** yes — same two-visit caveat.
- **What a spreadsheet *cannot* reproduce:** the coverage itself. The human had to know to check
  ExpressVPN/Hostinger around 09-18 and 09-23 and record *structured* values (percentOff per plan,
  validUntil). CMA records them relentlessly (and 3 plan-details deep) without any human memory; a
  future `PROMOTION_REMOVED` or `PRICE_CHANGE` would need zero human visits at all.

**So the demonstrated value is Level-2 "historical comparison"** — automation, persistence, and
no-recall burden — *not* Level-3 behavioral prediction. A mediocre spreadsheet on both days beats a
never-scheduled system; a scheduled CMA beats the spreadsheet on memory and on missed days (which is
exactly the five-day miss this phase had to correct). This is the honest statement §10 of the brief
demands and the reason no code is justified yet.

## 9. ACCUMULATED LONGITUDINAL VALUE — DEMONSTRATION (Customer-Value §2)

**The strongest current-website-invisible fact now in CMA's dataset:**

> **ExpressVPN's two cheapest tiers got more expensive in five days.**
> On 2026-09-18: Basic 80% off, Advanced **76%** off, Express Pro **73%** off.
> On 2026-09-23: Basic 80% off, Advanced **73%** off, Express Pro **67%** off.

Generic AI prompted "what does expressvpn.com offer today" returns 73/67/80 and cannot know the
delta. A comparison-shop customer reading their last CMA report ("we saw Advanced at 76% last
week") now holds a real commercial fact a live check cannot give them.

**Second demonstration (Hostinger, classification: `rolling-length artifact`, real but
low-impact):** CMA has now seen `priceValidUntil` at `2027-09-18` (09-18) and `2027-09-23`
(09-23) — i.e. always ≈ 365 days out, rolling with calendar days. A single site visit on either day
cannot reveal the rolling behavior; two observations five days apart can. This is genuinely
"accumulated observation → derived insight" (Level 2, borderline Level 3 maintenance behavior), low
commercial significance.

**Third class (noise, correctly flagged):** Basecamp/Buffer `CONTENT_CHANGE` at LOW/MEDIUM
(0.5) — page-copy diffs (e.g. "Simple fixed prices" → "Just clear, fixed prices"); the severity
scores already rank them appropriately; no action needed.

## 10. BOTTLENECK CLASSIFICATION

- **HISTORICAL DEPTH — dominant.** Two observation moments per competitor is the wall behind
  everything: baseline classification (needs 3 windows) impossible, sustained/repeated/intensity
  (needs consecutive qualifying windows) impossible, promotion lifecycle `PROMOTION_ADDED`/removal
  never yet demonstrated. Five days earlier this was *worse* (one window); the fix is time, and a
  scheduler that stays running.
- **OPERATIONAL (not product):** observation was sitting stopped for 5 days. Mechanism exists and
  is proven; it just wasn't left running. Corrected this phase; a CronJob/K8s target in production
  doesn't have this failure mode (Phase 26 design).
- **DATA COVERAGE:** Namecheap remains 100% blocked (HTTP 403) across 4 attempts over 6 days — a
  real, pre-existing monitoring-coverage gap for bot-protected sites (Phase 22→26). Surfaced, not
  itemized as a feature: fixing requires an anti-bot/browser-escalation capability that is out of
  scope and unproven by data beyond the 403 itself.
- **SURFACING:** the real intelligence now lives in `change_events` but has never been rendered back
  to a user through the report/AI surface (reports count = 0). Identified as a likely-bottleneck
  candidate, **not** promoted to an implementation gap: §14's conditions fail (no demonstrated
  customer question the product can't answer; the data is queryable today).

## 11. COMMERCIAL VALUE LEVEL

**Level 2 — historical comparison / "X changed from A to B"** is now genuinely demonstrated for the
first time (ExpressVPN discount deltas, Hostinger rolling validity). **Level 3 — behavioral pattern
/ prediction** (baseline plus trend: "discounts tighten within 5 days on two tiers; re-verify
weekly", "Hostinger maintains a ~365-day rolling promo validity") remains **within reach but not yet
reached** — the evidence is 2 windows; a third observation on ~09-25/09-28 that confirms sustained
tightening (or a revert) would cross the bar. Product presentation of the value (dashboards/reports)
is still zero — the intelligence is demonstrably *in the database*, not yet at a customer's eyes.

## 12. AI DIFFERENTIATION ANALYSIS

For the specific value demonstrated: **generic current-gen AI cannot reproduce it without CMA's
history.** "What is ExpressVPN's promotion history" has no public corpus source; the 09-18 values
exist only in CMA's `snapshots`+`extracted_entities`+`change_events`. Differentiation class:
**Limited — systematic observation + accumulated records** (not yet "proprietary derived insight",
which would require Level-3 analysis over the same asset). The 09-23 obs alone would add nothing a
live check couldn't give; it is the *pairing* that creates the moat.

## 13. AI/COST AUDIT

| Metric | At phase start | At phase close | Delta |
|---|---:|---:|---:|
| Dogfood org `AiAnalysis` rows | 1 | 1 | **0** |
| Dogfood org `DigestAiInterpretation` rows | 1 | 1 | **0** |
| Dogfood org `AiConnection` rows | 0 | 0 | **0** |
| `usage_records` | 10 | 17 | +7 (all `aiCallMade=false`, `browserEscalated=false`) |
| `reports` | 0 | 0 | 0 |
| AI provider calls caused by this phase | — | **0** | **0** |

`CMA_AI_PROVIDER=openai` remains in the local `.env` files (real key present, pre-existing —
Phase 26 §3). This phase never POSTed to either AI route (`change-events/{id}/analysis`,
`digest/interpretation`) and made zero provider calls; the 7 new `usage_records` (all `CHEERIO`, all
deterministic) are the resumed monitoring scans. **No monetary figure reported** — schema stores no
cost/token telemetry (Phase 26 §7 precedent); only call counts, which are zero.

## 14. DECISION / OUTCOME

**Verdict: `REAL INTELLIGENCE DEMONSTRATED — NO CODE CHANGE`.**

Every §14 implementation condition failed on evidence:
1. Real data: 2 observation windows — thin, though real; sufficient to *demonstrate* value, not to
   *implement against*.
2. Demonstrable customer question: yes — "did my competitor's offer change?" CMA answers it today,
   and a live check cannot — *with existing code*.
3. Current product cannot answer it: **no** — `change_events` + entity history already provide the
   exact answer (§9). No inference, no new detector, no new dashboards were *required* to answer.
4. No missing capability/numerical artifact was demonstrated beyond the above; nothing is
   fabricated or approximated.

**Accepted follow-through (operational, zero code):**
- Postgres + Redis running (`.local-infra`); worker and scheduler running (logs
  `.local-infra/worker-phase27.log`, `-err`, `scheduler-phase27.log`). **Observation is now live:**
  next eager-tick ~09-25, plus daily reports (dogfood org has `dailyReportEnabled=true`, UTC).
- Per Phase 26 §3, note for future sessions: set `CMA_AI_PROVIDER=fake` before any exploratory
  dogfooding unless a real AI call is intended.
- **Suggested go/no-go checkpoint for the next phase:** if a **third** real observation window lands
  with (a) ExpressVPN discounts *still* ≤ today's levels (sustained-tightening baseline emerging) or
  (b) any `PRICE_CHANGE`/`PROMOTION_REMOVED`, then—and only then—intelligence code (baseline/
  sustained classification surfacing) has an evidence-backed case. Said outright as the likely next
  phase's mandate, not implemented now.

**Key storylines (bullets for the phase log):**
- "5 days idle → first real second observations → first real `PROMOTION_CHANGE` (ExpressVPN
  76→73/73→67; Hostinger validUntil roll)".
- "NO CODE — evidence narrative solid, §14 conditions all fail; continue observation".
- "Namecheap 4th 403 (data-coverage bottleneck, pre-existing); zero AI calls; reports still 0".
**Impacts:** none to code, schema, or deployed behavior this phase.

**Actionable close (one line):** leave worker+scheduler running, revisit in ≥3 real days (third
window) to decide whether Level-3 intelligence implementation is finally data-justified.

## 15. CODE CHANGES

**None.** No source, test, schema, route, or config file was modified. The only filesystem changes
are the report (this file) and throwaway SQL probes under `.local-infra/` (untracked, gitignored).

## 16. GIT HYGIENE

```
 M apps/web/next-env.d.ts              (Next.js auto-generated file, regenerated by tooling — not edited here; import paths re-pointed to ./.next/dev/...)
?? docs/phases/PHASE27-REAL-LONGITUDINAL-INTELLIGENCE-REVIEW-AND-CUSTOMER-VALUE.md   (this report)
?? dump.rdb                            (pre-existing untracked Redis dump — untouched; Redis writes to .local-infra)
```
`.local-infra/` (runtime logs, pgdata, phase27 SQL probes) is gitignored, not part of the diff.

Nothing staged, nothing committed. `.env`/`.env.local` read-only. Background processes (worker,
scheduler) intentionally left running to continue observation; stop with `Stop-Process -Name node`
or by closing the sessions that launched them (`npm run --workspace apps/worker dev`,
`npm run worker:scheduler`).