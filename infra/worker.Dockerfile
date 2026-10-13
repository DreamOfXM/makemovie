# MakeMovie worker：与 api 同构，外加合成用的 ffmpeg。
FROM node:22-bookworm-slim AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app
RUN corepack enable \
  && pnpm config set registry ${NPM_REGISTRY} \
  && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages packages
COPY apps/worker apps/worker
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @studio/db generate \
  && pnpm --filter @studio/providers build \
  && pnpm --filter @studio/worker build

FROM node:22-bookworm-slim
WORKDIR /app
# fonts-noto-cjk：显式角标要烧中文，而 @studio/media 的候选路径找的正是
# NotoSansCJK-Regular.ttc。容器里没有 CJK 字体时角标会被记为 skipped，
# GB 45438-2025 的显式标识就落空了——红线级缺口，不能等成片才发现。
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates ffmpeg fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/* \
  && test -n "$(find /usr/share/fonts -name 'NotoSansCJK-Regular.ttc' -print -quit)" \
  && corepack enable
COPY --from=build /root/.cache/prisma /root/.cache/prisma
COPY --from=build /root/.cache/node/corepack /root/.cache/node/corepack
COPY --from=build /app /app
ENV NODE_ENV=production STUDIO_ARTIFACTS_DIR=/var/lib/studio/artifacts STUDIO_SECRETS_DIR=/var/lib/studio/secrets
RUN mkdir -p /var/lib/studio/artifacts /var/lib/studio/secrets
# 运行时走 tsx（与开发态一致）：@studio/* 的 exports 指向 TS 源，
# 源内 .js 导入约定只有 tsx 会重写，裸 node 的类型剥离不认。
CMD ["sh", "-c", "pnpm --filter @studio/db generate && pnpm --filter @studio/worker exec tsx src/main.ts"]
