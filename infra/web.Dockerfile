# MakeMovie 控制台（Next standalone）。
# /api 代理目标在构建期决定：镜像默认指向 compose 服务名 api ——
# 自定义部署改 build-arg API_ORIGIN（如 http://localhost:4010）。
FROM node:22-bookworm-slim AS build
ARG API_ORIGIN=http://api:4010
ARG NEXT_PUBLIC_API_URL=/api
ENV API_ORIGIN=${API_ORIGIN} NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app
RUN corepack enable \
  && pnpm config set registry ${NPM_REGISTRY}
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages packages
COPY apps/web apps/web
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @studio/db generate \
  && pnpm --filter @studio/web build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3010 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3010
CMD ["node", "apps/web/server.js"]
