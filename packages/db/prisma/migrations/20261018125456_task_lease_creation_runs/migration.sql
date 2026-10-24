-- AlterTable
ALTER TABLE "ArtifactOperation" ADD COLUMN     "claimToken" TEXT,
ADD COLUMN     "leaseUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "GenerationTask" ADD COLUMN     "claimToken" TEXT,
ADD COLUMN     "leaseUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CreationRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "batchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreationRun_requestKey_key" ON "CreationRun"("requestKey");

-- CreateIndex
CREATE INDEX "CreationRun_organizationId_idx" ON "CreationRun"("organizationId");
