-- 项目级审计重抽上限（用户拍板 C+B：重抽带否决原因 + 上限可调）。
-- null = 全局默认 2；每抽一次都计一次生成费，花几次由项目主人说了算。
ALTER TABLE "Project" ADD COLUMN "qcMaxAttempts" INTEGER;
