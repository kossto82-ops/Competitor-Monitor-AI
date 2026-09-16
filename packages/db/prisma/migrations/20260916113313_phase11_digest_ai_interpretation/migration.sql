-- AlterTable
ALTER TABLE "reports" ALTER COLUMN "timezone" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "digest_ai_interpretations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "status" "AiAnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "promptVersion" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "summary" TEXT,
    "observations" JSONB NOT NULL DEFAULT '[]',
    "interpretations" JSONB NOT NULL DEFAULT '[]',
    "hypotheses" JSONB NOT NULL DEFAULT '[]',
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "durationMs" INTEGER,
    "providerMetadata" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "digest_ai_interpretations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "digest_ai_interpretations_organizationId_idx" ON "digest_ai_interpretations"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "digest_ai_interpretations_organizationId_days_key" ON "digest_ai_interpretations"("organizationId", "days");

-- AddForeignKey
ALTER TABLE "digest_ai_interpretations" ADD CONSTRAINT "digest_ai_interpretations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
