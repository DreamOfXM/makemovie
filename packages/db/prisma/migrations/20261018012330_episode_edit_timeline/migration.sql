-- CreateTable
CREATE TABLE "EpisodeEdit" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "headRevision" INTEGER NOT NULL DEFAULT 0,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EpisodeEdit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EpisodeEditRevision" (
    "id" TEXT NOT NULL,
    "editId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "fpsNum" INTEGER NOT NULL,
    "fpsDen" INTEGER NOT NULL,
    "outputSpec" TEXT NOT NULL DEFAULT '{}',
    "clips" TEXT NOT NULL DEFAULT '[]',
    "tracks" TEXT NOT NULL DEFAULT '[]',
    "fingerprint" TEXT NOT NULL,
    "author" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EpisodeEditRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EditMedia" (
    "id" TEXT NOT NULL,
    "originalArtifactId" TEXT NOT NULL,
    "normalizedArtifactId" TEXT NOT NULL,
    "conformPolicyVersion" INTEGER NOT NULL DEFAULT 1,
    "fpsNum" INTEGER NOT NULL,
    "fpsDen" INTEGER NOT NULL,
    "frameCount" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EditMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeEdit_episodeId_key" ON "EpisodeEdit"("episodeId");

-- CreateIndex
CREATE INDEX "EpisodeEdit_organizationId_idx" ON "EpisodeEdit"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeEditRevision_editId_revision_key" ON "EpisodeEditRevision"("editId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "EditMedia_originalArtifactId_fpsNum_fpsDen_conformPolicyVer_key" ON "EditMedia"("originalArtifactId", "fpsNum", "fpsDen", "conformPolicyVersion");

-- AddForeignKey
ALTER TABLE "EpisodeEdit" ADD CONSTRAINT "EpisodeEdit_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodeEditRevision" ADD CONSTRAINT "EpisodeEditRevision_editId_fkey" FOREIGN KEY ("editId") REFERENCES "EpisodeEdit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
