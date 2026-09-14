# Short Drama Studio

> Status: the platform layer (tenancy, RBAC, sessions, audit, and the model capability configuration center), the first generation pipeline (stage batches, the BullMQ queue, worker execution with candidate fallback, the quality gate, artifact storage and streaming, and FFmpeg composition), source and script versioning with approval gating, episode asset authoring with reference-image generation, versioning, and approval, and acceptance-gated delivery manifests are implemented and covered by tests. Quality control has two checkers: a deterministic hash placeholder that is still the default, and a model-driven visual audit of images and single video frames that is implemented but has never been run against a live provider. The remaining upstream content stage (storyboard authoring gates), the enforcement of upstream approvals on generation triggers, and the deep content audits remain design; section-level status is called out inline.

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
- Model-driven visual audit of image artifacts and single video frames behind `STUDIO_QC_MODE=model`, which fails the task rather than degrading when no auditor can judge
- FFmpeg composition of an episode's succeeded video artifacts, plus mock media synthesis for credential-free runs
- Source document and script versioning: checksummed uploads with duplicate detection, approval gating, and storyboards re-pointed at the approved script version
- Episode assets: authoring with a kind, name, and description; reference-image generation through the image slot; versioning; and approval
- Acceptance-gated delivery packaging with versioned JSON manifests, acceptance, and reasoned rejection
- Artifact storage behind one `Storage` interface with two backends — local disk (the default) and S3-compatible object storage — injected into the API and the worker and streamed over an authenticated endpoint
- Docker Compose deployment (compose file and API/worker/web Dockerfiles present; end-to-end startup not yet verified)
- Apache-2.0 licensing

Planned:

- OAuth and SSO extension points
- S3 backend completion: an integration test against a real MinIO in CI, bucket bootstrap, multipart and streaming upload, and range delivery
- Storyboard authoring gates (binding approved assets to storyboards), plus enforcement of upstream approvals on generation triggers
- Delivery audits beyond the manifest: normalized media and reproducible export
- Per-tenant, per-provider, and per-model concurrency limits
- Additional provider adapters (OpenAI-compatible APIs, Volcengine)

## Monorepo

- `apps/web`: Next.js application (projects, generation panel, sources & scripts, deliveries, model center, members; English/Chinese UI)
- `apps/api`: Fastify API (auth, projects, episodes, members, providers, bindings, generations, source/script versions, deliveries, artifact streaming, audit)
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
- SourceDocumentVersion
- ScriptVersion
- ProviderConnection
- ModelCapability
- CapabilityBinding
- GenerationBatch
- GenerationTask
- MediaArtifact
- QualityCheck
- Composition
- Delivery
- AuditEvent
- UsageLedger
- Asset
- AssetVersion

Defined in the schema and migrations, waiting on storyboard authoring:

- StoryboardAsset (the storyboard↔asset join table exists, but nothing populates it yet)

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

Episode and storyboard transitions are implemented that way — validated by `packages/domain`, written through the API, and audited. Source and script versions now run the same approval flow upstream: a script version can only be derived from an `APPROVED` source version, and approving a script makes it the episode's current writing. The gate is not yet enforced on generation: a stage can be triggered as soon as its slot has a verified candidate, without an approved script or asset stage in between.

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

1. The API stage maps to one capability slot: `SCRIPT → script_text`, `ASSET → image_gen`, `STORYBOARD → storyboard_text`, `IMAGE → image_gen`, `VIDEO → video_t2v`, `AUDIO → tts_voice`. `IMAGE` is persisted as the schema stage `FIRST_FRAME` and mapped back on the way out.
2. `IMAGE` and `VIDEO` plan one task per storyboard (optionally restricted by `storyboardIds`, which must all belong to the episode); `ASSET` plans one task per asset; the other stages plan a single episode-level task. The prompt is the storyboard title and description, the asset's `kind name: description`, or the episode title.
3. Candidates come from `resolve` for that slot and project: project scope before organization scope, priority descending, deduplicated by capability, dropping unverified capabilities and disabled connections. An empty list is a `409` — nothing is queued that could not run.
4. A `GenerationBatch` and its `GenerationTask` rows are written in one transaction. Each task carries the idempotency key `${episodeId}:${stage}:${entityId}`, which is unique, so re-triggering the same stage of the same episode returns the existing batch with `200` instead of queueing duplicate work.
5. One `run-task` job per task is enqueued, then an audit event records the trigger.

