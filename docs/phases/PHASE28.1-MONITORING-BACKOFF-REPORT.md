# Phase 28.1 - exponential backoff for permanently failing monitored URLs

Commit `1e617d6`. This report was written afterwards (Phase 29 / A6) from the commit message and
the code; the commit shipped without one.

## Problem

A fetch or verification failure never advances `MonitoredUrl.lastSuccessfulScanAt` - it only
increments `consecutiveFailureCount`. `listDueMonitoredUrls` decided "due" from
`lastSuccessfulScanAt + scanFrequencyMinutes`, so a URL that kept failing stayed due forever and was
re-enqueued on every 15-minute scheduler tick.

Observed live in the dogfood environment: a bot-blocked URL (Namecheap, permanent 403) climbed to 41
consecutive failures, writing a `FAILED_TO_VERIFY` snapshot every 15 minutes, and the scheduler
re-enqueued 396 of 396 due URLs on each tick (almost all of them E2E fixture URLs that always fail).

## Change

- New column `MonitoredUrl.lastAttemptAt`, set on **every** job (success or failure) inside
  `persistMonitoringResult`. Migration `20260924000000_phase28_monitoring_backoff` backfills it from
  the latest snapshot of each URL; never-scanned URLs stay `NULL`, which means "due immediately".
- `listDueMonitoredUrls` (`packages/db/src/repositories/monitoredUrls.ts`) now applies a backoff
  anchored on `lastAttemptAt`: a URL attempted more recently than `monitoringBackoffMs(count)` ago is
  skipped. Otherwise the original rule applies (`lastSuccessfulScanAt + scanFrequencyMinutes`).
- `monitoringBackoffMs(n)`: `0` when `n <= 0`; otherwise `15 min * 2^(min(n-1, 10))`, capped at 24 h -
  15m, 30m, 1h, 2h, 4h, 8h, 16h, 24h, 24h, ... The base equals the scheduler tick, so the first
  failure is still retried on the very next tick, exactly as before.
- A success resets `consecutiveFailureCount` to 0, so a healthy URL is unaffected (zero backoff, the
  normal success cadence).

## Verified at the time

`packages/db` 221 tests, `apps/worker` 71 tests, typecheck of db/worker/web (per the commit message).
`packages/db/src/repositories/monitoredUrls.test.ts` gained 65 lines covering the backoff.

## Known limitations (found in the Phase 29 audit)

1. The backoff is independent of `scanFrequencyMinutes`. A URL configured to scan daily that fails once
   is retried after 15 minutes - more often than its own cadence - because the first-failure backoff
   is one scheduler tick. (Audit item E14.)
2. There is no terminal state. A URL that fails forever is retried every 24 hours indefinitely; nothing
   marks it `STALE`/`DISABLED` or alerts the customer that it cannot be monitored. (E14.)
3. Backoff is per URL; five URLs of one competitor host can still be fetched at the same moment. There
   is no per-host rate limit or jitter. (E14.)

These are scheduled in Phase B of [PHASE29-AUDIT-AND-ROADMAP.md](PHASE29-AUDIT-AND-ROADMAP.md).
