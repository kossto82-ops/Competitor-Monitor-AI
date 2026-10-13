-- CreateEnum
CREATE TYPE "SignalKind" AS ENUM ('PRICE_INCREASE', 'PRICE_DECREASE', 'PLAN_ADDED', 'PLAN_REMOVED', 'PROMOTION_STARTED', 'PROMOTION_CHANGED', 'PROMOTION_ENDED', 'CONTENT_UPDATE');

-- CreateEnum
CREATE TYPE "EpistemicLevel" AS ENUM ('FACT', 'INTERPRETATION', 'INFERENCE');

-- CreateEnum
CREATE TYPE "SignalEvidenceRole" AS ENUM ('PRIMARY', 'SUPPORTING');

-- CreateTable
CREATE TABLE "signals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "monitoredUrlId" TEXT NOT NULL,
    "entityKey" TEXT,
    "kind" "SignalKind" NOT NULL,
    "epistemicLevel" "EpistemicLevel" NOT NULL DEFAULT 'FACT',
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "currency" TEXT,
    "percentageChange" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_evidence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "changeEventId" TEXT NOT NULL,
    "role" "SignalEvidenceRole" NOT NULL,

    CONSTRAINT "signal_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "signals_organizationId_occurredAt_idx" ON "signals"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "signals_monitoredUrlId_occurredAt_idx" ON "signals"("monitoredUrlId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "signals_organizationId_dedupeKey_key" ON "signals"("organizationId", "dedupeKey");

-- CreateIndex
CREATE INDEX "signal_evidence_organizationId_idx" ON "signal_evidence"("organizationId");

-- CreateIndex
CREATE INDEX "signal_evidence_changeEventId_idx" ON "signal_evidence"("changeEventId");

-- CreateIndex
CREATE UNIQUE INDEX "signal_evidence_signalId_changeEventId_key" ON "signal_evidence"("signalId", "changeEventId");

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_monitoredUrlId_fkey" FOREIGN KEY ("monitoredUrlId") REFERENCES "monitored_urls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_evidence" ADD CONSTRAINT "signal_evidence_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_evidence" ADD CONSTRAINT "signal_evidence_changeEventId_fkey" FOREIGN KEY ("changeEventId") REFERENCES "change_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

