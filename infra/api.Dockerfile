# MakeMovie API。bookworm-slim 而非 alpine：Prisma 引擎在 musl 上要另配 openssl，
# slim 上 apt 一步到位。运行时依赖 @studio/* 的 TS 源（Node ≥22.18 原生类型剥离），
# 镜像带整个 workspace。启动前先跑迁移——单容器部署不需要额外的 migrate 步骤。
FROM node:22-bookworm-slim AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app
RUN corepack enable \
  && pnpm config set registry ${NPM_REGISTRY} \
  && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages packages
COPY apps/api apps/api
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @studio/db generate \
  && pnpm --filter @studio/providers build \
  && pnpm --filter @studio/api build

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
COPY --from=build /root/.cache/prisma /root/.cache/prisma
COPY --from=build /root/.cache/node/corepack /root/.cache/node/corepack
COPY --from=build /app /app
ENV NODE_ENV=production STUDIO_ARTIFACTS_DIR=/var/lib/studio/artifacts
RUN mkdir -p /var/lib/studio/artifacts
EXPOSE 4010
# 启动三步：生成 Prisma 客户端（层间路径解析不承诺保留生成物）→ 迁移 → 起 API。
CMD ["sh", "-c", "pnpm --filter @studio/db generate && pnpm --filter @studio/db exec prisma migrate deploy && pnpm --filter @studio/api exec tsx src/main.ts"]
