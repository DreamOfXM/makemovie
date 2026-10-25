-- 单镜/单素材的修复触发不是链路的一步：它完成时不得接力下一阶段。
-- 存量任务全部来自整阶段触发，按 true 回填；点名镜头的触发会在建任务时写 false。
ALTER TABLE "GenerationTask" ADD COLUMN "relayEligible" BOOLEAN NOT NULL DEFAULT true;
