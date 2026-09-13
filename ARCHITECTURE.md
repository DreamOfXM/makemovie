# Short Drama Studio

## Goal

A self-hostable and commercial-ready AI short-drama production system. It manages the complete path from source material to an audited deliverable:

source audit → script → assets → storyboards → first frames → videos → voice/subtitles/music → composition → acceptance → delivery.

The system must distinguish planning completion, asset completion, generation completion, acceptance completion, and delivery completion.

## Product boundaries

Initial release:

- Multi-tenant users, organizations, projects, and role permissions
- Email/password authentication with OAuth extension points
- PostgreSQL persistence with Prisma
- Redis and BullMQ workers
- S3-compatible storage; MinIO for local deployment
- Next.js web application
- NestJS/Fastify API
- FFmpeg media worker
- Provider adapters for Bailian, OpenAI-compatible APIs, and Volcengine
- Docker Compose deployment
- Apache-2.0 licensing

## Monorepo

- `apps/web`: Next.js application
- `apps/api`: NestJS API and authentication
- `apps/worker`: BullMQ workers for AI and media jobs
- `packages/domain`: domain entities, state machines, validation, events
- `packages/db`: Prisma schema and migrations
- `packages/providers`: provider and model adapters
- `packages/media`: FFmpeg pipelines and media inspection
- `packages/config`: typed environment and runtime configuration
- `packages/ui`: shared UI primitives
- `infra`: Docker Compose, MinIO, PostgreSQL, Redis
- `docs`: product, API, operations, and provider specifications

## Domain model

Tenant isolation is mandatory on every aggregate:

- User
- Organization
- OrganizationMember
- Project
- Episode
- SourceDocumentVersion
- ScriptVersion
- Asset and AssetVersion
- Storyboard and StoryboardVersion
- GenerationBatch
- GenerationTask
- MediaArtifact
- QualityCheck
- Composition
- Delivery
- AuditEvent
- ProviderConnection
- ModelCapability
- UsageLedger

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

- modality: T2V, I2V, R2V, image, text, audio
- accepted inputs and limits
- output limits
- supported resolutions and durations
- reference-image behavior
- audio behavior
- rate limits
- entitlement probe status
- last verified timestamp

Tasks are planned against capabilities, not model names alone.

Rules:

- A task with first-frame or character references may use only I2V/R2V capabilities.
- T2V is never an automatic fallback for reference tasks.
- Fallback candidates are unique, capability-compatible, entitlement-verified, and recorded in order.
- Every attempt stores provider, model, configuration version, request snapshot, response status, and sanitized error.
- A successful submission stops fallback; polling never creates a replacement task.

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

- Password hashes use Argon2id
- Session or short-lived access tokens with rotation
- Organization-scoped authorization at API and worker boundaries
- Provider secrets encrypted at rest and redacted from logs
- Signed object URLs with expiration
- Webhook signatures and replay protection
- Audit events for permission, configuration, generation, deletion, and delivery actions

## Initial acceptance criteria

- A new organization can create a project and episode through the web UI
- A source document can be versioned and audited
- The system can produce approved script, asset, and storyboard versions
- A reference video task cannot select T2V
- A failed model attempt preserves its error and can select only compatible verified alternatives
- Two tenants cannot read or mutate each other's records or artifacts
- A completed artifact can be traced to its storyboard, prompt, model, task, and source version
- A delivery manifest identifies missing, blocked, and approved segments
- Docker Compose starts web, API, worker, PostgreSQL, Redis, and MinIO
