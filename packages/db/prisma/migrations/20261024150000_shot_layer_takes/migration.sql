-- 分镜层（plan_2026-10-24 §3）+ 连续段（§4.4）+ 时长证据（§4.2）+ 母带实测时长（S5）。
ALTER TABLE "Storyboard"
  ADD COLUMN "shotRole" TEXT,
  ADD COLUMN "transition" TEXT NOT NULL DEFAULT 'cut',
  ADD COLUMN "transitionMs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lines" JSONB,
  ADD COLUMN "ambience" TEXT;

ALTER TABLE "ModelCapability" ADD COLUMN "durationEvidence" JSONB;
ALTER TABLE "Composition" ADD COLUMN "durationMs" INTEGER;

CREATE TABLE "ShotTake" (
  "id" TEXT NOT NULL,
  "storyboardId" TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  "plannedMs" INTEGER NOT NULL,
  "promptDelta" TEXT NOT NULL DEFAULT '',
  "firstFrameArtifactId" TEXT,
  "endFrameArtifactId" TEXT,
  "videoArtifactId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "selected" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShotTake_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ShotTake_storyboardId_order_key" ON "ShotTake"("storyboardId", "order");
CREATE INDEX "ShotTake_storyboardId_idx" ON "ShotTake"("storyboardId");
ALTER TABLE "ShotTake" ADD CONSTRAINT "ShotTake_storyboardId_fkey"
  FOREIGN KEY ("storyboardId") REFERENCES "Storyboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 存量集：每镜一个 artifact 包成 order=1 的唯一 take（plan §4.4 迁移口径）。
-- 只包已选/最新的成功视频；未出片的镜头不造空 take。
INSERT INTO "ShotTake" ("id", "storyboardId", "order", "plannedMs", "videoArtifactId", "status", "selected", "updatedAt")
SELECT 'legacy-' || "id", "id", 1, "durationMs", "selectedVideoArtifactId", 'SUCCEEDED', true, CURRENT_TIMESTAMP
FROM "Storyboard"
WHERE "selectedVideoArtifactId" IS NOT NULL;
