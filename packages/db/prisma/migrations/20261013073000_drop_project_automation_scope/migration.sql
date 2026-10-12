-- 撤掉 automationScope：它是「做多少」那一轴（lean/full），但流水线、worker 与 API
-- 读侧都没有任何一行读它——选了 lean 与选了 full，跑出来的东西和账单完全一样。
-- 一个说了不做、也不影响花费的开关比没有开关更坏：它让用户以为自己在控制范围。
--
-- 该列自加入起从未被读取，也没有回填过数据，删除不影响任何既有项目的运行结果。
ALTER TABLE "Project" DROP COLUMN "automationScope";
