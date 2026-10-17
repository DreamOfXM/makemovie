-- AlterTable
ALTER TABLE "Storyboard" ADD COLUMN     "lockedReferences" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lockedVideoSelection" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lockedVoiceSelection" BOOLEAN NOT NULL DEFAULT false;
