import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Prisma, syncBatchStatus, type ModelCapability as CapabilityRow } from '@studio/db'
import type { ModelModality } from '@studio/domain'
import type { RunTaskCandidate, RunTaskPayload } from '@studio/jobs'
import { buildObjectKey, extensionFor, sha256, synthesizeMockMedia } from '@studio/media'
import { createAdapter, type ModelCapability, type PollResult, type ProviderAdapter, type ProviderRequest } from '@studio/providers'
import { decryptSecret } from '@studio/security'
import type { QcMode } from './config.js'
import type { PipelineDeps } from './deps.js'

export const QC_THRESHOLD = 0.7
export const MAX_ATTEMPTS = 3

type TaskRow = Prisma.GenerationTaskGetPayload<{ include: { batch: { include: { episode: { include: { project: true } } } } } }>

type CandidateOutcome = { status: 'succeeded' } | { status: 'rework' } | { status: 'exhausted' } | { status: 'next'; error: string }

interface Material {
  bytes: Uint8Array
  mimeType: string
  width?: number
  height?: number
  durationMs?: number
}

const POLL_INTERVAL_MS = 250
const POLL_TIMEOUT_MS = 30_000
const MOCK_DURATION_MS = 1_000

// ffmpeg chooses the container from the output file extension, so the temp name has to
// match the modality before synthesizeMockMedia can tell us the real mime type.
const MOCK_EXTENSION: Record<string, string> = { image: 'png', t2v: 'mp4', i2v: 'mp4', r2v: 'mp4', tts: 'wav', music: 'wav' }

export async function runTask(payload: RunTaskPayload, deps: PipelineDeps): Promise<void> {
  const task = await deps.db.generationTask.findUnique({
    where: { id: payload.taskId },
    include: { batch: { include: { episode: { include: { project: true } } } } },
  })
  if (!task) throw new Error(`generation task ${payload.taskId} not found`)
  if (task.status === 'CANCELLED') return

  await deps.db.generationTask.update({ where: { id: task.id }, data: { status: 'RUNNING', attempts: payload.attempt } })
  await syncBatchStatus(deps.db, task.batchId)

  const errors: string[] = []
  for (const candidate of payload.candidates) {
    let outcome: CandidateOutcome
    try {
      outcome = await runCandidate(task, candidate, payload, deps)
    } catch (error) {
      outcome = { status: 'next', error: `${label(candidate)}: ${message(error)}` }
    }
    if (outcome.status === 'next') {
      errors.push(outcome.error)
      continue
    }
    await syncBatchStatus(deps.db, task.batchId)
    return
  }

  await deps.db.generationTask.update({
    where: { id: task.id },
    data: { status: 'FAILED', errorSnapshot: JSON.stringify(errors.length > 0 ? errors : ['no candidates supplied']) },
  })
  await syncBatchStatus(deps.db, task.batchId)
}

