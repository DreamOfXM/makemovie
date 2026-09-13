FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @studio/web build
ENV NODE_ENV=production
EXPOSE 3010
CMD ["pnpm", "--filter", "@studio/web", "start", "-p", "3010"]
