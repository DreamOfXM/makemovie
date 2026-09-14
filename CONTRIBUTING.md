# Contributing

Short Drama Studio is a pnpm monorepo. This guide covers setup, the conventions the code follows, and what a pull request needs before it can merge.

## Prerequisites

- Node.js ≥ 22.18 — workspace packages are consumed as TypeScript source through Node's native type stripping
- pnpm 9 — `corepack enable` picks up the pinned version from `packageManager`
- FFmpeg ≥ 6 on `PATH` — the media and worker tests synthesize and compose real media
- Redis on `127.0.0.1:6380` — the pipeline tests use a real queue (API tests take database 7, worker tests database 5, and each obliterates its own database at teardown). `docker compose up -d redis` provides it; CI runs a service container.
- Docker — for local PostgreSQL/Redis/MinIO. PostgreSQL is **not** needed for tests: they boot an embedded instance.

## Setup

```bash
pnpm install
pnpm --filter @studio/db generate   # Prisma client
pnpm build                          # compiles @studio/providers, api, worker, web
```

Run the app:

```bash
docker compose up -d postgres redis minio
pnpm --filter @studio/db exec prisma migrate deploy
pnpm dev                            # api :4010, web :3010, worker
```

Never run `pnpm build` while `pnpm dev` is up. The recursive build includes `next build`, which clobbers `apps/web/.next` — the same directory the dev server serves from — so the running dev server starts 404ing its own chunks and the browser sits stuck on "Restoring your session…". If that happens, stop the dev stack, delete `apps/web/.next`, and restart `pnpm dev`.

## Testing

```bash
pnpm test                                        # every package
pnpm --filter @studio/api test                   # one package
pnpm --filter @studio/api exec vitest run test/model-center.test.ts
pnpm --filter @studio/api exec vitest run -t 'resolve'
```

`apps/api/test/env.ts` starts an embedded PostgreSQL on a random free port above 55400, applies the real migrations with `prisma migrate deploy`, builds the Fastify app with `logger: false`, and returns helpers (`register`, `authHeaders`, `stop`). Use it for any test that touches the database — do not mock Prisma.

Vitest strips types without checking them, and each package's `tsconfig.json` only includes `src`. `pnpm typecheck` therefore ends with `tsc -p tsconfig.test.json`, which typechecks API and package test files together. Add new test directories to that config's `include` list.

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

### Generation pipeline

- Never assign `GenerationBatch.status` directly. Call `syncBatchStatus(db, batchId)` from `@studio/db` after any task transition; the batch status is derived from its task counts.
- The API streams artifacts from, and the worker writes them into, `app.config.artifactsDir` (`STUDIO_ARTIFACTS_DIR`). Both processes must resolve the same **absolute** path — a relative default resolves against each package directory and silently splits the media in two.
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
