# Short Drama Studio

Apache-2.0 | 自托管、可商业化的 AI 短剧生产平台

从原文审计到交付的完整链路：`source audit → script → assets → storyboards → first frames → videos → voice/subtitles/music → composition → acceptance → delivery`

Skill: `docs/skills/short-drama-production/SKILL.md`

## Monorepo

- `apps/api` Fastify API
- `apps/web` Next.js
- `apps/worker` BullMQ
- `packages/domain` 状态机与能力校验
- `packages/db` Prisma + PostgreSQL
- `packages/providers` Provider 适配
- `packages/media` 媒体处理
- `packages/config` 配置

## Quick start

```bash
pnpm install
pnpm --filter @studio/db generate
pnpm typecheck
pnpm build
docker compose up -d
```
