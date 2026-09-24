# Phase 28 — Third Observation & First Longitudinal Intelligence Signal

## 1. STATUS

**INSUFFICIENT THIRD OBSERVATION**

At Phase 28 start (DB `now()` ≈ `2026-09-23 10:50:06 UTC` — verified in-step, ~20 minutes after
Phase 27's observation window), **no third real observation has occurred yet**. Phase 27 closed at
`2026-09-23 10:29:10` (latest successful snapshot). The 24-hour `scanFrequencyMinutes=1440` cadence
means the next natural real observation for the six successful competitors lands on **~2026-09-24
10:29 UTC** — roughly one full day away. By the Phase 28 decision gate this is the **Path A**
verdict: no third real observation window exists, therefore the third-observation checkpoint for
intelligence-code implementation is **not yet triggered** and **zero production code changes** are
made. Observation machinery (worker + scheduler) has been left running continuously since Phase 27
(verified live at 11:00 UTC) so the third window accumulates on schedule.

## 2. REAL OBSERVATION EVIDENCE (Verified Live)

Probed directly from the running local Postgres `competitor_monitor` (db `now()` at probe time
`2026-09-23 10:50:06 UTC`), scoped to the real Phase-22 dogfood org **CMA Dogfood Phase22**
(`cmu5f7zhi0001a9rl4wyg34h6`). All other orgs are E2E/Smoke fixtures and excluded.

**DB-wide maxima:</summary>

| Artifact | Max timestamp | Meaning |
|---|---|---|
| `snapshots.fetchedAt` (success) | 2026-09-23 10:29:10.292 | Phase 27's Dropbox second observation |
| `snapshots.fetchedAt` (all, incl. failures) | 2026-09-23 10:44:05.710 | Namecheap 6th `FAILED_TO_VERIFY` |
| `monitoring_jobs.finishedAt` | 2026-09-23 10:44:05.711 | Namecheap job (only post-10:29 dogfood job) |
| `usage_records.createdAt` | 2026-09-23 10:44:05.713 | Namecheap usage row |
| `change_events.detectedAt` | 2026-09-23 10:29:08.512 | unchanged from Phase 27 |

**Per-competitor real snapshot state (18 snapshots: 13 successful, 5 failed):**

| Competitor | Snapshots | Situation |
|---|---|---|
| Basecamp | 2 | 09-17 NO_CHANGE · 09-23 CHANGED |
| Buffer | 2 | 09-17 NO_CHANGE · 09-23 CHANGED |
| Dropbox | 3 | 09-17 NO_CHANGE · 09-17 CHANGED (known same-session artifact) · 09-23 NO_CHANGE |
| ExpressVPN | 2 | 09-18 NO_CHANGE · 09-23 CHANGED |
| Hostinger | 2 | 09-18 NO_CHANGE · 09-23 CHANGED |
| Mailchimp | 2 | 09-18 NO_CHANGE · 09-23 NO_CHANGE |
| Namecheap | 5 | all `FAILED_TO_VERIFY` (403 bot-block); `consecutiveFailureCount=6`, `lastSuccessfulScanAt=NULL` |

**Conclusion: every competitor has exactly two distinct successful observation moments (Dropbox 3
with one artifact) — no third observation window has produced data anywhere in the org.** The only
row written since Phase 27 is Namecheap's 6th failed retry at 10:44 from the scheduler's second tick
(see §3). Nothing synthetic, backdated, or fixture-injected; the two existing observation moments
are real fetches to the public sites.

## 3. SCHEDULER ACTIVITY SINCE PHASE 27 (why 402/402 → 396/396)

Two scheduler ticks are visible in the running worker log:

- **Tick 1 (`…-29835989`), 402/402 due URLs** — this is Phase 27's window (10:29 UTC). All six
  successful dogfood URLs scanned; everything else on the platform `FAILED_TO_VERIFY`.
- **Tick 2 (`…-29836004`), 396/396 due URLs (~10:44 UTC)** — the scheduler re-enqueued the **396
  URLs still due** (failed scans do not advance `lastSuccessfulScanAt`, so they stay due each tick;
  402−6 = 396). The six Phase-27-successful competitors were *not* re-enqueued because their 24h
  window had not elapsed. Consistent with design: no URL double-scanned within its cadence.

Only Namecheap (from the dogfood org) appears in tick 2, failing again at 10:44:05. **The second
tick produced no successful observation and no `change_events`.** This matches Phase 27 §7's
accounting exactly (+1 Namecheap failure, no runaway duplication).

## 4. CHANGE EVENTS

**Still exactly the 6 ChangeEvents from Phase 27** (max `detectedAt = 2026-09-23 10:29:08.512`,
verified again this phase):

| # | Detected | Competitor | Type | Old | New | Confidence |
|---|---|---|---|---|---:|
| 1 | 09-17 11:15:46 | Dropbox | `PRODUCT_REMOVED` | PRICE 0 USD | removed | 0.7 (known structured-data artifact) |
| 2 | 09-23 10:29:05 | Hostinger | `PROMOTION_CHANGE` | `priceValidUntil=2027-09-18` | `priceValidUntil=2027-09-23` | 0.75 |
| 3 | 09-23 10:29:07 | ExpressVPN | `PROMOTION_CHANGE` | `percentOff=76` | `percentOff=73` | 0.75 |
| 4 | 09-23 10:29:07 | ExpressVPN | `PROMOTION_CHANGE` | `percentOff=73` | `percentOff=67` | 0.75 |
| 5 | 09-23 10:29:06 | Basecamp | `CONTENT_CHANGE` | page copy | page copy | 0.5 |
| 6 | 09-23 10:29:08 | Buffer | `CONTENT_CHANGE` | page copy | page copy | 0.5 |

**By type:** `PROMOTION_CHANGE` 3, `CONTENT_CHANGE` 2, `PRODUCT_REMOVED` 1. No new event landed;
nothing was manufactured, backdated, or fixture-injected.

## 5. LONGITUDINAL SIGNAL (the third-observation checkpoint)

The Phase 28 checkpoint is: a **third** real observation window landing with **continued ExpressVPN
discount tightening** (`percentOff` advanced ≤ 73 / express pro ≤ 67) **OR any genuine
`PRICE_CHANGE` / `PROMOTION_REMOVED`**.

**Third observation: does not exist yet.** The ExpressVPN/Hostinger comparison still rests on a
two-window delta:

- ExpressVPN: 09-18 → 09-23 = Advanced 76%→73%, Express Pro 73%→67%, Basic held at 80%.
- Hostinger: `priceValidUntil` rolling +5 calendar days (2027-09-18 → 2027-09-23), consistent with a
  ~365-day rolling validity window.

A two-window delta is a *demonstration* of accumulated observation; a third window is what would
confirm **sustained tightening** (a single baseline direction) or reveal **constructive / revert
behavior**. Sustained-tightening classification and promotion-lifecycle tracking
(`PROMOTION_ADDED → CHANGE → REMOVED`) both remain `INSUFFICIENT_HISTORY` — unchanged since Phase
27. This is a data-accumulation state, not a code gap.

## 6. CUSTOMER-VISIBLE RESULT

**None new this phase — and correctly so.**

- A customer opening a report/digest today would see the same content as at Phase 27 close: the two
  `PROMOTION_CHANGE` facts (Section 4) already surfaced-change intelligence. **No new commercial fact
  has accumulated in the ~½ hour since.**
- `reports` count for the dogfood org = **0** (unchanged). The intelligence lives in
  `change_events` + `snapshots` + `extracted_entities`; it has still never been rendered back to a
  user (Phase 27 §10 surfacing bottleneck — unchanged, correctly still not promoted to an
  implementation gap under the Path-A gate).
- Per the brief's hard rule: an **empty-state render is not proof** and no new signal is *claimed*
  here. Status for all Phase 28 claims: **UNPROVEN** (nothing to prove yet — no third window).

## 7. MANUAL RECONSTRUCTION TEST (adversary check)

Same honest ceiling as Phase 27, unchanged:

- The ExpressVPN 76→73 / 73→67 and Hostinger validity roll are reproducible in a spreadsheet **if** a
  human visited both on 09-18 *and* 09-23 and recorded structured values.
- CMA's edge remains: **automation, persistence, and no human-recall burden.** A future
  third-window visit (09-24 ~10:29) confirming tightened-or-equal discounts is exactly what would
  move the demonstration toward a *sustained* pattern — but that second delta must be **real
  continued observation**, never extrapolated.

A reconstruction test for "third observation" cannot be run because no third observation data
exists. That absence is itself the finding.

## 8. DECISION / OUTCOME

**Verdict: `INSUFFICIENT THIRD OBSERVATION` → NO PRODUCTION CODE CHANGES.**

Reasoning, explicitly against the Phase 28 Path-A/B gate:

1. **Real third observation:** none — verified (Sections 2–3). The next natural window is ~09-24
   10:29 UTC, and the scheduler is running to catch it.
2. **Sustained ExpressVPN tightening (second confirming delta):** not yet observable — has not
   happened in real time.
3. **`PRICE_CHANGE` / `PROMOTION_REMOVED`:** no event of this type has ever landed for any dogfood
   competitor.
4. **Path B precondition fails on every clause → no implementable signal.** Building the smallest
   longitudinal signal (e.g. `SUSTAINED_ACTIVITY_TREND`) *now* would require fabricating or
   extrapolating the third window — explicitly forbidden by the brief. It stays parked behind real
   elapsed history.

**Follow-through (operational, zero code):**
- Postgres + Redis running (`.local-infra`); worker + scheduler confirmed running at 11:00 UTC
  (12 node processes; logs `.local-infra/worker-phase27.log`, `scheduler-phase27.log`). **Observation
  is live and continuous; the third window will accumulate on schedule (~09-24 10:29 UTC).**
- Per Phase 26 §3 note for future sessions: set `CMA_AI_PROVIDER=fake` before exploratory
  dogfooding unless a real AI call is intended.
- **Next checkpoint (unchanged, now concrete):** after the **third** real observation window
  (~2026-09-24 10:29 UTC): if ExpressVPN `percentOff` advanced ≤ 73 AND express pro ≤ 67 sustained
  (baseline-confirming), or any `PRICE_CHANGE` / `PROMOTION_REMOVED` lands, then implementation of
  the smallest deterministic longitudinal signal has an evidence-backed case. Revisit then; not now.

## 9. QUERY PERFORMANCE

The two query shapes this phase's evidence depends on, `EXPLAIN ANALYZE` on the live DB (both
index-driven, org-scoped, sub-millisecond):

