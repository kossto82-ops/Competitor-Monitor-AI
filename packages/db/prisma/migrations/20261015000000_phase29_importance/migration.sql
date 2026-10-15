-- AlterTable
ALTER TABLE "competitors" ADD COLUMN     "relevance" INTEGER NOT NULL DEFAULT 2;

-- CreateTable
CREATE TABLE "importance_configs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "weights" JSONB NOT NULL,
    "kindEmphasis" JSONB NOT NULL,
    "tiers" JSONB NOT NULL,
    "recencyHalfLifeDays" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "importance_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "importance_configs_organizationId_version_key" ON "importance_configs"("organizationId", "version");

