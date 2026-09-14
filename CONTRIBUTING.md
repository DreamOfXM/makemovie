# Contributing

MakeMovie is a pnpm monorepo. This guide covers setup, the conventions the code follows, and what a pull request needs before it can merge.

## Prerequisites

- Node.js ≥ 22.18 — workspace packages are consumed as TypeScript source through Node's native type stripping
- pnpm 9 — `corepack enable` picks up the pinned version from `packageManager`
- FFmpeg ≥ 6 on `PATH` — the media and worker tests synthesize and compose real media
- Redis on `127.0.0.1:6380` — the pipeline tests use a real queue (API tests take database 7, worker tests database 5, and each obliterates its own database at teardown). `docker compose up -d redis` provides it; CI runs a service container.
- Docker — for local PostgreSQL and Redis. PostgreSQL is **not** needed for tests: they boot an embedded instance. MinIO is in the compose file as well, but nothing needs it unless you set `STORAGE_BACKEND=s3`, and no test touches it — the S3 backend is tested against an in-process fake server.

## Setup

```bash
pnpm install
pnpm --filter @studio/db generate   # Prisma client
pnpm build                          # compiles @studio/providers, api, worker, web
```

Run the app:

```bash
docker compose up -d postgres redis
pnpm --filter @studio/db exec prisma migrate deploy
pnpm dev                            # api :4010, web :3010, worker
```

Add `minio` to that command only if you mean to run with `STORAGE_BACKEND=s3`, and create the bucket before the first generation — nothing in the stack does it. Either use the MinIO console on <http://localhost:9001> (login `studio` / `studio-password`, the compose root credentials) and create a bucket named `studio`, or `mc mb local/studio` from a container that has `mc`. Neither has been run here: no container runtime was available where the S3 backend was written.

Never run `pnpm build` while `pnpm dev` is up. The recursive build includes `next build`, which clobbers `apps/web/.next` — the same directory the dev server serves from — so the running dev server starts 404ing its own chunks and the browser sits stuck on "Restoring your session…". If that happens, stop the dev stack, delete `apps/web/.next`, and restart `pnpm dev`.

## Testing

```bash
pnpm test                                        # every package
pnpm --filter @studio/api test                   # one package
pnpm --filter @studio/api exec vitest run test/model-center.test.ts
pnpm --filter @studio/api exec vitest run -t 'resolve'
```

`apps/api/test/env.ts` starts an embedded PostgreSQL on a random free port above 55400, applies the real migrations with `prisma migrate deploy`, builds the Fastify app with `logger: false`, and returns helpers (`register`, `authHeaders`, `stop`). Use it for any test that touches the database — do not mock Prisma.

Vitest strips types without checking them, and each package's `tsconfig.json` only includes `src`. `pnpm typecheck` therefore ends with `tsc -p tsconfig.test.json`, which typechecks every test directory in the repo. Add a new one to that config's `include` list — a test file that is missing from it runs green while carrying type errors, because nothing else looks at it.

## Conventions

### Package exports

Every workspace package points its `exports` at `src/index.ts` **except `@studio/providers`**, which points at `dist`. The reason: Node's type stripping does not rewrite relative `./types.js` specifiers to `.ts`, so a multi-file TypeScript package cannot be consumed from source. If you change anything under `packages/providers/src`, run `pnpm --filter @studio/providers build` before starting the API or its tests will fail with `ERR_MODULE_NOT_FOUND`.

### API routes

- One Fastify plugin per resource under `apps/api/src/routes`, registered in `apps/api/src/app.ts`
- Guard every route with `requirePermission('<action>')` from `apps/api/src/plugins/auth.ts`
- Scope every query by `request.auth!.organizationId`; a record from another tenant returns 404, never 403
- Write an audit event for every mutation via `recordAudit` in `apps/api/src/lib/audit.ts`
- Return 4xx with `{ error: string }`; do not throw raw Prisma errors at callers

### Secrets

Provider API keys go through `encryptSecret(plaintext, masterKey)` / `decryptSecret(payload, masterKey)` from `@studio/security` (AES-256-GCM, ciphertext format `v1.<iv>.<tag>.<ct>`). The master key comes from `app.config.masterKey`. Never store a plaintext key, never include `encryptedSecret` in a response, and never log it.

### Storage

- Reach bytes through the injected storage — `app.storage` in the API, `deps.storage` in the worker. Never construct a backend inside a route or a task, and never import `DiskStorage` or `S3Storage` outside `packages/media`: the whole point of the seam is that neither process knows which backend it has.
- Each process builds exactly one instance with `storageFrom(config)` and closes it on shutdown. An S3 client holds a live socket agent that will otherwise keep Node alive, and `close()` is what releases it.
- Do not add a path-shaped method to `Storage`. `localPath` was removed because only a filesystem can implement it. A caller that genuinely needs a real file writes one, as composition does with `read` into a temporary directory.
- `open` resolves `null` for an absent object and throws for anything else. Keep that split — answering an unreachable store with "not found" hides media behind a 404 that is not true.
- The S3 backend has only ever been tested against an in-process fake server, which ignores the `Authorization` header. Anything you change about signing, credentials, region, or TLS stays unverified until someone runs it against a real MinIO; say so in the pull request rather than letting the green suite imply otherwise.

