# MakeMovie

**AI film & video production platform — from source text to an audited, delivered master.**

English | [中文](./README.zh-CN.md)

Apache-2.0 · Self-hostable · One pipeline for short dramas, films, and long-form video:

`source audit → script → assets → storyboards → first frames → videos → composition → acceptance → delivery`

MakeMovie turns a piece of source writing — a novel excerpt, a treatment, a screenplay — into a finished episode master through an automated, traceable pipeline. Upload the source and approve it; the platform writes the shooting script, breaks it into shots, extracts the cast, props and scenes, generates reference images, first frames and clips, composes the master, and packages a delivery manifest. Every step is viewable, editable and traceable to the model run that produced it, and a human approval is the checkpoint between spending and shipping.

## Features

**Platform**

- Multi-tenant organizations, projects and episodes with role-based access control (OWNER / ADMIN / EDITOR / REVIEWER / VIEWER)
- Database-backed sessions with Argon2id password hashing, per-organization switching, and member management with session revocation
- Full audit trail of state transitions and privileged actions
- Web console with English / Chinese interface

**Model capability center**

- Provider catalogs with capability slots: script text, storyboard text, image generation, video (T2V / I2V / R2V), voice, music, and visual audit
- Provider API keys encrypted at rest (AES-256-GCM) and never returned by read endpoints
- Entitlement probes that verify which models a key can actually call before you bind them
- Slot bindings with ordered fallback candidates; project-level bindings override organization-level ones

**Production pipeline**

- Source and script versioning with checksums, duplicate detection, and explicit approval gates
- AI content generation: the script is written from the approved source, the shot list and the cast/props/scenes are extracted from the approved script — each stage gated on its upstream approval
- Episode assets with generated reference images, approval as the likeness, and bindings to the shots that use them
- Per-stage generation batches dispatched over BullMQ with idempotent triggers, candidate fallback, and automatic rework on quality rejection
- Automated orchestration: a completed batch relays the next stage on its own, from script to composed master; **Advance pipeline** remains available for manual stepping
- Edit and regenerate: every stage's output stays editable; re-running a stage produces a new revision while prior revisions are kept for traceability
- Script-approval cascade: approving an edited script regenerates the breakdown as a new shot revision, supersedes the shots it replaces, re-runs their media, and re-cuts the master
- FFmpeg composition of each shot's own succeeded clip into a single episode master
- Acceptance-gated delivery: a versioned JSON manifest listing every shot's artifacts with checksums, beside the master and the quality counts
- Artifact storage behind one interface with local-disk and S3-compatible backends
- Traceability: every generated script, shot, asset and artifact records the task, prompt, provider, model and quality check that produced it

**Quality control**

- Deterministic gate by default; optional model-driven visual audit (`STUDIO_QC_MODE=model`) that judges images directly and videos by an extracted mid-clip frame
- Text and audio pass unaudited by design — there is no visual surface to judge — and the console labels them **Not audited** rather than showing a score nobody earned

## Architecture

| Component | Purpose |
| --- | --- |
| `apps/web` | Next.js console: projects, episode workspace, generation panel, sources & scripts, assets, deliveries, model center, members |
| `apps/api` | Fastify API: auth, tenancy, catalog and bindings, generation triggers, versioning, deliveries, artifact streaming, audit |
| `apps/worker` | BullMQ consumer: provider calls, quality gates, content write-back, composition |
| `packages/domain` | State machines, RBAC matrix, capability slots and binding rules |
| `packages/pipeline` | Orchestration: stage gates, prompt building, batching, auto-advance, regenerate, cascade, composition planning |
| `packages/providers` | Provider catalogs and adapters (Alibaba Cloud Bailian / DashScope, mock) |
| `packages/db` | Prisma schema, migrations, batch status rollup |
| `packages/media` | Object storage backends, media synthesis for the mock provider, FFmpeg composition |
| `packages/security` | Argon2id hashing, token hashing, AES-256-GCM secret encryption |
| `packages/jobs` | Queue names and job payload contracts shared by API and worker |
| `packages/config` | Typed environment configuration |

## Requirements

- Node.js ≥ 22.18 (workspace packages run as TypeScript source via native type stripping)
- pnpm 9
- FFmpeg ≥ 6 on `PATH` (composition); the worker Docker image includes it
- Docker, for PostgreSQL / Redis in local deployment (plus MinIO when `STORAGE_BACKEND=s3`)

## Quick start

