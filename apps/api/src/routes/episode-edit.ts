import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'
import { apiError } from '../lib/api-error.js'
import { isValidSequenceFps } from '@studio/domain'
import { editFingerprint } from '@studio/media'
import type { RationalFps } from '@studio/domain'

/**
 * US-024 编辑修订保存与旧集初始化。
 * GET /episodes/:id/edit —— 读 head;旧集首次打开时按 live 分镜+当前选版建默认序列。
 * PUT /episodes/:id/edit —— CAS 保存(expectedEditRevision),创建不可变修订。
 * POST /episodes/:id/edit/restore —— 以历史修订创建新 head(不篡改历史)。
 */
interface ClipDocJson {
  clipId: string
  storyboardId: string
  artifactId: string
  sourceInFrame: number
  sourceOutFrame: number
}

interface EditBody {
  fps?: { fpsNum?: unknown; fpsDen?: unknown }
  clips?: unknown
  tracks?: unknown
  outputSpec?: unknown
  expectedEditRevision?: unknown
}

function parseClips(raw: unknown): ClipDocJson[] | { error: string } {
  if (!Array.isArray(raw)) return { error: 'clips must be an array' }
  const clips: ClipDocJson[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return { error: 'each clip must be an object' }
    const clip = item as Record<string, unknown>
    if (typeof clip.clipId !== 'string' || typeof clip.storyboardId !== 'string' || typeof clip.artifactId !== 'string') {
      return { error: 'clipId, storyboardId, artifactId are required strings' }
    }
    if (typeof clip.sourceInFrame !== 'number' || typeof clip.sourceOutFrame !== 'number' || !Number.isInteger(clip.sourceInFrame) || !Number.isInteger(clip.sourceOutFrame)) {
      return { error: 'sourceInFrame and sourceOutFrame must be integers (editMedia frame indices)' }
    }
    if (clip.sourceOutFrame <= clip.sourceInFrame) return { error: `clip ${clip.clipId}: sourceOutFrame must be > sourceInFrame` }
    clips.push({ clipId: clip.clipId, storyboardId: clip.storyboardId, artifactId: clip.artifactId, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame })
  }
  return clips
}

