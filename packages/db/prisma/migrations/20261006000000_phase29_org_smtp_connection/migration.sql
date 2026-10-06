-- CreateTable
CREATE TABLE "organization_smtp_connections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "security" TEXT NOT NULL,
    "username" TEXT,
    "encryptedPassword" TEXT,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_smtp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_smtp_connections_organizationId_key" ON "organization_smtp_connections"("organizationId");

-- AddForeignKey
ALTER TABLE "organization_smtp_connections" ADD CONSTRAINT "organization_smtp_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
