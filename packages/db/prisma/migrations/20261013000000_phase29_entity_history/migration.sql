-- CreateEnum
CREATE TYPE "EntityStatus" AS ENUM ('ACTIVE', 'ABSENT');

-- CreateEnum
CREATE TYPE "EntityVersionOrigin" AS ENUM ('FIRST_SEEN', 'CHANGE', 'BASELINE', 'REAPPEARED');

-- CreateTable
CREATE TABLE "entities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "monitoredUrlId" TEXT NOT NULL,
    "type" "EntityType" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "absentSince" TIMESTAMP(3),

    CONSTRAINT "entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_versions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "value" TEXT,
    "currency" TEXT,
    "raw" TEXT NOT NULL,
    "origin" "EntityVersionOrigin" NOT NULL,
    "changeEventId" TEXT,

    CONSTRAINT "entity_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "entities_organizationId_idx" ON "entities"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "entities_monitoredUrlId_key_key" ON "entities"("monitoredUrlId", "key");

-- CreateIndex
CREATE INDEX "entity_versions_entityId_observedAt_idx" ON "entity_versions"("entityId", "observedAt");

-- CreateIndex
CREATE INDEX "entity_versions_organizationId_idx" ON "entity_versions"("organizationId");

-- CreateIndex
CREATE INDEX "entity_versions_snapshotId_idx" ON "entity_versions"("snapshotId");

-- AddForeignKey
ALTER TABLE "entities" ADD CONSTRAINT "entities_monitoredUrlId_fkey" FOREIGN KEY ("monitoredUrlId") REFERENCES "monitored_urls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_changeEventId_fkey" FOREIGN KEY ("changeEventId") REFERENCES "change_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

