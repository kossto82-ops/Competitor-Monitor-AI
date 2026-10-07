-- AlterTable
ALTER TABLE "monitored_urls" ADD COLUMN     "disabledAt" TIMESTAMP(3),
ADD COLUMN     "disabledReason" TEXT;
