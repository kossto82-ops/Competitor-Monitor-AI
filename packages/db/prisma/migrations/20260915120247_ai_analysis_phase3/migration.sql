-- AlterEnum
BEGIN;
CREATE TYPE "AiAnalysisStatus_new" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');
ALTER TABLE "ai_analyses" ALTER COLUMN "status" TYPE "AiAnalysisStatus_new" USING ("status"::text::"AiAnalysisStatus_new");
ALTER TYPE "AiAnalysisStatus" RENAME TO "AiAnalysisStatus_old";
ALTER TYPE "AiAnalysisStatus_new" RENAME TO "AiAnalysisStatus";
DROP TYPE "AiAnalysisStatus_old";
COMMIT;

-- AlterTable
ALTER TABLE "ai_analyses" DROP COLUMN "businessImpact",
DROP COLUMN "category",
DROP COLUMN "competitiveInterpretation",
DROP COLUMN "completionTokens",
DROP COLUMN "promptTokens",
DROP COLUMN "providerModel",
DROP COLUMN "recommendedAttention",
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "confidence" TEXT,
ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "inputTokens" INTEGER,
ADD COLUMN     "interpretations" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "model" TEXT,
ADD COLUMN     "organizationId" TEXT NOT NULL,
ADD COLUMN     "outputTokens" INTEGER,
ADD COLUMN     "promptVersion" TEXT NOT NULL,
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'PENDING',
DROP COLUMN "speculation",
ADD COLUMN     "speculation" JSONB NOT NULL DEFAULT '[]';

-- CreateIndex
CREATE INDEX "ai_analyses_organizationId_idx" ON "ai_analyses"("organizationId");

