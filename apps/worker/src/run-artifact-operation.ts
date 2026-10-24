import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { Prisma, resolveVideoArtifactShot } from '@studio/db'
import { buildObjectKey, extensionFor } from '@studio/media'
import type { RunArtifactOperationPayload } from '@studio/jobs'
import { createAdapter } from '@studio/providers'
import { decryptSecret } from '@studio/security'
import { errorMessage, pollToSettled, toCapability } from './provider-call.js'
import { materialize, parseRequest, saveProviderResult, restoreProviderResult, type Material } from './run-task.js'
import type { PipelineDeps } from './deps.js'

/** V01 租约兜底:与生成任务同一纪律,慢消费者不被误判死。 */
const LEASE_GRACE_MS = 120_000

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

/**
 * 制品操作的执行侧:视频延长。与生成任务共用适配器/轮询/落库的三件工具,但
 * 生命周期独立——操作行自己就是台账,成功后按 applyPolicy 决定是否钦定为该镜成片。
 *
 * V01:操作与生成任务同一条执行安全纪律——原子领取(QUEUED/租约过期的 RUNNING/
 * 待查询的 BLOCKED 才可执行)、提交留痕、提交未知与轮询超时进 BLOCKED(待查询,
 * 重投续查 providerTaskId 而不是重新提交)、终态 fenced 写回。
 */
