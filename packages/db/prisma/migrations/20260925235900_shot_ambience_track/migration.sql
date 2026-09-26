-- 每镜「环境音」：一条可导入的氛围声，混在配音下面。
-- 它与 audioSource 正交——声音来源决定这一镜的人声从哪来，这一列决定配音底下垫什么，
-- 所以「只用配音」+ 导入环境音 = 配音 + 环境音，不必赌模型原声里有没有它自己念的词。
ALTER TABLE "Storyboard" ADD COLUMN "importedAmbienceArtifactId" TEXT;
