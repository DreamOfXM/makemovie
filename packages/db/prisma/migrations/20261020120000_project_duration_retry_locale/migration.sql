-- 单镜时长上限 / 每镜重抽上限（语义改变）/ 三档失败处置 / 空间默认内容语言。
--
-- qcMaxAttempts 的旧语义是「总尝试次数（含首次）」，新语义 maxRetriesPerShot 是
-- 「重抽次数（不含首次）」。改名的同时把已有值减 1，保留原行为的等价映射：
--   旧 null（默认总尝试 2 次） -> 新 null（默认重抽 1 次，即总尝试 2 次）＝ 不变
--   旧 1（仅首次）             -> 新 0（不重抽）＝ 不变
--   旧 3（总尝试 3 次）        -> 新 2（重抽 2 次）＝ 不变
-- 迁移不做读时兼容：写完之后代码里不再存在 qcMaxAttempts 的任何读取点。

ALTER TABLE "Project" RENAME COLUMN "qcMaxAttempts" TO "maxRetriesPerShot";

DO $$
DECLARE
  changed integer;
BEGIN
  UPDATE "Project"
     SET "maxRetriesPerShot" = GREATEST("maxRetriesPerShot" - 1, 0)
   WHERE "maxRetriesPerShot" IS NOT NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RAISE NOTICE 'maxRetriesPerShot 语义迁移：% 行被减 1', changed;
END $$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT COALESCE("maxRetriesPerShot"::text, 'null') AS v, count(*) AS n
      FROM "Project"
     GROUP BY 1
     ORDER BY 1
  LOOP
    RAISE NOTICE 'maxRetriesPerShot=% -> % 个项目', r.v, r.n;
  END LOOP;
END $$;

ALTER TABLE "Project" ADD COLUMN "maxShotDurationMs" INTEGER;
ALTER TABLE "Project" ADD COLUMN "retryTechnical" TEXT;
ALTER TABLE "Project" ADD COLUMN "retryConsistency" TEXT;
ALTER TABLE "Project" ADD COLUMN "retryCreative" TEXT;

ALTER TABLE "Organization" ADD COLUMN "defaultContentLocale" TEXT NOT NULL DEFAULT 'zh';
