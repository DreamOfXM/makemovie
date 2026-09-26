-- 每镜「字幕文本」：字幕是硬烧进画面的，交付后改不掉，所以文本必须能在人发现
-- 「导入的音频念的不是这句台词」时当场改掉。null = 沿用 storyboard.dialogue，
-- 也就是改动前唯一的取值路径，历史行不需要回填。
ALTER TABLE "Storyboard" ADD COLUMN "subtitleText" TEXT;
