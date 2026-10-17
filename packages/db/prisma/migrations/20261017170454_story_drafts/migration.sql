-- CreateTable
CREATE TABLE "StoryDraft" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT,
    "storyText" TEXT NOT NULL,
    "recipeKey" TEXT,
    "recipeVersion" INTEGER,
    "styleId" TEXT,
    "contentLocale" TEXT,
    "targetDurationMs" INTEGER,
    "consumedProjectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoryDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoryDraft_organizationId_idx" ON "StoryDraft"("organizationId");

-- AddForeignKey
ALTER TABLE "StoryDraft" ADD CONSTRAINT "StoryDraft_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
