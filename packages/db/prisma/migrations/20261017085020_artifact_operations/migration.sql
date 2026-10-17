-- CreateTable
CREATE TABLE "ArtifactOperation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceArtifactId" TEXT NOT NULL,
    "outputArtifactId" TEXT,
    "connectionId" TEXT NOT NULL,
    "capabilityId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "requestSnapshot" TEXT NOT NULL,
    "errorSnapshot" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtifactOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArtifactOperation_organizationId_idx" ON "ArtifactOperation"("organizationId");

-- AddForeignKey
ALTER TABLE "ArtifactOperation" ADD CONSTRAINT "ArtifactOperation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
