-- AlterTable
ALTER TABLE "ArtifactOperation" ADD COLUMN     "applyPolicy" TEXT NOT NULL DEFAULT 'candidate_only',
ADD COLUMN     "applyReason" TEXT,
ADD COLUMN     "applyStatus" TEXT,
ADD COLUMN     "expectedShotRevision" INTEGER;