Execution (`apps/worker/src/run-task.ts`):

- A cancelled task is dropped before any provider call. Otherwise the task goes `RUNNING` with its attempt number and the batch status is resynchronised.
- Candidates are tried in order. For each one the connection and capability are re-read and re-checked, the API key is decrypted, the adapter submits the planned request, and the worker polls to a settled state (250 ms interval, 30 s deadline).
- The result is materialized into bytes: a `mock://` URL is synthesized locally with FFmpeg, an `http(s)` URL is downloaded, and a text result is encoded as UTF-8.
- The artifact is stored under `tenant/project/episode/stage/task/v<attempt>.<ext>` and recorded as an immutable `MediaArtifact` with checksum, mime type, dimensions or duration, and the provider response as metadata.
- A `QualityChecker` then judges the stored artifact and writes a `QualityCheck` row: `APPROVED` at or above the 0.7 threshold, `NEEDS_REVIEW` with a score below it, or `NEEDS_REVIEW` with a **null** score when the checker could not judge at all. A rejection re-queues the same task with `attempt + 1` up to three attempts, then fails it; an unjudged artifact fails it immediately and queues nothing (see **Quality gates**).
- On success the worker writes a `UsageLedger` entry (input prompt length, output byte count) and stamps the task `SUCCEEDED` with the winning provider, model, and response snapshot. For an `ASSET`-stage task it then appends the next `AssetVersion` for the asset named in the task's request snapshot, pointing at the stored artifact and left `DRAFT` — a passed quality check is not a human approval of the likeness.
- Every candidate failure is collected into `errorSnapshot`, so a failed task explains the whole fallback chain rather than only the last error.

Live-provider verification: the DashScope adapter's Qwen-Image path has been run against the live Bailian API and produced real images — the `ASSET` flow above ran end-to-end on `qwen-image-3.0`, which answers synchronously on the multimodal endpoint. The other DashScope paths (the async wanx image endpoint, video generation, and the VLM audit) are in the catalog but have not been run live; only Qwen-Image image generation is proven.

Batch status is derived, never set directly: `syncBatchStatus` recounts the tasks after every transition and rolls up to `RUNNING` while anything is queued or running, `BLOCKED` if anything failed, `NEEDS_REVIEW` if cancellations are mixed with successes, `CANCELLED` if nothing ran, and `COMPLETED` otherwise.

Cancellation (`POST /generations/tasks/:taskId/cancel`) is only allowed while a task is still `QUEUED`; a running task is left alone because its provider call has already been paid for.

Composition (`POST /episodes/:episodeId/compositions`) records a `Composition` with a manifest of the episode's storyboard ids and enqueues `compose-episode`. The worker takes the newest succeeded video artifact of every storyboard in the manifest, concatenates them with the FFmpeg concat demuxer, stores the result as a `COMPOSITION` artifact, and marks the composition `COMPLETED`; any missing segment or FFmpeg failure marks it `BLOCKED` and logs stderr.

Read surface: `GET /episodes/:episodeId/generations` returns every batch with its tasks, artifacts, and latest quality check, and `GET /artifacts/:artifactId/content` streams the bytes. Both are tenant-scoped and require `read`.

