-- 首帧与配音的钦定指针（与 selectedVideoArtifactId 同族）：
-- null = 自动取最新成功版（现状行为），指针 = 人选定的那一版。
-- 首帧指针决定视频生成的条件帧；配音指针决定合成时的音轨。读侧校验归属，
-- 悬空（版本被删/跨镜）即回退自动规则。
ALTER TABLE "Storyboard" ADD COLUMN "selectedFrameArtifactId" TEXT;
ALTER TABLE "Storyboard" ADD COLUMN "selectedVoiceArtifactId" TEXT;