export async function runArtifactOperation(payload: RunArtifactOperationPayload, deps: PipelineDeps): Promise<void> {
  const operation = await deps.db.artifactOperation.findUnique({ where: { id: payload.operationId } })
  if (!operation || operation.organizationId !== payload.organizationId) return
  if (operation.status === 'SUCCEEDED' || operation.status === 'FAILED') return
  // BLOCKED(含 submission_unknown)是持久终止态——除非台账里有已受理未落定的上游
  // 任务(待查询),重投续查;否则恢复须人工查单后把状态重置为 QUEUED 再发。
  if (operation.status === 'BLOCKED') {
    const resumable = await resumableOperationAttempt(deps.db, operation.id)
    if (!resumable) return
  }

  const now = new Date()
  const claimToken = randomUUID()
  const leaseUntil = new Date(now.getTime() + deps.pollTimeoutMs + LEASE_GRACE_MS)
  const claim = await deps.db.artifactOperation.updateMany({
    where: {
      id: operation.id,
      OR: [
        { status: 'QUEUED' },
        { status: 'RUNNING', OR: [{ claimToken: null }, { leaseUntil: null }, { leaseUntil: { lt: now } }] },
        { status: 'BLOCKED', claimToken: null },
      ],
    },
    data: { status: 'RUNNING', claimToken, leaseUntil },
  })
  if (claim.count !== 1) return
  /** V01 fenced 终态:租约易主后本消费者的结论作废。 */
  const owned = async (data: Prisma.ArtifactOperationUncheckedUpdateManyInput) => {
    const written = await deps.db.artifactOperation.updateMany({
      where: { id: operation.id, claimToken },
      data: { ...data, claimToken: null, leaseUntil: null },
    }).catch(() => ({ count: 0 }))
    return written.count === 1
  }

  try {
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
    const isEdit = operation.kind === 'video_edit'
    const adapterMethod = isEdit ? adapter.editVideo : adapter.extend
    if (!adapterMethod) throw new Error(`adapter for ${operation.provider} no longer implements ${isEdit ? 'editVideo' : 'extend'}`)

    const snapshot = parseRequest(operation.requestSnapshot, operation.model)
    const bytes = await deps.storage.read(source.objectKey)
    // R02:源片真实时长用 ffprobe 实测——压缩码率下按字节数推算时长不可靠
    // (同分辨率不同码率差数倍),mock 契约「源时长+追加时长」必须建立在实测上。
    let sourceDurationMs: number | undefined
    {
      const probeDir = await mkdtemp(path.join(os.tmpdir(), 'studio-probe-'))
      try {
        const probeFile = path.join(probeDir, `source${path.extname(source.objectKey) || '.bin'}`)
        await (await import('node:fs/promises')).writeFile(probeFile, bytes)
        const { probeDuration } = await import('@studio/media')
        const probed = await probeDuration(probeFile).catch(() => 0)
        if (probed > 0) sourceDurationMs = probed
        else if (source.durationMs != null && source.durationMs > 0) sourceDurationMs = source.durationMs
      } finally {
        await rm(probeDir, { recursive: true, force: true })
      }
    }
    const request = {
      ...snapshot,
      parameters: { ...(snapshot.parameters as Record<string, unknown> ?? {}), ...(sourceDurationMs !== undefined ? { sourceDurationMs } : {}) },
      input: { ...snapshot.input, media: [{ type: 'first_clip' as const, url: `data:${source.mimeType};base64,${Buffer.from(bytes).toString('base64')}` }] },
    }

    // Q01/V01 恢复查单：上次提交已拿到 providerTaskId 且未落定时，续查该上游任务
    // 而不是重新提交——上游可能已接单，再次 submit 就是重复计费。
    const prior = await resumableOperationAttempt(deps.db, operation.id)

    let submitted: { taskId: string }
    let attemptRowId: string
    if (prior?.providerTaskId) {
      submitted = { taskId: prior.providerTaskId }
      attemptRowId = prior.id
      process.stderr.write(`operation ${operation.id}: resuming poll of provider task ${prior.providerTaskId} instead of re-submitting\n`)
    } else {
      // US-035/V01:操作提交留痕;唯一键冲突=同 attempt 已有提交者,按提交未知处理。
      try {
        const row = await deps.db.submissionAttempt.create({
          data: {
            operationId: operation.id,
            attemptNumber: payload.attempt,
            status: 'submitting',
            provider: operation.provider,
            model: operation.model,
            connectionId: operation.connectionId,
            capabilityId: operation.capabilityId,
          },
        })
        attemptRowId = row.id
      } catch (ledgerError) {
        const message = isUniqueViolation(ledgerError)
          ? `submission unknown — attempt ${payload.attempt} already has a submitter (operation ledger conflict); manual verification required before retry`
          : `submission ledger unavailable (${errorMessage(ledgerError)}) — refusing to submit without an auditable attempt record`
        await owned({ status: 'BLOCKED', errorSnapshot: message })
        return
      }
      try {
        submitted = await adapterMethod.call(adapter, capability, request)
        await deps.db.submissionAttempt.update({
          where: { id: attemptRowId },
          data: { status: 'accepted', providerTaskId: submitted.taskId },
        }).catch(() => undefined)
      } catch (submitError) {
        // R01:提交未知是持久终止态——上游可能已接单,自动重试(含 BullMQ 重投)
        // 都可能重复计费。记台账、置 BLOCKED、正常返回不抛错(抛错会触发队列重试)。
        await deps.db.submissionAttempt.update({
          where: { id: attemptRowId },
          data: { status: 'submission_unknown', errorSnapshot: submitError instanceof Error ? submitError.message : String(submitError) },
        }).catch(() => undefined)
        await owned({
          status: 'BLOCKED',
          errorSnapshot: `submission unknown — provider ${operation.provider} model ${operation.model} may have accepted the task (attempt ${payload.attempt}); manual verification required before retry. ${submitError instanceof Error ? submitError.message : String(submitError)}`,
        })
        return
      }
    }
    const result = prior?.resultSnapshot ? restoreProviderResult(prior.resultSnapshot) : await pollToSettled(adapter, capability, submitted.taskId, { intervalMs: deps.pollIntervalMs, timeoutMs: deps.pollTimeoutMs })
    if (result.status === 'timeout') {
      // V01:本地等待超时≠供应商失败——上游还在跑。进 BLOCKED(待查询),台账保持
      // accepted:重投续查,人工裁决前绝不重新提交。
      await deps.db.submissionAttempt.update({
        where: { id: attemptRowId },
        data: { status: 'accepted', errorSnapshot: result.error },
      }).catch(() => undefined)
      await owned({
        status: 'BLOCKED',
        errorSnapshot: `provider task ${submitted.taskId} accepted but did not settle within ${deps.pollTimeoutMs}ms — pending query, redelivery resumes polling; no re-submit. ${result.error}`,
      })
      return
    }
    await deps.db.submissionAttempt.update({
      where: { id: attemptRowId },
      data: result.status === 'failed' ? { status: 'settled', resolution: 'failed' } : { status: 'result_ready', resultSnapshot: saveProviderResult(result) },
    }).catch(() => undefined)
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
      const output = await deps.db.mediaArtifact.upsert({
        where: { objectKey_version: { objectKey: stored.key, version: 1 } },
        update: {},
        create: {
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
          durationMs: material.durationMs ?? (sourceDurationMs ?? source.durationMs ?? 0) + (Number.isFinite((request.parameters as { durationMs?: number }).durationMs) ? (request.parameters as { durationMs: number }).durationMs : 5000),
        },
      })
      const finished = await deps.db.$transaction(async tx => {
        // Lock the operation before any selection side effect. Claim takeover and
        // adoption serialize on this row, so an old consumer cannot adopt first.
        const owner = await tx.artifactOperation.updateMany({
          where: { id: operation.id, claimToken, leaseUntil: { gte: new Date() } },
          data: { leaseUntil: new Date(Date.now() + LEASE_GRACE_MS) },
        })
        if (owner.count !== 1) return false
      // US-019 采用策略:按 applyPolicy 决定是否自动钦定——默认 candidate_only
      // (只产出候选,不替换选版),apply_if_empty/apply_if_unchanged 需 CAS 校验。
      const policy = (JSON.parse(operation.requestSnapshot) as { applyPolicy?: string }).applyPolicy ?? operation.applyPolicy
      let applyStatus = 'applied'
      let applyReason: string | undefined
      if (policy === 'candidate_only') {
        applyStatus = 'skipped'
        applyReason = 'candidate_only: result is a candidate, not auto-adopted'
      } else {
        // 所有自动采用策略都必须先检查锁——锁是人工意图,任何策略都不能覆盖。
        const current = await tx.storyboard.findUnique({
          where: { id: shotContext.storyboardId },
          select: { selectedVideoArtifactId: true, lockedVideoSelection: true, stateRevision: true },
        })
        if (current?.lockedVideoSelection) {
          applyStatus = 'skipped'
          applyReason = 'shot video selection is locked — result stays as candidate'
        } else if (policy === 'apply_if_empty' && current && current.selectedVideoArtifactId !== null) {
          applyStatus = 'skipped'
          applyReason = 'apply_if_empty: shot already has a selection, result stays as candidate'
        } else if (policy === 'apply_if_unchanged') {
          // apply_if_unchanged 缺 revision = 无法证明选择未变——不能无条件采用。
          if (operation.expectedShotRevision === null || operation.expectedShotRevision === undefined) {
            applyStatus = 'skipped'
            applyReason = 'apply_if_unchanged requires expectedShotRevision — without it, cannot verify selection is unchanged'
          } else if (current && current.stateRevision !== operation.expectedShotRevision) {
            applyStatus = 'skipped'
            applyReason = `shot stateRevision changed (expected ${operation.expectedShotRevision}, now ${current.stateRevision})`
          }
        }
        // V02 CAS 采用:上面读到的锁/选版/revision 只是决策依据,真正的写入必须带
        // 同一组期望值做条件 UPDATE——「读取之后、写入之前」人工改选/加锁时,这里
        // count=0,自动采用让位为候选,绝不覆盖人工意图。采用本身推进 stateRevision。
        if (applyStatus === 'applied') {
          const applied = await tx.storyboard.updateMany({
            where: {
              id: shotContext.storyboardId,
              lockedVideoSelection: false,
              selectedVideoArtifactId: current?.selectedVideoArtifactId ?? null,
              ...(policy === 'apply_if_unchanged' ? { stateRevision: operation.expectedShotRevision! } : {}),
            },
            data: { selectedVideoArtifactId: output.id, stateRevision: { increment: 1 } },
          })
          if (applied.count !== 1) {
            applyStatus = 'skipped'
            applyReason = 'shot selection changed while the operation ran (CAS) — result stays as candidate'
          }
        }
      }
      await tx.submissionAttempt.update({ where: { id: attemptRowId }, data: { status: 'settled', resolution: 'succeeded', artifactId: output.id } })
      await tx.artifactOperation.update({ where: { id: operation.id }, data: { status: 'SUCCEEDED', outputArtifactId: output.id, applyStatus, ...(applyReason ? { applyReason } : {}), claimToken: null, leaseUntil: null } })
      return true
      })
      if (!finished) process.stderr.write(`operation ${operation.id}: lease lost before completion — outcome recorded as candidate only\n`)
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  } catch (error) {
    const recoverable = await resumableOperationAttempt(deps.db, operation.id)
    await owned({ status: recoverable ? 'BLOCKED' : 'FAILED', errorSnapshot: errorMessage(error) }).catch(() => undefined)
    process.stderr.write(`operation ${operation.id} failed: ${errorMessage(error)}\n`)
  }
}

/** V01:操作台账里已受理未落定的提交——续查凭据;已落定的不复查(结果已可用)。 */
async function resumableOperationAttempt(db: PipelineDeps['db'], operationId: string) {
  return db.submissionAttempt.findFirst({
    where: { operationId, providerTaskId: { not: null }, status: { in: ['accepted', 'running', 'result_ready'] } },
    orderBy: { id: 'desc' },
  }).catch(() => null)
}
