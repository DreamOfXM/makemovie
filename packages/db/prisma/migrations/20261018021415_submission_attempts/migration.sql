-- CreateTable
CREATE TABLE "SubmissionAttempt" (
    "id" TEXT NOT NULL,
    "taskId" TEXT,
    "operationId" TEXT,
    "attemptNumber" INTEGER NOT NULL,
    "requestKey" TEXT,
    "providerTaskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "resolution" TEXT,
    "errorSnapshot" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubmissionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubmissionAttempt_taskId_idx" ON "SubmissionAttempt"("taskId");

-- CreateIndex
CREATE INDEX "SubmissionAttempt_operationId_idx" ON "SubmissionAttempt"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionAttempt_taskId_attemptNumber_key" ON "SubmissionAttempt"("taskId", "attemptNumber");
