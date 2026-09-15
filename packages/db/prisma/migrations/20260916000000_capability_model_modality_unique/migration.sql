-- A vendor model_name can serve more than one modality: Kling answers both
-- /v1/videos/text2video and /v1/videos/image2video for `kling-v1-6`, and Seedance's pro
-- models take a text-only or an image-bearing content array under one id. Keying a
-- capability by model alone made it impossible to register the image-to-video half of
-- either vendor.
DROP INDEX "ModelCapability_connectionId_model_key";

-- CreateIndex
CREATE UNIQUE INDEX "ModelCapability_connectionId_model_modality_key" ON "ModelCapability"("connectionId", "model", "modality");