async function runCandidate(task: TaskRow, candidate: RunTaskCandidate, payload: RunTaskPayload, deps: PipelineDeps): Promise<CandidateOutcome> {
  const connection = await deps.db.providerConnection.findUnique({ where: { id: candidate.connectionId } })
  if (!connection || !connection.enabled || connection.organizationId !== task.organizationId) {
    return { status: 'next', error: `${label(candidate)}: connection ${candidate.connectionId} unavailable` }
  }
  const capabilityRow = await deps.db.modelCapability.findUnique({ where: { id: candidate.capabilityId } })
  if (!capabilityRow || capabilityRow.connectionId !== connection.id) {
    return { status: 'next', error: `${label(candidate)}: capability ${candidate.capabilityId} unavailable` }
  }

  const capability = toCapability(connection.provider, capabilityRow)
  const request = parseRequest(task.requestSnapshot, candidate.model)
  const apiKey = decryptSecret(connection.encryptedSecret, deps.masterKey)
  const adapter = createAdapter(connection.provider, { apiKey, baseUrl: connection.baseUrl })

  const submitted = await adapter.submit(capability, request)
  const result = await pollToSettled(adapter, capability, submitted.taskId, deps)
  if (result.status === 'failed') return { status: 'next', error: `${label(candidate)}: ${result.error ?? 'provider reported failure'}` }

  const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-artifact-'))
  try {
    const material = await materialize(result, capability.modality, workdir)
    const objectKey = buildObjectKey({
      tenantId: task.organizationId,
      projectId: task.batch.episode.project.id,
      episodeId: task.batch.episodeId,
      stage: task.stage,
      entityId: task.id,
      version: payload.attempt,
      extension: extensionFor(material.mimeType),
    })
    const stored = await deps.storage.put(objectKey, material.bytes, material.mimeType)
    const artifact = await deps.db.mediaArtifact.create({
      data: {
        organizationId: task.organizationId,
        taskId: task.id,
        stage: task.stage,
        objectKey: stored.key,
        checksum: stored.checksum,
        mimeType: stored.mimeType,
        version: payload.attempt,
        width: material.width,
        height: material.height,
        durationMs: material.durationMs,
        metadata: JSON.stringify(result),
      },
    })

    const score = qcScore(task.id, payload.attempt, deps.qcMode)
    const passed = score >= QC_THRESHOLD
    await deps.db.qualityCheck.create({
      data: {
        status: passed ? 'APPROVED' : 'NEEDS_REVIEW',
        kind: 'fake-qc',
        score,
        report: JSON.stringify({ threshold: QC_THRESHOLD, mode: deps.qcMode, candidate }),
        artifactId: artifact.id,
      },
    })

    if (!passed) {
      if (payload.attempt >= MAX_ATTEMPTS) {
        await deps.db.generationTask.update({
          where: { id: task.id },
          data: { status: 'FAILED', errorSnapshot: `fake-qc: threshold not met after ${MAX_ATTEMPTS} attempts` },
        })
        return { status: 'exhausted' }
      }
      await deps.enqueueJob({ ...payload, attempt: payload.attempt + 1 })
      return { status: 'rework' }
    }

    await deps.db.usageLedger.create({
      data: {
        organizationId: task.organizationId,
        taskId: task.id,
        provider: candidate.provider,
        model: candidate.model,
        modality: capability.modality,
        inputUnits: promptLength(request),
        outputUnits: stored.sizeBytes,
      },
    })
    await deps.db.generationTask.update({
      where: { id: task.id },
      data: {
        status: 'SUCCEEDED',
        provider: candidate.provider,
        model: candidate.model,
        responseSnapshot: JSON.stringify({
          attempt: payload.attempt,
          candidate,
          providerTaskId: submitted.taskId,
          artifactId: artifact.id,
          artifactUrl: result.artifactUrl ?? null,
          qc: { score, threshold: QC_THRESHOLD },
        }),
      },
    })
    return { status: 'succeeded' }
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

async function pollToSettled(adapter: ProviderAdapter, capability: ModelCapability, providerTaskId: string, deps: PipelineDeps): Promise<PollResult> {
  const intervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS
  const timeoutMs = deps.pollTimeoutMs ?? POLL_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await adapter.poll(capability, providerTaskId)
    if (result.status !== 'running') return result
    if (Date.now() + intervalMs > deadline) return { status: 'failed', error: `provider task ${providerTaskId} did not settle within ${timeoutMs}ms` }
    await sleep(intervalMs)
  }
}

async function materialize(result: PollResult, modality: string, workdir: string): Promise<Material> {
  const artifactUrl = result.artifactUrl
  if (artifactUrl?.startsWith('mock://')) {
    const target = path.join(workdir, `artifact.${MOCK_EXTENSION[modality] ?? 'bin'}`)
    const media = await synthesizeMockMedia(modality, target, { durationMs: MOCK_DURATION_MS })
    return { bytes: new Uint8Array(await readFile(target)), ...media }
  }
  if (artifactUrl) {
    const response = await fetch(artifactUrl)
    if (!response.ok) throw new Error(`artifact download failed: HTTP ${response.status}`)
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
    return { bytes: new Uint8Array(await response.arrayBuffer()), mimeType: contentType || 'application/octet-stream' }
  }
  if (typeof result.text === 'string') return { bytes: new TextEncoder().encode(result.text), mimeType: 'text/plain' }
  throw new Error('provider completed without an artifact')
}

function qcScore(taskId: string, attempt: number, mode: QcMode): number {
  if (mode === 'pass') return 1
  if (mode === 'fail') return 0.1
  const digest = sha256(new TextEncoder().encode(`${taskId}:${attempt}`))
  return Number.parseInt(digest.slice(0, 8), 16) / 0xffffffff
}

function parseRequest(snapshot: string | null, fallbackModel: string): ProviderRequest {
  if (!snapshot) throw new Error('task has no requestSnapshot')
  const parsed = JSON.parse(snapshot) as { model?: unknown; input?: unknown; parameters?: unknown }
  return {
    model: typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : fallbackModel,
    input: isRecord(parsed.input) ? parsed.input : {},
    parameters: isRecord(parsed.parameters) ? parsed.parameters : {},
  }
}

function promptLength(request: ProviderRequest): number {
  return typeof request.input.prompt === 'string' ? request.input.prompt.length : 0
}

function toCapability(provider: string, row: CapabilityRow): ModelCapability {
  return {
    provider,
    model: row.model,
    modality: row.modality as ModelModality,
    acceptsFirstFrame: row.acceptsFirstFrame,
    acceptsReferenceImages: row.acceptsReferenceImages,
    maxReferenceImages: row.maxReferenceImages,
    entitlementVerifiedAt: row.entitlementVerifiedAt,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function label(candidate: RunTaskCandidate): string {
  return `${candidate.provider}/${candidate.model}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
