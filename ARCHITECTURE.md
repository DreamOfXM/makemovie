# Short Drama Studio

> Status: the platform layer (tenancy, RBAC, sessions, audit, and the model capability configuration center) and the first generation pipeline (stage batches, the BullMQ queue, worker execution with candidate fallback, the quality gate, artifact storage and streaming, and FFmpeg composition) are implemented and covered by tests. The upstream content stages (source documents, script and asset versions, storyboard authoring gates), the acceptance audits, and delivery remain design; section-level status is called out inline.

## Goal

A self-hostable and commercial-ready AI short-drama production system. It manages the complete path from source material to an audited deliverable:

source audit → script → assets → storyboards → first frames → videos → voice/subtitles/music → composition → acceptance → delivery.

The system must distinguish planning completion, asset completion, generation completion, acceptance completion, and delivery completion.

## Product boundaries

Shipped:

- Multi-tenant users, organizations, projects, and role permissions
- Email/password authentication with database-backed sessions
- PostgreSQL persistence with Prisma
- Next.js web application with English/Chinese UI
- Fastify API
- Model capability configuration center with encrypted provider credentials and entitlement probes
- Provider adapters for Alibaba Bailian (DashScope) and a credential-free mock provider
- Generation pipeline: stage batches, BullMQ queue on Redis, worker with ordered candidate fallback, quality gate with rework attempts, immutable artifacts, usage ledger entries
- FFmpeg composition of an episode's succeeded video artifacts, plus mock media synthesis for credential-free runs
- Local disk artifact storage shared by the API and the worker, streamed over an authenticated endpoint
- Docker Compose deployment (compose file and API/worker/web Dockerfiles present; end-to-end startup not yet verified)
- Apache-2.0 licensing

Planned:

- OAuth and SSO extension points
- S3-compatible object storage behind the same `Storage` interface; MinIO for local deployment
- Source document, script version, and asset stages with upstream-approval gating
- Acceptance audits and delivery manifests
- Per-tenant, per-provider, and per-model concurrency limits
- Additional provider adapters (OpenAI-compatible APIs, Volcengine)

## Monorepo

- `apps/web`: Next.js application (projects, generation panel, model center, members; English/Chinese UI)
- `apps/api`: Fastify API (auth, projects, episodes, members, providers, bindings, generations, artifact streaming, audit)
- `apps/worker`: BullMQ consumer running generation tasks and episode composition
- `packages/domain`: domain entities, capability slots, state machines, validation
- `packages/db`: Prisma schema, migrations, the generated client, and the batch status rollup
- `packages/jobs`: queue name and job payload contracts shared by the API and the worker
- `packages/providers`: provider catalogs and adapters (dashscope, mock)
- `packages/media`: object storage, mock media synthesis, FFmpeg composition, and media inspection
- `packages/config`: typed environment and runtime configuration
- `packages/security`: Argon2id hashing, token hashing, AES-256-GCM secret encryption
- `infra`: API, worker, and web Dockerfiles (`docker-compose.yml` sits at the repository root)
- `docs`: currently the short-drama production skill specification; product, API, and operations docs are still to be written

## Domain model

Tenant isolation is mandatory on every aggregate. Exercised by the API and worker today:

- User
- Organization
- OrganizationMember
- Session
- Project
- Episode
- Storyboard
- ProviderConnection
- ModelCapability
- CapabilityBinding
- GenerationBatch
- GenerationTask
- MediaArtifact
- QualityCheck
- Composition
- AuditEvent
- UsageLedger

Defined in the schema and migrations, waiting on the upstream content stages and delivery:

- SourceDocumentVersion
- ScriptVersion
- Asset and AssetVersion
- StoryboardVersion and StoryboardAsset
- Delivery

All generated artifacts are immutable. A new generation creates a new artifact version and never overwrites an existing file or prompt.

## Production state machine

Each stage has explicit states:

- `draft`
- `ready`
- `running`
- `needs_review`
- `approved`
- `blocked`
- `completed`
- `cancelled`

Transitions require validated inputs and produce an audit event. A downstream job cannot start unless its upstream stage is approved.

Episode and storyboard transitions are implemented that way — validated by `packages/domain`, written through the API, and audited. The upstream-approval gate is not yet enforced on generation: a stage can be triggered as soon as its slot has a verified candidate, because the script and asset stages that would approve it do not exist yet.

## Model capability policy

A provider connection is separate from a model capability. A capability declares:

- modality: `text`, `image`, `t2v`, `i2v`, `r2v`, `tts`, `music`, `vlm`
- reference-image behavior: first frame accepted, reference images accepted, maximum reference count
- model-specific limits held in the `spec` JSON: resolutions, durations, audio behavior, rate limits
- entitlement probe status and message
- last probed and last verified timestamps

