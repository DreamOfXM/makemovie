import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  addVoiceboxSample,
  createVoiceboxProfile,
  generateVoiceboxSpeech,
  isVoiceboxRunning,
  listVoiceboxProfiles,
} from '@studio/providers'
import type { RunTaskPayload } from '@studio/jobs'
import { buildObjectKey, extensionFor, probeDuration } from '@studio/media'
import { HashQualityChecker, QC_THRESHOLD } from './qc.js'
import { recordAssetVersion } from './asset-version.js'
import { taskLog, type LogAnchor } from './execution-log.js'
import { nextArtifactVersion, parseRequest, type TaskRow } from './run-task.js'
import type { PipelineDeps } from './deps.js'

/**
 * 角色声音路径（r10 音频体系，2026-09-30 定稿）：说话人绑定了声音且本机
 * Voicebox 在线时，配音走零成本本机克隆——云端 TTS 候选只作降级。
 *
 * 解析链：镜头 speaker → 同集角色素材（同名）→ Asset.voiceArtifactId →
 * 参考音频 + transcript（上传时存进 artifact.metadata）→ Voicebox 克隆
 * profile（按素材 id 幂等创建）→ /generate 异步出声。
 *
 * 任何一步不成立都返回 skip，任务回落到原有云端候选——这条路径的价值在于
 * 「有就用、没有不挡路」。
 */

export type VoiceOutcome =
  | { kind: 'skip'; reason: string }
  | { kind: 'next'; error: string }
  | { kind: 'succeeded'; artifactId: string }
  | { kind: 'rework' }
  | { kind: 'exhausted' }

/** Voicebox 首次出声可能要下载 ~1GB 克隆引擎，轮询上限给足（默认 10 分钟）。 */
const VOICEBOX_TIMEOUT_MS = 600_000