Upstream versions (`apps/api/src/routes/sources.ts`): source documents and scripts are versioned per episode, unique on `(episodeId, version)`, and deliberately carry no timestamp columns — the version number is the ordering key and lists come back newest-first. `POST /episodes/:episodeId/source-versions` stores the uploaded `content` verbatim (at most 200,000 characters) with a server-computed SHA-256 checksum; re-uploading content whose checksum equals the latest version's is a `409 sources:duplicate`. Approval flips a version to `APPROVED` once (`409 sources:alreadyApproved` on a repeat). `POST /episodes/:episodeId/script-versions` derives a script version by copying content and checksum from an `APPROVED` source version named by `sourceVersion` (`409 sources:sourceNotApproved` otherwise), and approving a script version re-points every storyboard of the episode at it through `storyboard.updateMany`, returning `storyboardsUpdated` so downstream stages trace exactly one script version. List endpoints return summaries without content, keeping the list cheap; the single-version endpoint includes it. Reads require `read`, writes require `episode:write` (EDITOR minimum), and every write is audited (`source.upload`, `source.approve`, `script.derive`, `script.approve`).

Assets (`apps/api/src/routes/assets.ts`): assets are the episode-level references a production reuses — a character, a prop, a scene. `POST /episodes/:episodeId/assets` creates one from a `kind`, a `name`, and a `description` (the text that drives its reference-image prompt), unique on `(episodeId, kind, name)` (`409 assets:duplicate`). Triggering the `ASSET` generation stage plans one image task per asset through the `image_gen` slot, carrying the asset id in the task's request snapshot; when such a task succeeds the worker appends the next `AssetVersion` (description and prompt snapshot set to the prompt, `artifactId` pointing at the stored image, status `DRAFT`). `POST /episodes/:episodeId/assets/:assetId/versions/:version/approve` flips the version to `APPROVED` once (`409 assets:alreadyApproved` on a repeat) and marks the asset approved; nothing is re-pointed, because nothing references an approved asset until storyboard binding lands. Reads require `read`, writes require `episode:write`, and every write is audited (`asset.create`, `asset.approve`).

Delivery (`apps/api/src/routes/deliveries.ts`): `POST /episodes/:episodeId/deliveries` packages a delivery behind an acceptance gate — there must be a `COMPLETED` composition with a non-null master `artifactId`, and every storyboard of the episode must have a succeeded VIDEO-stage artifact. This is deliberately the same rule the compose worker uses to pick a clip, so an episode that cannot be composed cannot be delivered; when the gate fails the response is `409 delivery:notReady` with a human-readable `reasons` array naming each missing piece. The manifest is a versioned JSON document (`schemaVersion` 1) stored as a string on `Delivery.manifest`: `packagedAt`, episode identity, the latest source and script version refs `{version, checksum, status}`, per-storyboard artifacts (`stage`, `objectKey`, `checksum`, `mimeType`, `version`, dimensions, duration), the composition master, and a `quality` summary whose counts come from one `groupBy` over `QualityCheck` reaching the episode through any of its four relations (storyboard, batch, source document version, or artifact task batch) and whose `threshold` restates the same 0.7 bar the worker judges artifacts against. `POST /deliveries/:id/accept` sets `APPROVED` and stamps `acceptance.acceptedAt` into the manifest; `POST /deliveries/:id/reject` requires a non-blank `reason` and sets `NEEDS_REVIEW`; an accepted delivery is immutable — both verbs then answer `409 delivery:alreadyAccepted`. Deliveries carry no timestamp columns either, so lists order newest-first by cuid id. `GET /episodes/:episodeId/deliveries` and `GET /deliveries/:id/manifest` are the reads. Writes require `episode:write` and are audited (`delivery.create`, `delivery.accept`, `delivery.reject`); every route looks the episode or delivery up through `project.organizationId`, so a cross-tenant id is a 404, never a 403. The web project page mounts a **Sources & scripts** panel and a **Deliveries** panel under the generation panel: write actions are `episode:write`-guarded and render disabled for viewers while reads stay enabled, the `delivery:notReady` reasons surface as a warning alert, the duplicate-checksum 409 becomes an inline field error, and the manifest download goes through the authenticated API client and hands the browser a revocable blob URL — a raw API URL is never placed in the DOM.