```bash
pnpm install
pnpm --filter @studio/db generate
pnpm build
docker compose up -d                                  # postgres, redis, minio
pnpm --filter @studio/db exec prisma migrate deploy
pnpm dev                                              # api :4010 · web :3010 · worker
```

Open http://localhost:3010 and create a workspace, then bind models in **Model center**:

1. Add a provider connection. API keys are encrypted at rest with `STUDIO_MASTER_KEY`.
2. Run **Probe entitlements** to verify which models your key can call.
3. Bind verified models to the capability slots. **Resolve candidates** shows the ordered fallback list the pipeline will use.

Produce an episode:

4. Open a project, select an episode, and in **Sources & scripts** paste or upload the source text, then **Approve** it. The approval starts the chain: the script stage runs on its own and writes a script version from the approved source.
5. Read the generated script (**View** expands the full text) and correct it in place if needed — saving recomputes the checksum and returns it to draft for re-approval — then **Approve** it. That approval sets the rest running: shot breakdown, asset extraction, reference images, first frames, clips, and the composed master. The **Generation** panel shows every stage, and each artifact becomes previewable as it lands.
6. Step in whenever you want. **Advance pipeline** pushes one step by hand, **Trigger generation** runs a single stage, **Regenerate** re-runs a stage after an edit as a new revision, and **Compose episode** cuts a master on demand.
7. In **Deliveries**, package the episode. Packaging is refused with reasons until composition has completed and every live shot has a succeeded clip; then inspect or download the manifest and record an accept or reject.

Triggering a stage twice returns the existing batch instead of queueing duplicate work; **Regenerate** is the deliberate way to re-run a stage after editing its upstream.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `STUDIO_MASTER_KEY` | development key | 64-hex AES-256-GCM key encrypting provider secrets; required in production, which refuses the development key |
| `REDIS_URL` | `redis://localhost:6380` | BullMQ broker |
| `STORAGE_BACKEND` | `disk` | `disk` stores artifacts under `STUDIO_ARTIFACTS_DIR`; `s3` stores them in an S3-compatible object store |
| `STUDIO_ARTIFACTS_DIR` | `var/artifacts` | Disk backend root; the API and the worker must share the same absolute path (`pnpm dev` sets it, Docker Compose shares a volume) |
| `STUDIO_QC_MODE` | `pass` | Quality gate: `pass` accepts every artifact, `fail` rejects every one, `random` scores a hash of task and attempt against the 0.7 threshold, `model` asks the bound `visual_audit` model |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | compose defaults | Used only when `STORAGE_BACKEND=s3`; the bucket must already exist |
| `CORS_ORIGIN` | `http://localhost:3010` | Comma-separated allowed origins |
| `SESSION_TTL_MS` | 7 days | Session lifetime |
| `PORT` | `4010` | API port |

Notes:

- With `STORAGE_BACKEND=s3` the API and the worker must be configured identically; create the bucket before the first generation (against the compose MinIO: `mc mb local/studio`).
- `STUDIO_QC_MODE=model` requires a vision model probed and bound to the `visual_audit` slot, and costs one vision call per image or video artifact. Without a verified binding, image and video tasks fail with a null-score quality check instead of silently falling back.

## Mock provider

The repository ships a mock provider used by the test suite and for exploring the full workflow without any API key: bind a `mock-*` model to a slot and every stage completes with synthetic output. It is a test double only — no demo dataset, sample media, or seeded content is included in the repository.

## Testing

```bash
pnpm test
```

API integration tests boot an embedded PostgreSQL, apply the real migrations, and exercise auth, RBAC, tenant isolation, the state machine, the audit trail, the model capability center, generation batches, artifact streaming, versioning, assets, orchestration and acceptance-gated deliveries end to end — no Docker and no API key required. Worker tests cover candidate fallback, the quality gate with rework, the visual audit, composition, AI content write-back and auto-advance, shelling out to a real `ffmpeg`. Media tests cover both storage backends. The mock provider stands in for live multimodal calls so the suite runs anywhere.

## Roadmap

- Voice, subtitles and music inside the automated chain
- Deep content audits: source coverage, script coverage, cross-shot continuity, audio sync
- Visual-audit threshold calibrated against live vision-model scores
- Edit cascade from an individual shot to its media
- Per-edit wording history for hand-edited shots

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — domain model, capability policy, state machine, orchestration, queue design, quality gates, storage, security
- [CONTRIBUTING.md](./CONTRIBUTING.md) — development workflow, testing, pull-request checklist
- [docs/skills/film-production/SKILL.md](./docs/skills/film-production/SKILL.md) — the production methodology the pipeline encodes

## License

Apache-2.0