1. Dogfood `change_events` ordered by `detectedAt` — Index Scan on
   `change_events_organizationId_idx`; **Execution Time 0.130 ms** (6 rows).
2. Per-URL observation counts from `snapshots` — Bitmap Index Scan on
   `snapshots_organizationId_idx` + GroupAggregate; **Execution Time 0.135 ms** (19 rows → 7 URLs).

No index gaps surfaced; org-scoped longitudinal reads are cheap even under the org-wide volume that
already exists. A future signal surfacing PR would reuse these exact access paths.

## 10. AI / COST AUDIT

| Metric | Phase 27 close | Phase 28 close | Delta |
|---|---|---:|---:|
| Dogfood org `ai_analyses` | 1 | 1 | **0** |
| Dogfood org `digest_ai_interpretations` | 1 | 1 | **0** |
| Dogfood org `ai_connections` | 0 | 0 | **0** |
| `usage_records` | 17 | 18 | +1 (only Namecheap 403, `aiCallMade=false`) |
| `reports` | 0 | 0 | **0** |
| AI provider calls caused by this phase | — | **0** | **0** |

- The 1 existing `ai_analyses` row (09-17, openai/gpt-4o-mini, $0.000219) and 1
  `digest_ai_interpretations` row (09-17, 30d window, $0.000317) are both **pre-Phase-28** and
  untouched. No `POST` to either AI route occurred; no provider call was made.
