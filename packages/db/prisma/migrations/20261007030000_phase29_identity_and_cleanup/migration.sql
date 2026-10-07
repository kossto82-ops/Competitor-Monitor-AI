-- ExtractedEntity gets its own organizationId (tenant convention), backfilled from its snapshot.
ALTER TABLE "extracted_entities" ADD COLUMN "organizationId" TEXT;
UPDATE "extracted_entities" e SET "organizationId" = s."organizationId" FROM "snapshots" s WHERE e."snapshotId" = s."id";
ALTER TABLE "extracted_entities" ALTER COLUMN "organizationId" SET NOT NULL;
CREATE INDEX "extracted_entities_organizationId_idx" ON "extracted_entities"("organizationId");

-- ChangeEvent: one event per (snapshot, type, field). Pre-existing duplicates (same snapshot, type and
-- field) are removed first, keeping the earliest, so the unique index can be created on a live database.
DELETE FROM "change_events" a USING "change_events" b
WHERE a."currentSnapshotId" = b."currentSnapshotId"
  AND a."changeType" = b."changeType"
  AND a."fieldPath" = b."fieldPath"
  AND a."id" > b."id";
CREATE UNIQUE INDEX "change_events_currentSnapshotId_changeType_fieldPath_key" ON "change_events"("currentSnapshotId", "changeType", "fieldPath");

-- Escalation flags nothing ever read (no extractor tier above Cheerio exists).
ALTER TABLE "monitored_urls" DROP COLUMN "requiresJs", DROP COLUMN "requiresInteraction";
