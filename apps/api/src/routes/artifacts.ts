import type { FastifyInstance } from 'fastify'
import type { MediaArtifact } from '@studio/db'
import { resolveSlotCandidates, resolveVideoArtifactShot } from '@studio/db'
import { reserveOrganizationCalls, recordJobIntent } from '@studio/pipeline'
import { createAdapter } from '@studio/providers'
import { isVetableArtifactStage, parseArtifactVeto, writeArtifactVeto, type ArtifactVeto } from '@studio/domain'
import { pipelineJobs } from '../lib/jobs.js'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

export interface ArtifactDto {
  id: string
  mimeType: string
  objectKey: string
  /** Which attempt of this object this is. The shot history writes 「v2」, so the number
   * has to come from the row rather than from counting the list in the browser. */
  version: number
  width: number | null
  height: number | null
  durationMs: number | null
  downloadUrl: string
  /** 人工导入件的原始文件名。对象键是按租户/项目/阶段重建的路径，人对着它认不出自己
   *  传的是哪个文件；只有导入那一档带这个名字，生成产物永远是 null。 */
  filename: string | null
  /** SD-172：这一版被人否掉了（标不可用 + 理由）。null = 没人否过它。
   *  读侧（镜头履历、生效版、合成取版）都看这一格，界面上「已否决」必须有出处。 */
  veto: ArtifactVeto | null
}

export function toArtifactDto(artifact: MediaArtifact): ArtifactDto {
  return {
    id: artifact.id,
    mimeType: artifact.mimeType,
    objectKey: artifact.objectKey,
    version: artifact.version,
    width: artifact.width,
    height: artifact.height,
    durationMs: artifact.durationMs,
    downloadUrl: `/artifacts/${artifact.id}/content`,
    filename: importedFilename(artifact.metadata),
    veto: parseArtifactVeto(artifact.metadata),
  }
}

function importedFilename(metadata: string | null): string | null {
  if (!metadata) return null
  try {
    const parsed = JSON.parse(metadata) as { filename?: unknown }
    return typeof parsed.filename === 'string' ? parsed.filename : null
  } catch {
    return null
  }
}

