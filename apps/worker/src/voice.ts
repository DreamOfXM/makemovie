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
import { isVoiceOverSpeaker, normalizeSpeaker } from '@studio/domain'
import { buildObjectKey, extensionFor, probeDuration } from '@studio/media'
import { HashQualityChecker, QC_THRESHOLD } from './qc.js'
import { recordAssetVersion } from '@studio/pipeline'
import { taskLog, type LogAnchor } from './execution-log.js'
import { nextArtifactVersion, parseRequest, type TaskRow } from './run-task.js'
import { embeddedEngineStatus, embeddedGenerateSpeech, modelLabel } from './tts-engine.js'
import type { PipelineDeps } from './deps.js'

/**
 * 角色声音路径（r10 音频体系，2026-09-30 定稿）：说话人绑定了声音时，配音走本机
 * 克隆引擎——云端 TTS 候选只作降级。
 *
 * 引擎优先级（2026-10-05 拍板：开源用户主路径=内嵌引擎）：
 *   1. 内嵌 Qwen3-TTS MLX（引擎目录 venv+模型就绪）——MakeMovie 自己的推理，
 *      ref_text 可控、无外部依赖
 *   2. Voicebox 在线（17493）——装了的人白嫖，零额外下载
 *   3. 都没有 → skip，任务回落云端 TTS 候选（下载引导由 API/UI 层负责提示）
 *
 * 解析链：镜头 speaker → 同集角色素材（同名）→ Asset.voiceArtifactId →
 * 参考音频 + transcript（上传时存进 artifact.metadata）。VO（画外音）不是角色名：
 * 先按同名找，找不到就回退到本集唯一一条已绑定的角色声音——本片画外音就是
 * 主角的第一人称旁白。任何一步不成立都返回 skip——「有就用、没有不挡路」。
 */

export type VoiceOutcome =
  | { kind: 'skip'; reason: string }
  | { kind: 'next'; error: string }
  | { kind: 'succeeded'; artifactId: string }
  | { kind: 'rework' }
  | { kind: 'exhausted' }

/** Voicebox 首次出声可能要下载 ~1GB 克隆引擎，轮询上限给足（默认 10 分钟）。 */
const VOICEBOX_TIMEOUT_MS = 600_000

export interface VoiceCandidate {
  id: string
  name: string
  voiceArtifactId: string | null
}

/**
 * 一个镜头的克隆配音落到哪个角色素材上。VO 不是角色名：同名声源不存在时，
 * 只有「本集恰好一个角色绑了声音」才回退——多个就跳过（回落云端 TTS），绝不猜。
 * 系统音 / 创作者同理没有角色声音，走云端。
 */
export function resolveSpeakerAsset(
  speaker: string,
  named: VoiceCandidate | null,
  voicedCharacters: VoiceCandidate[],
): { kind: 'asset'; asset: VoiceCandidate } | { kind: 'skip'; reason: string } {
  if (named?.voiceArtifactId) return { kind: 'asset', asset: named }
  if (isVoiceOverSpeaker(speaker)) {
    if (voicedCharacters.length === 0) return { kind: 'skip', reason: 'voice-over (VO) has no character voice bound in this episode' }
    if (voicedCharacters.length > 1) return { kind: 'skip', reason: 'voice-over (VO) matches multiple character voices; pick one in the shot speaker field' }
    return { kind: 'asset', asset: voicedCharacters[0]! }
  }
  return { kind: 'skip', reason: `speaker "${speaker}" has no bound voice` }
}

