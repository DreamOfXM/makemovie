-- 剧本层节奏契约（plan_2026-10-24 §3）：
-- Project.shotRhythm 是项目级阈值（JSON），ScriptVersion.rhythm 是批准时的量测快照。
ALTER TABLE "Project" ADD COLUMN "shotRhythm" TEXT;
ALTER TABLE "ScriptVersion" ADD COLUMN "rhythm" TEXT;
