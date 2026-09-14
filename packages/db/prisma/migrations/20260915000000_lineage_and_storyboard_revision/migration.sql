-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "generationTaskId" TEXT;

-- AlterTable
ALTER TABLE "ScriptVersion" ADD COLUMN     "generationTaskId" TEXT;

-- AlterTable
ALTER TABLE "Storyboard" ADD COLUMN     "generationTaskId" TEXT,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "supersededAt" TIMESTAMP(3);

-- DropIndex
DROP INDEX "Storyboard_episodeId_number_key";

-- CreateIndex
CREATE INDEX "Storyboard_episodeId_supersededAt_idx" ON "Storyboard"("episodeId", "supersededAt");

-- CreateIndex
CREATE UNIQUE INDEX "Storyboard_episodeId_revision_number_key" ON "Storyboard"("episodeId", "revision", "number");

-- AddForeignKey
ALTER TABLE "ScriptVersion" ADD CONSTRAINT "ScriptVersion_generationTaskId_fkey" FOREIGN KEY ("generationTaskId") REFERENCES "GenerationTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_generationTaskId_fkey" FOREIGN KEY ("generationTaskId") REFERENCES "GenerationTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Storyboard" ADD CONSTRAINT "Storyboard_generationTaskId_fkey" FOREIGN KEY ("generationTaskId") REFERENCES "GenerationTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
