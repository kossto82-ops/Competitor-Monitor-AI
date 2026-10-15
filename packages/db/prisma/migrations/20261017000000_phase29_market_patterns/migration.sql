-- CreateEnum
CREATE TYPE "MarketPatternKind" AS ENUM ('MARKET_PRICES_UP', 'MARKET_PRICES_DOWN', 'MARKET_PLANS_ADDED', 'MARKET_PLANS_REMOVED', 'MARKET_PROMOTIONS');

-- CreateEnum
CREATE TYPE "MarketPatternStatus" AS ENUM ('ACTIVE', 'RESOLVED');

-- CreateTable
CREATE TABLE "market_patterns" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "MarketPatternKind" NOT NULL,
    "status" "MarketPatternStatus" NOT NULL DEFAULT 'ACTIVE',
    "epistemicLevel" "EpistemicLevel" NOT NULL DEFAULT 'INTERPRETATION',
    "ruleVersion" INTEGER NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "affectedCount" INTEGER NOT NULL,
    "observedCount" INTEGER NOT NULL,
    "share" DOUBLE PRECISION NOT NULL,
    "summary" TEXT NOT NULL,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL,
    "lastConfirmedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "market_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_pattern_evidence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "patternId" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "competitorName" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,

    CONSTRAINT "market_pattern_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "market_patterns_organizationId_status_lastConfirmedAt_idx" ON "market_patterns"("organizationId", "status", "lastConfirmedAt");

-- CreateIndex
CREATE INDEX "market_pattern_evidence_signalId_idx" ON "market_pattern_evidence"("signalId");

-- CreateIndex
CREATE UNIQUE INDEX "market_pattern_evidence_patternId_signalId_key" ON "market_pattern_evidence"("patternId", "signalId");

-- AddForeignKey
ALTER TABLE "market_pattern_evidence" ADD CONSTRAINT "market_pattern_evidence_patternId_fkey" FOREIGN KEY ("patternId") REFERENCES "market_patterns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_pattern_evidence" ADD CONSTRAINT "market_pattern_evidence_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

