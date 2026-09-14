# Short Drama Studio

Apache-2.0 | Self-hostable, commercial-ready AI short-drama production platform

Full pipeline from source material to audited deliverable:
`source audit → script → assets → storyboards → first frames → videos → voice/subtitles/music → composition → acceptance → delivery`

## Features

Working today:

- Multi-tenant organizations, projects, episodes, and role-based access control (OWNER / ADMIN / EDITOR / REVIEWER / VIEWER)
- Database-backed sessions with Argon2id password hashing and per-organization switching
- **Model capability center**: provider catalogs, encrypted API keys, entitlement probes, and capability-slot bindings with ordered fallback resolution
- **Source & script versioning**: checksummed source uploads with duplicate detection, explicit approval, and script versions derived from an approved source — approving a script re-points every storyboard of the episode at it, and a script can be edited by hand (an edit resets it to draft for re-approval)
- **Episode assets**: author characters, props, and scenes with a description, generate a reference image for each through the bound image model, and approve the version you want — a succeeded generation becomes a draft asset version linked to its artifact
- **Generation pipeline**: per-stage batches (script, asset, storyboard, image, video, audio) dispatched over BullMQ, resolved through the capability bindings, quality-gated with automatic rework, and streamed back as immutable artifacts
- **AI content generation**: the script and storyboard stages write real generated content back into the episode — the script from the approved source, the storyboard shots from the approved script — each gated on its upstream approval. This is the first phase of a fully automated, human-on-the-loop pipeline
- **Model-driven visual audit** (`STUDIO_QC_MODE=model`): images are judged by the model bound to the `visual_audit` slot and videos by one frame extracted mid-clip. The default gate is still a deterministic hash placeholder that names itself `fake-qc`. Text and audio are **not** audited — they fail the task rather than pretend to pass
- FFmpeg composition of the succeeded video artifacts into a single episode deliverable
- **Acceptance-gated delivery**: packaging refuses an episode the composer could not compose, writes a versioned JSON manifest of every artifact, checksum, and quality count, and records an audited accept or reject
- Artifact storage behind one `Storage` interface with two backends — local disk (the default) and S3-compatible object storage selected by `STORAGE_BACKEND` — injected into the API and the worker rather than constructed by them
- Episode workflow status with validated transitions and an audit trail
- Member management with session revocation on removal
- Web UI with English/Chinese switching
- Provider adapters: Alibaba Cloud Bailian (DashScope) and a mock provider for development and CI
- GitHub Actions CI running typecheck, build, and the full test suite

Designed, not yet built:

- Automatic stage orchestration — one-click end-to-end from an approved source through composition — and downstream regeneration when a script or storyboard is edited
- Storyboard authoring gates (binding approved assets to storyboards) and upstream-approval enforcement for the media (image/video/audio) stages

## Monorepo

- `apps/api` — Fastify API (auth, projects, episodes, members, providers, bindings, generations, source/script versions, assets, deliveries, artifact streaming, audit)
- `apps/web` — Next.js app (projects, generation panel, sources & scripts, assets, deliveries, model center, members; i18n en/zh)
- `apps/worker` — BullMQ consumer running generation tasks, quality gates, and composition
- `packages/domain` — state machines, RBAC matrix, capability slots and bind rules
- `packages/db` — Prisma schema, migrations, and batch status rollup
- `packages/jobs` — queue names and job payload contracts shared by the API and the worker
- `packages/providers` — provider catalogs and adapters (dashscope, mock)
- `packages/security` — Argon2id hashing, token hashing, AES-256-GCM secret encryption
- `packages/media` — object storage (disk and S3 backends), mock media synthesis, and FFmpeg composition
- `packages/config` — typed environment configuration

## Requirements

- Node.js ≥ 22.18 (workspace packages are executed via native TypeScript type stripping)
- pnpm 9
- FFmpeg ≥ 6 on `PATH` (the worker shells out to `ffmpeg`/`ffprobe` for composition); the worker Docker image installs it
- Docker (for PostgreSQL / Redis in local deployment; MinIO too, but only if you set `STORAGE_BACKEND=s3`)

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
6. In the **Sources & scripts** panel, upload the source document, approve it, then derive a script version from the approved source and approve that — approving a script re-points every storyboard of the episode at it, so downstream stages trace one writing.
7. In the **Deliveries** panel, package the episode into a delivery manifest — packaging is refused with reasons until the composition has completed and every storyboard has a succeeded video — then inspect or download the manifest, and accept it or reject it with a reason.

