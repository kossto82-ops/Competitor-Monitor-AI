-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "marketLocale" TEXT;

-- AlterTable
ALTER TABLE "snapshots" ADD COLUMN     "pageLanguage" TEXT,
ADD COLUMN     "requestedLocale" TEXT;
