-- 剧本分镜表的「生成方式」列此前只被解析、从未落库：平台不知道哪些镜头是
-- 字卡/屏幕录制/合成/UI，IMAGE/VIDEO 会把整集 63 镜都排进计费队列。
ALTER TABLE "Storyboard" ADD COLUMN "method" TEXT;
