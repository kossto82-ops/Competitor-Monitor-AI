-- Phase 28.1: monitoring backoff for failing URLs.

-- The scheduler's "due" logic (listDueMonitoredUrls) previously only
-- looked at lastSuccessfulScanAt + scanFrequencyMinutes. A fetch or
-- verification failure never advances lastSuccessfulScanAt (it only
-- increments consecutiveFailureCount), so a URL that keeps failing is
-- "due" forever and gets re-enqueued on every scheduler tick. This
-- column anchors the exponential backoff: the scheduler now measures
-- next-scan from the most recent attempt (success or failure), not
-- from a success that never happens.

-- Existing rows: backfill from the most recent snapshot's fetchedAt -
-- every scan (successful or not, FAILED_TO_VERIFY included) writes a
-- Snapshot, so the latest snapshot IS the last attempt. URLs that
-- never had a snapshot (e.g. brand new URLs) keep NULL, which the due
-- logic still treats as "scan now".

-- AddColumn
ALTER TABLE "monitored_urls" ADD COLUMN "lastAttemptAt" TIMESTAMP(3);

-- Backfill: last attempt = latest snapshot for the URL.
UPDATE "monitored_urls" mu
SET "lastAttemptAt" = (
  SELECT MAX(s."fetchedAt")
  FROM "snapshots" s
  WHERE s."monitoredUrlId" = mu."id"
)
WHERE EXISTS (
  SELECT 1 FROM "snapshots" s WHERE s."monitoredUrlId" = mu."id"
);