## Queue design

Implemented: one BullMQ queue, `studio-pipeline`, carrying two job kinds — `run-task` and `compose-episode`. Job ids are deterministic (`run-<taskId>-<attempt>` and `compose-<compositionId>`) so a duplicate enqueue is a no-op and a rework attempt never collides with its predecessor. BullMQ retries a crashed job twice with exponential backoff; application-level retries (candidate fallback, quality-gate rework) are expressed as new payloads, not as BullMQ retries, because each one has to be visible in the task's attempt count.

Planned: the per-stage topology the schema anticipates — `source-analysis`, `script-generation`, `asset-generation`, `storyboard-generation`, `image-generation`, `video-generation`, `audio-generation`, `quality-check`, `composition`, `delivery` — with concurrency limits per tenant, provider, model, and capability, and retry classification that distinguishes transient, entitlement, validation, and content failures.

Source and script versioning, approval, and delivery packaging are deliberately not on this list: they shipped as synchronous API writes because they only move small text and metadata. What still needs a queue behind those names is the model-driven work — analyzing a source document, writing a script from it, and the normalized-media export a delivery audit would require.

## Quality gates

After the artifact is stored and before it can be accepted, a `QualityChecker` (`apps/worker/src/qc.ts`) judges it and returns one of three verdicts. The checker only decides; `run-task` owns the record, so the score, the 0.7 threshold, the mode, and the winning candidate land in `QualityCheck.report` the same way whichever checker ran.

- `pass` → `QualityCheck.status = APPROVED`, the usage ledger entry is written, the task succeeds.
- `rework` → `NEEDS_REVIEW` with a score, and the same task is re-queued with `attempt + 1`, up to three attempts, then fails with `<kind>: threshold not met after 3 attempts`.
- `unjudged` → `NEEDS_REVIEW` with a **null** score, and the task fails immediately with `<kind>: <reason>`. Nothing is re-queued.

The third verdict is the one that carries the design. An auditor that could not judge has reported a fault in the audit, not a defect in the content, so the pipeline neither regenerates — that would pay for an artifact nobody rejected — nor falls back to the other checker, which would pretend a judgment happened. `HashQualityChecker` refuses to be constructed under `STUDIO_QC_MODE=model` for the same reason: a missing checker must not silently become a hash score.

Two checkers ship.

**`HashQualityChecker`** — the default, `kind: 'fake-qc'`. It scores a SHA-256 of the task id and attempt number against the threshold. Deterministic, so a given attempt always gets the same verdict and tests can rely on it; `STUDIO_QC_MODE` forces the outcome (`pass` accepts everything, `fail` rejects everything, `random` exercises both paths). It is a placeholder, not a quality judgement about the media, and it names itself as `fake-qc` in the row it writes.

**`ModelQualityChecker`** — `STUDIO_QC_MODE=model`, `kind: 'visual-audit'`. It sends the artifact to the model bound to the `visual_audit` slot and asks for `{"score": <0..1>, "reasons": [...]}`. Candidates come from the same `resolveSlotCandidates` the planner uses, so an unverified capability or a disabled connection is not an auditor. The answer is parsed defensively: prose and code fences around the JSON are tolerated, but a score that is not a finite number in `[0, 1]` is rejected rather than clamped, because a clamped guess would still look like a judgment.

| Modality | Audited | How |
| --- | --- | --- |
| `image` | yes | the artifact bytes are sent as-is |
| `t2v`, `i2v`, `r2v` | partially | one JPEG frame extracted mid-clip by FFmpeg (`frameArgs` in `packages/media`) |
| `text`, `tts`, `music` | **no** | no visual surface; returns `unjudged` and the task fails |

The frame is taken from the middle of the clip rather than the start because a first frame is usually a fade-in, and it is scaled to at most 1024 px wide without ever upscaling.

What `mode=model` has not been shown to do:

