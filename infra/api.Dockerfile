FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/security/package.json packages/security/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @studio/db generate && pnpm --filter @studio/api build
ENV NODE_ENV=production
EXPOSE 4010
CMD ["sh", "-c", "pnpm --filter @studio/db exec prisma migrate deploy && node apps/api/dist/main.js"]