export async function episodeEditRoutes(app: FastifyInstance): Promise<void> {
  // GET:读 head;旧集/空集首次打开时初始化默认序列。
  app.get<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/edit',
    { preHandler: requirePermission('read') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await app.db.episode.findFirst({ where: { id: request.params.episodeId, project: { organizationId: auth.organizationId } } })
      if (!episode) return reply.code(404).send({ error: 'episode not found' })

      let edit = await app.db.episodeEdit.findUnique({ where: { episodeId: episode.id }, include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } } })

      // 旧集/空集初始化:按 live 分镜 + 当前选版(或 null 占位)建默认连续剪辑。
      if (edit === null) {
        const storyboards = await app.db.storyboard.findMany({ where: { episodeId: episode.id, supersededAt: null }, orderBy: { number: 'asc' } })
        const defaultClips: ClipDocJson[] = storyboards.map((shot, index) => ({
          clipId: `clip-${index + 1}`,
          storyboardId: shot.id,
          // 占位:无选版时 artifactId 为空串——不伪造精确 duration(§13 迁移要求)。
          artifactId: '',
          sourceInFrame: 0,
          sourceOutFrame: 1,
        }))
        const fps: RationalFps = { fpsNum: 25, fpsDen: 1 }
        const fingerprint = editFingerprint({ fpsNum: fps.fpsNum, fpsDen: fps.fpsDen, clips: defaultClips.map(clip => ({ clipId: clip.clipId, artifactId: clip.artifactId, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame })), tracks: [] })
        edit = await app.db.episodeEdit.create({
          data: {
            episodeId: episode.id,
            organizationId: auth.organizationId,
            headRevision: 1,
            revisions: {
              create: { revision: 1, fpsNum: fps.fpsNum, fpsDen: fps.fpsDen, clips: JSON.stringify(defaultClips), tracks: '[]', fingerprint, author: 'system-initial' },
            },
          },
          include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } },
        })
      }

      const head = edit.revisions[0]
      if (!head) return reply.code(500).send({ error: 'edit has no revisions' })
      return {
        editId: edit.id,
        headRevision: edit.headRevision,
        revision: { ...head, clips: JSON.parse(head.clips), tracks: JSON.parse(head.tracks), outputSpec: JSON.parse(head.outputSpec) },
      }
    },
  )

  // PUT:CAS 保存新修订。
  app.put<{ Params: { episodeId: string }; Body: EditBody }>(
    '/episodes/:episodeId/edit',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await app.db.episode.findFirst({ where: { id: request.params.episodeId, project: { organizationId: auth.organizationId } } })
      if (!episode) return reply.code(404).send({ error: 'episode not found' })
      const edit = await app.db.episodeEdit.findUnique({ where: { episodeId: episode.id } })
      if (!edit) return reply.code(404).send({ error: 'edit not initialized — GET first' })

      const expected = typeof request.body?.expectedEditRevision === 'number' ? request.body.expectedEditRevision : null
      if (expected === null) return reply.code(400).send({ error: 'expectedEditRevision is required for CAS' })
      if (expected !== edit.headRevision) {
        const { body } = apiError('version_conflict', `编辑已被修改(当前 revision ${edit.headRevision},你预期 ${expected})`, { nextAction: 'reload' })
        return reply.code(409).send({ ...body, currentRevision: edit.headRevision })
      }

      const fpsNum = typeof request.body?.fps?.fpsNum === 'number' ? request.body.fps.fpsNum : 25
      const fpsDen = typeof request.body?.fps?.fpsDen === 'number' ? request.body.fps.fpsDen : 1
      if (!isValidSequenceFps({ fpsNum, fpsDen })) {
        return reply.code(400).send({ error: 'fps must be 24, 25, or 30 (as fpsNum/fpsDen)' })
      }
      const clipsResult = parseClips(request.body?.clips)
      if ('error' in clipsResult) return reply.code(400).send({ error: clipsResult.error })
      const clips = clipsResult
      const tracks = Array.isArray(request.body?.tracks) ? JSON.stringify(request.body.tracks) : '[]'
      const outputSpec = typeof request.body?.outputSpec === 'object' && request.body.outputSpec !== null ? JSON.stringify(request.body.outputSpec) : '{}'
      const fingerprint = editFingerprint({ fpsNum, fpsDen, clips: clips.map(clip => ({ clipId: clip.clipId, artifactId: clip.artifactId, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame })), tracks: JSON.parse(tracks) })

      const updated = await app.db.$transaction(async tx => {
        const revision = await tx.episodeEditRevision.create({
          data: { editId: edit.id, revision: edit.headRevision + 1, fpsNum, fpsDen, clips: JSON.stringify(clips), tracks, outputSpec, fingerprint, author: auth.userId ?? 'agent' },
        })
        const head = await tx.episodeEdit.update({ where: { id: edit.id }, data: { headRevision: edit.headRevision + 1 } })
        return { revision, head }
      })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'edit.save', entityType: 'EpisodeEdit', entityId: edit.id, payload: { revision: updated.head.headRevision, fingerprint } })
      return { editId: edit.id, headRevision: updated.head.headRevision, revision: { ...updated.revision, clips, tracks: JSON.parse(tracks), outputSpec: JSON.parse(outputSpec) } }
    },
  )

  // POST restore:以历史修订创建新 head。
  app.post<{ Params: { episodeId: string }; Body: { revision?: unknown } }>(
    '/episodes/:episodeId/edit/restore',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await app.db.episode.findFirst({ where: { id: request.params.episodeId, project: { organizationId: auth.organizationId } } })
      if (!episode) return reply.code(404).send({ error: 'episode not found' })
      const edit = await app.db.episodeEdit.findUnique({ where: { episodeId: episode.id } })
      if (!edit) return reply.code(404).send({ error: 'edit not initialized' })
      const revision = typeof request.body?.revision === 'number' ? request.body.revision : null
      if (revision === null) return reply.code(400).send({ error: 'revision is required' })
      const source = await app.db.episodeEditRevision.findUnique({ where: { editId_revision: { editId: edit.id, revision } } })
      if (!source) return reply.code(404).send({ error: `revision ${revision} not found` })

      // 恢复 = 创建新修订(内容来自源),不修改历史字节。
      const restored = await app.db.$transaction(async tx => {
        const newRevision = await tx.episodeEditRevision.create({
          data: { editId: edit.id, revision: edit.headRevision + 1, fpsNum: source.fpsNum, fpsDen: source.fpsDen, clips: source.clips, tracks: source.tracks, outputSpec: source.outputSpec, fingerprint: source.fingerprint, author: auth.userId ?? 'agent' },
        })
        const head = await tx.episodeEdit.update({ where: { id: edit.id }, data: { headRevision: edit.headRevision + 1 } })
        return { revision: newRevision, head }
      })
      await recordAudit(app.db, { organizationId: auth.organizationId, userId: auth.userId, action: 'edit.restore', entityType: 'EpisodeEdit', entityId: edit.id, payload: { from: revision, to: restored.head.headRevision } })
      return { editId: edit.id, headRevision: restored.head.headRevision, restoredFrom: revision }
    },
  )
}
