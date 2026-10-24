-- 重抽三档的「先问」落点：任务在质检/技术失败处停下来等人决定时，把类别、
-- 原因、额度与候选链存进 reviewSnapshot；状态仍是 FAILED（批次因此停住），
-- 人工重抽写 retried，接受豁免写 waived 并把任务翻成 SUCCEEDED（合成只认成功任务）。
ALTER TABLE "GenerationTask" ADD COLUMN "reviewSnapshot" TEXT;
