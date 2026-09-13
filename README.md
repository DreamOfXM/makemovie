# Short Drama Studio

Apache-2.0 | Self-hostable, commercial-ready AI short-drama production platform

Full pipeline from source material to audited deliverable:
`source audit → script → assets → storyboards → first frames → videos → voice/subtitles/music → composition → acceptance → delivery`

## Features

Working today:

- Multi-tenant organizations, projects, episodes, and role-based access control (OWNER / ADMIN / EDITOR / REVIEWER / VIEWER)
- Database-backed sessions with Argon2id password hashing and per-organization switching
- **Model capability center**: provider catalogs, encrypted API keys, entitlement probes, and capability-slot bindings with ordered fallback resolution
- **Generation pipeline**: per-stage batches (script, storyboard, image, video, audio) dispatched over BullMQ, resolved through the capability bindings, quality-gated with automatic rework, and streamed back as immutable artifacts
- FFmpeg composition of the succeeded video artifacts into a single episode deliverable
- Episode workflow status with validated transitions and an audit trail
- Member management with session revocation on removal
- Web UI with English/Chinese switching
- Provider adapters: Alibaba Cloud Bailian (DashScope) and a mock provider for development and CI
- GitHub Actions CI running typecheck, build, and the full test suite

Designed, not yet built:

- Source document versioning and upstream-approval gating for the script, asset, and storyboard stages
- Acceptance review and delivery manifests

## Monorepo

- `apps/api` — Fastify API (auth, projects, episodes, members, providers, bindings, generations, artifact streaming, audit)
- `apps/web` — Next.js app (projects, generation panel, model center, members; i18n en/zh)
- `apps/worker` — BullMQ consumer running generation tasks, quality gates, and composition
- `packages/domain` — state machines, RBAC matrix, capability slots and bind rules
- `packages/db` — Prisma schema, migrations, and batch status rollup
- `packages/jobs` — queue names and job payload contracts shared by the API and the worker
- `packages/providers` — provider catalogs and adapters (dashscope, mock)
- `packages/security` — Argon2id hashing, token hashing, AES-256-GCM secret encryption
- `packages/media` — disk object storage, mock media synthesis, and FFmpeg composition
- `packages/config` — typed environment configuration

## Requirements

- Node.js ≥ 22.18 (workspace packages are executed via native TypeScript type stripping)
- pnpm 9
- FFmpeg ≥ 6 on `PATH` (the worker shells out to `ffmpeg`/`ffprobe` for composition); the worker Docker image installs it
- Docker (for PostgreSQL / Redis / MinIO in local deployment)

## Quick start

```bash
pnpm install
pnpm --filter @studio/db generate
pnpm typecheck
pnpm build
docker compose up -d          # postgres, redis, minio
pnpm --filter @studio/db exec prisma migrate deploy
pnpm dev                      # api :4010, web :3010, worker
```

Open http://localhost:3010, create a workspace, then configure models in **Model Center**:

1. Add a provider connection (API keys are encrypted at rest with `STUDIO_MASTER_KEY`).
2. Run **Probe entitlements** to verify which models your key can actually use.
3. Bind verified models to capability slots (script, storyboard, image, video T2V/I2V/R2V, voice, music, visual audit). Project-level bindings override organization-level ones; `Resolve candidates` shows the ordered fallback list the pipeline will use.
4. Open a project, select an episode, and use the **Generation** panel: pick a stage and **Trigger generation**. Each task runs through the resolved candidates, is quality-gated (up to three attempts), and its artifacts become previewable in the panel while it polls for status.
5. **Compose episode** concatenates the newest succeeded video artifact of every storyboard into a single deliverable.

Triggering a stage twice returns the existing batch instead of queueing duplicate work, so a retry needs a new episode.

Use the **Mock Provider** to explore the whole flow without any API key.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `STUDIO_MASTER_KEY` | all-zero dev key | 64-hex AES-256-GCM key for provider secrets; required in production |
| `REDIS_URL` | `redis://localhost:6380` | BullMQ |
| `STUDIO_ARTIFACTS_DIR` | `var/artifacts` | generated-media root; the worker writes here and the API streams from here, so both processes need the same absolute path (`pnpm dev` sets it, Docker Compose shares a volume) |
| `STUDIO_QC_MODE` | `random` | worker quality gate: `pass` accepts every artifact, `fail` rejects every one, `random` scores a hash of the task and attempt against the 0.7 threshold |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | MinIO defaults | object storage |
| `CORS_ORIGIN` | `http://localhost:3010` | comma-separated allowed origins |
| `SESSION_TTL_MS` | 7 days | session lifetime |
| `PORT` | `4010` | API port |

Production refuses the all-zero development master key.

## Tests

```bash
pnpm test
```

API integration tests boot an embedded PostgreSQL, apply real migrations, and exercise auth, RBAC, tenant isolation, the state machine, audit trail, the model capability center, generation batches, and artifact streaming end to end — no Docker required. Worker tests cover candidate fallback, the quality gate with rework attempts, and composition, and shell out to a real `ffmpeg`.

## Documentation

- `ARCHITECTURE.md` — domain model, model capability center, state machine, capability policy, queue design, quality gates, security
- `CONTRIBUTING.md` — development workflow, testing, and pull-request checklist
- `docs/skills/short-drama-production/SKILL.md` — the production methodology the pipeline encodes

## License

Apache-2.0
