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
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
COPY --from=build /root/.cache/prisma /root/.cache/prisma
COPY --from=build /root/.cache/node/corepack /root/.cache/node/corepack
COPY --from=build /app /app
ENV NODE_ENV=production STUDIO_ARTIFACTS_DIR=/var/lib/studio/artifacts
RUN mkdir -p /var/lib/studio/artifacts
# 运行时走 tsx（与开发态一致）：@studio/* 的 exports 指向 TS 源，
# 源内 .js 导入约定只有 tsx 会重写，裸 node 的类型剥离不认。
CMD ["sh", "-c", "pnpm --filter @studio/db generate && pnpm --filter @studio/worker exec tsx src/main.ts"]
