-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "exampleSourceNote" TEXT,
ADD COLUMN     "isExample" BOOLEAN NOT NULL DEFAULT false;
