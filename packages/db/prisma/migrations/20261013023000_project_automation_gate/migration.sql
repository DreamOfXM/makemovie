-- 制作档位的两个轴，取值见 @studio/domain 的 automationScopes / automationGates。
--
-- 两列都可空，且刻意不加默认值：null 分别按 full 与 beforeSpend 解释，也就是引入
-- 档位之前的行为。于是这次迁移不改变任何既有项目的运行结果——新增的只是两种此前
-- 够不着的能力（lean 与 auto）。回填成显式值反而会让"当时是什么档"这件事失真。
ALTER TABLE "Project" ADD COLUMN "automationScope" TEXT;
ALTER TABLE "Project" ADD COLUMN "automationGate" TEXT;