Tasks are planned against capabilities, not model names alone.

Rules enforced by the worker today:

- Fallback candidates are resolved in order, unique per capability, entitlement-verified, and only from enabled connections.
- The first candidate that settles successfully stops the fallback loop; polling happens inside the same job and never creates a replacement task.
- `GenerationTask` records the winning `provider` and `model`, the planned `requestSnapshot`, a `responseSnapshot` (attempt, candidate, provider task id, artifact id, QC score), and an `errorSnapshot` listing every candidate failure that was tried.
- A candidate that fails or is rejected advances to the next one; a task only fails after every candidate is exhausted or the attempt budget runs out.

Rules that are still design:

- A task with first-frame or character references may use only I2V/R2V capabilities; T2V is never an automatic fallback for reference tasks. Today the video stage always resolves the `video_t2v` slot because no reference inputs are planned yet.
- One row per attempt, each carrying its own configuration version. Attempts are currently re-queued jobs that overwrite the same task row, and `capabilitySnapshot` is reserved but unused.

## Model capability configuration center

Model configuration is a four-layer chain. Nothing downstream may skip a layer.

1. **Catalog** (`packages/providers/src/catalog.ts`) — a built-in, code-reviewed description of the models a provider exposes and the capabilities each one honestly supports. DashScope lists only the modalities the adapter can actually drive; the mock provider covers every modality so the pipeline can run without credentials. Catalogs are read-only data, not tenant state.
2. **Connection** (`ProviderConnection`) — a tenant's credential record: provider key, display name, base URL, enabled flag, last error, and an optional `projectId` that scopes the connection to one project. The API key is encrypted with AES-256-GCM by `packages/security` before it reaches the database and is never returned by any read endpoint.
3. **Capability** (`ModelCapability`) — one row per catalog model under a connection, carrying `model`, `displayName`, `modality` (`text`, `image`, `t2v`, `i2v`, `r2v`, `tts`, `music`, `vlm`), `acceptsFirstFrame`, `acceptsReferenceImages`, `maxReferenceImages`, and a `spec` JSON blob that holds the model-specific detail (resolutions, durations, audio behavior, rate limits). Probe state lives in `probeStatus`, `probeMessage`, `lastProbedAt`, and `entitlementVerifiedAt`; probing calls the provider through the adapter and stamps `entitlementVerifiedAt` only on success.
4. **Binding** (`CapabilityBinding`) — attaches a verified capability to one of the nine capability slots (`script_text`, `storyboard_text`, `image_gen`, `video_t2v`, `video_i2v`, `video_r2v`, `tts_voice`, `music_gen`, `visual_audit`) at either organization or project scope with a priority. `slotModality` in `packages/domain` maps each slot to the single modality it accepts, `canBind` rejects mismatches, and a capability without `entitlementVerifiedAt` cannot be bound at all.

`GET /bindings/resolve?slot=&projectId=` returns the ordered candidate list the planner consumes: project-scope bindings first, then organization scope, each sorted by priority descending, deduplicated by capability, with disabled or unverified capabilities dropped.

API surface: `GET /providers/catalogs`, `GET|POST|PATCH|DELETE /providers/connections`, `POST /providers/connections/:connectionId/probe`, `GET|POST|PATCH|DELETE /bindings`, `GET /bindings/resolve`. Provider and binding management require the `providers:manage` / `bindings:manage` permissions (ADMIN and OWNER); every mutation writes an audit event.

The web Model Center page exposes the same chain in order — connections and probes, slot bindings, resolution preview, then catalogs — in both English and Chinese.

## Generation pipeline

Planning (`POST /episodes/:episodeId/generations`, permission `generation:trigger`):

1. The API stage maps to one capability slot: `SCRIPT → script_text`, `STORYBOARD → storyboard_text`, `IMAGE → image_gen`, `VIDEO → video_t2v`, `AUDIO → tts_voice`. `IMAGE` is persisted as the schema stage `FIRST_FRAME` and mapped back on the way out.
2. `IMAGE` and `VIDEO` plan one task per storyboard (optionally restricted by `storyboardIds`, which must all belong to the episode); the other stages plan a single episode-level task. The prompt is the storyboard title and description, or the episode title.
3. Candidates come from `resolve` for that slot and project: project scope before organization scope, priority descending, deduplicated by capability, dropping unverified capabilities and disabled connections. An empty list is a `409` — nothing is queued that could not run.
4. A `GenerationBatch` and its `GenerationTask` rows are written in one transaction. Each task carries the idempotency key `${episodeId}:${stage}:${entityId}`, which is unique, so re-triggering the same stage of the same episode returns the existing batch with `200` instead of queueing duplicate work.
5. One `run-task` job per task is enqueued, then an audit event records the trigger.