export async function runCharacterVoice(
  task: TaskRow,
  payload: RunTaskPayload,
  deps: PipelineDeps,
  anchor: LogAnchor,
): Promise<VoiceOutcome> {
  if (!task.storyboardId) return { kind: 'skip', reason: 'task has no storyboard' }
  const storyboard = await deps.db.storyboard.findUnique({ where: { id: task.storyboardId }, select: { speaker: true } })
  const speaker = storyboard?.speaker?.trim()
  if (!speaker) return { kind: 'skip', reason: 'shot has no speaker' }

  const asset = await deps.db.asset.findFirst({
    where: { episodeId: task.batch.episodeId, kind: 'character', name: speaker, voiceArtifactId: { not: null } },
    select: { id: true, name: true, voiceArtifactId: true },
  })
  if (!asset?.voiceArtifactId) return { kind: 'skip', reason: `speaker "${speaker}" has no bound voice` }

  if (!(await isVoiceboxRunning(deps.voiceboxBaseUrl))) {
    return { kind: 'skip', reason: 'Voicebox is not running (voice falls back to cloud TTS)' }
  }

  const artifact = await deps.db.mediaArtifact.findUnique({ where: { id: asset.voiceArtifactId } })
  if (!artifact) return { kind: 'next', error: `voice artifact ${asset.voiceArtifactId} not found` }
  let transcript = ''
  try {
    const meta = JSON.parse(artifact.metadata ?? '{}') as { transcript?: unknown }
    transcript = typeof meta.transcript === 'string' ? meta.transcript : ''
  } catch { /* 旧样本没有 metadata，按空 transcript 走 */ }

  const request = parseRequest(task.requestSnapshot, 'voicebox-clone')
  const text = typeof request.input.prompt === 'string' ? request.input.prompt : ''
  if (!text) return { kind: 'next', error: 'voice task has no dialogue text' }

  try {
    const profileId = await ensureProfile(deps, asset.id, asset.name, artifact.objectKey, artifact.mimeType, transcript)
    await taskLog(deps.db, anchor, 'info', 'voice.profile', `cloned voice profile ${profileId} for ${speaker}`, { assetId: asset.id })

    const speech = await generateVoiceboxSpeech({
      profileId,
      text,
      language: 'zh',
      baseUrl: deps.voiceboxBaseUrl,
      timeoutMs: VOICEBOX_TIMEOUT_MS,
      onStatus: (status, job) => {
        // loading_model = 首次下载引擎（~1GB），必须让用户在执行日志里看见进度，否则像卡死。
        void taskLog(deps.db, anchor, 'info', 'voice.status', `voicebox job ${job.id}: ${status}`, { status })
      },
    })

    return await persistVoiceArtifact(task, payload, deps, anchor, speech.bytes, speech.mimeType, speech.durationMs, {
      profileId,
      jobId: speech.job.id,
      assetId: asset.id,
    })
  } catch (error) {
    return { kind: 'next', error: `voicebox clone: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 按素材幂等建 profile：同名复用；没有样本才喂样本（换绑声音=新 artifact，名字带指纹）。 */
async function ensureProfile(
  deps: PipelineDeps,
  assetId: string,
  assetName: string,
  objectKey: string,
  mimeType: string,
  transcript: string,
): Promise<string> {
  const existing = await listVoiceboxProfiles(deps.voiceboxBaseUrl)
  const mine = existing.find(profile => profile.name === `makemovie-${assetId}`)
  if (mine && mine.sample_count > 0) return mine.id

  const bytes = new Uint8Array(await deps.storage.read(objectKey))
  const profile = mine ?? await createVoiceboxProfile({ name: `makemovie-${assetId}`, baseUrl: deps.voiceboxBaseUrl })
  await addVoiceboxSample({
    profileId: profile.id,
    bytes,
    filename: `voice-${assetId}.wav`,
    mimeType,
    referenceText: transcript,
    baseUrl: deps.voiceboxBaseUrl,
  })
  return profile.id
}

/** 与 runCandidate 的成功路径同构：落件 → 质检 → 任务收尾。质检规则共用（音频无视觉面 → 放行）。 */
async function persistVoiceArtifact(
  task: TaskRow,
  payload: RunTaskPayload,
  deps: PipelineDeps,
  anchor: LogAnchor,
  bytes: Uint8Array,
  mimeType: string,
  durationMs: number | null,
  voiceMeta: { profileId: string; jobId: string; assetId: string },
): Promise<VoiceOutcome> {
  const workdir = await mkdtemp(path.join(tmpdir(), 'studio-voice-'))
  try {
    let probedMs = durationMs
    if (probedMs == null) {
      const file = path.join(workdir, 'voice.wav')
      await writeFile(file, bytes)
      probedMs = await probeDuration(file).catch(() => null)
    }
    const version = await nextArtifactVersion(deps.db, task)
    const objectKey = buildObjectKey({
      tenantId: task.organizationId,
      projectId: task.batch.episode.project.id,
      episodeId: task.batch.episode.id,
      stage: 'AUDIO',
      entityId: task.id,
      version,
      extension: extensionFor(mimeType),
    })
    const stored = await deps.storage.put(objectKey, bytes, mimeType)
    const artifact = await deps.db.mediaArtifact.create({
      data: {
        organizationId: task.organizationId,
        taskId: task.id,
        stage: 'AUDIO',
        objectKey: stored.key,
        checksum: stored.checksum,
        mimeType: stored.mimeType,
        version,
        durationMs: probedMs,
        metadata: JSON.stringify({ engine: 'voicebox', ...voiceMeta }),
      },
    })

    const checker = deps.checker ?? new HashQualityChecker(task.id, payload.attempt, deps.qcMode)
    const verdict = await checker.check({
      organizationId: task.organizationId,
      projectId: task.batch.episode.project.id,
      stage: 'AUDIO',
      modality: 'tts',
      mimeType,
      bytes,
      prompt: '',
      workdir,
      durationMs: probedMs ?? undefined,
    })
    await deps.db.qualityCheck.create({
      data: {
        status: verdict.decision === 'pass' ? 'APPROVED' : 'NEEDS_REVIEW',
        kind: verdict.kind,
        score: verdict.decision === 'unjudged' ? null : verdict.score,
        report: JSON.stringify({
          kind: verdict.kind,
          threshold: QC_THRESHOLD,
          mode: deps.qcMode,
          candidate: { provider: 'voicebox', model: 'voicebox-clone' },
          reasons: verdict.decision === 'pass' ? [] : verdict.reasons,
        }),
        artifactId: artifact.id,
      },
    })
    if (verdict.decision === 'unjudged' || verdict.decision === 'rework') {
      // 本机克隆零成本：重抽不需要预算权衡，直接再排一抽。
      const maxAttempts = task.batch.episode.project.qcMaxAttempts ?? 3
      if (payload.attempt >= maxAttempts) {
        await taskLog(deps.db, anchor, 'error', 'task.fail', `voicebox voice: ${verdict.kind} not met after ${maxAttempts} attempts`)
        await deps.db.generationTask.update({
          where: { id: task.id },
          data: { status: 'FAILED', errorSnapshot: `voicebox voice: threshold not met after ${maxAttempts} attempts`, provider: 'voicebox', model: 'voicebox-clone' },
        })
        return { kind: 'exhausted' }
      }
      await deps.enqueueJob({ ...payload, attempt: payload.attempt + 1 })
      return { kind: 'rework' }
    }

    // 零成本引擎也记账：用量表是诚实账本，0 计费行的存在证明这条没烧云端额度。
    await deps.db.usageLedger.create({
      data: {
        organizationId: task.organizationId,
        taskId: task.id,
        provider: 'voicebox',
        model: 'voicebox-clone',
        modality: 'tts',
        inputUnits: 0,
        outputUnits: stored.sizeBytes,
      },
    })
    await taskLog(deps.db, anchor, 'info', 'candidate.success', `voicebox-clone produced tts artifact via character voice (QC ${verdict.decision})`, { artifactId: artifact.id })
    await deps.db.generationTask.update({
      where: { id: task.id },
      data: {
        status: 'SUCCEEDED',
        provider: 'voicebox',
        model: 'voicebox-clone',
        responseSnapshot: JSON.stringify({ attempt: payload.attempt, engine: 'voicebox', ...voiceMeta, artifactId: artifact.id }),
      },
    })
    await recordAssetVersion(deps.db, task, artifact.id, '')
    return { kind: 'succeeded', artifactId: artifact.id }
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}
