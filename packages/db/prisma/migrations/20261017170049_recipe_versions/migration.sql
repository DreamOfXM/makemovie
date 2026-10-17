-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "recipeKey" TEXT,
ADD COLUMN     "recipeSnapshot" TEXT,
ADD COLUMN     "recipeVersion" INTEGER;

-- CreateTable
CREATE TABLE "RecipeVersion" (
    "id" TEXT NOT NULL,
    "recipeKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "spec" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecipeVersion_recipeKey_version_key" ON "RecipeVersion"("recipeKey", "version");
