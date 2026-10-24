-- S2b: a shot that plans longer than its effective ceiling carries the human's decision
-- (same-shot splicing, model switch, or a manual split) next to the shot it belongs to.
ALTER TABLE "Storyboard" ADD COLUMN "durationPlan" JSONB;
