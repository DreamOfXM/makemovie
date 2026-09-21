-- 角色中台地基:素材身份上提到项目级,集级 Asset 通过 projectAssetId 链接到全局库。
-- 同一角色跨集复用同一份身份与参考图历史,而不是每集重建。
CREATE TABLE "ProjectAsset" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
    "generationTaskId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectAssetVersion" (
    "id" TEXT NOT NULL,
    "projectAssetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "promptSnapshot" TEXT,
    "artifactId" TEXT,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',

    CONSTRAINT "ProjectAssetVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectAsset_projectId_kind_name_key" ON "ProjectAsset"("projectId", "kind", "name");
CREATE UNIQUE INDEX "ProjectAssetVersion_projectAssetId_version_key" ON "ProjectAssetVersion"("projectAssetId", "version");

CREATE INDEX "ProjectAsset_projectId_idx" ON "ProjectAsset"("projectId");

ALTER TABLE "ProjectAsset" ADD CONSTRAINT "ProjectAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectAssetVersion" ADD CONSTRAINT "ProjectAssetVersion_projectAssetId_fkey" FOREIGN KEY ("projectAssetId") REFERENCES "ProjectAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Asset" ADD COLUMN "projectAssetId" TEXT;
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_projectAssetId_fkey" FOREIGN KEY ("projectAssetId") REFERENCES "ProjectAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