Execution (`apps/worker/src/run-task.ts`):

- A cancelled task is dropped before any provider call. Otherwise the task goes `RUNNING` with its attempt number and the batch status is resynchronised.
- Candidates are tried in order. For each one the connection and capability are re-read and re-checked, the API key is decrypted, the adapter submits the planned request, and the worker polls to a settled state (250 ms interval, 30 s deadline).
- The result is materialized into bytes: a `mock://` URL is synthesized locally with FFmpeg, an `http(s)` URL is downloaded, and a text result is encoded as UTF-8.
- The artifact is stored under `tenant/project/episode/stage/task/v<attempt>.<ext>` and recorded as an immutable `MediaArtifact` with checksum, mime type, dimensions or duration, and the provider response as metadata.
- The quality gate scores the artifact and writes a `QualityCheck` row (`APPROVED` at or above the 0.7 threshold, otherwise `NEEDS_REVIEW`). A rejection re-queues the same task with `attempt + 1` up to three attempts, then fails the task.
- On success the worker writes a `UsageLedger` entry (input prompt length, output byte count) and stamps the task `SUCCEEDED` with the winning provider, model, and response snapshot.
- Every candidate failure is collected into `errorSnapshot`, so a failed task explains the whole fallback chain rather than only the last error.

Batch status is derived, never set directly: `syncBatchStatus` recounts the tasks after every transition and rolls up to `RUNNING` while anything is queued or running, `BLOCKED` if anything failed, `NEEDS_REVIEW` if cancellations are mixed with successes, `CANCELLED` if nothing ran, and `COMPLETED` otherwise.

Cancellation (`POST /generations/tasks/:taskId/cancel`) is only allowed while a task is still `QUEUED`; a running task is left alone because its provider call has already been paid for.

Composition (`POST /episodes/:episodeId/compositions`) records a `Composition` with a manifest of the episode's storyboard ids and enqueues `compose-episode`. The worker takes the newest succeeded video artifact of every storyboard in the manifest, concatenates them with the FFmpeg concat demuxer, stores the result as a `COMPOSITION` artifact, and marks the composition `COMPLETED`; any missing segment or FFmpeg failure marks it `BLOCKED` and logs stderr.

Read surface: `GET /episodes/:episodeId/generations` returns every batch with its tasks, artifacts, and latest quality check, and `GET /artifacts/:artifactId/content` streams the bytes. Both are tenant-scoped and require `read`.

## Queue design

Implemented: one BullMQ queue, `studio-pipeline`, carrying two job kinds — `run-task` and `compose-episode`. Job ids are deterministic (`run-<taskId>-<attempt>` and `compose-<compositionId>`) so a duplicate enqueue is a no-op and a rework attempt never collides with its predecessor. BullMQ retries a crashed job twice with exponential backoff; application-level retries (candidate fallback, quality-gate rework) are expressed as new payloads, not as BullMQ retries, because each one has to be visible in the task's attempt count.

Planned: the per-stage topology the schema anticipates — `source-analysis`, `script-generation`, `asset-generation`, `storyboard-generation`, `image-generation`, `video-generation`, `audio-generation`, `quality-check`, `composition`, `delivery` — with concurrency limits per tenant, provider, model, and capability, and retry classification that distinguishes transient, entitlement, validation, and content failures.

## Quality gates

Implemented: every generated artifact is scored by a `fake-qc` check — a deterministic hash of the task id and attempt number, so a given attempt always gets the same verdict and tests can rely on it. The score is compared against the 0.7 threshold and stored as a `QualityCheck` row referencing the artifact, which means the rework history of a task survives in the database. `STUDIO_QC_MODE` forces the outcome (`pass`, `fail`) for demos and tests; the default `random` mode exercises both paths. This is a placeholder for the real audits below, not a quality judgement about the media.

Designed, not yet built:

- Source audit: event order, time, location, characters, props, dialogue, required beats, ending
- Script audit: source coverage and prohibited additions
- Asset audit: identity references, deduplication, ownership, version
- Storyboard audit: duration budget, source excerpt, continuity in/out, asset bindings
- Generation audit: request capability compatibility, reference inputs, artifact ownership
- Visual audit: identity, scene, action, prop, lighting, continuity
- Audio audit: dialogue presence, duration, loudness, sync, music and effects tracks
- Delivery audit: complete coverage, normalized media, manifest, checksums, and reproducible export

A stage may be marked complete only with recorded check results. Partial output is explicitly reported as partial.

