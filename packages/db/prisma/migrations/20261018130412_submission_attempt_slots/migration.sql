-- DropIndex
DROP INDEX "SubmissionAttempt_taskId_attemptNumber_key";

-- AlterTable
ALTER TABLE "SubmissionAttempt" ADD COLUMN     "capabilityId" TEXT,
ADD COLUMN     "connectionId" TEXT,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "promptChars" INTEGER,
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "slot" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionAttempt_taskId_attemptNumber_slot_key" ON "SubmissionAttempt"("taskId", "attemptNumber", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionAttempt_operationId_attemptNumber_key" ON "SubmissionAttempt"("operationId", "attemptNumber");
