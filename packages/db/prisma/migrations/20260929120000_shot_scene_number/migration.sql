-- 镜头的场次归属（r06·A 场景主帧的前提）：null = 旧数据无场次信息，不参与主帧逻辑。
-- 场次内首镜（编号最小者）的钦定首帧升格为该场主帧，场内其余镜生成首帧时作参考图。
ALTER TABLE "Storyboard" ADD COLUMN "sceneNumber" INTEGER;
