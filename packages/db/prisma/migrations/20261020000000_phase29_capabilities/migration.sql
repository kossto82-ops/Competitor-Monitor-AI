-- CreateEnum
CREATE TYPE "CapabilityState" AS ENUM ('PRESENT', 'ABSENT');

-- CreateEnum
CREATE TYPE "CapabilityMethod" AS ENUM ('DETERMINISTIC', 'AI');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "capabilityPacks" TEXT[] DEFAULT ARRAY['general']::TEXT[];

-- CreateTable
CREATE TABLE "capability_observations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "monitoredUrlId" TEXT NOT NULL,
    "capabilityKey" TEXT NOT NULL,
    "state" "CapabilityState" NOT NULL DEFAULT 'PRESENT',
    "method" "CapabilityMethod" NOT NULL DEFAULT 'DETERMINISTIC',
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence" TEXT NOT NULL,
    "missCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "absentSince" TIMESTAMP(3),

    CONSTRAINT "capability_observations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "capability_observations_organizationId_competitorId_idx" ON "capability_observations"("organizationId", "competitorId");

-- CreateIndex
CREATE UNIQUE INDEX "capability_observations_monitoredUrlId_capabilityKey_key" ON "capability_observations"("monitoredUrlId", "capabilityKey");

-- AddForeignKey
ALTER TABLE "capability_observations" ADD CONSTRAINT "capability_observations_monitoredUrlId_fkey" FOREIGN KEY ("monitoredUrlId") REFERENCES "monitored_urls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

