-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "stateRevision" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ShotControl" (
    "id" TEXT NOT NULL,
    "storyboardId" TEXT NOT NULL,
    "framing" TEXT,
    "cameraAngle" TEXT,
    "cameraMovement" TEXT,
    "actionStart" TEXT,
    "actionEnd" TEXT,
    "mood" TEXT,
    "negativePrompt" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShotControl_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShotControl_storyboardId_key" ON "ShotControl"("storyboardId");

-- AddForeignKey
ALTER TABLE "ShotControl" ADD CONSTRAINT "ShotControl_storyboardId_fkey" FOREIGN KEY ("storyboardId") REFERENCES "Storyboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
