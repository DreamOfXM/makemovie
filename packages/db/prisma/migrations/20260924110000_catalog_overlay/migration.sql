-- CreateTable
CREATE TABLE "CatalogHidden" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogHidden_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogCustomModel" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "displayName" TEXT,
    "modality" TEXT NOT NULL,
    "acceptsFirstFrame" BOOLEAN NOT NULL DEFAULT false,
    "acceptsReferenceImages" BOOLEAN NOT NULL DEFAULT false,
    "maxReferenceImages" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogCustomModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CatalogHidden_organizationId_provider_model_key" ON "CatalogHidden"("organizationId", "provider", "model");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogCustomModel_organizationId_provider_model_modality_key" ON "CatalogCustomModel"("organizationId", "provider", "model", "modality");

-- AddForeignKey
ALTER TABLE "CatalogHidden" ADD CONSTRAINT "CatalogHidden_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogCustomModel" ADD CONSTRAINT "CatalogCustomModel_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

