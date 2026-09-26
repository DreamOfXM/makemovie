-- 每镜「声音来源」:配音/原声/两者叠加/人工导入,由人当场选。
-- null 表示按镜型默认(有台词=只用配音,无台词=只用原声),默认规则写在代码里而不是
-- 数据库,这样翻默认不需要回填历史行。
CREATE TYPE "AudioSource" AS ENUM ('VOICE', 'NATIVE', 'VOICE_NATIVE', 'IMPORTED');

ALTER TABLE "Storyboard" ADD COLUMN "audioSource" "AudioSource";
-- 导入的音频文件(裸 id,读侧校验归属,悬空即回退到该档的其它来源)。
ALTER TABLE "Storyboard" ADD COLUMN "importedVoiceArtifactId" TEXT;

-- 导入件不挂任何生成任务,只能靠镜头归属被找回来(版本号也按它累计)。
ALTER TABLE "MediaArtifact" ADD COLUMN "storyboardId" TEXT;
CREATE INDEX "MediaArtifact_storyboardId_stage_idx" ON "MediaArtifact"("storyboardId", "stage");

-- 镜头被重新拆分时留文件、断引用:导入的音频是人提供的素材,不该随分镜行一起消失。
ALTER TABLE "MediaArtifact"
  ADD CONSTRAINT "MediaArtifact_storyboardId_fkey" FOREIGN KEY ("storyboardId")
  REFERENCES "Storyboard"("id") ON DELETE SET NULL ON UPDATE CASCADE;
