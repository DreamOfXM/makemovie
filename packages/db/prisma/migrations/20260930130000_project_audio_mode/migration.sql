-- 项目语音模式（r10 音频体系）：null = video_native（默认），voice_clone = 用角色绑定音色。
ALTER TABLE "Project" ADD COLUMN "audioMode" TEXT;
