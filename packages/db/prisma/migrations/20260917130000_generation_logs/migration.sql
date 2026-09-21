-- 执行日志:每个生成任务的全程打点(候选尝试/提交/质检/跳过/成败),可查询可追溯。
CREATE TABLE "GenerationLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GenerationLog_taskId_createdAt_idx" ON "GenerationLog"("taskId", "createdAt");
CREATE INDEX "GenerationLog_organizationId_createdAt_idx" ON "GenerationLog"("organizationId", "createdAt");