- All 18 `usage_records` are `aiCallMade=false`, `browserEscalated=false`, `extractionMethod=CHEERIO`
  (deterministic pipeline only). Scheduler's structural guarantee held:
  `0 AI calls - monitoring never calls AI`.

## 11. TESTS

**No code changed → no tests to add, fix, or re-run.** The pipeline, scheduler, and comparator that
produced all 18 real snapshots and 6 change events ran with zero source modifications (verified by
`git status` — only the pre-existing `next-env.d.ts` tooling diff and untracked `dump.rdb`).
Behavioral verification this phase = the live pipeline + queries above, not unit tests. If/When Path
B triggers a real code change, the existing unit suite plus a local `CMA_AI_PROVIDER=fake`
run/verification is the prescribed gate (Phase 26/27 precedent).

## 12. LIMITATIONS

- **Historical depth remains the wall:** two observation windows per competitor (Dropbox 3, with the
  same-session artifact among them). Baseline classification, sustained-trend classification,
  repeated-pricing counting, and promotion-lifecycle detection all remain `INSUFFICIENT_HISTORY`.
  Phase 28 adds no window; it *confirms waiting is the correct action*.
- **Observation cadence is daily, not intraday:** with `scanFrequencyMinutes=1440`, an observation
  gap is expected by design; the ~24 h between windows is normal, not a defect.
- **Namecheap still 100% bot-blocked** (6 × 403 over 13 days; `consecutiveFailureCount=6`). Data-
  coverage gap, pre-existing (Phase 22→27); noted, not itemized — fixing requires an anti-bot /
  browser-escalation capability that is out of scope and unproven beyond the 403 itself.
- **Surfacing remains zero:** the real intelligence is still only queryable in the DB
  (`change_events`/`snapshots`/`extracted_entities`); `reports` = 0. Correctly NOT an implementation
  item under the Path-A gate.
- **Empty vs real-data proof:** this phase makes **no** REAL-DATA claim about a third observation —
  the honest status of "third observation / sustained signal" is **UNPROVEN / DOES NOT EXIST YET**;
  an empty state is exactly what the absence of history *should* show.

## 13. CODE CHANGES

**None.** No source, test, schema, route, or config file modified. Filesystem changes limited to this
report and throwaway SQL probes under `%TEMP%\opencode\phase28\` (untracked, not part of the repo).

## 14. GIT HYGIENE

```
 M apps/web/next-env.d.ts              (Next.js auto-generated, regenerated by tooling — pre-existing, not edited here)
?? docs/phases/PHASE28-THIRD-OBSERVATION-FIRST-LONGITUDINAL-INTELLIGENCE-REPORT.md   (this report)
?? dump.rdb                            (pre-existing untracked Redis dump — untouched)
```

`.local-infra/` (runtime logs, pgdata) is gitignored, not part of the diff. `git diff --stat` = 1
file (`apps/web/next-env.d.ts`, 2 insertions / 2 deletions, pre-existing).

Nothing staged, nothing committed. `.env`/`.env.local` read-only. Background processes (worker,
scheduler, Postgres, Redis) intentionally left running to accumulate the third observation window;
stop with `Stop-Process -Name node` or the issuing sessions.