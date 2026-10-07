-- AlterTable
ALTER TABLE "monitored_urls" ADD COLUMN     "etag" TEXT,
ADD COLUMN     "lastModifiedHeader" TEXT,
ADD COLUMN     "validatorsSetAt" TIMESTAMP(3);
