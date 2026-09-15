-- AlterTable
ALTER TABLE "Storyboard" ADD COLUMN     "dialogue" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "speaker" TEXT;

-- AlterEnum
ALTER TYPE "Stage" ADD VALUE 'MUSIC';
ALTER TYPE "Stage" ADD VALUE 'SUBTITLE';
