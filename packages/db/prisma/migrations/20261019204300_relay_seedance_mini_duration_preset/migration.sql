-- 中转站（好猫 Token）提供的 seedance-2.0-mini 没有可信的可选时长清单。2026-10-19
-- 产品决定：一律按 15 秒购买，故该能力行声明 {kind:"fixed",value:15}。worker 会对每一镜
-- 发 duration=15；镜头计划秒数不是 15 时，执行日志同时写 durationAsked=<计划秒数>。
--
-- 这是人工预设，不是厂商验证过的能力声明。若中转站拒绝 15 秒，改这一行（或本预设）即可，
-- 不碰适配器。只填空白：任何已经声明过时长的行不被覆盖。
UPDATE "ModelCapability"
SET spec = jsonb_set(COALESCE(spec, '{}'::jsonb), '{duration}', '{"kind": "fixed", "value": 15}'::jsonb, true)
WHERE model = 'seedance-2.0-mini'
  AND modality IN ('t2v', 'i2v', 'r2v')
  AND COALESCE(spec, '{}'::jsonb) -> 'duration' IS NULL;