- **The audit itself has never run against a live provider.** The DashScope multimodal endpoint and its `messages` request shape are now proven live — the Qwen-Image generation path uses that same endpoint and has produced real images — but no `qwen-vl` model was available, so the audit direction specifically (a base64 frame in, a JSON verdict out) is still written from documentation and unverified.
- **The threshold is inherited, not measured.** 0.7 came from the hash placeholder. No calibration run has established what a vision model's score distribution actually looks like.
- **It is not reproducible.** The same frame asked twice can score differently, which is why `mode=model` is never a CI default.
- **One frame cannot see motion.** Stutter, drift, and a character changing clothes mid-shot are invisible to it, as is every continuity defect between shots. Video audit here is a still-image proxy and is recorded as one.
- **Audio is never heard.** A video artifact is judged on a silent frame.
- **Base64 payload limits are untested.** A 1024 px JPEG inlined into a request body may exceed a provider's cap.
- **The failure is loud but not free.** `mode=model` pays for generation before it discovers that no auditor is bound.

Designed, not yet built:

- Source audit: event order, time, location, characters, props, dialogue, required beats, ending
- Script audit: source coverage and prohibited additions
- Asset audit: identity references, deduplication, ownership, version
- Storyboard audit: duration budget, source excerpt, continuity in/out, asset bindings
- Generation audit: request capability compatibility, reference inputs, artifact ownership
- Visual audit beyond a single frame: identity across shots, scene, action, prop, lighting, continuity — the slot is bound and one frame is really judged, but nothing yet compares two shots or two attempts
- Audio audit: dialogue presence, duration, loudness, sync, music and effects tracks
- Delivery audit: normalized media and reproducible export (complete coverage, the manifest, and checksums ship with delivery packaging)

A stage may be marked complete only with recorded check results. Partial output is explicitly reported as partial.

## Artifact traceability

The full chain the design requires, in both directions:

project → episode → storyboard/asset → generation batch → task attempt → artifact → quality checks

and:

artifact → task attempt → model/configuration → source prompt/input versions → storyboard/asset → episode/project/organization.

Implemented today: `MediaArtifact → GenerationTask → GenerationBatch → Episode → Project → Organization` are real relations, the batch also links the storyboards it planned against, and `QualityCheck` points at the artifact it scored. The object key itself encodes tenant, project, episode, stage, entity, and version. The artifact stores checksum, mime type, dimensions or duration, and the raw provider response as metadata; the task stores the planned request snapshot, the winning provider and model, and a response snapshot naming the attempt, candidate, provider task id, and artifact id.

Input version references are real down to the script and the asset: storyboards carry `scriptVersionId`, re-pointed at every script approval, so an artifact traces back through its batch and storyboard to the exact approved script content and checksum, and the delivery manifest names the source and script versions beside every artifact checksum. An `ASSET`-stage artifact likewise traces to its asset through `AssetVersion.artifactId`, with the asset id carried in the task's request snapshot. Still missing: a configuration version per attempt.

## Storage

Metadata lives in PostgreSQL; bytes live behind one `Storage` interface in `packages/media`. Two implementations sit behind it and nothing else in the system knows which one is running: `STORAGE_BACKEND` selects them and defaults to `disk`, so the S3 settings are inert until it is set.

The contract is `put`, `read`, `exists`, `open`, and `close`. Three of those are shaped by constraints worth stating, because each one looks like an oddity until you know what it is for:

- `open` returns a stream **and the object's size**, and resolves `null` when the object is absent rather than throwing. Absence is an expected outcome at the only call site — the API turns it into its `artifact file not found` response — so a thrown error there would be a control-flow exception. The size rides beside the body because the `MediaArtifact` row has no size column and cannot supply a content-length; S3 returns it on the same `GetObject` that returns the body, so it costs no extra round-trip.
- There is deliberately **no path-shaped method**. An earlier `localPath` existed so ffmpeg could be handed a real file, and only the disk backend could ever implement it — an abstraction with a method one implementation cannot satisfy is not an abstraction. Callers that need a file materialise one, which is what composition already did: it writes what `read` returned into a temporary directory.
- `close` exists because an S3 client holds a live socket agent that keeps the process up. The disk backend holds nothing between calls and its `close` is empty.

