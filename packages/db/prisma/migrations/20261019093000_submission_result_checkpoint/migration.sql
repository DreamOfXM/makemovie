ALTER TABLE "SubmissionAttempt" ADD COLUMN "resultSnapshot" TEXT, ADD COLUMN "artifactId" TEXT;
ALTER TABLE "CreationRun" ADD COLUMN "inputSnapshot" TEXT, ADD COLUMN "claimToken" TEXT, ADD COLUMN "leaseUntil" TIMESTAMP(3);
