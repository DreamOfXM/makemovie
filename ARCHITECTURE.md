# Short Drama Studio

> Status: the platform layer (tenancy, RBAC, sessions, audit, and the model capability configuration center) is implemented and covered by tests. The generation pipeline sections — queue design, quality gates, artifact traceability, and object storage — describe the design the schema already anticipates but the workers do not yet execute. Section-level status is called out inline.

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
- Docker Compose deployment (compose file and API/worker/web Dockerfiles present; end-to-end startup not yet verified)
- Apache-2.0 licensing

Planned:

- OAuth and SSO extension points
- Redis and BullMQ workers
- S3-compatible storage; MinIO for local deployment
- FFmpeg media worker
- Additional provider adapters (OpenAI-compatible APIs, Volcengine)

## Monorepo

- `apps/web`: Next.js application (projects, model center, members; English/Chinese UI)
- `apps/api`: Fastify API (auth, projects, episodes, members, providers, bindings, audit)
- `apps/worker`: BullMQ workers; scaffolding only until the generation pipeline lands
- `packages/domain`: domain entities, capability slots, state machines, validation
- `packages/db`: Prisma schema, migrations, and the generated client
- `packages/providers`: provider catalogs and adapters (dashscope, mock)
- `packages/media`: FFmpeg pipelines and media inspection
- `packages/config`: typed environment and runtime configuration
- `packages/security`: Argon2id hashing, token hashing, AES-256-GCM secret encryption
- `infra`: API, worker, and web Dockerfiles (`docker-compose.yml` sits at the repository root)
- `docs`: currently the short-drama production skill specification; product, API, and operations docs are still to be written

## Domain model

Tenant isolation is mandatory on every aggregate. Exercised by the API today:

- User
- Organization
- OrganizationMember
- Session
- Project
- Episode
- ProviderConnection
- ModelCapability
- CapabilityBinding
- AuditEvent
- UsageLedger

Defined in the schema and migrations, driven by the pipeline once it lands:

- SourceDocumentVersion
- ScriptVersion
- Asset and AssetVersion
- Storyboard, StoryboardVersion, and StoryboardAsset
- GenerationBatch
- GenerationTask
- MediaArtifact
- QualityCheck
- Composition
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

## Model capability policy

A provider connection is separate from a model capability. A capability declares:

- modality: `text`, `image`, `t2v`, `i2v`, `r2v`, `tts`, `music`, `vlm`
- reference-image behavior: first frame accepted, reference images accepted, maximum reference count
- model-specific limits held in the `spec` JSON: resolutions, durations, audio behavior, rate limits
- entitlement probe status and message
- last probed and last verified timestamps

Tasks are planned against capabilities, not model names alone.

Rules:

- A task with first-frame or character references may use only I2V/R2V capabilities.
- T2V is never an automatic fallback for reference tasks.
- Fallback candidates are unique, capability-compatible, entitlement-verified, and recorded in order.
- Every attempt stores provider, model, configuration version, request snapshot, response status, and sanitized error.
- A successful submission stops fallback; polling never creates a replacement task.

## Model capability configuration center

Model configuration is a four-layer chain. Nothing downstream may skip a layer.

