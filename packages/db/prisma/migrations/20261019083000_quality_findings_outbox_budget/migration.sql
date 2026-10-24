-- AlterTable
ALTER TABLE "GenerationBatch" ADD COLUMN     "paused" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "inFlightCallLimit" INTEGER;

-- CreateTable
CREATE TABLE "QualityFinding" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "compositionId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "findingKey" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "evidenceTimeSeconds" DOUBLE PRECISION,
    "artifactId" TEXT,
    "storyboardId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "decidedBy" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QualityFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobOutbox" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP,

    CONSTRAINT "JobOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QualityFinding_organizationId_episodeId_status_idx" ON "QualityFinding"("organizationId", "episodeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "QualityFinding_compositionId_findingKey_key" ON "QualityFinding"("compositionId", "findingKey");

-- CreateIndex
CREATE INDEX "JobOutbox_status_createdAt_idx" ON "JobOutbox"("status", "createdAt");
