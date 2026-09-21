-- The connection probe used to stamp entitlementVerifiedAt on every capability based on
-- one credential ping (a hardcoded qwen-turbo call) that never addressed those models.
-- A nonexistent model name therefore wore a verified badge until a real generation
-- failed. Carry the old stamps over as what they actually proved, then revoke the
-- entitlement claim: per-model probes and first real generations re-earn it one
-- addressed call at a time.
ALTER TABLE "ModelCapability" ADD COLUMN "credentialVerifiedAt" TIMESTAMP(3);
UPDATE "ModelCapability" SET "credentialVerifiedAt" = "entitlementVerifiedAt";
UPDATE "ModelCapability" SET "entitlementVerifiedAt" = NULL;
