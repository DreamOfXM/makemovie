import type { FastifyInstance } from 'fastify'
import { resolveSlotCandidates } from '@studio/db'
import { checkAudioTechnicals, diffTranscript } from '@studio/media'
import { createAdapter, type ModelCapability } from '@studio/providers'
import { decryptSecret } from '@studio/security'
import { recordAudit } from '../lib/audit.js'
import { requirePermission } from '../plugins/auth.js'

/**
 * US-033 转写与音画检查:对最新 COMPLETED 合成的音频做两件事——
 *  1. ASR:逐镜转写钦定的 AUDIO 制品(selectedVoiceArtifactId,退
 *     importedVoiceArtifactId;一镜都取不到就退母带一次),diffTranscript 对
 *     storyboard.dialogue,差异落 QualityFinding(dimension:'asr',
 *     missing/mismatch→warning、extra→info);
 *  2. 技术音频:母带 volumedetect,clipping/silence 疑点落 QualityFinding。
 * 无 asr 槽位绑定时 409 {error:'asr:notBound'} 明示缺能力,不静默跳过。
 */
export async function audioReviewRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { episodeId: string } }>(
    '/episodes/:episodeId/audio-review',
    { preHandler: requirePermission('episode:write') },
    async (request, reply) => {
      const auth = request.auth!
      const episode = await app.db.episode.findFirst({
        where: { id: request.params.episodeId, project: { organizationId: auth.organizationId } },
        include: { project: true },
      })
      if (!episode) return reply.code(404).send({ error: 'episode not found' })

      const composition = await app.db.composition.findFirst({
        where: { episodeId: episode.id, status: 'COMPLETED', artifactId: { not: null } },
        orderBy: { id: 'desc' },
      })
      if (!composition?.artifactId) return reply.code(409).send({ error: 'no completed composition to review' })
      const masterArtifact = await app.db.mediaArtifact.findUnique({ where: { id: composition.artifactId } })
      if (!masterArtifact) return reply.code(409).send({ error: 'composition artifact missing' })
      const fingerprint = composition.inputFingerprint ?? composition.id

      // asr 能力解析:方法存在与否是能力探测(与 extend/editVideo 选型同一纪律)。
      const candidates = await resolveSlotCandidates(app.db, auth.organizationId, episode.projectId, 'audio_transcribe')
      const candidate = candidates.find(item => typeof createAdapter(item.provider, { apiKey: '', baseUrl: '' }).transcribe === 'function')
      if (!candidate) return reply.code(409).send({ error: 'asr:notBound' })

      const connection = await app.db.providerConnection.findUnique({ where: { id: candidate.connectionId } })
      const capabilityRow = await app.db.modelCapability.findUnique({ where: { id: candidate.capabilityId } })
      if (!connection || !capabilityRow) return reply.code(409).send({ error: 'asr:notBound' })
      const capability: ModelCapability = {
        provider: connection.provider,
        model: capabilityRow.model,
        modality: capabilityRow.modality as ModelCapability['modality'],
        acceptsFirstFrame: capabilityRow.acceptsFirstFrame,
        acceptsReferenceImages: capabilityRow.acceptsReferenceImages,
        maxReferenceImages: capabilityRow.maxReferenceImages,
      }
      const adapter = createAdapter(connection.provider, { apiKey: decryptSecret(connection.encryptedSecret, app.config.masterKey), baseUrl: connection.baseUrl })
      if (!adapter.transcribe) return reply.code(409).send({ error: 'asr:notBound' })

      const storyboards = await app.db.storyboard.findMany({
        where: { episodeId: episode.id, supersededAt: null },
        orderBy: { number: 'asc' },
      })

      interface ReviewTarget {
        storyboardId: string | null
        dialogue: string
        artifactId: string
        objectKey: string
        mimeType: string
        durationMs: number | null
      }
      // 逐镜优先:钦定配音 → 导入配音;一镜都取不到才有母带兜底。
      const targets: ReviewTarget[] = []
      for (const storyboard of storyboards) {
        const pinnedId = storyboard.selectedVoiceArtifactId ?? storyboard.importedVoiceArtifactId
        if (!pinnedId) continue
        const artifact = await app.db.mediaArtifact.findFirst({ where: { id: pinnedId, organizationId: auth.organizationId } })
        if (!artifact || !artifact.mimeType.startsWith('audio/')) continue
        targets.push({ storyboardId: storyboard.id, dialogue: storyboard.dialogue, artifactId: artifact.id, objectKey: artifact.objectKey, mimeType: artifact.mimeType, durationMs: artifact.durationMs })
      }
      if (targets.length === 0 && (masterArtifact.mimeType.startsWith('video/') || masterArtifact.mimeType.startsWith('audio/'))) {
        // 无逐镜音频:对母带转写一次,期望文本=全部台词拼接——定位不到单镜,
        // findingKey 用 asr:master:{i},storyboardId 留空。
        targets.push({
          storyboardId: null,
          dialogue: storyboards.map(storyboard => storyboard.dialogue).join(''),
          artifactId: masterArtifact.id,
          objectKey: masterArtifact.objectKey,
          mimeType: masterArtifact.mimeType,
          durationMs: masterArtifact.durationMs,
        })
      }

      const findings: Array<{ findingKey: string; dimension: string; severity: string; message: string; evidenceTimeSeconds: number | null; storyboardId: string | null; artifactId: string }> = []
      let transcriptedShots = 0

      const upsert = async (finding: (typeof findings)[number]): Promise<void> => {
        await app.db.qualityFinding.upsert({
          where: { compositionId_findingKey: { compositionId: composition.id, findingKey: finding.findingKey } },
          create: {
            organizationId: auth.organizationId, episodeId: episode.id, compositionId: composition.id, fingerprint,
            findingKey: finding.findingKey, dimension: finding.dimension, severity: finding.severity,
            message: finding.message, evidenceTimeSeconds: finding.evidenceTimeSeconds,
            storyboardId: finding.storyboardId, artifactId: finding.artifactId,
          },
          // 重跑只刷新事实,不清人工裁决(status/decidedBy/reason 原地保留)。
          update: { severity: finding.severity, message: finding.message, evidenceTimeSeconds: finding.evidenceTimeSeconds },
        })
      }

      for (const target of targets) {
        let transcript: { transcript: string; segments?: Array<{ startMs: number; endMs: number; text: string }> }
        try {
          const bytes = await app.storage.read(target.objectKey)
          transcript = await adapter.transcribe(capability, {
            audio: { dataUrl: `data:${target.mimeType};base64,${Buffer.from(bytes).toString('base64')}` },
            language: episode.project.contentLocale === 'en' ? 'en' : 'zh',
            ...(target.durationMs != null && target.durationMs > 0 ? { durationMs: target.durationMs } : {}),
          })
        } catch (error) {
          return reply.code(502).send({ error: `asr transcription failed: ${error instanceof Error ? error.message : String(error)}` })
        }
        transcriptedShots += 1

        const owner = target.storyboardId ?? 'master'
        for (const [index, item] of diffTranscript(target.dialogue, transcript).entries()) {
          const finding = {
            findingKey: `asr:${owner}:${index}`,
            dimension: 'asr',
            severity: item.kind === 'extra' ? 'info' : 'warning',
            message: item.kind === 'missing'
              ? `line not heard in the audio: "${item.expectedText ?? ''}"`
              : item.kind === 'extra'
                ? `unexpected speech: "${item.actualText ?? ''}"`
                : `line differs: expected "${item.expectedText ?? ''}", heard "${item.actualText ?? ''}"`,
            evidenceTimeSeconds: item.startMs !== undefined ? item.startMs / 1000 : null,
            storyboardId: target.storyboardId,
            artifactId: target.artifactId,
          }
          findings.push(finding)
          await upsert(finding)
        }
      }

      // 技术音频检查:母带 volumedetect(clipping/silence 疑点,失败不算错)。
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const os = (await import('node:os')).default
      const path = (await import('node:path')).default
      const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-asr-'))
      try {
        const masterPath = path.join(workdir, `master${path.extname(masterArtifact.objectKey) || '.bin'}`)
        await writeFile(masterPath, await app.storage.read(masterArtifact.objectKey))
        for (const technical of await checkAudioTechnicals(masterPath)) {
          const finding = {
            // technical.id 自带 audio_ 前缀(audio_clipping/audio_silence),不再叠一层。
            findingKey: technical.id,
            dimension: 'audio',
            severity: technical.severity,
            message: technical.message,
            evidenceTimeSeconds: technical.evidenceTimeSeconds,
            storyboardId: null,
            artifactId: masterArtifact.id,
          }
          findings.push(finding)
          await upsert(finding)
        }
      } finally {
        await rm(workdir, { recursive: true, force: true })
      }

      await recordAudit(app.db, {
        organizationId: auth.organizationId, userId: auth.userId,
        action: 'episode.audio-review', entityType: 'Composition', entityId: composition.id,
        payload: { findings: findings.length, transcriptedShots, model: candidate.model },
      })
      return { compositionId: composition.id, fingerprint, transcriptedShots, findings }
    },
  )
}