### Generation pipeline

- Never assign `GenerationBatch.status` directly. Call `syncBatchStatus(db, batchId)` from `@studio/db` after any task transition; the batch status is derived from its task counts.
- Judge artifacts through the `QualityChecker` seam in `apps/worker/src/qc.ts`, never by writing a `QualityCheck` row from somewhere else. A checker returns `pass`, `rework`, or `unjudged`; `run-task` owns the row so the threshold, mode, and candidate are recorded identically whichever checker ran. `unjudged` means the audit broke, not that the content is bad — it must fail the task and must never fall through to a different checker, because a score nobody produced looks exactly like a judgment that happened.
- `STUDIO_QC_MODE=model` costs one vision-model call per artifact and is not reproducible: the same frame can score differently on a second run. Keep it out of CI and out of any test default. Tests that need a rejection should supply a stub checker rather than turning the mode on.
- The API streams artifacts from, and the worker writes them into, one injected `Storage`. On the default `disk` backend that is `STUDIO_ARTIFACTS_DIR`, and both processes must resolve the same **absolute** path — a relative default resolves against each package directory and silently splits the media in two. On `s3` the same reasoning applies to the endpoint and bucket, which is why compose merges one shared block into both services instead of listing it twice.
- Artifact bytes reach the browser only through `GET /artifacts/:artifactId/content`, which needs the session bearer token. Media elements cannot send headers, so the web app fetches the bytes and hands `URL.createObjectURL` results to the element, revoking them on unmount. Do not paste the URL into an `src` attribute.

### Domain vs Prisma enums

`packages/domain` uses snake_case (`video_t2v`); Prisma enums use SCREAMING_SNAKE (`VIDEO_T2V`). Convert at the route boundary with `toUpperCase()` / `toLowerCase()` and validate with the `is*` guards (`isCapabilitySlot`, `isWorkflowStatus`). Do not let Prisma enum strings leak into the domain package.

### Web i18n

`apps/web/lib/i18n.tsx` holds the English and Chinese dictionaries. Every user-facing string goes through `t('key')`, and a new key must be added to **both** dictionaries. No hardcoded labels in components. Count strings use the built-in plural subset — `'{count, plural, one {# planned task} other {# planned tasks}}'` — which is expanded before plain `{name}` interpolation; `#` becomes the value and `one` only ever matches exactly 1.

### Migrations

```bash
pnpm --filter @studio/db exec prisma migrate dev --name add_thing
```

Commit the generated SQL under `packages/db/prisma/migrations`. Never edit a migration that has been applied or committed — add a new one.

## Adding a provider adapter

1. Add the catalog entry in `packages/providers/src/catalog.ts`. List only the modalities the adapter can actually drive — a catalog entry that the adapter later throws on is a bug, not a placeholder.
2. Implement `ProviderAdapter` (`probe`, `submit`, `poll`) in a new file next to `dashscope.ts`. Keep request construction in pure exported functions (see `buildSubmitRequest` / `buildPollRequest`) so they are unit-testable without a network.
3. Register the adapter in `createAdapter` in `packages/providers/src/index.ts`.
4. Pass every error body through `sanitizeError` before it reaches the database or a log.
5. Add unit tests in `packages/providers/test/` covering catalog integrity, request building, and status mapping. Add an API integration test if the adapter changes route behavior.
6. Rebuild: `pnpm --filter @studio/providers build`.

The mock provider must keep covering all modalities so the pipeline stays runnable without credentials.

## Adding a capability slot

1. Add it to `capabilitySlots` and `slotModality` in `packages/domain/src/index.ts`
2. Add the matching value to `enum CapabilitySlot` in the Prisma schema and create a migration
3. Add the label to both i18n dictionaries
4. Add a `canBind` test for the new slot/modality pair

## Pull request checklist

- [ ] `pnpm typecheck`, `pnpm build`, and `pnpm test` all pass locally
- [ ] New behavior has tests; API changes have integration tests against the embedded database
- [ ] Routes are permission-guarded, tenant-scoped, and audited
- [ ] No secret, token, or key is logged, returned by an endpoint, or committed
- [ ] New UI strings exist in both the English and Chinese dictionaries
- [ ] Schema changes ship with a migration
- [ ] `README.md` / `ARCHITECTURE.md` updated if behavior or boundaries changed
- [ ] The description says what changed and why, and notes anything not covered by tests

CI runs typecheck, build, and the full test suite on every push to `main` and every pull request. A red CI blocks merge.

## License

By contributing you agree your contributions are licensed under Apache-2.0.
