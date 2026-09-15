-- AlterTable
ALTER TABLE "ai_analyses" ADD COLUMN     "providerMetadata" JSONB;

-- CreateTable
CREATE TABLE "ai_connections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "baseUrl" TEXT,
    "encryptedApiKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_connections_organizationId_idx" ON "ai_connections"("organizationId");

-- CreateIndex
CREATE INDEX "ai_connections_organizationId_enabled_idx" ON "ai_connections"("organizationId", "enabled");

-- AddForeignKey
ALTER TABLE "ai_connections" ADD CONSTRAINT "ai_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

