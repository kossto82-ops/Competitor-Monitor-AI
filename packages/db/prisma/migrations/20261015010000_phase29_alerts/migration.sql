-- CreateEnum
CREATE TYPE "AlertLevel" AS ENUM ('URGENT', 'IMPORTANT', 'NOTICE');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'DISMISSED');

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" "AlertLevel" NOT NULL,
    "minImportance" INTEGER NOT NULL,
    "minConfidence" DOUBLE PRECISION NOT NULL,
    "kinds" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "monitoredUrlId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "ruleName" TEXT NOT NULL,
    "level" "AlertLevel" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "importance" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstRaisedAt" TIMESTAMP(3) NOT NULL,
    "lastRaisedAt" TIMESTAMP(3) NOT NULL,
    "statusChangedAt" TIMESTAMP(3),

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_signals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,

    CONSTRAINT "alert_signals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "alert_rules_organizationId_ruleKey_key" ON "alert_rules"("organizationId", "ruleKey");

-- CreateIndex
CREATE INDEX "alert_events_organizationId_status_lastRaisedAt_idx" ON "alert_events"("organizationId", "status", "lastRaisedAt");

-- CreateIndex
CREATE INDEX "alert_events_organizationId_dedupeKey_lastRaisedAt_idx" ON "alert_events"("organizationId", "dedupeKey", "lastRaisedAt");

-- CreateIndex
CREATE UNIQUE INDEX "alert_signals_signalId_key" ON "alert_signals"("signalId");

-- CreateIndex
CREATE INDEX "alert_signals_alertId_idx" ON "alert_signals"("alertId");

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_monitoredUrlId_fkey" FOREIGN KEY ("monitoredUrlId") REFERENCES "monitored_urls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_signals" ADD CONSTRAINT "alert_signals_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "alert_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_signals" ADD CONSTRAINT "alert_signals_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

