-- CreateEnum
CREATE TYPE "AlertDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "alertEmailMinLevel" "AlertLevel" NOT NULL DEFAULT 'IMPORTANT',
ADD COLUMN     "alertEmailsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "alert_deliveries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "levelSent" "AlertLevel" NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "AlertDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "alert_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_deliveries_organizationId_sentAt_idx" ON "alert_deliveries"("organizationId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "alert_deliveries_alertId_recipient_levelSent_attempt_key" ON "alert_deliveries"("alertId", "recipient", "levelSent", "attempt");

-- AddForeignKey
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "alert_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

