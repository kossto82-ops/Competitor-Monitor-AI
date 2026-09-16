-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('GENERATING', 'COMPLETED', 'FAILED');

-- DropIndex
DROP INDEX "reports_organizationId_reportDate_key";

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "dailyReportEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- AlterTable
ALTER TABLE "reports" DROP COLUMN "competitorsChecked",
DROP COLUMN "failedScans",
DROP COLUMN "highSeverityCount",
DROP COLUMN "lowSeverityCount",
DROP COLUMN "mediumSeverityCount",
DROP COLUMN "noChangeCount",
DROP COLUMN "successfulScans",
DROP COLUMN "urlsChecked",
ADD COLUMN     "changeCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "competitorCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "competitorsWithChangesCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "status" "ReportStatus" NOT NULL DEFAULT 'GENERATING',
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "generatedAt" DROP NOT NULL,
ALTER COLUMN "generatedAt" DROP DEFAULT;

-- Phase 4 note: "timezone"/"updatedAt" keep a DEFAULT here (unlike the
-- Prisma-generated diff) purely so this migration can apply cleanly
-- against a database that may already contain Phase 1 stub `reports`
-- rows written by tenantIsolation.test.ts fixtures. The Prisma schema
-- itself has no default for `timezone` - every row written by
-- application code always supplies it explicitly.

-- CreateTable
CREATE TABLE "report_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "changeEventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_items_organizationId_idx" ON "report_items"("organizationId");

-- CreateIndex
CREATE INDEX "report_items_reportId_idx" ON "report_items"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "report_items_reportId_changeEventId_key" ON "report_items"("reportId", "changeEventId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_logs_reportId_channel_recipient_key" ON "notification_logs"("reportId", "channel", "recipient");

-- CreateIndex
CREATE INDEX "reports_organizationId_reportDate_idx" ON "reports"("organizationId", "reportDate");

-- CreateIndex
CREATE UNIQUE INDEX "reports_organizationId_reportDate_timezone_key" ON "reports"("organizationId", "reportDate", "timezone");

-- AddForeignKey
ALTER TABLE "report_items" ADD CONSTRAINT "report_items_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_items" ADD CONSTRAINT "report_items_changeEventId_fkey" FOREIGN KEY ("changeEventId") REFERENCES "change_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
