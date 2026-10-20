-- AlterTable
ALTER TABLE "monitored_urls" ADD COLUMN     "capabilityAiCheckedAt" TIMESTAMP(3),
ADD COLUMN     "capabilityAiCheckedSnapshotId" TEXT;

-- CreateTable
CREATE TABLE "custom_capabilities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "phrases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capability_ai_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "AiAnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "pagesChecked" INTEGER NOT NULL DEFAULT 0,
    "pagesRemaining" INTEGER NOT NULL DEFAULT 0,
    "findings" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "failedPages" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "errorMessage" TEXT,

    CONSTRAINT "capability_ai_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_capabilities_organizationId_idx" ON "custom_capabilities"("organizationId");

-- CreateIndex
CREATE INDEX "capability_ai_runs_organizationId_requestedAt_idx" ON "capability_ai_runs"("organizationId", "requestedAt");

-- AddForeignKey
ALTER TABLE "custom_capabilities" ADD CONSTRAINT "custom_capabilities_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capability_ai_runs" ADD CONSTRAINT "capability_ai_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

