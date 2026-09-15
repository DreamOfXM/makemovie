# MakeMovie

> Status: the platform layer (tenancy, RBAC, sessions, audit, and the model capability configuration center), the generation pipeline (stage batches, the BullMQ queue, worker execution with candidate fallback, the quality gate, artifact storage and streaming, and FFmpeg composition), source and script versioning with approval gating, episode assets with reference-image generation, versioning, approval, and binding to storyboard shots, and acceptance-gated delivery manifests are implemented and covered by tests. The pipeline is AI-driven and runs itself: approving a source starts `SCRIPT`, which writes a real `ScriptVersion`; approving that script starts `STORYBOARD`, which writes the shot list **and** extracts the episode's characters, props and scenes; from there a completed batch relays the next stage on its own — assets → first frames → video → composition — until a composed master exists. An approval is the checkpoint the chain waits at, and opening it continues the chain rather than waiting for a second click; a human can still push one step at a time with **Advance pipeline**. Approving an edited script cascades: the breakdown is regenerated, the new revision supersedes the old shots instead of deleting them, and the media stages re-run for the shots the episode actually uses. Every generated row carries the task that produced it, so any script, shot or asset traces back to its prompt, provider, model and artifact. Quality control has two checkers — a deterministic hash placeholder (the default, which passes outright rather than rejecting media on a number that is not a quality signal) and a model-driven visual audit of images and single video frames that is implemented but has never been run against a live provider. Text and audio are never scored by either: there is no visual surface to stand in for. The remaining work — voice/music in the chain, the deep content audits (source, script, storyboard, audio), a live visual audit with a calibrated threshold, live video generation, and a per-attempt configuration version — is design; section-level status is called out inline.

## Goal

