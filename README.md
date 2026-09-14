# Short Drama Studio

Apache-2.0 | Self-hostable, commercial-ready AI short-drama production platform

Full pipeline from source material to audited deliverable:
`source audit → script → assets → storyboards → first frames → videos → voice/subtitles/music → composition → acceptance → delivery`

## Features

Working today:

- Multi-tenant organizations, projects, episodes, and role-based access control (OWNER / ADMIN / EDITOR / REVIEWER / VIEWER)
- Database-backed sessions with Argon2id password hashing and per-organization switching
- **Model capability center**: provider catalogs, encrypted API keys, entitlement probes, and capability-slot bindings with ordered fallback resolution
- **Source & script versioning**: checksummed source uploads with duplicate detection, explicit approval, and script versions derived from an approved source — approving a script re-points every storyboard of the episode at it. Version lists stay cheap (length and checksum only); the console expands any version to read its full text, which is what makes an AI-written script reviewable before you approve it, and a script can be edited in place there (an edit recomputes the checksum and resets it to draft for re-approval)
- **Episode assets**: author characters, props, and scenes with a description, generate a reference image for each through the bound image model, approve the version you want, and bind assets to the storyboard shots that use them — a succeeded generation becomes a draft asset version linked to its artifact
- **Generation pipeline**: per-stage batches (script, asset, storyboard, image, video, audio) dispatched over BullMQ, resolved through the capability bindings, quality-gated with automatic rework, and streamed back as immutable artifacts
- **AI content generation**: the script and storyboard stages write real generated content back into the episode — the script from the approved source, the storyboard shots from the approved script — each gated on its upstream approval
- **Automated orchestration**: a one-click **Advance pipeline** runs the next eligible stage, and the worker auto-advances on its own whenever a batch completes, chaining script → storyboard → asset → first frames → video. Each hop is gated on the approval it needs (a script needs an approved source; storyboards, images, video, and audio need an approved script), so the chain pauses for a human instead of spending money on unapproved visuals
- **Edit + regenerate**: every stage's output stays editable, and re-running a stage after an edit creates a new revision rather than overwriting the old one — the prior batch is kept for traceability and the newest revision is what the console shows
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

- The automated chain stops at video: composition is still a deliberate human click, and audio (voice/music) is triggerable but not auto-advanced
- Regenerate is explicit per stage, not an auto-cascade — editing a script does not silently re-run every downstream stage, because that would spend on visuals nobody asked to regenerate; a human regenerates the stages they want
- Batches carry revisions, storyboards do not: regenerating the storyboard stage writes its shot list as new shots numbered after the existing ones, so the old breakdown stays alongside the new, and there is no delete for a shot
- Assets are still authored by hand (their reference images are AI-generated); automatically extracting characters, props, and scenes from the script is not built
- The deep content audits (source coverage, continuity across shots, audio sync) and the live video / vision-model audit paths

## Monorepo

- `apps/api` — Fastify API (auth, projects, episodes, members, providers, bindings, generations, source/script versions, assets, deliveries, artifact streaming, audit)
- `apps/web` — Next.js app (projects, generation panel, sources & scripts, assets, deliveries, model center, members; i18n en/zh)
- `apps/worker` — BullMQ consumer running generation tasks, quality gates, and composition
- `packages/domain` — state machines, RBAC matrix, capability slots and bind rules
- `packages/db` — Prisma schema, migrations, and batch status rollup
- `packages/jobs` — queue names and job payload contracts shared by the API and the worker
- `packages/pipeline` — generation orchestration (stage gates, prompt building, batching, auto-advance, regenerate) shared by the API trigger and the worker relay
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
4. Open a project, select an episode, and drive the pipeline. **Advance pipeline** (in the episode stepper) runs the next eligible stage and the worker keeps the chain moving on its own once a batch completes; or use the **Generation** panel to **Trigger generation** for a single stage by hand. Each task runs through the resolved candidates, is quality-gated (up to three attempts), and its artifacts become previewable in the panel while it polls for status.
5. **Compose episode** concatenates the newest succeeded video artifact of every storyboard into a single deliverable.
6. In the **Sources & scripts** panel, upload the source document, approve it, then derive a script version from the approved source and approve that — approving a script re-points every storyboard of the episode at it, so downstream stages trace one writing. Use **View** on any version to read its full text, and **Edit** on a script to correct it before approving; saving resets it to draft so the change is re-approved.
7. In the **Deliveries** panel, package the episode into a delivery manifest — packaging is refused with reasons until the composition has completed and every storyboard has a succeeded video — then inspect or download the manifest, and accept it or reject it with a reason.

Triggering a stage twice returns the existing batch instead of queueing duplicate work. To re-run a stage after editing its upstream, use **Regenerate** in the Generation panel: it creates a new revision (the prior batch is kept for traceability) instead of colliding with the first run.

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

API integration tests boot an embedded PostgreSQL, apply real migrations, and exercise auth, RBAC, tenant isolation, the state machine, audit trail, the model capability center, generation batches, artifact streaming, source and script versioning, and acceptance-gated deliveries end to end — no Docker required. They also pin the orchestration: the upstream-approval gates on the content and media stages, the one-click `run-pipeline` advance (including skipping a stage whose first frames already ran), and regenerate creating a new revision while leaving the base batch intact — plus the single-version script read that makes a generated script reviewable, and the cross-origin preflight that makes the console's `PATCH`, `PUT`, and `DELETE` calls reachable from a browser at all. Worker tests cover candidate fallback, the quality gate with rework attempts, the model-driven visual audit (a missing or unverified auditor, a rejected artifact, an approved image and an approved video frame, and a provider fault), composition, the AI content write-back (a script version and storyboard rows from the approved upstream), and auto-advance relaying a completed batch into the next stage — and shell out to a real `ffmpeg`. Media tests cover both storage backends — the disk one against a temporary directory, the S3 one against an in-process fake server, which is as far as it can be tested without a real object store. No test calls a live multimodal provider; the auditor in the tests is the mock, which answers a fixed score it has not earned by looking at anything.

## Documentation

- `ARCHITECTURE.md` — domain model, model capability center, state machine, capability policy, generation pipeline and orchestration (auto-advance, regenerate), queue design, quality gates, storage, security
- `CONTRIBUTING.md` — development workflow, testing, and pull-request checklist
- `docs/skills/short-drama-production/SKILL.md` — the production methodology the pipeline encodes

## License

Apache-2.0