export async function artifactRoutes(app: FastifyInstance): Promise<void> {
  // 注册期取一次入队函数:它内部要挂 onClose 钩子,请求期再取会撞
  // already-listening(pipelineJobs 与 generations 路由同款用法)。
  const enqueueJob = pipelineJobs(app)
  app.get<{ Params: { artifactId: string } }>(
    '/artifacts/:artifactId/content',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const artifact = await app.db.mediaArtifact.findFirst({ where: { id: request.params.artifactId, organizationId: auth.organizationId } })
      if (!artifact) return reply.code(404).send({ error: 'artifact not found' })
      const stored = await app.storage.open(artifact.objectKey)
      if (!stored) return reply.code(404).send({ error: 'artifact file not found' })
      reply.header('content-type', artifact.mimeType)
      reply.header('content-length', String(stored.sizeBytes))
      return reply.send(stored.body)
    },
  )

  // SD-172｜人工否决位：机器说「过线」不等于人收下这一版。
  // #30 / #43 / #51 实测：过线即「自动取最新」，版本行只给「切版本」和「重跑」，
  // 人想否掉一个机器说好的版本只能再花一次抽。这里给的就是那一刀：
  // 标不可用 + 必填理由，落在产物自己的 metadata 上（不开新列），
  // 镜头履历、生效版读数与合成取版三条链都读同一格（见 @studio/domain 的 artifact-veto）。
  // 撤销（undo）也走这一条路由：否决是可撤回的人工判断，不是删除。
  app.post<{ Params: { artifactId: string }; Body: { reason?: unknown; undo?: unknown } }>(
    '/artifacts/:artifactId/veto',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const artifact = await app.db.mediaArtifact.findFirst({
        where: { id: request.params.artifactId, organizationId: auth.organizationId },
      })
      // 跨空间的 id 只会得到 404：存在的产物与别人的产物必须是同一个回答。
      if (!artifact) return reply.code(404).send({ error: 'artifact not found' })
      if (!isVetableArtifactStage(artifact.stage)) return reply.code(400).send({ error: 'veto:unsupportedStage' })
      const undo = request.body?.undo === true
      const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim() : ''
      // 理由对「标不可用」是必填的：没有理由的否决在履历里就是一条无声的删除，
      // 下一个人只会看见少了一版。撤销不需要理由（它把人手上的东西还回去）。
      if (!undo && reason === '') return reply.code(400).send({ error: 'veto:reasonRequired' })

      const veto: ArtifactVeto | null = undo
        ? null
        : { at: new Date().toISOString(), by: auth.userId ?? 'unknown', reason: reason.slice(0, 500) }
      const updated = await app.db.$transaction(async tx => {
        const row = await tx.mediaArtifact.update({
          where: { id: artifact.id },
          data: { metadata: writeArtifactVeto(artifact.metadata, veto) },
        })
        // 钦定指针必须跟着走：人刚说这一版不能用，镜头却还把它钉成「就用这条」，
        // 合成会照指针取回被否的那一版。清掉指针＝回到「自动取最新（跳过被否的）」。
        // 锁定档一并放开：locked + 空指针按数据矛盾处理会让整集合成抛错，而这一刀
        // 正是人对那条锁的更新决定。
        if (artifact.storyboardId) {
          const pointer = artifact.stage === 'VIDEO'
            ? 'selectedVideoArtifactId'
            : artifact.stage === 'FIRST_FRAME'
              ? 'selectedFrameArtifactId'
              : 'selectedVoiceArtifactId'
          await tx.storyboard.updateMany({
            where: { id: artifact.storyboardId, [pointer]: artifact.id },
            data: pointer === 'selectedVideoArtifactId'
              ? { selectedVideoArtifactId: null, lockedVideoSelection: false }
              : pointer === 'selectedFrameArtifactId'
                ? { selectedFrameArtifactId: null }
                : { selectedVoiceArtifactId: null },
          })
        }
        return row
      })

      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: undo ? 'artifact.unveto' : 'artifact.veto',
        entityType: 'media-artifact',
        entityId: artifact.id,
        payload: {
          storyboardId: artifact.storyboardId,
          stage: artifact.stage,
          version: artifact.version,
          ...(reason ? { reason: reason.slice(0, 500) } : {}),
        },
      })
      return { artifact: toArtifactDto(updated) }
    },
  )

  // 视频延长:对这一镜已入片的切片做「接着拍」——比整镜重抽省钱,也不换画面。
  // 候选只取「适配器真的实现了 extend」的视频模型(方法存在与否是能力探测,
  // 不靠目录声明);操作行独立记账,成功后由 worker 把加长版钦定为该镜成片。
  app.post<{ Params: { artifactId: string }; Body: { durationMs?: unknown } }>(
    '/artifacts/:artifactId/extend',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const artifact = await app.db.mediaArtifact.findFirst({
        where: { id: request.params.artifactId, organizationId: auth.organizationId },
      })
      if (!artifact) return reply.code(404).send({ error: 'artifact not found' })
      if (!artifact.mimeType.startsWith('video/')) return reply.code(400).send({ error: 'extend works on video artifacts only' })
      // 统一归属解析:生成产物与延长产物(可链式)同一条信任路径。
      const shotContext = await resolveVideoArtifactShot(app.db, artifact.id, auth.organizationId)
      if (!shotContext) return reply.code(400).send({ error: 'artifact has no shot to extend for' })
      const { storyboardId, projectId } = shotContext

      const requested = typeof request.body?.durationMs === 'number' ? request.body.durationMs : 5000
      const durationMs = Math.min(10_000, Math.max(1_000, Math.round(requested)))
      // US-019 采用策略与镜头 CAS。
      const applyPolicy = typeof (request.body as { applyPolicy?: unknown })?.applyPolicy === 'string'
        ? (request.body as { applyPolicy: string }).applyPolicy : 'candidate_only'
      if (!['candidate_only', 'apply_if_empty', 'apply_if_unchanged'].includes(applyPolicy)) {
        return reply.code(400).send({ error: 'applyPolicy must be one of candidate_only, apply_if_empty, apply_if_unchanged' })
      }
      const expectedShotRevision = typeof (request.body as { expectedShotRevision?: unknown })?.expectedShotRevision === 'number'
        ? (request.body as { expectedShotRevision: number }).expectedShotRevision : null

      const pool = [
        ...(await resolveSlotCandidates(app.db, auth.organizationId, projectId, 'video_t2v')),
        ...(await resolveSlotCandidates(app.db, auth.organizationId, projectId, 'video_i2v')),
      ]
      const candidate = pool.find(item => typeof createAdapter(item.provider, { apiKey: '', baseUrl: '' }).extend === 'function')
      if (!candidate) return reply.code(409).send({ error: 'no bound video model supports extend' })

      const operation = await app.db.$transaction(async tx => {
        if (!await reserveOrganizationCalls(tx, auth.organizationId, 1)) return null
        const operation = await tx.artifactOperation.create({
        data: {
          organizationId: auth.organizationId,
          kind: 'video_extend',
          sourceArtifactId: artifact.id,
          connectionId: candidate.connectionId,
          capabilityId: candidate.capabilityId,
          provider: candidate.provider,
          model: candidate.model,
          requestSnapshot: JSON.stringify({ input: { prompt: '延长这一镜：画面与动作延续原片结尾，不引入新内容' }, parameters: { durationMs }, sourceArtifactId: artifact.id, storyboardId, applyPolicy }),
          applyPolicy,
          expectedShotRevision,
        },
        })
        await recordJobIntent(tx, { kind: 'run-artifact-operation', operationId: operation.id, organizationId: auth.organizationId, attempt: 1, candidate: { connectionId: candidate.connectionId, capabilityId: candidate.capabilityId, provider: candidate.provider, model: candidate.model } })
        return operation
      })
      if (!operation) return reply.code(429).send({ error: 'pipeline:inFlightBudget', reasons: ['organization call reservations exhausted'] })
      await enqueueJob({ kind: 'run-artifact-operation', operationId: operation.id, organizationId: auth.organizationId, attempt: 1, candidate: { connectionId: candidate.connectionId, capabilityId: candidate.capabilityId, provider: candidate.provider, model: candidate.model } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId,
        userId: auth.userId,
        action: 'artifact.extend',
        entityType: 'ArtifactOperation',
        entityId: operation.id,
        payload: { sourceArtifactId: artifact.id, storyboardId, durationMs, model: candidate.model },
      })
      return reply.code(202).send({ operation: { id: operation.id, kind: operation.kind, status: operation.status, sourceArtifactId: artifact.id, durationMs } })
    },
  )
  // US-021+022 定向编辑:对已有视频下达修改指令,保留未提及区域。
  app.post<{ Params: { artifactId: string }; Body: { instruction?: unknown; applyPolicy?: unknown } }>(
    '/artifacts/:artifactId/edit-video',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const instruction = typeof request.body?.instruction === 'string' ? request.body.instruction.trim() : ''
      if (instruction === '') return reply.code(400).send({ error: 'instruction is required (what to change)' })

      const artifact = await app.db.mediaArtifact.findFirst({
        where: { id: request.params.artifactId, organizationId: auth.organizationId },
      })
      if (!artifact) return reply.code(404).send({ error: 'artifact not found' })
      if (!artifact.mimeType.startsWith('video/')) return reply.code(400).send({ error: 'editVideo works on video artifacts only' })
      const shotContext = await resolveVideoArtifactShot(app.db, artifact.id, auth.organizationId)
      if (!shotContext) return reply.code(400).send({ error: 'artifact has no shot to edit for' })

      // 候选:适配器实现了 editVideo 的模型。
      const pool = [
        ...(await resolveSlotCandidates(app.db, auth.organizationId, shotContext.projectId, 'video_t2v')),
        ...(await resolveSlotCandidates(app.db, auth.organizationId, shotContext.projectId, 'video_i2v')),
      ]
      const candidate = pool.find(item => typeof createAdapter(item.provider, { apiKey: '', baseUrl: '' }).editVideo === 'function')
      if (!candidate) return reply.code(409).send({ error: 'no bound video model supports directed editing' })

      const applyPolicy = typeof request.body?.applyPolicy === 'string' ? request.body.applyPolicy : 'candidate_only'
      const operation = await app.db.$transaction(async tx => {
        if (!await reserveOrganizationCalls(tx, auth.organizationId, 1)) return null
        const operation = await tx.artifactOperation.create({
        data: {
          organizationId: auth.organizationId,
          kind: 'video_edit',
          sourceArtifactId: artifact.id,
          connectionId: candidate.connectionId,
          capabilityId: candidate.capabilityId,
          provider: candidate.provider,
          model: candidate.model,
          requestSnapshot: JSON.stringify({ input: { prompt: instruction }, parameters: {}, sourceArtifactId: artifact.id, storyboardId: shotContext.storyboardId, applyPolicy }),
          applyPolicy,
        },
        })
        await recordJobIntent(tx, { kind: 'run-artifact-operation', operationId: operation.id, organizationId: auth.organizationId, attempt: 1, candidate: { connectionId: candidate.connectionId, capabilityId: candidate.capabilityId, provider: candidate.provider, model: candidate.model } })
        return operation
      })
      if (!operation) return reply.code(429).send({ error: 'pipeline:inFlightBudget', reasons: ['organization call reservations exhausted'] })
      await enqueueJob({ kind: 'run-artifact-operation', operationId: operation.id, organizationId: auth.organizationId, attempt: 1, candidate: { connectionId: candidate.connectionId, capabilityId: candidate.capabilityId, provider: candidate.provider, model: candidate.model } })
      await recordAudit(app.db, {
        organizationId: auth.organizationId, userId: auth.userId,
        action: 'artifact.editVideo', entityType: 'ArtifactOperation', entityId: operation.id,
        payload: { sourceArtifactId: artifact.id, instruction: instruction.slice(0, 200), model: candidate.model },
      })
      return reply.code(202).send({ operation: { id: operation.id, kind: 'video_edit', status: operation.status, instruction } })
    },
  )

}