A self-hostable and commercial-ready AI film & video production system. It manages the complete path from source material to an audited deliverable:

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
- AI content generation: the `SCRIPT` and `STORYBOARD` stages write real generated content back into the domain — a `ScriptVersion` from the approved source, `Storyboard` rows from the approved script, and the episode's characters, props and scenes extracted from the same reply — and every stage's output stays editable (a script version's content can be patched, which recomputes its checksum and resets it to draft). Each generated row records the task that produced it, so a script, shot or asset traces back to its prompt, provider, model and artifact
- Pipeline orchestration: a completed batch auto-advances to the next eligible stage (script → storyboard → asset → first frames → video) through a shared `@studio/pipeline` module the worker and the API both call, and composition is the terminal step the chain takes once every live shot has a clip. An approval opens the checkpoint the chain is waiting at and continues it, so the two human decisions (approve the source, approve the script) are the only clicks a first run needs; `POST /episodes/:id/run-pipeline` still advances one step on demand. Content and media stages are gated on the upstream approval — a script needs an approved source; storyboards, images, video, and audio need an approved script — so the chain pauses for a human instead of spending on unapproved work
- Edit + regenerate: re-running a stage after an edit creates a new revision (an `:rN` suffix on the idempotency key) rather than colliding with the prior batch, which is kept for traceability. Approving an edited script cascades on its own: the breakdown is regenerated, the new revision supersedes the prior shots instead of deleting them, and the media stages re-run for the shots the episode actually uses, ending in a re-cut master
- Model-driven visual audit of image artifacts and single video frames behind `STUDIO_QC_MODE=model`, which fails the task rather than degrading when no auditor can judge. Neither checker scores text or audio: there is no visual surface for a hash or a frame to stand in for
- FFmpeg composition of an episode's succeeded video artifacts, plus mock media synthesis for credential-free runs
- Source document and script versioning: checksummed uploads with duplicate detection, approval gating, and the episode's live storyboards re-pointed at the approved script version whenever that approval did not cascade a regenerate
- Episode assets: extracted from the script by the `STORYBOARD` stage or authored by hand with a kind, name, and description; reference-image generation through the image slot; versioning; approval; and binding an asset to the storyboard shots that use it
- Acceptance-gated delivery packaging with versioned JSON manifests, acceptance, and reasoned rejection
- Artifact storage behind one `Storage` interface with two backends — local disk (the default) and S3-compatible object storage — injected into the API and the worker and streamed over an authenticated endpoint
- Docker Compose deployment (compose file and API/worker/web Dockerfiles present; end-to-end startup not yet verified)
- Apache-2.0 licensing

Planned:

- OAuth and SSO extension points
- S3 backend completion: an integration test against a real MinIO in CI, bucket bootstrap, multipart and streaming upload, and range delivery
- Orchestration boundaries still open: voice and music are triggerable by hand but sit outside the automated chain, and a hand edit to an individual shot does not cascade — regenerating its first frame or clip is still a deliberate click (an edited *script* does cascade, and carries the media stages and composition with it)
- Delivery audits beyond the manifest: normalized media and reproducible export
- Per-tenant, per-provider, and per-model concurrency limits
- Additional provider adapters (OpenAI-compatible APIs, Volcengine)

## Monorepo

- `apps/web`: Next.js application (projects, generation panel, sources & scripts, deliveries, model center, members; English/Chinese UI)
- `apps/api`: Fastify API (auth, projects, episodes, members, providers, bindings, generations, source/script versions, deliveries, artifact streaming, audit)
- `apps/worker`: BullMQ consumer running generation tasks, auto-advancing the pipeline when a batch completes, and composing episodes with their voice, score and subtitles
- `packages/domain`: domain entities, capability slots, state machines, validation
- `packages/db`: Prisma schema, migrations, the generated client, and the batch status rollup
- `packages/jobs`: queue name and job payload contracts shared by the API and the worker
- `packages/pipeline`: generation orchestration — stage gates, prompt building, batching, auto-advance, regenerate, the script-approval cascade, and composition planning — shared by the API trigger and the worker relay so both paths plan identically
- `packages/providers`: provider catalogs and adapters (dashscope, seedance, kling, mock)
- `packages/media`: object storage, mock media synthesis, FFmpeg composition — concat, voice, score and soft subtitles — and media inspection
- `packages/config`: typed environment and runtime configuration
- `packages/security`: Argon2id hashing, token hashing, AES-256-GCM secret encryption
- `infra`: API, worker, and web Dockerfiles (`docker-compose.yml` sits at the repository root)
- `docs`: currently the film & video production skill specification; product, API, and operations docs are still to be written

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
- StoryboardAsset (the storyboard↔asset join, populated when an asset is bound to a shot)

All generated artifacts are immutable. A new generation creates a new artifact version and never overwrites an existing file or prompt.

Three families of columns make the AI-written rows traceable and revisable:

- `generationTaskId` on `ScriptVersion`, `Storyboard`, and `Asset` names the task that produced the row, and is null when a human wrote it. Through it any generated row reaches its prompt, provider, model, artifacts, and quality checks — the console renders it as an "AI generated" badge on the row.
- `revision` and `supersededAt` on `Storyboard` version the breakdown. A regenerate writes the next revision, numbered from 1 within it (unique on `(episodeId, revision, number)`), and stamps every prior shot with the moment it stopped being the episode's breakdown. Superseded shots are never deleted — they may carry first frames and clips already paid for, and they are the record of what an earlier master was cut from — and every planning path reads only the live ones.
- `storyboardId` on `GenerationTask` names the shot a `FIRST_FRAME`, `VIDEO` or `AUDIO` task was made for, and is null for the episode-level stages. A batch covers every shot it was planned against, so without this column a three-shot batch has one relation to three shots and no way to say which artifact belongs to which: composition cut the same clip once per shot, and the delivery manifest listed all of a batch's artifacts under each of them. Reading the shot out of the idempotency key's third segment is not a substitute — that key is an anti-collision token, and parsing a relation out of it would silently detach every shot from its media the day the format changed.

`Storyboard` also holds the audio chain's input as data rather than as prose: `dialogue` is the line actually spoken in that shot — empty string means the shot is silent, which is the same thing as having no line — and `speaker` labels who says it. Both are written by the `STORYBOARD` stage out of the model's own reply and are editable like any other shot field, which is what lets a voice task exist per shot without parsing a description. `speaker` is only a label today: it prefixes the voice prompt so a human can recognise the line, and nothing maps a speaker to a voice identity yet.

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

Episode and storyboard transitions are implemented that way — validated by `packages/domain`, written through the API, and audited. Source and script versions now run the same approval flow upstream: a script version can only be derived from an `APPROVED` source version, and approving a script makes it the episode's current writing. The gate is enforced on generation too: `SCRIPT` is refused (`409 generations:noApprovedSource`) without an approved source version, and `STORYBOARD`, `IMAGE`, `VIDEO`, `AUDIO`, and `MUSIC` are refused (`409 generations:noApprovedScript`) without an approved script version, so nothing is generated downstream until a human has signed off on the writing it comes from. The auto-advance honours the same gates and pauses at a stage whose approval is missing rather than forcing it — and an approval is what releases it: approving a source starts `SCRIPT`, and approving a script starts `STORYBOARD`, or cascades a regenerate of the breakdown when the live shots were written from an older version. The chain therefore waits at a human decision instead of at a button.

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

## Provider adapters

Every vendor sits behind one three-method contract (`packages/providers/src/types.ts`): `probe(capability)`, `submit(capability, request) → taskId`, and `poll(capability, taskId) → running | completed | failed`, with the modality and its limits passed in as a `ModelCapability` rather than parsed out of a model name. Adapters build and interpret HTTP and nothing else: they never touch the database, storage, or the queue, so all polling, retrying, fallback and materialization stays in the worker, which is the only place that knows a task was already paid for. `createAdapter` is the single factory, and a provider that is not in the registry is an error rather than a fallback.

What that contract has to absorb is the variety in how vendors hand back a result:

- **Synchronous endpoints ride the async loop.** DashScope's text, VLM, Qwen-Image and `qwen3-tts-flash` paths answer in one call, but the worker only speaks submit-then-poll, so the adapter parks the answer in an in-process map and returns a synthetic `ds-sync-<n>` task id. A second code path in the worker would have to learn which models are which; this way a sync vendor is indistinguishable from an async one from the outside.
- **Authentication is per vendor.** DashScope and Ark take a bearer token, with `X-DashScope-Async: enable` set on the task endpoints only and never on the synchronous ones. Kling has no token endpoint at all: it takes a self-signed HS256 JWT whose `iss` is the access key, `exp` is thirty minutes out, and `nbf` is five seconds back, signed with the secret key. That token is re-signed under a five-minute refresh margin, which is why a connection can hold a second credential (`accessKeyEncrypted`, encrypted with the same envelope as the API key and never returned by any read endpoint) and why the catalog flags the pair so the form asks for both halves.
- **Status vocabularies are not shared.** `SUCCEEDED`/`FAILED`/`CANCELED`, Ark's `queued`/`running`/`succeeded`/`cancelled`, and Kling's `submitted`/`processing`/`succeed` are each normalized to the three states the contract allows. An unrecognised status is treated as *running*, not failed: an intermediate state a vendor added after this code was written should delay a poll, not write off a generation that is already paid for. A `404` on a poll is a failure, because there is no task left to wait on.
- **Artifact links expire.** Ark and the TTS endpoint hand back roughly a day, Kling about thirty days, so no adapter result is ever streamed from the vendor. The worker downloads the bytes the moment a task settles and serves the artifact from its own storage; the provider response survives only as metadata.

A catalog entry is a promise that can be checked, because probing materialises every model a catalog lists and probes it under that connection. So a catalog lists only what its adapter can actually drive and what a production stage can actually bind: Seedance and Kling list text-to-video alone — Ark's image-to-video wants a first frame at a *public* URL, which contradicts keeping frames in the product's own storage, and Kling's wants base64 the adapter does build but no stage can bind yet. Both reasons are recorded in the entry's `spec` rather than left to the issue tracker.

A probe proves the credential, not entitlement for one model: each adapter makes the cheapest vendor-confirmed call it can (a one-token text completion, `GET /api/v3/models`, a page-size-one task listing) once per connection and reuses that answer across models. Model-level access is established by the first real submission, and `canBind` still requires the probe stamp — what the probe attests is that this key works, which is the honest claim.

Provider failures reach logs and `errorSnapshot` only through `sanitizeError`, which keeps `code`, `message`, and `request_id` and truncates anything else to 500 characters, so a vendor echoing a request back in its error body cannot leak the key that was in the header.

The mock adapter implements the same interface for tests and for running the chain without credentials: it settles on the second poll, returns deterministic script and storyboard documents for the two content models, and yields a `mock://` URL the worker turns into real local media. It is a test double, not a demo dataset.

## Generation pipeline

Planning (`POST /episodes/:episodeId/generations`, permission `generation:trigger`):

1. The API stage maps to one capability slot: `SCRIPT → script_text`, `ASSET → image_gen`, `STORYBOARD → storyboard_text`, `IMAGE → image_gen`, `VIDEO → video_t2v`, `AUDIO → tts_voice`, `MUSIC → music_gen`. `IMAGE` is persisted as the schema stage `FIRST_FRAME` and mapped back on the way out.
2. `IMAGE`, `VIDEO` and `AUDIO` plan one task per **live** storyboard (optionally restricted by `storyboardIds`, which must all belong to the episode and none of which may be superseded), except that `AUDIO` narrows that set to the shots whose `dialogue` is non-empty — a voice task for a silent shot buys audio of nothing — and is a `400` when no live shot has a line at all; `ASSET` plans one task per asset; `SCRIPT`, `STORYBOARD` and `MUSIC` plan a single episode-level task. The prompt is the storyboard title and description, the asset's `kind name: description`, the shot's `【speaker】dialogue` for a voice task, or — for the content stages — the approved upstream text: `SCRIPT` is refused (`409`) without an approved source version and is prompted with it, and `STORYBOARD` is refused without an approved script version and is prompted for one JSON document, `{"shots": [...], "assets": [...]}`, so the same reply breaks the script into shots and reports the characters, props and scenes it uses. Each shot in that document carries its own `dialogue` and `speaker`, which is where the audio chain gets its input: `dialogue` is meant for the line actually spoken in the shot, empty when the shot is silent. The content task's request snapshot carries the approved `scriptVersionId`, which is what the worker stamps on the rows it writes.
3. Candidates come from `resolve` for that slot and project: project scope before organization scope, priority descending, deduplicated by capability, dropping unverified capabilities and disabled connections. An empty list is a `409` — nothing is queued that could not run.
4. A `GenerationBatch` and its `GenerationTask` rows are written in one transaction. Each task carries the idempotency key `${episodeId}:${stage}:${entityId}`, which is unique, so re-triggering the same stage of the same episode returns the existing batch with `200` instead of queueing duplicate work. A `regenerate` trigger appends a revision suffix — `${episodeId}:${stage}:${entityId}:rN`, where N is the number of batches already run for that episode and stage — so a re-run after an edit gets fresh keys and a brand-new batch while the prior one stays intact for traceability, and regenerating a stage that never ran is just its first run (N is 0, no suffix). The key is only ever an anti-collision token: a shot-scoped task also persists its shot on `GenerationTask.storyboardId`, which is the relation every downstream read uses to say whose artifact this is.
5. One `run-task` job per task is enqueued, then an audit event records the trigger (`generation.trigger`, or `generation.regenerate` carrying the revision number for a regenerate).

Execution (`apps/worker/src/run-task.ts`):

- A cancelled task is dropped before any provider call. Otherwise the task goes `RUNNING` with its attempt number and the batch status is resynchronised.
- Candidates are tried in order. For each one the connection and capability are re-read and re-checked, the API key is decrypted, the adapter submits the planned request, and the worker polls to a settled state (250 ms interval, `STUDIO_POLL_TIMEOUT_MS` deadline — 15 minutes by default, because a real text-to-video task takes minutes and an expired deadline would throw away a generation that was already paid for).
- The result is materialized into bytes: a `mock://` URL is synthesized locally with FFmpeg, an `http(s)` URL is downloaded, and a text result is encoded as UTF-8.
- The artifact is stored under `tenant/project/episode/stage/task/v<attempt>.<ext>` and recorded as an immutable `MediaArtifact` with checksum, mime type, dimensions or duration, and the provider response as metadata.
- A `QualityChecker` then judges the stored artifact and writes a `QualityCheck` row: `APPROVED` at or above the 0.7 threshold, `NEEDS_REVIEW` with a score below it, or `NEEDS_REVIEW` with a **null** score when the checker could not judge at all. A rejection re-queues the same task with `attempt + 1` up to three attempts, then fails it; an unjudged artifact fails it immediately and queues nothing (see **Quality gates**). Neither verdict applies to a modality with no visual surface: `text`, `tts`, and `music` pass outright in both checkers, because a script or a soundtrack judged "unauditable" would fail the content pipeline on an audit that had nothing to look at.
- On success the worker writes a `UsageLedger` entry (input prompt length, output byte count) and then writes generated content back into the domain before stamping the task `SUCCEEDED` with the winning provider, model, and response snapshot. An `ASSET`-stage task appends the next `AssetVersion` for the asset named in the request snapshot, pointing at the stored artifact and left `DRAFT` — a passed quality check is not a human approval of the likeness. A `SCRIPT`-stage task becomes a new draft `ScriptVersion` (deduplicated by checksum, so an identical reply does not leave a second version behind). A `STORYBOARD`-stage task writes its shots as a **new revision** of the episode's breakdown — numbered from 1 within the revision, stamped with the `scriptVersionId` the prompt was built from — and once every shot of the new revision exists, stamps `supersededAt` on all prior revisions. Superseding rather than deleting keeps the shots that already carry paid-for first frames and clips readable as history while making sure exactly one revision is live, which is what composition, planning, and delivery all count. The same reply also carries the episode's cast, props, and scenes: `assets` entries with a recognised `kind` (`character`, `prop`, `scene`) and a non-blank `name` become `Asset` rows left `DRAFT`, and one that collides with an asset already there is skipped rather than failing the task that just succeeded, because re-extracting the same character on a regenerate must not cost the approved reference image it may already have. Every row the worker writes carries `generationTaskId`, which is the persisted link back to the task, batch, model, prompt, and artifact that produced it. Writing content before `SUCCEEDED` means an unparseable result falls through to the next candidate instead of leaving a succeeded task with nothing to show.
- Every candidate failure is collected into `errorSnapshot`, so a failed task explains the whole fallback chain rather than only the last error.

Live-provider verification: the DashScope adapter's Qwen-Image path has been run against the live Bailian API and produced real images — the `ASSET` flow above ran end-to-end on `qwen-image-3.0`, which answers synchronously on the multimodal endpoint. The other DashScope paths (the async wanx image endpoint, video generation, and the VLM audit) are in the catalog but have not been run live; only Qwen-Image image generation is proven. The newer paths are in the same position: the `qwen3-tts-flash` and `fun-music-v1` audio endpoints, the Volcano Ark Seedance task API, and the Kling task API are implemented and tested against stubbed responses that reproduce each vendor's documented request shape and status vocabulary, but no live key has been spent on them from this repository.

Batch status is derived, never set directly: `syncBatchStatus` recounts the tasks after every transition and rolls up to `RUNNING` while anything is queued or running, `BLOCKED` if anything failed, `NEEDS_REVIEW` if cancellations are mixed with successes, `CANCELLED` if nothing ran, and `COMPLETED` otherwise.

Cancellation (`POST /generations/tasks/:taskId/cancel`) is only allowed while a task is still `QUEUED`; a running task is left alone because its provider call has already been paid for.

Composition (`POST /episodes/:episodeId/compositions`) records a `Composition` whose manifest is the ordered list of the episode's **live** storyboard ids — superseded shots are excluded, because concatenating them would either block forever on a clip nobody is going to make or splice a replaced breakdown into the episode — and enqueues `compose-episode`. The worker walks that manifest in order and takes, per shot, the newest succeeded video artifact **of that shot's own VIDEO task** (`GenerationTask.storyboardId`, newest `version` first) and the newest succeeded AUDIO artifact of its own AUDIO task when the shot carries dialogue. Concatenation is two-pass: the clips join with stream copy so the picture is never re-encoded, then each voice line is padded or trimmed to that shot's **measured** duration (a line shorter than its shot leaves the gap silent, a longer one is cut at the cut point, and a silent shot contributes pure silence) before the lines concatenate into one speech track; the episode's latest MUSIC artifact is looped and mixed under that track at a quarter of its own volume when one exists; and the result plus an SRT built from the same durations is muxed back onto the copied video as `aac` audio and a `mov_text` subtitle stream. Soft subtitles rather than burned-in ones are the point — burning would re-encode every frame of the master to save nothing. The master lands as a `COMPOSITION` artifact and the subtitle document as a `SUBTITLE` artifact beside it — the composition points at both — so a subtitle is downloadable, listable and traceable like any other output rather than a blob in a metadata column. Its cues are built from each shot's `dialogue` against that shot's measured clip, not from whichever voice lines happened to land, so the track documents the writing and stays correct when a line is re-voiced; the composition is then marked `COMPLETED`, and any missing segment or FFmpeg failure marks it `BLOCKED` and logs stderr. `BLOCKED` rather than `FAILED` keeps the composition retriggerable once the missing clip lands. Resolving the clip through the batch instead would hand every shot of a batch the same artifact — the mock's byte-identical clips hid that, and a real provider would have composed one shot once per shot in the batch, i.e. a master of the same take repeated three times; the same lineage rule is why each voice line is resolved through its own task too. An episode with no voice and no score takes the original single-pass copy path, so a silent master is byte-for-byte what it was before audio existed.

`planComposition` in `packages/pipeline` decides when the chain should take that step, and composition is its terminal one — no slot, no prompt, no provider, so it is planned apart from `PIPELINE_STAGES`. It refuses with `composition:noStoryboards` when the episode has no live shots and with `composition:missingVideo` while any live shot still lacks a clip, since composing then is guaranteed to land in `BLOCKED`. A live shot with dialogue whose own voice line has not landed is refused the same way (`composition:missingVoice`), because cutting it silently would ship a master where a spoken line is simply absent — but that gate is raised only when the episode's project or organization can actually resolve a `tts_voice` candidate. An installation that never signed up for audio must still be able to deliver a silent episode, so the missing binding is treated as "nobody owes this line a voice", not as a permanent block; a silent shot never blocks anything. Background score is opportunistic by the same reasoning: the composer mixes it when it landed and stays quiet when it did not, so no gate waits on it. It also refuses with `composition:alreadyPlanned` when the newest composition's manifest already equals the live shot list, in the same order: re-cutting an unchanged list would only spend ffmpeg time re-making a master that exists. A regenerate changes that list — the new revision supersedes the shots the master was cut from — so the comparison is exactly what makes an episode re-cut after its breakdown is regenerated instead of shipping a master assembled from a script version nobody is using any more. The same-list rule has one audio exception: if a shot's voice line landed *after* that master was planned, the master is a stale render rather than finished work, so the plan is ready again — neither the task nor the artifact carries a usable timestamp, so "after" is decided by cuid id ordering, which is chronological. The manifest itself stays a list of storyboard ids and records no audio: the composer looks every track up by lineage at cut time, and caching voice or subtitle ids there would only go stale the first time a line was regenerated.

Read surface: `GET /episodes/:episodeId/generations` returns every batch with its tasks, artifacts, and latest quality check, and `GET /artifacts/:artifactId/content` streams the bytes. Both are tenant-scoped and require `read`.

Orchestration (`packages/pipeline`, shared by the API and the worker): the pipeline advances itself, but only as far as a human has approved. `PIPELINE_STAGES` is the auto-advance order — `SCRIPT → STORYBOARD → ASSET → IMAGE → VIDEO → AUDIO → MUSIC` — and composition is the terminal step taken once every stage has run. `nextRunnableStage` walks that order and returns the first stage that has not run yet and whose prerequisites are met: `SCRIPT` needs an approved source **and no approved script** (an approved script is what the stage exists to produce, so a human who derived or wrote one has already produced it — planning the stage anyway would buy a generation nobody asked for and leave a second draft behind), `STORYBOARD` an approved script, `ASSET` at least one asset, `IMAGE`/`VIDEO`/`MUSIC` an approved script and at least one live storyboard, and `AUDIO` an approved script and at least one live shot that actually carries dialogue — a shotless or dialogue-free episode never owes a voice stage. "Has not run yet" is not just "a batch exists": a shot-scoped batch counts as run only while it still targets live shots, because a batch whose shots have all been superseded made media for a breakdown the episode no longer uses, and treating it as done would stall the chain after a regenerate instead of carrying it down through assets, first frames, video, audio and a re-cut master. A stage whose slot has no verified candidate cannot run here at all, so `advancePipeline` keeps a skip set for the call, steps past that stage, and asks again — the chain walks past a capability this installation never bound rather than stalling on it. Nothing is persisted about the skip: every advance re-derives it, so binding a voice model later resumes voicing with nothing to unstick, and once no stage is left the same call composes. Two callers drive it:

- `POST /episodes/:episodeId/run-pipeline` (permission `generation:trigger`) advances one step on demand — the console's one-click **Advance pipeline**. It returns the stage it started and its batch, or the composition it created (`stage: COMPOSITION`, `201`), or `409 pipeline:nothingRunnable` when every stage is run, composition is already cut from the live shots, or the chain is paused on a missing approval — which the console reports as "up to date" rather than as an error.
- The worker relays through the same `advancePipeline` when a batch reaches `COMPLETED` (`apps/worker/src/run-task.ts`), so the chain keeps moving without a human between stages. This auto-advance is system-initiated: it is attributed to no user and audited as `pipeline.autoAdvance` (a human click is `pipeline.advance`). Advancing is best effort — the batch that just completed was already paid for, so a failure to start the next stage is logged to stderr, not thrown back as a job failure that would re-run the completed one.

Because both paths call the same `triggerStage`, a stage the auto-advance starts is gated, prompted, batched, and audited exactly as if a person had triggered it. The advance stops at the first stage whose approval is missing, and an approval is itself what releases the chain again: approving a source or a script calls `advancePipeline` from the same request (see **Upstream versions**), so the only clicks a production needs are the two approvals — everything between them runs itself. That is what makes the chain human-on-the-loop rather than fully autonomous: it runs up to a composed master on its own and waits at each approval for a person.

Regenerate is the edit half of the loop, and it revises both halves of the model: a `regenerate: true` trigger creates a new revision batch with `:rN` keys (planning step 4) and leaves the prior batch intact, and a regenerated `STORYBOARD` run writes a new shot revision and supersedes the old one, so the episode holds exactly one live breakdown plus a readable history rather than two breakdowns side by side. Nothing is ever deleted — the superseded shots keep the first frames and clips already paid for, and the console can show them behind a "history" toggle.

Editing a script does not silently re-run anything: patching a version recomputes its checksum and resets it to `DRAFT`, and a draft drives nothing. **Approval** is the checkpoint that cascades (`cascadeScriptApproval`). When a human approves a script version and the episode's live shots trace a different one, the approval itself triggers a `STORYBOARD` regenerate — the breakdown was produced from words that are no longer current, so leaving it in place would ship a master cut from a script nobody approved. Only a human approval cascades: the worker never approves a script, so the automatic relay it drives cannot arrive back here and loop. The cascade is best effort — the approval is already persisted by the time it runs, so a downstream re-run that could not be enqueued is reported in the response and logged rather than rolling the approval back, and `error: null` means there was simply nothing to cascade (no live shots, or every one of them already traces the approved version, so re-running would pay for the same breakdown again). From there the chain carries itself down without another click: the regenerated breakdown supersedes the shots the media batches targeted, which makes those stages un-run again for `nextRunnableStage`, so assets, first frames, and video re-run for the new revision and `planComposition` sees a changed live shot list and re-cuts the master.

There is no schema-level staleness flag, and one edit still does not cascade: patching an **individual shot** (`PATCH /storyboards/:id`) changes that row in place and leaves its first frame and clip as they are. A human who rewrites a shot re-runs `IMAGE`/`VIDEO` for it with `regenerate: true` — deliberate, because re-buying a clip on every keystroke of a description is not a trade worth making automatically.

Upstream versions (`apps/api/src/routes/sources.ts`): source documents and scripts are versioned per episode, unique on `(episodeId, version)`, and deliberately carry no timestamp columns — the version number is the ordering key and lists come back newest-first. `POST /episodes/:episodeId/source-versions` stores the uploaded `content` verbatim (at most 200,000 characters) with a server-computed SHA-256 checksum; re-uploading content whose checksum equals the latest version's is a `409 sources:duplicate`. Approval flips a version to `APPROVED` once (`409 sources:alreadyApproved` on a repeat) and then starts the chain: the same request calls `advancePipeline`, so approving a source begins `SCRIPT` instead of waiting for a second click on **Advance pipeline**. `POST /episodes/:episodeId/script-versions` derives a script version by copying content and checksum from an `APPROVED` source version named by `sourceVersion` (`409 sources:sourceNotApproved` otherwise), and a script version's content can also be edited by hand (`PATCH /episodes/:episodeId/script-versions/:version`), which recomputes the checksum and resets the version to `DRAFT` so an edit is re-approved before it drives generation.

Approving a script version is the one write that both records a decision and moves work. It first asks whether the episode's live shots were generated from a different version and, if so, cascades a `STORYBOARD` regenerate (see **Regenerate**) and returns `cascaded: true`. Only when nothing cascaded does it re-point every live storyboard at the approved version through `storyboard.updateMany` and return that count as `storyboardsUpdated`, so downstream stages trace exactly one script version. The two are mutually exclusive on purpose: stamping the shots a cascade is about to supersede would make the old breakdown claim it came from words it never saw, and the new revision carries the approved version itself, written by the worker from the task's request snapshot. Superseded shots are never re-pointed at all — a shot keeps the version it was actually broken out of. With nothing to cascade the approval then advances the chain into `STORYBOARD`; a cascade already started the next step, so it does not advance twice.

List endpoints return summaries without content, keeping the list cheap; each family has a single-version `GET` that includes it (`/source-versions/:version` and `/script-versions/:version`), which is what lets the console show the text a human is being asked to approve — a generated script is unreadable as a character count and a checksum — and edit it in place. Reads require `read`, writes require `episode:write` (EDITOR minimum), and every write is audited (`source.upload`, `source.approve`, `script.derive`, `script.edit`, `script.approve`, plus `script.approve.cascade` naming the batch it started); the advance an approval triggers is audited as `pipeline.advance` under the approving user, which is what lets the console and the audit trail say who set the chain moving.

Assets (`apps/api/src/routes/assets.ts`): assets are the episode-level references a production reuses — a character, a prop, a scene. They arrive two ways. The `STORYBOARD` stage extracts them: the same reply that breaks the script into shots reports the cast, props, and scenes it uses, and the worker writes them as `DRAFT` assets (see **Execution**), which is what lets the `ASSET` stage run on an episode nobody typed a cast for. `POST /episodes/:episodeId/assets` is the hand-authored path — a `kind`, a `name`, and a `description` (the text that drives its reference-image prompt) — and both are unique on `(episodeId, kind, name)` (`409 assets:duplicate`). Triggering the `ASSET` generation stage plans one image task per asset through the `image_gen` slot, carrying the asset id in the task's request snapshot; when such a task succeeds the worker appends the next `AssetVersion` (description and prompt snapshot set to the prompt, `artifactId` pointing at the stored image, status `DRAFT`). `POST /episodes/:episodeId/assets/:assetId/versions/:version/approve` flips the version to `APPROVED` once (`409 assets:alreadyApproved` on a repeat) and marks the asset approved — an extraction and a passed quality check are not a likeness a human has signed off on, so this stays a person's call. Reads require `read`, writes require `episode:write`, and every write is audited (`asset.create`, `asset.approve`).

Binding an asset to the shots that use it lives on the storyboard, not the asset: `PUT /storyboards/:storyboardId/assets` (permission `storyboard:write`) replaces the shot's whole set in one transaction — a `Map` deduplicates repeated `assetId`s with the last role winning, and an id belonging to another episode is a `400` naming it. `GET` on the same path reads the links back with the asset's kind, name, and status. Approval is deliberately not a precondition: a shot can be cast against a draft reference and the likeness regenerated later. The console renders every asset of the episode as a toggle chip and writes role `appears` for a link it creates, audited as `storyboard.assets`.

Delivery (`apps/api/src/routes/deliveries.ts`): `POST /episodes/:episodeId/deliveries` packages a delivery behind an acceptance gate — there must be a `COMPLETED` composition with a non-null master `artifactId`, and every **live** storyboard of the episode must have a succeeded VIDEO-stage artifact, which is `composedStoryboardIds` from `packages/pipeline`: the same rule restated for the auto-compose step, so the two refuse for exactly the same episodes. Counting live shots rather than all of them is what keeps a regenerated breakdown deliverable — demanding a clip for a superseded shot would refuse every delivery of an episode whose shot list was ever revised. When the gate fails the response is `409 delivery:notReady` with a human-readable `reasons` array naming each missing piece. The manifest is a versioned JSON document (`schemaVersion` 1) stored as a string on `Delivery.manifest`: `packagedAt`, episode identity, the latest source and script version refs `{version, checksum, status}`, per-storyboard artifacts (`stage`, `objectKey`, `checksum`, `mimeType`, `version`, dimensions, duration) collected from that shot's **own** succeeded tasks — episode-level tasks belong to no shot, and resolving through the batch instead would list all of a batch's artifacts under each of its shots, so a three-shot episode would ship a manifest naming nine artifacts per shot and three copies of the same clip — the composition master, and a `quality` summary whose counts come from one `groupBy` over `QualityCheck` reaching the episode through any of its four relations (storyboard, batch, source document version, or artifact task batch) and whose `threshold` restates the same 0.7 bar the worker judges artifacts against. `POST /deliveries/:id/accept` sets `APPROVED` and stamps `acceptance.acceptedAt` into the manifest; `POST /deliveries/:id/reject` requires a non-blank `reason` and sets `NEEDS_REVIEW`; an accepted delivery is immutable — both verbs then answer `409 delivery:alreadyAccepted`. Deliveries carry no timestamp columns either, so lists order newest-first by cuid id. `GET /episodes/:episodeId/deliveries` and `GET /deliveries/:id/manifest` are the reads. Writes require `episode:write` and are audited (`delivery.create`, `delivery.accept`, `delivery.reject`); every route looks the episode or delivery up through `project.organizationId`, so a cross-tenant id is a 404, never a 403. The web project page mounts a **Sources & scripts** panel and a **Deliveries** panel under the generation panel: write actions are `episode:write`-guarded and render disabled for viewers while reads stay enabled, the `delivery:notReady` reasons surface as a warning alert, the duplicate-checksum 409 becomes an inline field error, and the manifest download goes through the authenticated API client and hands the browser a revocable blob URL — a raw API URL is never placed in the DOM.

## Queue design

Implemented: one BullMQ queue, `studio-pipeline`, carrying two job kinds — `run-task` and `compose-episode`. Job ids are deterministic (`run-<taskId>-<attempt>` and `compose-<compositionId>`) so a duplicate enqueue is a no-op and a rework attempt never collides with its predecessor. BullMQ retries a crashed job twice with exponential backoff; application-level retries (candidate fallback, quality-gate rework) are expressed as new payloads, not as BullMQ retries, because each one has to be visible in the task's attempt count.

Planned: the per-stage topology the schema anticipates — `source-analysis`, `script-generation`, `asset-generation`, `storyboard-generation`, `image-generation`, `video-generation`, `audio-generation`, `quality-check`, `composition`, `delivery` — with concurrency limits per tenant, provider, model, and capability, and retry classification that distinguishes transient, entitlement, validation, and content failures.

Source and script versioning, approval, and delivery packaging are deliberately not on this list: they shipped as synchronous API writes because they only move small text and metadata. Writing a script from an approved source, and breaking an approved script into shots, are on it — they run as `SCRIPT` and `STORYBOARD` tasks on `studio-pipeline` like any other generation (see **Orchestration**). Auto-advance is not a third job kind: it runs inline in the `run-task` handler that observed the batch complete, because the next stage's own `run-task` jobs are what get enqueued. What still needs a queue behind those names is analyzing a source document for structure and the normalized-media export a delivery audit would require.

## Quality gates

After the artifact is stored and before it can be accepted, a `QualityChecker` (`apps/worker/src/qc.ts`) judges it and returns one of three verdicts. The checker only decides; `run-task` owns the record, so the score, the 0.7 threshold, the mode, and the winning candidate land in `QualityCheck.report` the same way whichever checker ran.

- `pass` → `QualityCheck.status = APPROVED`, the usage ledger entry is written, the task succeeds.
- `rework` → `NEEDS_REVIEW` with a score, and the same task is re-queued with `attempt + 1`, up to three attempts, then fails with `<kind>: threshold not met after 3 attempts`.
- `unjudged` → `NEEDS_REVIEW` with a **null** score, and the task fails immediately with `<kind>: <reason>`. Nothing is re-queued.

The third verdict is the one that carries the design. An auditor that could not judge has reported a fault in the audit, not a defect in the content, so the pipeline neither regenerates — that would pay for an artifact nobody rejected — nor falls back to the other checker, which would pretend a judgment happened. `HashQualityChecker` refuses to be constructed under `STUDIO_QC_MODE=model` for the same reason: a missing checker must not silently become a hash score.

Nothing with no visual surface reaches any of the three verdicts. `auditPlanFor(modality)` returns `'none'` for `text`, `tts`, and `music`, and **both** checkers pass such an artifact outright rather than returning `unjudged` — a script or a soundtrack is not a broken audit, it is nothing to audit, and failing the task would block the content stages the whole chain is built on. The row it writes says `fake-qc` with a score of 1, so a pass nobody audited names itself as the placeholder instead of reading like a visual audit that happened to like what it saw.

Two checkers ship.

**`HashQualityChecker`** — the default, and a placeholder rather than a quality judgement about the media: it names itself as `fake-qc` in the row it writes. It scores a SHA-256 of the task id and attempt number against the threshold, deterministically, so a given attempt always gets the same verdict and tests can rely on it; `STUDIO_QC_MODE` forces the outcome (`pass` accepts everything, `fail` rejects everything, `random` exercises both paths). The shipped default mode is **`pass`**: a placeholder with no opinion about the media has no business rejecting it, and under an automated chain a random rejection re-buys an artifact nobody faulted and stalls everything downstream of it. `random` is still there to exercise the rework path on purpose.

**`ModelQualityChecker`** — `STUDIO_QC_MODE=model`, `kind: 'visual-audit'`. It sends the artifact to the model bound to the `visual_audit` slot and asks for `{"score": <0..1>, "reasons": [...]}`. Candidates come from the same `resolveSlotCandidates` the planner uses, so an unverified capability or a disabled connection is not an auditor. A modality with no visual surface is passed before any candidate is looked up, which is what lets `mode=model` write a script or break a storyboard on an installation that has no auditor bound at all. The answer is parsed defensively: prose and code fences around the JSON are tolerated, but a score that is not a finite number in `[0, 1]` is rejected rather than clamped, because a clamped guess would still look like a judgment.

The console renders the same distinction the database makes. The generation panel prints a percentage only for a `visual-audit` score; a `fake-qc` row reads **Not audited** rather than a green 100% nobody earned, and so does an `unjudged` check, whose null score the API passes through instead of coercing to `0` — a coerced zero would arrive as a red 0%, i.e. a failed judgment that never happened. The `kind` and `status` stay one hover away on the cell.

| Modality | Audited | How |
| --- | --- | --- |
| `image` | yes | the artifact bytes are sent as-is |
| `t2v`, `i2v`, `r2v` | partially | one JPEG frame extracted mid-clip by FFmpeg (`frameArgs` in `packages/media`) |
| `text`, `tts`, `music` | **no** | no visual surface to show a model; passes unaudited instead of coming back `unjudged` |

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

Implemented today: `MediaArtifact → GenerationTask → GenerationBatch → Episode → Project → Organization` are real relations, the batch also links the storyboards it planned against, a shot-scoped task carries `storyboardId` naming the single shot its artifact depicts (the batch says which shots a run covered; only the task says whose picture this is), and `QualityCheck` points at the artifact it scored. The object key itself encodes tenant, project, episode, stage, entity, and version. The artifact stores checksum, mime type, dimensions or duration, and the raw provider response as metadata; the task stores the planned request snapshot, the winning provider and model, and a response snapshot naming the attempt, candidate, provider task id, and artifact id.

Input version references are real down to the script and the asset: storyboards carry `scriptVersionId`, stamped from the task's request snapshot when the worker writes them so a shot traces the exact approved words it was broken out of, and re-pointed at a newly approved version only when that approval cascaded nothing (see **Upstream versions**). `revision` and `supersededAt` beside it say which breakdown of the episode a shot belongs to and whether the episode still uses it, so an artifact found through a superseded shot is understood as history rather than as current output. An `ASSET`-stage artifact likewise traces to its asset through `AssetVersion.artifactId`, with the asset id carried in the task's request snapshot, and the delivery manifest names the source and script versions beside every artifact checksum.

The other direction is persisted too: `ScriptVersion`, `Storyboard`, and `Asset` each carry a nullable `generationTaskId` pointing at the task that produced them, and through it at the batch, the winning provider and model, the prompt, the stored artifact, and the quality check that passed it. It is null on a row a human wrote — a hand-authored asset or a derived script version — which is the difference the console renders as an "AI generated" badge rather than guessing from the content. Still missing: a configuration version per attempt.

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
- No read endpoint returns an encrypted secret; connection responses expose only `apiKeySet` and `accessKeySet`
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
- Triggering `SCRIPT` with no approved source, or `STORYBOARD`/`IMAGE`/`VIDEO`/`AUDIO`/`MUSIC` with no approved script, is rejected with `409` and queues nothing
- A succeeded `SCRIPT` task writes a new draft `ScriptVersion` deduplicated by checksum, and a succeeded `STORYBOARD` task writes its shots as a new revision stamped with the approved script, supersedes every prior revision, and creates a `DRAFT` asset for each character, prop, and scene it reports; output that cannot be parsed fails the task rather than writing rows, and a superseded shot is never deleted
- A generated `ScriptVersion`, `Storyboard`, and `Asset` carries `generationTaskId` back to the task, batch, model, prompt, and artifact that produced it, and a human-authored row leaves it null
- A script version's content can be edited, which recomputes its checksum and resets the version to draft so the edit is re-approved before it drives generation
- `POST /episodes/:id/run-pipeline` advances exactly one runnable step — a stage, or the composition once every stage has run — skipping a stage that already has a batch covering live shots, and answers `409 pipeline:nothingRunnable` when the episode is up to date or paused on a missing approval
- The worker advances the pipeline by itself when a batch reaches `COMPLETED`, audited as `pipeline.autoAdvance` with no user; a failed advance is logged rather than thrown, so the completed job is not re-run
- Approving a source starts `SCRIPT` in the same request, and approving a script either cascades a `STORYBOARD` regenerate — answering `cascaded: true` and leaving the live shots alone — or re-points them at the approved version and starts `STORYBOARD`; neither rolls the approval back when the next step cannot be planned
- A superseded shot keeps the script version it was actually generated from, so a superseded breakdown never claims it came from words it never saw
- `IMAGE` and `VIDEO` plan only against live storyboards, and a batch whose shots have all been superseded stops counting as run, so the chain carries a regenerate down through assets, first frames, and video instead of stalling on stages that already ran
- Composition is cut from the live shot list in order, blocks when a clip is missing, refuses to re-cut an unchanged list, and is re-cut once a regenerate changes it
- A `regenerate` trigger creates a new batch whose keys carry a `:rN` revision suffix, leaves the prior batch and its keys untouched, and is audited as `generation.regenerate` carrying the revision
- The storyboard media read prefers the newest revision's artifact, so a regenerated shot displays the regeneration and not the stale one
- Composition cuts each shot from its **own** clip: a two-shot episode whose clips run 1 s and 3 s composes to ~4 s, where resolving through the batch would pick one artifact twice and land on 2 s or 6 s
- `AUDIO` plans one voice task per **speaking** live shot with that shot's own line as the prompt, and is refused with `400` when no live shot carries a line, so a silent episode never buys audio of nothing
- A shot reads back with its `dialogue`, its `speaker` and its voice artifact, and a human can rewrite the line and the speaker through the storyboard patch route
- Composition holds while a speaking shot has no voice line — but only once a voice model is bound — takes the `MUSIC` step from the approved script when a generator is bound, and re-cuts once a voice line lands after the master was planned
- A master mixes the per-shot voice and the episode's score under a video stream the FFmpeg pass never re-encodes, and carries a `mov_text` subtitle track; a dialogue-free, score-free episode still composes on the original single-pass copy path
- The subtitle document of a finished composition is its own downloadable artifact, and a line still gets its cue when its voice never landed
- A candidate failure is preserved on the task and the worker advances to the next verified candidate
- A rejected artifact is reworked up to three attempts and then fails the task, with a `QualityCheck` row per attempt
- `STUDIO_QC_MODE=model` with no verified `visual_audit` binding fails an image or video task, records a `QualityCheck` with a null score, and queues no further attempt — while text and audio pass unaudited under either checker, so the content stages run with no auditor bound
- `STUDIO_QC_MODE=model` with a bound auditor approves an image artifact outright and a video artifact judged from one FFmpeg-extracted frame
- Batch status is derived from its tasks after every transition, including cancellation
- Only a queued task can be cancelled; a viewer cannot trigger, cancel, or compose
- An artifact streams with its stored mime type and length, and a missing file is a `404`
- A source upload is deduplicated by checksum, a script can only be derived from an approved source, and approving a script re-points every live storyboard of the episode at it when nothing cascaded
- A single script version reads back with its content — including straight after an edit — while the list stays content-free, and a version number belonging to another organization's episode is a `404`
- The browser preflight is answered for `POST`, `PUT`, `PATCH`, and `DELETE` against an allowed origin and not echoed for one outside the allowlist
- An asset can be authored or extracted, its reference image generated through the image slot, and a version approved — which also marks the asset approved — and a completed asset artifact traces back to that version
- An asset can be bound to the storyboards that use it whether or not it is approved, and binding an asset belonging to another episode is rejected
- Delivery packaging is refused with reasons while no composition has completed or any live storyboard lacks a succeeded video — the same rule the auto-compose step applies
- A delivery manifest names the source and script versions with checksums, each live storyboard's **own** artifacts, the composition master, and the quality counts against the 0.7 threshold
- An accepted delivery is immutable, and rejecting one requires a reason

Pending:

- Source, script, and audio content pass a real content audit (event order, coverage, prohibited additions): today they are passed unaudited, which is honest about there being nothing visual to judge but is not a judgement about the writing
- The visual audit has run against a live multimodal provider, and the 0.7 threshold is calibrated to what one actually scores
- Video and audio generation have run against a live provider: the wanx video path, `qwen3-tts-flash`, `fun-music-v1`, the Seedance task API and the Kling task API are covered only by stubbed-response tests written against each vendor's documented contract, and only Qwen-Image image generation is proven live
- A speaker is a label, not an identity: nothing maps a named character to one voice across shots, so every line goes to the bound model's default voice unless the caller passes one
- Subtitle cues are per line against each shot's measured clip, not per word, so a line's cue is as tight as its shot rather than as tight as the speech
- A hand edit of an individual shot cascades: patching a shot's description or its line leaves its first frame, clip and voice as they are, and a person has to re-run `IMAGE`/`VIDEO`/`AUDIO` for it (an edited *script* does cascade, through approval)
- A shot's human edits are versioned: only an AI regenerate creates a revision, so `PATCH /storyboards/:id` rewrites the row in place and there is no per-edit history of the wording a person typed
- A reference video task cannot select T2V
- A completed artifact can be traced back to a per-attempt configuration version
- Delivery audits verify normalized media and reproducible export
- Docker Compose starts web, API, worker, PostgreSQL, Redis, and MinIO
