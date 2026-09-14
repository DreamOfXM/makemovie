-- AlterTable
ALTER TABLE "GenerationTask" ADD COLUMN     "storyboardId" TEXT;

-- CreateIndex
CREATE INDEX "GenerationTask_storyboardId_stage_status_idx" ON "GenerationTask"("storyboardId", "stage", "status");

-- AddForeignKey
ALTER TABLE "GenerationTask" ADD CONSTRAINT "GenerationTask_storyboardId_fkey" FOREIGN KEY ("storyboardId") REFERENCES "Storyboard"("id") ON DELETE SET NULL ON UPDATE CASCADE;
