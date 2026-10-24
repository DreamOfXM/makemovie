-- The catalog used to describe accepted clip lengths as a bare `durations` array, and that
-- shape carried two incompatible meanings: `[2, 15]` for Wan read as "any whole number in
-- between", `[5, 10]` for Kling read as "5 or 10, nothing between". No array reveals which
-- rule produced it, so each legacy value is translated here by name rather than inferred,
-- and the result is the declared shape `packages/domain/src/duration.ts` reads.
--
-- Rows whose `durations` array is not one of the eight below keep the old key and gain no
-- `duration`: they are left undeclared, which the worker records per task as
-- `duration=vendor-default` in the execution log. Deleting the unrecognised array would
-- destroy the only evidence an operator has to write the right declaration.

UPDATE "ModelCapability" SET spec = jsonb_set(spec - 'durations', '{duration}', '{"kind":"fixed","value":5}')::jsonb
  WHERE spec ? 'durations' AND spec -> 'durations' = '[5]'::jsonb;

UPDATE "ModelCapability" SET spec = jsonb_set(spec - 'durations', '{duration}', '{"kind":"range","min":2,"max":12}')::jsonb
  WHERE spec ? 'durations' AND spec -> 'durations' = '[2,12]'::jsonb;

UPDATE "ModelCapability" SET spec = jsonb_set(spec - 'durations', '{duration}', '{"kind":"range","min":2,"max":15}')::jsonb
  WHERE spec ? 'durations' AND spec -> 'durations' = '[2,15]'::jsonb;

UPDATE "ModelCapability" SET spec = jsonb_set(spec - 'durations', '{duration}', '{"kind":"range","min":2,"max":30}')::jsonb
  WHERE spec ? 'durations' AND spec -> 'durations' = '[2,30]'::jsonb;

UPDATE "ModelCapability" SET spec = jsonb_set(spec - 'durations', '{duration}', '{"kind":"range","min":4,"max":15}')::jsonb
  WHERE spec ? 'durations' AND spec -> 'durations' = '[4,15]'::jsonb;

UPDATE "ModelCapability" SET spec = jsonb_set(spec - 'durations', '{duration}', '{"kind":"range","min":4,"max":30}')::jsonb
  WHERE spec ? 'durations' AND spec -> 'durations' = '[4,30]'::jsonb;

UPDATE "ModelCapability" SET spec = jsonb_set(spec - 'durations', '{duration}', '{"kind":"steps","values":[5,10]}')::jsonb
  WHERE spec ? 'durations' AND spec -> 'durations' = '[5,10]'::jsonb;

UPDATE "ModelCapability" SET spec = jsonb_set(spec - 'durations', '{duration}', '{"kind":"steps","values":[4,6,8]}')::jsonb
  WHERE spec ? 'durations' AND spec -> 'durations' = '[4,6,8]'::jsonb;