1. **Catalog** (`packages/providers/src/catalog.ts`) — a built-in, code-reviewed description of the models a provider exposes and the capabilities each one honestly supports. DashScope lists only the modalities the adapter can actually drive; the mock provider covers every modality so the pipeline can run without credentials. Catalogs are read-only data, not tenant state.
2. **Connection** (`ProviderConnection`) — a tenant's credential record: provider key, display name, base URL, enabled flag, last error, and an optional `projectId` that scopes the connection to one project. The API key is encrypted with AES-256-GCM by `packages/security` before it reaches the database and is never returned by any read endpoint.
3. **Capability** (`ModelCapability`) — one row per catalog model under a connection, carrying `model`, `displayName`, `modality` (`text`, `image`, `t2v`, `i2v`, `r2v`, `tts`, `music`, `vlm`), `acceptsFirstFrame`, `acceptsReferenceImages`, `maxReferenceImages`, and a `spec` JSON blob that holds the model-specific detail (resolutions, durations, audio behavior, rate limits). Probe state lives in `probeStatus`, `probeMessage`, `lastProbedAt`, and `entitlementVerifiedAt`; probing calls the provider through the adapter and stamps `entitlementVerifiedAt` only on success.
4. **Binding** (`CapabilityBinding`) — attaches a verified capability to one of the nine capability slots (`script_text`, `storyboard_text`, `image_gen`, `video_t2v`, `video_i2v`, `video_r2v`, `tts_voice`, `music_gen`, `visual_audit`) at either organization or project scope with a priority. `slotModality` in `packages/domain` maps each slot to the single modality it accepts, `canBind` rejects mismatches, and a capability without `entitlementVerifiedAt` cannot be bound at all.

`GET /bindings/resolve?slot=&projectId=` returns the ordered candidate list the planner consumes: project-scope bindings first, then organization scope, each sorted by priority descending, deduplicated by capability, with disabled or unverified capabilities dropped.

API surface: `GET /providers/catalogs`, `GET|POST|PATCH|DELETE /providers/connections`, `POST /providers/connections/:connectionId/probe`, `GET|POST|PATCH|DELETE /bindings`, `GET /bindings/resolve`. Provider and binding management require the `providers:manage` / `bindings:manage` permissions (ADMIN and OWNER); every mutation writes an audit event.

The web Model Center page exposes the same chain in order — connections and probes, slot bindings, resolution preview, then catalogs — in both English and Chinese.

## Queue design

BullMQ queues:

- `source-analysis`
- `script-generation`
- `asset-generation`
- `storyboard-generation`
- `image-generation`
- `video-generation`
- `audio-generation`
- `quality-check`
- `composition`
- `delivery`

Jobs are idempotent by deterministic job key. Queues support concurrency limits per tenant, provider, model, and capability. Retries distinguish transient errors, entitlement errors, validation errors, and content failures.

## Quality gates

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

Every artifact must be reachable in both directions:

project → episode → storyboard/asset → generation batch → task attempt → artifact → quality checks

and:

artifact → task attempt → model/configuration → source prompt/input versions → storyboard/asset → episode/project/organization.

Each artifact has tenant ID, project ID, episode ID, storyboard or asset ID, stage, version, prompt/input snapshot, model, provider, configuration version, task ID, object-storage key, checksum, dimensions, duration, and timestamps.

## Storage

The application stores metadata in PostgreSQL and binary data in S3-compatible storage. Object keys are generated from tenant/project/episode/stage/entity/version and never from user-provided filenames. Local development uses MinIO with the same S3 interface.

## Security

Implemented:

- Password hashing with Argon2id (`packages/security`)
- Provider API keys encrypted at rest with AES-256-GCM; ciphertext format `v1.<iv>.<tag>.<ct>` (base64url), master key supplied as 64 hex characters via `STUDIO_MASTER_KEY`
- No read endpoint returns an encrypted secret; connection responses expose only `apiKeySet`
- Sessions stored in the database as SHA-256 token hashes with a 7-day TTL, revoked on logout, organization switch, and membership removal
- Role-based authorization (`OWNER > ADMIN > EDITOR > REVIEWER > VIEWER`) checked by `requirePermission` at every route boundary; every query is scoped by `organizationId`
- Provider errors pass through `sanitizeError`, which keeps only code, message, and request id, truncated to 500 characters
- Audit events for authentication, membership, provider, and binding actions
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

Pending the generation pipeline:

- A source document can be versioned and audited
- The system can produce approved script, asset, and storyboard versions
- A reference video task cannot select T2V
- A failed model attempt preserves its error and can select only compatible verified alternatives
- A completed artifact can be traced to its storyboard, prompt, model, task, and source version
- A delivery manifest identifies missing, blocked, and approved segments
- Docker Compose starts web, API, worker, PostgreSQL, Redis, and MinIO
