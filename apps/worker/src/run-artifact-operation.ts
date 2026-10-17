import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveVideoArtifactShot } from '@studio/db'
import { buildObjectKey, extensionFor } from '@studio/media'
import type { RunArtifactOperationPayload } from '@studio/jobs'
import { createAdapter } from '@studio/providers'
import { decryptSecret } from '@studio/security'
import { errorMessage, pollToSettled, toCapability } from './provider-call.js'
import { materialize, parseRequest, type Material } from './run-task.js'
import type { PipelineDeps } from './deps.js'

/**
 * 制品操作的执行侧:视频延长。与生成任务共用适配器/轮询/落库的三件工具,但
 * 生命周期独立——操作行自己就是台账,成功后把加长版钦定为该镜成片。
 *
 * 「延长即采用」的语义:用户是对这一镜正在用的切片点的延长,意图就是让成片
 * 换成加长版——所以输出直接落 storyboard.selectedVideoArtifactId。否则自动
 * 选版只看任务制品,非任务产物永远选不中,延长等于白做。人工随后可再改。
 */
export async function runArtifactOperation(payload: RunArtifactOperationPayload, deps: PipelineDeps): Promise<void> {
  const operation = await deps.db.artifactOperation.findUnique({ where: { id: payload.operationId } })
  if (!operation || operation.organizationId !== payload.organizationId) return
  if (operation.status === 'SUCCEEDED') return

  try {
    await deps.db.artifactOperation.update({ where: { id: operation.id }, data: { status: 'RUNNING' } })
    const source = await deps.db.mediaArtifact.findFirst({
      where: { id: operation.sourceArtifactId, organizationId: operation.organizationId },
    })
    // 统一归属解析:生成产物走任务,延长产物走成功操作链——支持对加长版继续延长。
    const shotContext = source ? await resolveVideoArtifactShot(deps.db, source.id, operation.organizationId) : null
    if (!source || !shotContext) throw new Error('the source artifact no longer resolves to a shot')

    const connection = await deps.db.providerConnection.findUnique({ where: { id: operation.connectionId } })
    if (!connection) throw new Error(`connection ${operation.connectionId} unavailable`)
    const capabilityRow = await deps.db.modelCapability.findUnique({ where: { id: operation.capabilityId } })
    if (!capabilityRow) throw new Error(`capability ${operation.capabilityId} unavailable`)
    const capability = toCapability(connection.provider, capabilityRow)

    const apiKey = decryptSecret(connection.encryptedSecret, deps.masterKey)
    const adapter = createAdapter(connection.provider, { apiKey, baseUrl: connection.baseUrl })
    if (!adapter.extend) throw new Error(`adapter for ${operation.provider} no longer implements extend`)

    const snapshot = parseRequest(operation.requestSnapshot, operation.model)
    const bytes = await deps.storage.read(source.objectKey)
    const request = { ...snapshot, input: { ...snapshot.input, media: [{ type: 'first_clip' as const, url: `data:${source.mimeType};base64,${Buffer.from(bytes).toString('base64')}` }] } }

    const submitted = await adapter.extend(capability, request)
    const result = await pollToSettled(adapter, capability, submitted.taskId, { intervalMs: deps.pollIntervalMs, timeoutMs: deps.pollTimeoutMs })
    if (result.status === 'failed') throw new Error(result.error ?? 'provider reported failure')

    const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-extend-'))
    try {
      if (!source.stage) throw new Error('source artifact has no stage')
      const material: Material = await materialize(result, capability.modality, workdir)
      const objectKey = buildObjectKey({
        tenantId: operation.organizationId,
        projectId: shotContext.projectId,
        episodeId: shotContext.episodeId,
        stage: source.stage,
        entityId: operation.id,
        version: 1,
        extension: extensionFor(material.mimeType),
      })
      const stored = await deps.storage.put(objectKey, material.bytes, material.mimeType)
      const output = await deps.db.mediaArtifact.create({
        data: {
          organizationId: operation.organizationId,
          stage: source.stage,
          objectKey: stored.key,
          checksum: stored.checksum,
          mimeType: stored.mimeType,
          version: 1,
          width: source.width,
          height: source.height,
          // 血缘:统一归属解析与「再延长」的依据,US-003 正式化前的最小落点。
          metadata: JSON.stringify({ storyboardId: shotContext.storyboardId, operationId: operation.id, parentArtifactId: source.id }),
          durationMs: material.durationMs ?? (source.durationMs ?? 0) + (Number.isFinite((snapshot.parameters as { durationMs?: number } | undefined)?.durationMs) ? (snapshot.parameters as { durationMs: number }).durationMs : 5000),
        },
      })
      await deps.db.artifactOperation.update({ where: { id: operation.id }, data: { status: 'SUCCEEDED', outputArtifactId: output.id } })
      await deps.db.storyboard.update({ where: { id: shotContext.storyboardId }, data: { selectedVideoArtifactId: output.id } })
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  } catch (error) {
    await deps.db.artifactOperation.update({
      where: { id: operation.id },
      data: { status: 'FAILED', errorSnapshot: errorMessage(error) },
    }).catch(() => undefined)
    process.stderr.write(`operation ${operation.id} failed: ${errorMessage(error)}\n`)
  }
}