The disk backend roots at `STUDIO_ARTIFACTS_DIR`. The worker writes into it and the API streams out of it, so both processes must resolve the same absolute path — `pnpm dev` pins it, and the Docker Compose deployment shares a named volume. Object keys are generated from tenant/project/episode/stage/entity/version and never from user-provided filenames, and the disk backend rejects any key that escapes its root before touching the filesystem.

The S3 backend talks path-style to `S3_ENDPOINT` and requests checksums only when required, so an upload carries the caller's bytes instead of `aws-chunked` transfer framing. Each process builds exactly one instance through `storageFrom` and injects it — the API onto `app.storage`, the worker into its dependency bundle — and closes it on shutdown. Neither constructs a backend inside a request handler or a task.

What the S3 backend has not been shown to do:

- **It has never met a real S3 server.** No container runtime was available where it was written. It is verified against an in-process fake HTTP server implementing `PUT`/`GET`/`HEAD` and answering a missing key with a genuine `NoSuchKey` body, which exercises request shaping, key encoding, content-type propagation, response-body-to-stream conversion, `ContentLength` extraction, and absence-versus-fault mapping. The fake ignores the `Authorization` header, so SigV4 signature acceptance, credential handling, region resolution, and TLS are unverified; those lines carry `// UNVERIFIED`.
- **The compose stack has never been brought up in `s3` mode.** Compose defaults to `disk`, so nothing regresses, but that path is unexercised end to end.
- **It does not create the bucket.** MinIO ships no `studio` bucket, so `STORAGE_BACKEND=s3` against a fresh stack fails at the first `put` until one exists.
- **Uploads are single-shot.** No multipart and no streaming upload, untested at the sizes a real episode produces.
- **Delivery is whole-body.** No `Accept-Ranges` is offered, so browser video seeking has no range support to fall back on.
- **Absence and outage are told apart only by status.** A 404 is absent; anything else is re-thrown. That is deliberate — reporting an unreachable store as "not found" would silently hide media — but it has only been proven against the fake server's 500.

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
- `STUDIO_QC_MODE=model` with no verified `visual_audit` binding fails the task, records a `QualityCheck` with a null score, and queues no further attempt
- `STUDIO_QC_MODE=model` with a bound auditor approves an image artifact outright and a video artifact judged from one FFmpeg-extracted frame
- Batch status is derived from its tasks after every transition, including cancellation
- Only a queued task can be cancelled; a viewer cannot trigger, cancel, or compose
- An artifact streams with its stored mime type and length, and a missing file is a `404`
- Composition concatenates the newest succeeded video of every storyboard in the manifest and blocks when one is missing
- A source upload is deduplicated by checksum, a script can only be derived from an approved source, and approving a script re-points every storyboard of the episode at it
- An asset can be authored, its reference image generated through the image slot, and a version approved — which also marks the asset approved — and a completed asset artifact traces back to that version
- Delivery packaging is refused with reasons while no composition has completed or any storyboard lacks a succeeded video — the same rule the compose worker applies
- A delivery manifest names the source and script versions with checksums, every storyboard artifact, the composition master, and the quality counts against the 0.7 threshold
- An accepted delivery is immutable, and rejecting one requires a reason

Pending:

- Source and script content passes its content audits (event order, coverage, prohibited additions)
- Text and audio artifacts pass a real content audit; under `mode=model` they are returned unjudged and the task fails
- The visual audit has run against a live multimodal provider, and the 0.7 threshold is calibrated to what one actually scores
- The system can produce approved storyboard versions
- A reference video task cannot select T2V
- A completed artifact can be traced back to a per-attempt configuration version
- Delivery audits verify normalized media and reproducible export
- Docker Compose starts web, API, worker, PostgreSQL, Redis, and MinIO
