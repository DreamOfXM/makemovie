-- 角色的声音绑定（r10 音频体系）：指向一个音频 artifact（从视频提取/用户上传/TTS 生成的参考音频）。
-- null = 未绑定（台词用视频模型默认声音或全局 TTS）。
ALTER TABLE "Asset" ADD COLUMN "voiceArtifactId" TEXT;
