FROM node:22-alpine
WORKDIR /app
RUN corepack enable && apk add --no-cache ffmpeg
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/jobs/package.json packages/jobs/package.json
COPY packages/media/package.json packages/media/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/security/package.json packages/security/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @studio/db generate \
  && pnpm --filter @studio/providers build \
  && pnpm --filter @studio/worker build
ENV NODE_ENV=production \
    STUDIO_ARTIFACTS_DIR=/var/lib/studio/artifacts
RUN mkdir -p /var/lib/studio/artifacts
VOLUME /var/lib/studio/artifacts
CMD ["node", "apps/worker/dist/main.js"]