Triggering a stage twice returns the existing batch instead of queueing duplicate work, so a retry needs a new episode.

Use the **Mock Provider** to explore the whole flow without any API key.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `STUDIO_MASTER_KEY` | all-zero dev key | 64-hex AES-256-GCM key for provider secrets; required in production |
| `REDIS_URL` | `redis://localhost:6380` | BullMQ |
| `STORAGE_BACKEND` | `disk` | `disk` stores artifacts under `STUDIO_ARTIFACTS_DIR`; `s3` stores them in an S3-compatible object store |
| `STUDIO_ARTIFACTS_DIR` | `var/artifacts` | the disk backend's root; the worker writes here and the API streams from here, so both processes need the same absolute path (`pnpm dev` sets it, Docker Compose shares a volume). Unused when `STORAGE_BACKEND=s3` |
| `STUDIO_QC_MODE` | `random` | worker quality gate: `pass` accepts every artifact, `fail` rejects every one, `random` scores a hash of the task and attempt against the 0.7 threshold, `model` asks the bound `visual_audit` model to judge it |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | MinIO defaults | used only when `STORAGE_BACKEND=s3`; the bucket must already exist |
| `CORS_ORIGIN` | `http://localhost:3010` | comma-separated allowed origins |
| `SESSION_TTL_MS` | 7 days | session lifetime |
| `PORT` | `4010` | API port |

Production refuses the all-zero development master key.

`STORAGE_BACKEND=s3` expects the bucket to exist already — nothing creates it, so against the compose MinIO you need `mc mb local/studio` before the first generation. The API and the worker read the same setting and must agree on it; if they do not, one of them writes artifacts the other cannot find. And the S3 backend has only ever been exercised against an in-process fake server, because no container runtime was available where it was written — whether a real MinIO or AWS accepts its signature is unverified. See **Storage** in `ARCHITECTURE.md`.

`STUDIO_QC_MODE=model` needs a `vlm` capability probed and bound to the `visual_audit` slot in **Model Center**, and it costs one vision-model call per artifact. Without a verified binding the worker fails the task and records a `QualityCheck` with a null score — it does not fall back to the hash, because a score nobody produced would look like a judgment that happened. The audit's multimodal request has still never been run against a real vision model — the endpoint and message shape are proven live by Qwen-Image generation, but no `qwen-vl` model was available to test the audit direction itself — and the 0.7 threshold is inherited from the placeholder rather than measured. See **Quality gates** in `ARCHITECTURE.md`.

DashScope image generation is different: the Qwen-Image path (`qwen-image-3.0` and `qwen-image-3.0-pro` in the catalog) has been run against the live Bailian API and produced real images, end-to-end through the asset flow. The async wanx image models, video generation, and the VLM audit are in the catalog but have not been run live.

## Tests

```bash
pnpm test
```

API integration tests boot an embedded PostgreSQL, apply real migrations, and exercise auth, RBAC, tenant isolation, the state machine, audit trail, the model capability center, generation batches, artifact streaming, source and script versioning, and acceptance-gated deliveries end to end — no Docker required. Worker tests cover candidate fallback, the quality gate with rework attempts, the model-driven visual audit (a missing or unverified auditor, a rejected artifact, an approved image and an approved video frame, and a provider fault), and composition, and shell out to a real `ffmpeg`. Media tests cover both storage backends — the disk one against a temporary directory, the S3 one against an in-process fake server, which is as far as it can be tested without a real object store. No test calls a live multimodal provider; the auditor in the tests is the mock, which answers a fixed score it has not earned by looking at anything.

## Documentation

- `ARCHITECTURE.md` — domain model, model capability center, state machine, capability policy, queue design, quality gates, storage, security
- `CONTRIBUTING.md` — development workflow, testing, and pull-request checklist
- `docs/skills/short-drama-production/SKILL.md` — the production methodology the pipeline encodes

## License

Apache-2.0
