-- CreateEnum
CREATE TYPE "ProjectFormat" AS ENUM ('SHORT_DRAMA', 'SERIES', 'FILM');

-- DropIndex
DROP INDEX "ProjectAsset_projectId_idx";

-- AlterTable
ALTER TABLE "Episode" ADD COLUMN     "targetDurationMs" INTEGER;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "format" "ProjectFormat" NOT NULL DEFAULT 'SHORT_DRAMA';

-- CreateTable
CREATE TABLE "ProjectSourceVersion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectSourceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceSegment" (
    "id" TEXT NOT NULL,
    "projectSourceVersionId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "title" TEXT,
    "marked" BOOLEAN NOT NULL DEFAULT true,
    "content" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SegmentAllocation" (
    "id" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "episodeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SegmentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSourceVersion_projectId_version_key" ON "ProjectSourceVersion"("projectId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "SourceSegment_projectSourceVersionId_index_key" ON "SourceSegment"("projectSourceVersionId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "SegmentAllocation_segmentId_key" ON "SegmentAllocation"("segmentId");

-- AddForeignKey
ALTER TABLE "ProjectSourceVersion" ADD CONSTRAINT "ProjectSourceVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceSegment" ADD CONSTRAINT "SourceSegment_projectSourceVersionId_fkey" FOREIGN KEY ("projectSourceVersionId") REFERENCES "ProjectSourceVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentAllocation" ADD CONSTRAINT "SegmentAllocation_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "SourceSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentAllocation" ADD CONSTRAINT "SegmentAllocation_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAssetVersion" ADD CONSTRAINT "ProjectAssetVersion_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "MediaArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