## Artifact traceability

The full chain the design requires, in both directions:

project → episode → storyboard/asset → generation batch → task attempt → artifact → quality checks

and:

artifact → task attempt → model/configuration → source prompt/input versions → storyboard/asset → episode/project/organization.

Implemented today: `MediaArtifact → GenerationTask → GenerationBatch → Episode → Project → Organization` are real relations, the batch also links the storyboards it planned against, and `QualityCheck` points at the artifact it scored. The object key itself encodes tenant, project, episode, stage, entity, and version. The artifact stores checksum, mime type, dimensions or duration, and the raw provider response as metadata; the task stores the planned request snapshot, the winning provider and model, and a response snapshot naming the attempt, candidate, provider task id, and artifact id.

Missing until the upstream content stages exist: source prompt and input version references (source document, script version, asset version) and a configuration version per attempt.

## Storage

Metadata lives in PostgreSQL; bytes live on a local disk root named by `STUDIO_ARTIFACTS_DIR`. The worker writes into it and the API streams out of it, so both processes must resolve the same absolute path — `pnpm dev` pins it, and the Docker Compose deployment shares a named volume. Object keys are generated from tenant/project/episode/stage/entity/version and never from user-provided filenames, and `DiskStorage` rejects any key that escapes the root.

The planned production backend is S3-compatible object storage (MinIO locally) behind the same `Storage` interface; the S3 settings in `packages/config` are read for that migration and are not used by the disk implementation.

## Security

Implemented:

- Password hashing with Argon2id (`packages/security`)
- Provider API keys encrypted at rest with AES-256-GCM; ciphertext format `v1.<iv>.<tag>.<ct>` (base64url), master key supplied as 64 hex characters via `STUDIO_MASTER_KEY`
- No read endpoint returns an encrypted secret; connection responses expose only `apiKeySet`
- Sessions stored in the database as SHA-256 token hashes with a 7-day TTL, revoked on logout, organization switch, and membership removal
- Role-based authorization (`OWNER > ADMIN > EDITOR > REVIEWER > VIEWER`) checked by `requirePermission` at every route boundary; every query is scoped by `organizationId`
- Provider errors pass through `sanitizeError`, which keeps only code, message, and request id, truncated to 500 characters
- Audit events for authentication, membership, provider, binding, generation, and composition actions
- Provider API keys are decrypted only inside the worker, for the duration of one candidate call; the plaintext never reaches the database, the API response, or a log line
- Artifact bytes are served only through `GET /artifacts/:artifactId/content`, which is tenant-scoped and requires a session; the web app fetches them with the bearer token and hands revocable blob URLs to the media elements, which cannot send headers themselves
- Object keys are validated against traversal before any filesystem access
- Login and registration are rate limited

Planned:

- Signed object URLs with expiration
- Webhook signatures and replay protection
- Secret rotation policy and key versioning

## Initial acceptance criteria

Met by the current codebase:

- A new organization can register, log in, and create a project and episode through the web UI
- Members can be listed, added, re-roled, and removed, with sessions revoked on removal
- The web UI switches between English and Chinese at runtime
- A provider connection can be created from a catalog, its API key stored encrypted, and never read back
- An entitlement probe stamps only capabilities the provider actually accepts
- A capability without a verified entitlement cannot be bound to a slot
- A slot/modality mismatch is rejected before any binding row is written
- `GET /bindings/resolve` returns project-scope candidates before organization-scope ones, by priority, deduplicated and filtered
- Two tenants cannot read or mutate each other's records
- Every provider and binding mutation leaves an audit entry
- Triggering a stage plans one batch with one task per target and enqueues exactly one job per task
- Triggering a stage with no verified candidate for its slot is rejected with `409` and queues nothing
- Re-triggering the same stage of the same episode returns the existing batch instead of duplicating work
- A candidate failure is preserved on the task and the worker advances to the next verified candidate
- A rejected artifact is reworked up to three attempts and then fails the task, with a `QualityCheck` row per attempt
- Batch status is derived from its tasks after every transition, including cancellation
- Only a queued task can be cancelled; a viewer cannot trigger, cancel, or compose
- An artifact streams with its stored mime type and length, and a missing file is a `404`
- Composition concatenates the newest succeeded video of every storyboard in the manifest and blocks when one is missing

Pending:

- A source document can be versioned and audited
- The system can produce approved script, asset, and storyboard versions
- A reference video task cannot select T2V
- A completed artifact can be traced back to its source prompt and input versions
- A delivery manifest identifies missing, blocked, and approved segments
- Docker Compose starts web, API, worker, PostgreSQL, Redis, and MinIO
