-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('STARTER', 'PRO', 'BUSINESS');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "UrlCategory" AS ENUM ('PRODUCT_PAGE', 'PRICING_PAGE', 'GENERAL');

-- CreateEnum
CREATE TYPE "ExtractionMethod" AS ENUM ('HTTP', 'CHEERIO', 'PLAYWRIGHT', 'BROWSER_USE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "VerificationState" AS ENUM ('CHANGED', 'NO_CHANGE', 'FAILED_TO_VERIFY');

-- CreateEnum
CREATE TYPE "ChangeType" AS ENUM ('PRICE_CHANGE', 'PRODUCT_ADDED', 'PRODUCT_REMOVED', 'PROMOTION_CHANGE', 'CONTENT_CHANGE');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('PRICE', 'PRODUCT', 'PLAN', 'PROMOTION', 'GENERIC');

-- CreateEnum
CREATE TYPE "AiAnalysisStatus" AS ENUM ('SUCCESS', 'FAILED', 'TIMEOUT', 'SKIPPED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('SENT', 'FAILED');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'STARTER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'OWNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitors" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitored_urls" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "label" TEXT,
    "category" "UrlCategory" NOT NULL DEFAULT 'GENERAL',
    "scanFrequencyMinutes" INTEGER NOT NULL DEFAULT 1440,
    "requiresJs" BOOLEAN NOT NULL DEFAULT false,
    "requiresInteraction" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSuccessfulScanAt" TIMESTAMP(3),
    "consecutiveFailureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitored_urls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitoring_jobs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "monitoredUrlId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monitoring_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snapshots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "monitoredUrlId" TEXT NOT NULL,
    "monitoringJobId" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "extractionMethod" "ExtractionMethod" NOT NULL,
    "httpStatus" INTEGER,
    "finalUrl" TEXT,
    "verificationState" "VerificationState" NOT NULL,
    "errorMessage" TEXT,
    "normalizedContent" TEXT NOT NULL,
    "contentHash" TEXT,
    "structuredDataHash" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "warnings" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extracted_entities" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "type" "EntityType" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT,
    "currency" TEXT,
    "raw" TEXT NOT NULL,

    CONSTRAINT "extracted_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "monitoredUrlId" TEXT NOT NULL,
    "previousSnapshotId" TEXT,
    "currentSnapshotId" TEXT NOT NULL,
    "changeType" "ChangeType" NOT NULL,
    "severity" "Severity" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "entityKey" TEXT,
    "fieldPath" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "currency" TEXT,
    "percentageChange" DOUBLE PRECISION,
    "evidenceExcerpt" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_analyses" (
    "id" TEXT NOT NULL,
    "changeEventId" TEXT NOT NULL,
    "status" "AiAnalysisStatus" NOT NULL,
    "summary" TEXT,
    "category" TEXT,
    "businessImpact" TEXT,
    "competitiveInterpretation" TEXT,
    "speculation" TEXT,
    "facts" JSONB NOT NULL DEFAULT '[]',
    "recommendedAttention" BOOLEAN NOT NULL DEFAULT false,
    "providerModel" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reportDate" TIMESTAMP(3) NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "competitorsChecked" INTEGER NOT NULL,
    "urlsChecked" INTEGER NOT NULL,
    "successfulScans" INTEGER NOT NULL,
    "failedScans" INTEGER NOT NULL,
    "highSeverityCount" INTEGER NOT NULL,
    "mediumSeverityCount" INTEGER NOT NULL,
    "lowSeverityCount" INTEGER NOT NULL,
    "noChangeCount" INTEGER NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reportId" TEXT,
    "channel" "NotificationChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL,
    "sentAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "monitoringJobId" TEXT,
    "extractionMethod" "ExtractionMethod",
    "browserEscalated" BOOLEAN NOT NULL DEFAULT false,
    "aiCallMade" BOOLEAN NOT NULL DEFAULT false,
    "aiPromptTokens" INTEGER,
    "aiCompletionTokens" INTEGER,
    "fetchSucceeded" BOOLEAN NOT NULL,
    "processingTimeMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_organizationId_idx" ON "users"("organizationId");

-- CreateIndex
CREATE INDEX "competitors_organizationId_idx" ON "competitors"("organizationId");

-- CreateIndex
CREATE INDEX "monitored_urls_organizationId_idx" ON "monitored_urls"("organizationId");

-- CreateIndex
CREATE INDEX "monitored_urls_competitorId_idx" ON "monitored_urls"("competitorId");

-- CreateIndex
CREATE INDEX "monitoring_jobs_organizationId_idx" ON "monitoring_jobs"("organizationId");

-- CreateIndex
CREATE INDEX "monitoring_jobs_monitoredUrlId_createdAt_idx" ON "monitoring_jobs"("monitoredUrlId", "createdAt");

-- CreateIndex
CREATE INDEX "monitoring_jobs_status_idx" ON "monitoring_jobs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "snapshots_monitoringJobId_key" ON "snapshots"("monitoringJobId");

-- CreateIndex
CREATE INDEX "snapshots_organizationId_idx" ON "snapshots"("organizationId");

-- CreateIndex
CREATE INDEX "snapshots_monitoredUrlId_fetchedAt_idx" ON "snapshots"("monitoredUrlId", "fetchedAt");

-- CreateIndex
CREATE INDEX "extracted_entities_snapshotId_idx" ON "extracted_entities"("snapshotId");

-- CreateIndex
CREATE INDEX "extracted_entities_key_idx" ON "extracted_entities"("key");

-- CreateIndex
CREATE INDEX "change_events_organizationId_idx" ON "change_events"("organizationId");

-- CreateIndex
CREATE INDEX "change_events_monitoredUrlId_detectedAt_idx" ON "change_events"("monitoredUrlId", "detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_analyses_changeEventId_key" ON "ai_analyses"("changeEventId");

-- CreateIndex
CREATE UNIQUE INDEX "reports_organizationId_reportDate_key" ON "reports"("organizationId", "reportDate");

-- CreateIndex
CREATE INDEX "notification_logs_organizationId_idx" ON "notification_logs"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "usage_records_monitoringJobId_key" ON "usage_records"("monitoringJobId");

-- CreateIndex
CREATE INDEX "usage_records_organizationId_createdAt_idx" ON "usage_records"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitored_urls" ADD CONSTRAINT "monitored_urls_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "competitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitoring_jobs" ADD CONSTRAINT "monitoring_jobs_monitoredUrlId_fkey" FOREIGN KEY ("monitoredUrlId") REFERENCES "monitored_urls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_monitoredUrlId_fkey" FOREIGN KEY ("monitoredUrlId") REFERENCES "monitored_urls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_monitoringJobId_fkey" FOREIGN KEY ("monitoringJobId") REFERENCES "monitoring_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_entities" ADD CONSTRAINT "extracted_entities_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_monitoredUrlId_fkey" FOREIGN KEY ("monitoredUrlId") REFERENCES "monitored_urls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_previousSnapshotId_fkey" FOREIGN KEY ("previousSnapshotId") REFERENCES "snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_currentSnapshotId_fkey" FOREIGN KEY ("currentSnapshotId") REFERENCES "snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_changeEventId_fkey" FOREIGN KEY ("changeEventId") REFERENCES "change_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_monitoringJobId_fkey" FOREIGN KEY ("monitoringJobId") REFERENCES "monitoring_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
