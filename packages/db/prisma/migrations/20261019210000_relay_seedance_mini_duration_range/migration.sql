-- 中转站（好猫 Token）的 seedance-2.0-mini 上游是 Seedance 2.0 系列，官方接受 4–15 秒。
-- 2026-10-19 产品决定修正：15 秒是单镜规划上限，不是每镜必须买满的固定值——短反应按
-- 剧情需要买 4–15 秒，长内容在分镜层拆镜。故把上一条人工预设从 fixed 15 改为 range 4–15。
--
-- 这是人工预设，不是厂商验证过的能力声明。只改上一条自己写入的那个值：任何其他已声明
-- 时长的行（含手工添加）不被覆盖。若中转站拒绝范围内的某个值，改这一行即可，不碰适配器。
UPDATE "ModelCapability"
SET spec = jsonb_set(spec, '{duration}', '{"kind": "range", "min": 4, "max": 15}'::jsonb, true)
WHERE model = 'seedance-2.0-mini'
  AND modality IN ('t2v', 'i2v', 'r2v')
  AND spec -> 'duration' = '{"kind": "fixed", "value": 15}'::jsonb;