export async function runCharacterVoice(
  task: TaskRow,
  payload: RunTaskPayload,
  deps: PipelineDeps,
  anchor: LogAnchor,
): Promise<VoiceOutcome> {
  if (!task.storyboardId) return { kind: 'skip', reason: 'task has no storyboard' }
  const storyboard = await deps.db.storyboard.findUnique({ where: { id: task.storyboardId }, select: { speaker: true } })
  const speaker = normalizeSpeaker(storyboard?.speaker)
  if (!speaker) return { kind: 'skip', reason: 'shot has no speaker' }

  const named = await deps.db.asset.findFirst({
    where: { episodeId: task.batch.episodeId, kind: 'character', name: speaker, voiceArtifactId: { not: null } },
    select: { id: true, name: true, voiceArtifactId: true },
  })
  const voiced = isVoiceOverSpeaker(speaker) && !named?.voiceArtifactId
    ? await deps.db.asset.findMany({
        where: { episodeId: task.batch.episodeId, kind: 'character', voiceArtifactId: { not: null } },
        select: { id: true, name: true, voiceArtifactId: true },
        take: 2,
      })
    : []
  const resolved = resolveSpeakerAsset(speaker, named, voiced)
  if (resolved.kind === 'skip') return resolved
  const asset = resolved.asset
  const voiceArtifactId = asset.voiceArtifactId
  if (!voiceArtifactId) return { kind: 'skip', reason: `speaker "${speaker}" has no bound voice` }

  const artifact = await deps.db.mediaArtifact.findUnique({ where: { id: voiceArtifactId } })
  if (!artifact) return { kind: 'next', error: `voice artifact ${voiceArtifactId} not found` }
  let transcript = ''
  try {
    const meta = JSON.parse(artifact.metadata ?? '{}') as { transcript?: unknown }
    transcript = typeof meta.transcript === 'string' ? meta.transcript : ''
  } catch { /* 旧样本没有 metadata，按空 transcript 走 */ }

  const request = parseRequest(task.requestSnapshot, 'qwen3-tts-clone')
  const text = typeof request.input.prompt === 'string' ? request.input.prompt : ''
  if (!text) return { kind: 'next', error: 'voice task has no dialogue text' }

  const refBytes = new Uint8Array(await deps.storage.read(artifact.objectKey))

  try {
    // 引擎 1：内嵌 Qwen3-TTS（产品主路径）。
    const embedded = embeddedEngineStatus()
    if (embedded.venvReady && embedded.modelReady) {
      const speech = await embeddedGenerateSpeech({ text, refBytes, refMimeType: artifact.mimeType, refText: transcript })
      const label = modelLabel(embedded.modelPath)
      await taskLog(deps.db, anchor, 'info', 'voice.engine', `embedded ${label} generated in ${speech.generationMs}ms`)
      return await persistVoiceArtifact(task, payload, deps, anchor, speech.bytes, 'audio/wav', null, {
        engine: 'embedded', model: label, assetId: asset.id,
      })
    }

    // 引擎 2：Voicebox 在线（装了就白嫖）。
    if (await isVoiceboxRunning(deps.voiceboxBaseUrl)) {
      const profileId = await ensureProfile(deps, asset.id, artifact.objectKey, artifact.mimeType, transcript)
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
        engine: 'voicebox', model: 'voicebox-clone', profileId, jobId: speech.job.id, assetId: asset.id,
      })
    }

    return { kind: 'skip', reason: 'no local voice engine (embedded not installed, Voicebox offline) — falling back to cloud TTS' }
  } catch (error) {
    return { kind: 'next', error: `local voice clone: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 按素材幂等建 profile：同名复用；没有样本才喂样本（换绑声音=新 artifact，名字带指纹）。 */
async function ensureProfile(
  deps: PipelineDeps,
  assetId: string,
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
  voiceMeta: { engine: 'embedded' | 'voicebox'; model: string; assetId: string; profileId?: string; jobId?: string },
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
        metadata: JSON.stringify({ voice: voiceMeta }),
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
          candidate: { provider: voiceMeta.engine, model: voiceMeta.model },
          reasons: verdict.decision === 'pass' ? [] : verdict.reasons,
        }),
        artifactId: artifact.id,
      },
    })
    if (verdict.decision === 'unjudged' || verdict.decision === 'rework') {
      // 本机克隆零成本：重抽不需要预算权衡，直接再排一抽（与主链同一口径）。
      const maxAttempts = (task.batch.episode.project.maxRetriesPerShot ?? 1) + 1
      if (payload.attempt >= maxAttempts) {
        await taskLog(deps.db, anchor, 'error', 'task.fail', `${voiceMeta.model}: ${verdict.kind} not met after ${maxAttempts} attempts`)
        await deps.db.generationTask.update({
          where: { id: task.id },
          data: { status: 'FAILED', errorSnapshot: `${voiceMeta.model}: threshold not met after ${maxAttempts} attempts`, provider: voiceMeta.engine, model: voiceMeta.model },
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
        provider: voiceMeta.engine,
        model: voiceMeta.model,
        modality: 'tts',
        inputUnits: 0,
        outputUnits: stored.sizeBytes,
      },
    })
    await taskLog(deps.db, anchor, 'info', 'candidate.success', `${voiceMeta.model} produced tts artifact via character voice (QC ${verdict.decision})`, { artifactId: artifact.id })
    await deps.db.generationTask.update({
      where: { id: task.id },
      data: {
        status: 'SUCCEEDED',
        provider: voiceMeta.engine,
        model: voiceMeta.model,
        responseSnapshot: JSON.stringify({ attempt: payload.attempt, ...voiceMeta, artifactId: artifact.id }),
      },
    })
    await recordAssetVersion(deps.db, task, artifact.id, '')
    return { kind: 'succeeded', artifactId: artifact.id }
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}
