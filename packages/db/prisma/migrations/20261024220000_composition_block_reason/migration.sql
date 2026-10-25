-- SD-177: 合成阻塞原因落行。worker 抓到异常只写 stderr，界面因此只能显示
-- 「已阻塞」这个没有解释的状态；成功一轮就把上一轮的原因清掉。
ALTER TABLE "Composition" ADD COLUMN     "errorSnapshot" TEXT;
