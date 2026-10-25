-- SD-039/SD-135: 记账绑受理而不是绑质检结论。一行账对应一次提交，
-- attemptId 的唯一性就是「同一提交不重复记账」的机器闸门（重投与重审复用同一 attempt 行）。
ALTER TABLE "UsageLedger" ADD COLUMN     "attemptId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "UsageLedger_attemptId_key" ON "UsageLedger"("attemptId");
