import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Prisma, syncBatchStatus } from '@studio/db'
import { isContentLocale } from '@studio/domain'
import type { RunTaskCandidate, RunTaskPayload } from '@studio/jobs'
import { buildObjectKey, extensionFor, REFERENCE_IMAGE_MAX_BYTES_10MB, synthesizeMockMedia, toDataUrl, toReferenceImage } from '@studio/media'
import {
  advancePipeline,
  buildStoryboardPrompt,
  DEFAULT_MAX_ATTEMPTS,
  mergeStoryboardReplies,
  planStoryboardSegments,
  targetShotDurationMs,
} from '@studio/pipeline'
import { createAdapter, type MediaReference, type ModelCapability as ProviderCapability, type PollResult, type ProviderAdapter, type ProviderRequest } from '@studio/providers'
import { decryptSecret } from '@studio/security'
import { recordAssetVersion } from './asset-version.js'
import { recordGeneratedContent } from './content.js'
import type { PipelineDeps } from './deps.js'
import { taskLog, type LogAnchor } from './execution-log.js'
import { errorMessage, pollToSettled, toCapability } from './provider-call.js'
import { HashQualityChecker, QC_THRESHOLD } from './qc.js'
import { runCharacterVoice } from './voice.js'

export type TaskRow = Prisma.GenerationTaskGetPayload<{ include: { batch: { include: { episode: { include: { project: true } } } } } }>

type CandidateOutcome = { status: 'succeeded' } | { status: 'rework' } | { status: 'exhausted' } | { status: 'next'; error: string }

interface Material {
  bytes: Uint8Array
  mimeType: string
  width?: number
  height?: number
  durationMs?: number
}

const MOCK_DURATION_MS = 1_000

// ffmpeg chooses the container from the output file extension, so the temp name has to
// match the modality before synthesizeMockMedia can tell us the real mime type.
const MOCK_EXTENSION: Record<string, string> = { image: 'png', t2v: 'mp4', i2v: 'mp4', r2v: 'mp4', tts: 'wav', music: 'wav' }

/** 产物版本号按「同一实体同一阶段已落产物最大版 +1」分配——版本是给用户看的
 *  "这一镜/这个素材的第 N 版"，必须跨任务连续：重跑会开新任务，旧逻辑按本任务
 *  计数就从 v1 重新起跳，同一镜出现两个 v1（2026-09-28 用户在版本胶片条上实测）。
 *  作用域阶梯：镜头任务按镜头×阶段；素材任务按任务↔素材多对多；其余按剧集。
 *  重排队（同任务重试）天然兼容：全集的 max ≥ 本任务的 max，(objectKey, version)
 *  唯一键照旧错开。 */
export async function nextArtifactVersion(
  db: PipelineDeps['db'],
  task: { stage: TaskRow['stage']; storyboardId: string | null; batch: { episodeId: string }; assets?: { id: string }[] },
): Promise<number> {
  const scope = task.storyboardId
    ? { task: { storyboardId: task.storyboardId } }
    : task.assets && task.assets.length > 0
      ? { task: { assets: { some: { id: { in: task.assets.map(asset => asset.id) } } } } }
      : { task: { batch: { episodeId: task.batch.episodeId } } }
  const last = await db.mediaArtifact.aggregate({ _max: { version: true }, where: { stage: task.stage, ...scope } })
  return (last._max.version ?? 0) + 1
}

export async function runTask(payload: RunTaskPayload, deps: PipelineDeps): Promise<void> {
  const task = await deps.db.generationTask.findUnique({
    where: { id: payload.taskId },
    // assets：素材任务的版本作用域要按「任务↔素材」多对多圈全集（见 nextArtifactVersion）。
    include: { batch: { include: { episode: { include: { project: true } } } }, assets: { select: { id: true } } },
  })
  if (!task) throw new Error(`generation task ${payload.taskId} not found`)
  if (task.status === 'CANCELLED') return
  // P7 守卫拦下的任务从不排队;万一有陈旧作业撞上,也绝不代烧——fail-closed。
  if (task.status === 'BLOCKED') return

  await deps.db.generationTask.update({ where: { id: task.id }, data: { status: 'RUNNING', attempts: payload.attempt } })
  await syncBatchStatus(deps.db, task.batchId)

  const anchor = { organizationId: task.organizationId, taskId: task.id, batchId: task.batchId, episodeId: task.batch.episode.id, stage: task.stage }
  await taskLog(deps.db, anchor, 'info', 'task.start', `attempt ${payload.attempt} with ${payload.candidates.length} candidate(s): ${payload.candidates.map(label).join(' → ') || 'none'}`, { attempt: payload.attempt, candidates: payload.candidates.map(label) })

  const errors: string[] = []
  // Which candidates actually got their turn before the task failed. Only success used to
  // stamp provider/model, so a failed task showed "—" in the console and the reader could
  // not tell which model burned out without expanding the error. The chain joins every
  // model tried, because a fallback that also failed is exactly what the reader needs
  // to see before rebinding the slot.
  const tried: RunTaskCandidate[] = []
  // What the shot's frame did across every candidate this task tried. It has to outlive a
  // single attempt: the model that wanted the frame is not the one that ends up delivering
  // the clip, and a text-only fallback that says nothing about the lost frame reads as if
  // no conditioning was ever planned.
  const referenceLog: ReferenceRecord[] = []

  // 角色声音优先（r10 音频体系）：说话人绑定了声音且本机 Voicebox 在线时，配音先走
  // 零成本本机克隆；任何一步不成立（没绑定/引擎不在线/克隆失败）都让位给云端 TTS
  // 候选——这条路径的价值是「有就用、没有不挡路」。
  if (task.stage === 'AUDIO') {
    let voice: Awaited<ReturnType<typeof runCharacterVoice>>
    try {
      voice = await runCharacterVoice(task, payload, deps, anchor)
    } catch (error) {
      voice = { kind: 'next', error: `voicebox clone: ${errorMessage(error)}` }
    }
    if (voice.kind === 'skip') {
      await taskLog(deps.db, anchor, 'info', 'voice.skip', voice.reason)
    } else if (voice.kind === 'next') {
      await taskLog(deps.db, anchor, 'warn', 'voice.fallback', `${voice.error} — falling back to cloud TTS candidates`)
    } else if (voice.kind === 'succeeded') {
      const status = await syncBatchStatus(deps.db, task.batchId)
      await taskLog(deps.db, anchor, 'info', 'task.success', `completed via voicebox-clone (character voice)`)
      if (status === 'COMPLETED') await autoAdvance(deps, task)
      return
    } else {
      // rework（已重排）与 exhausted（已 FAILED）在 runCharacterVoice 内收尾。
      return
    }
  }

  for (const candidate of payload.candidates) {
    let outcome: CandidateOutcome
    await taskLog(deps.db, anchor, 'info', 'candidate.start', `trying ${label(candidate)}`)
    try {
      outcome = await runCandidate(task, candidate, payload, deps, referenceLog, errors, anchor)
    } catch (error) {
      outcome = { status: 'next', error: `${label(candidate)}: ${errorMessage(error)}` }
    }
    if (outcome.status === 'next') {
      errors.push(outcome.error)
      tried.push(candidate)
      await taskLog(deps.db, anchor, 'warn', 'candidate.skip', outcome.error)
      continue
    }
    const status = await syncBatchStatus(deps.db, task.batchId)
    await taskLog(deps.db, anchor, 'info', 'task.success', `completed via ${label(candidate)}`)
    if (status === 'COMPLETED') await autoAdvance(deps, task)
    return
  }

  await deps.db.generationTask.update({
    where: { id: task.id },
    data: {
      status: 'FAILED',
      errorSnapshot: JSON.stringify(errors.length > 0 ? errors : ['no candidates supplied']),
      ...(tried.length > 0 ? { provider: tried[0].provider, model: tried.map(candidate => candidate.model).join(' → ') } : {}),
    },
  })
  await taskLog(deps.db, anchor, 'error', 'task.fail', `all ${tried.length} candidate(s) failed`, { errors })
  await syncBatchStatus(deps.db, task.batchId)
}

// Relays a fully-succeeded batch into the next stage. System-initiated, so it is
// attributed to no user and audited as pipeline.autoAdvance. Advancing is best
// effort: the task that just completed already succeeded and was already paid
// for, so a failure to start the next stage is logged, not thrown back as a job
// failure that would re-run this one.
async function autoAdvance(deps: PipelineDeps, task: TaskRow): Promise<void> {
  try {
    const result = await advancePipeline({ db: deps.db, enqueueJob: deps.enqueueJob }, task.organizationId, null, task.batch.episode.id, { auto: true })
    // A refused stage (the VIDEO first-frame gate, for one) stops the relay silently
    // otherwise — the operator would never learn why the chain stopped mid-way.
    if (!result.ok) process.stderr.write(`auto-advance after batch ${task.batchId} stopped: ${result.error}${result.reasons ? ` (${result.reasons.join(', ')})` : ''}\n`)
  } catch (error) {
    process.stderr.write(`auto-advance after batch ${task.batchId} failed: ${errorMessage(error)}\n`)
  }
}

async function runCandidate(
  task: TaskRow,
  candidate: RunTaskCandidate,
  payload: RunTaskPayload,
  deps: PipelineDeps,
  referenceLog: ReferenceRecord[],
  errors: string[],
  anchor: LogAnchor,
): Promise<CandidateOutcome> {
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
  // 返工抽带否决原因（2026-09-29 用户拍板）：同一提示词盲抽重试浪费的是用户的钱，
  // 审计已经写明了错在哪，把原因拼进这一抽的尾部让它修正。快照仍是原始请求，
  // 修正内容随执行日志留痕（qc.reworkPrompt）。
  if (payload.attempt > 1 && typeof request.input.prompt === 'string' && request.input.prompt !== '') {
    const previous = await deps.db.qualityCheck.findFirst({
      where: { status: 'NEEDS_REVIEW', artifact: { taskId: task.id } },
      orderBy: { id: 'desc' },
      select: { report: true },
    })
    if (previous) {
      try {
        const parsed = JSON.parse(previous.report) as { reasons?: unknown }
        const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.filter((r): r is string => typeof r === 'string') : []
        if (reasons.length > 0) {
          request.input.prompt = `${request.input.prompt}\n\n重抽修正（审计否决了上一抽，原因）：${reasons.join('；')}。这一抽必须修正以上问题，其余要求不变。`
          await taskLog(deps.db, anchor, 'info', 'qc.reworkPrompt', 'rework attempt carries the audit rejection reasons', { reasons })
        }
      } catch {
        // 旧报文不是 JSON 就不带原因，照旧重试
      }
    }
  }
  const billed = pinBilledParameters(request, capability, capabilityRow.spec, payload.attempt)
  if (Object.keys(billed).length > 0) {
    await taskLog(deps.db, anchor, 'info', 'candidate.params', `${label(candidate)} billed with ${Object.entries(billed).map(([field, value]) => `${field}=${String(value)}`).join(' ')}`, billed)
  }
  const frame = await resolveFrame(task, capability, capabilityRow.spec, deps)
  let reference: Extract<FrameOutcome, { conditioned: true }> | undefined
  if (frame) {
    if (!frame.conditioned) {
      referenceLog.push({ model: candidate.model, conditioned: false, reason: frame.reason })
      return { status: 'next', error: `${label(candidate)}: ${frame.reason}` }
    }
    referenceLog.push({ model: candidate.model, conditioned: true })
    request.input.media = [{ type: 'first_frame', url: frame.dataUrl }]
    reference = frame
  }
  // 帧已经带上时,t2v 候选没有画面槽:跑它只会产出与首帧无关的"成功"片段——
  // 用户拿到的是一段冒名顶替的幻觉,不是成果。这里直接跳过该候选,错误链写明
  // "带首帧的任务需要图生视频模型",让失败原因(通常是 i2v 额度耗尽)直达用户。
  if (frame?.conditioned && capability.modality === 't2v') {
    return { status: 'next', error: `${label(candidate)}: skipped — the task carries an approved first frame, which a text-to-video model cannot honor (bind or fund an image-to-video model)` }
  }
  // 定妆照参考图:首帧任务带上镜头绑定素材的已定稿图,让支持参考图的图像模型
  // (qwen-image-edit 一类)画出同一批人。绑定的模型不吃参考图时不拦任务——
  // 文字描述仍在提示词里,降级原因记进 responseSnapshot.reference 供排查。
  if (capability.modality === 'image') {
    const sheets = await resolveAssetReferences(task, capability, capabilityRow.spec, deps, referenceLog)
    if (sheets) request.input.media = sheets
  }
  const apiKey = decryptSecret(connection.encryptedSecret, deps.masterKey)
  const accessKey = connection.accessKeyEncrypted ? decryptSecret(connection.accessKeyEncrypted, deps.masterKey) : undefined
  const adapter = createAdapter(connection.provider, { apiKey, accessKey, baseUrl: connection.baseUrl })

  // 4b 分段分镜:长剧本(或按目标时长估算的镜头数)超阈值时不整篇塞一个请求——
  // 那是今天的隐性截断。执行时按剧本的场景标记切块、逐段重建 prompt 调用,拼接
  // 后全局重编号写回同一 revision。阈值内返回 null,下面的单次调用路径原样保留。
  if (task.stage === 'STORYBOARD') {
    const segmentRequests = await storyboardSegmentRequests(task, request, deps)
    if (segmentRequests) return runSegmentedStoryboard(task, candidate, capability, adapter, segmentRequests, payload, deps, errors, anchor)
  }

  const submitted = await adapter.submit(capability, request)
  const result = await pollToSettled(adapter, capability, submitted.taskId, {
    intervalMs: deps.pollIntervalMs,
    timeoutMs: deps.pollTimeoutMs,
  })
  if (result.status === 'failed') return { status: 'next', error: `${label(candidate)}: ${result.error ?? 'provider reported failure'}` }

  const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-artifact-'))
  try {
    const material = await materialize(result, capability.modality, workdir)
    const artifactVersion = await nextArtifactVersion(deps.db, task)
    const objectKey = buildObjectKey({
      tenantId: task.organizationId,
      projectId: task.batch.episode.project.id,
      episodeId: task.batch.episode.id,
      stage: task.stage,
      entityId: task.id,
      version: artifactVersion,
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
        version: artifactVersion,
        width: material.width,
        height: material.height,
        durationMs: material.durationMs,
        metadata: JSON.stringify(result),
      },
    })

    const checker = deps.checker ?? new HashQualityChecker(task.id, payload.attempt, deps.qcMode)
    const verdict = await checker.check({
      organizationId: task.organizationId,
      projectId: task.batch.episode.project.id,
      stage: task.stage,
      modality: capability.modality,
      mimeType: material.mimeType,
      bytes: material.bytes,
      prompt: promptOf(request),
      workdir,
      durationMs: material.durationMs,
      ...(reference ? { referenceDataUrl: reference.dataUrl } : {}),
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
          candidate,
          reasons: verdict.decision === 'pass' ? [] : verdict.reasons,
        }),
        artifactId: artifact.id,
      },
    })
    const qcScore = verdict.decision === 'unjudged' ? null : verdict.score
    await taskLog(deps.db, anchor, verdict.decision === 'pass' ? 'info' : 'warn', 'qc.verdict', `${verdict.kind}: ${verdict.decision} (score ${qcScore ?? 'n/a'})`, { decision: verdict.decision, score: qcScore, reasons: verdict.decision === 'pass' ? [] : verdict.reasons })

    // An auditor that could not judge is a fault of the audit, not of the content.
    // Regenerating would pay for an artifact nobody rejected, and quietly scoring
    // it with the hash instead would pretend a judgment happened, so the task stops.
    if (verdict.decision === 'unjudged') {
      await taskLog(deps.db, anchor, 'error', 'task.fail', `${verdict.kind}: auditor could not judge — ${verdict.reasons.join('; ') || 'no verdict'}`)
      await deps.db.generationTask.update({
        where: { id: task.id },
        data: { status: 'FAILED', errorSnapshot: `${verdict.kind}: ${verdict.reasons.join('; ') || 'no verdict'}`, provider: candidate.provider, model: candidate.model },
      })
      return { status: 'exhausted' }
    }

    if (verdict.decision === 'rework') {
      const maxAttempts = task.batch.episode.project.qcMaxAttempts ?? DEFAULT_MAX_ATTEMPTS
      if (payload.attempt >= maxAttempts) {
        await taskLog(deps.db, anchor, 'error', 'task.fail', `${verdict.kind}: quality threshold not met after ${maxAttempts} attempts`, { reasons: verdict.reasons })
        await deps.db.generationTask.update({
          where: { id: task.id },
          data: { status: 'FAILED', errorSnapshot: `${verdict.kind}: threshold not met after ${maxAttempts} attempts`, provider: candidate.provider, model: candidate.model },
        })
        return { status: 'exhausted' }
      }
      await taskLog(deps.db, anchor, 'warn', 'qc.rework', `quality threshold not met (score ${verdict.score}) — retrying (attempt ${payload.attempt + 1}/${maxAttempts})`, { reasons: verdict.reasons })
      await deps.enqueueJob({ ...payload, attempt: payload.attempt + 1 })
      return { status: 'rework' }
    }

    // Write AI-generated episode content into the domain before the task is
    // marked succeeded, so an unparseable result fails this attempt (and falls
    // through to the next candidate) rather than leaving a succeeded task with
    // nothing to show for it.
    if (task.stage === 'SCRIPT' || task.stage === 'STORYBOARD') {
      await recordGeneratedContent(deps.db, task, new TextDecoder().decode(material.bytes))
    }

    await deps.db.usageLedger.create({
      data: {
        organizationId: task.organizationId,
        taskId: task.id,
        provider: candidate.provider,
        model: candidate.model,
        modality: capability.modality,
        inputUnits: promptOf(request).length,
        outputUnits: stored.sizeBytes,
      },
    })
    await taskLog(deps.db, anchor, 'info', 'candidate.success', `${label(candidate)} produced ${capability.modality} artifact (QC ${verdict.decision}, score ${verdict.score ?? 'n/a'})`, { artifactId: artifact.id })

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
          // What actually went over the wire, as opposed to the base the snapshot
          // promised: the seed after rotation and the pinned tier are the numbers a
          // cost or a reproduction question is answered with.
          ...(Object.keys(request.parameters).length > 0 ? { parameters: request.parameters } : {}),
          artifactId: artifact.id,
          artifactUrl: result.artifactUrl ?? null,
          qc: { score: verdict.score, threshold: QC_THRESHOLD },
          // 成功不等于全程顺利:排在前面的候选为什么让位,这条链是唯一线索。
          // (qwen-image-edit 挂了回落 wan2.2 出图,没有这条记录就只能盲猜。)
          ...(errors.length > 0 ? { candidateErrors: errors } : {}),
          // The frames are reported as ids and verdicts: their bytes would turn a per-task
          // text column into a media store, and the artifact rows already hold them.
          ...(referenceLog.length > 0 ? { reference: referenceLog } : {}),
        }),
      },
    })
    await recordAssetVersion(deps.db, task, artifact.id, promptOf(request))
    return { status: 'succeeded' }
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

/**
 * 分段分镜的请求准备:从快照取 scriptVersionId 回读剧本,按当前视频档位与集
 * 目标时长切块,并为每段重建一条分镜 prompt(带上该段折算出的镜头预算)。快照
 * 没有 scriptVersionId(旧任务、手工种子)时无从取剧本,返回 null 走单次调用——
 * 分段是长剧本的增强路径,不是新的任务契约。
 */
async function storyboardSegmentRequests(task: TaskRow, request: ProviderRequest, deps: PipelineDeps): Promise<ProviderRequest[] | null> {
  let scriptVersionId: string | undefined
  try {
    const snapshot = JSON.parse(task.requestSnapshot ?? '') as { scriptVersionId?: unknown }
    if (typeof snapshot.scriptVersionId === 'string' && snapshot.scriptVersionId !== '') scriptVersionId = snapshot.scriptVersionId
  } catch {
    return null
  }
  if (!scriptVersionId) return null
  const script = await deps.db.scriptVersion.findUnique({ where: { id: scriptVersionId }, select: { content: true } })
  if (!script) return null
  const episode = task.batch.episode
  const shotMs = await targetShotDurationMs(deps.db, task.organizationId, episode.projectId)
  const segments = planStoryboardSegments(script.content, { targetDurationMs: episode.targetDurationMs ?? undefined, shotMs })
  if (segments.length === 0) return null
  const locale = isContentLocale(episode.project.contentLocale) ? episode.project.contentLocale : 'zh'
  return segments.map(segment => ({
    ...request,
    input: { ...request.input, prompt: buildStoryboardPrompt(locale, segment.content, shotMs, segment.shotBudget) },
  }))
}

/**
 * 分段分镜的一次完整执行:逐段提交、落件、质检,全部段收齐后按段序拼接并全局
 * 重编号成一份分镜文档,再走与单次调用相同的落库路径(recordGeneratedContent),
 * 所有镜头因此落在同一个 revision、编号连续。任何一段失败都算这个候选失败,
 * 让位给下一个候选或重试——静默丢一段就是丢一截成片。
 */
async function runSegmentedStoryboard(
  task: TaskRow,
  candidate: RunTaskCandidate,
  capability: ProviderCapability,
  adapter: ProviderAdapter,
  requests: ProviderRequest[],
  payload: RunTaskPayload,
  deps: PipelineDeps,
  errors: string[],
  anchor: LogAnchor,
): Promise<CandidateOutcome> {
  const texts: string[] = []
  const artifactIds: string[] = []
  const billed: Array<{ inputUnits: number; outputUnits: number }> = []
  const checker = deps.checker ?? new HashQualityChecker(task.id, payload.attempt, deps.qcMode)
  for (const [index, segmentRequest] of requests.entries()) {
    await taskLog(deps.db, anchor, 'info', 'storyboard.segment', `segment ${index + 1}/${requests.length}`, { segment: index + 1, count: requests.length })
    const submitted = await adapter.submit(capability, segmentRequest)
    const result = await pollToSettled(adapter, capability, submitted.taskId, {
      intervalMs: deps.pollIntervalMs,
      timeoutMs: deps.pollTimeoutMs,
    })
    if (result.status === 'failed') return { status: 'next', error: `${label(candidate)}: ${result.error ?? 'provider reported failure'}` }

    const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-artifact-'))
    try {
      const material = await materialize(result, capability.modality, workdir)
      // 段产物共用任务行：max+1 对各段也天然错开（同段历史行 version 最大的那条 +1）。
      const artifactVersion = await nextArtifactVersion(deps.db, task)
      const objectKey = buildObjectKey({
        tenantId: task.organizationId,
        projectId: task.batch.episode.project.id,
        episodeId: task.batch.episode.id,
        stage: task.stage,
        // 段号进 objectKey:同一任务同一次尝试的各段产物互不覆盖,审计能对回每一次调用。
        entityId: `${task.id}-seg${index + 1}`,
        version: artifactVersion,
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
          version: artifactVersion,
          metadata: JSON.stringify(result),
        },
      })
      artifactIds.push(artifact.id)

      const verdict = await checker.check({
        organizationId: task.organizationId,
        projectId: task.batch.episode.project.id,
        stage: task.stage,
        modality: capability.modality,
        mimeType: material.mimeType,
        bytes: material.bytes,
        prompt: promptOf(segmentRequest),
        workdir,
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
            candidate,
            segment: index + 1,
            reasons: verdict.decision === 'pass' ? [] : verdict.reasons,
          }),
          artifactId: artifact.id,
        },
      })
      if (verdict.decision === 'unjudged') {
        await taskLog(deps.db, anchor, 'error', 'task.fail', `${verdict.kind}: auditor could not judge — ${verdict.reasons.join('; ') || 'no verdict'}`)
        await deps.db.generationTask.update({
          where: { id: task.id },
          data: { status: 'FAILED', errorSnapshot: `${verdict.kind}: ${verdict.reasons.join('; ') || 'no verdict'}`, provider: candidate.provider, model: candidate.model },
        })
        return { status: 'exhausted' }
      }
      if (verdict.decision === 'rework') {
        const maxAttempts = task.batch.episode.project.qcMaxAttempts ?? DEFAULT_MAX_ATTEMPTS
        if (payload.attempt >= maxAttempts) {
          await taskLog(deps.db, anchor, 'error', 'task.fail', `${verdict.kind}: quality threshold not met after ${maxAttempts} attempts`, { reasons: verdict.reasons })
          await deps.db.generationTask.update({
            where: { id: task.id },
            data: { status: 'FAILED', errorSnapshot: `${verdict.kind}: threshold not met after ${maxAttempts} attempts`, provider: candidate.provider, model: candidate.model },
          })
          return { status: 'exhausted' }
        }
        await taskLog(deps.db, anchor, 'warn', 'qc.rework', `quality threshold not met (score ${verdict.score}) on segment ${index + 1} — retrying (attempt ${payload.attempt + 1}/${maxAttempts})`, { reasons: verdict.reasons })
        await deps.enqueueJob({ ...payload, attempt: payload.attempt + 1 })
        return { status: 'rework' }
      }
      // 记账先攒着,整段任务成功才落 usage——与单次调用路径同口径:失败尝试不记账。
      billed.push({ inputUnits: promptOf(segmentRequest).length, outputUnits: stored.sizeBytes })
      texts.push(new TextDecoder().decode(material.bytes))
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  }

  const merged = mergeStoryboardReplies(texts)
  if (!merged) throw new Error('storyboard generation returned no parseable shot list')
  await recordGeneratedContent(deps.db, task, merged)
  for (const entry of billed) {
    await deps.db.usageLedger.create({
      data: { organizationId: task.organizationId, taskId: task.id, provider: candidate.provider, model: candidate.model, modality: capability.modality, ...entry },
    })
  }
  await taskLog(deps.db, anchor, 'info', 'candidate.success', `${label(candidate)} produced storyboard segments across ${requests.length} calls`, { artifactIds })
  await deps.db.generationTask.update({
    where: { id: task.id },
    data: {
      status: 'SUCCEEDED',
      provider: candidate.provider,
      model: candidate.model,
      responseSnapshot: JSON.stringify({
        attempt: payload.attempt,
        candidate,
        // 分段任务没有单一的 providerTaskId/URL:每段的原始回执在各段 artifact 的
        // metadata 里,这里记段数与段产物清单,审计从清单跳到每一段。
        storyboardSegments: { count: requests.length, artifactIds },
        ...(errors.length > 0 ? { candidateErrors: errors } : {}),
      }),
    },
  })
  return { status: 'succeeded' }
}

async function materialize(result: PollResult, modality: string, workdir: string): Promise<Material> {
  // A vendor that returns bytes has already done the download the worker cannot: its
  // media sits behind an authenticated GET or came inline as base64.
  if (result.inlineArtifact) return { ...result.inlineArtifact }
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

/**
 * What this candidate did with the shot's frame, or `null` when there was nothing to
 * decide: no frame in the snapshot, or a candidate that cannot take one. `null` is what
 * keeps the text-to-video path byte-identical to the one it had before conditioning existed.
 */
type FrameOutcome =
  | { conditioned: true; dataUrl: string }
  | { conditioned: false; reason: string }

/** One line of that story as it is kept on the succeeded task. Never the image itself. */
type ReferenceRecord =
  | { model: string; conditioned: true }
  | { model: string; conditioned: false; reason: string }

/**
 * Reads the shot's own frame out of storage and turns it into the conditioning image an
 * image-to-video model is given.
 *
 * The gate that flattens a transparent PNG and refuses an oversized frame runs here rather
 * than at plan time, because this is the first place the bytes are worth reading, and the
 * ceiling it judges them against belongs to whichever model ends up running the shot.
 *
 * Nothing here fails a task. A frame that cannot be used comes back as a reason: the caller
 * declines that candidate and the shot is made by a text-to-video model instead, because
 * conditioning is a quality gain and not an availability precondition.
 */
async function resolveFrame(
  task: TaskRow,
  capability: ProviderCapability,
  spec: unknown,
  deps: PipelineDeps,
): Promise<FrameOutcome | null> {
  // A text-to-video candidate has no slot for a frame and the adapter says so; reading the
  // bytes for it would spend storage traffic on an image nobody is going to look at.
  if (capability.modality !== 'i2v') return null
  const references = readFrameReferences(task.requestSnapshot)
  if (references.length === 0) return null
  const { artifactId } = references[0]

  try {
    const artifact = await deps.db.mediaArtifact.findFirst({
      where: { id: artifactId, organizationId: task.organizationId },
      select: { objectKey: true, mimeType: true },
    })
    if (!artifact) return { conditioned: false, reason: 'the referenced first frame is no longer stored' }

    const bytes = await deps.storage.read(artifact.objectKey)
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-reference-'))
    try {
      const frame = await toReferenceImage({
        bytes,
        mimeType: artifact.mimeType,
        workdir,
        // The bound model's own row carries the ceiling its generation publishes; a row
        // that declares none gets the tightest one rather than the loosest.
        limits: { maxBytes: referenceMaxBytes(spec) },
      })
      if (!frame.ok) return { conditioned: false, reason: frame.reason }
      return { conditioned: true, dataUrl: toDataUrl(frame.bytes, frame.mimeType) }
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  } catch (error) {
    return { conditioned: false, reason: errorMessage(error) }
  }
}

function referenceMaxBytes(spec: unknown): number {
  const declared = isRecord(spec) ? spec.referenceMaxBytes : undefined
  return typeof declared === 'number' && Number.isInteger(declared) && declared > 0 ? declared : REFERENCE_IMAGE_MAX_BYTES_10MB
}

/**
 * 首帧任务的定妆照参考图:requestSnapshot 带着触发时解析好的素材 APPROVED 版本 artifact。
 * 绑定的模型声明吃参考图(qwen-image-edit)才读字节、拍平、随请求发送;声明的上限之内
 * 逐张发送,单张失败只丢那张并记录原因,不拦任务——文字描述仍然在提示词里。
 */
async function resolveAssetReferences(
  task: TaskRow,
  capability: ProviderCapability,
  spec: unknown,
  deps: PipelineDeps,
  referenceLog: ReferenceRecord[],
): Promise<MediaReference[] | null> {
  const references = readFrameReferences(task.requestSnapshot)
  if (references.length === 0) return null
  if (!capability.acceptsReferenceImages) {
    referenceLog.push({ model: capability.model, conditioned: false, reason: `model "${capability.model}" does not take reference images; this frame fell back to text-to-image without the approved asset sheets` })
    return null
  }
  const media: MediaReference[] = []
  for (const reference of references.slice(0, capability.maxReferenceImages || references.length)) {
    try {
      const artifact = await deps.db.mediaArtifact.findFirst({
        where: { id: reference.artifactId, organizationId: task.organizationId },
        select: { objectKey: true, mimeType: true },
      })
      if (!artifact) {
        referenceLog.push({ model: capability.model, conditioned: false, reason: 'the referenced asset sheet is no longer stored' })
        continue
      }
      const bytes = await deps.storage.read(artifact.objectKey)
      const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-reference-'))
      try {
        const sheet = await toReferenceImage({ bytes, mimeType: artifact.mimeType, workdir, limits: { maxBytes: referenceMaxBytes(spec) } })
        if (!sheet.ok) {
          referenceLog.push({ model: capability.model, conditioned: false, reason: sheet.reason })
          continue
        }
        media.push({ type: 'reference_image', url: toDataUrl(sheet.bytes, sheet.mimeType) })
      } finally {
        await rm(workdir, { recursive: true, force: true })
      }
    } catch (error) {
      referenceLog.push({ model: capability.model, conditioned: false, reason: errorMessage(error) })
    }
  }
  if (media.length === 0) return null
  referenceLog.push({ model: capability.model, conditioned: true })
  return media
}

/** The frame/sheet references this task was planned with, as the pipeline wrote them. */
function readFrameReferences(snapshot: string | null): { artifactId: string }[] {
  if (!snapshot) return []
  const parsed: unknown = JSON.parse(snapshot)
  if (!isRecord(parsed) || !Array.isArray(parsed.referenceArtifacts)) return []
  const references: { artifactId: string }[] = []
  for (const entry of parsed.referenceArtifacts) {
    // 'first_frame' conditions a video clip on the shot's own frame; 'reference_image'
    // grounds a first frame on the approved asset sheets. Both read the same way here.
    if (!isRecord(entry) || (entry.type !== 'first_frame' && entry.type !== 'reference_image') || typeof entry.artifactId !== 'string') {
      throw new Error(`requestSnapshot carries a reference this worker cannot resolve: ${JSON.stringify(entry)}`)
    }
    references.push({ artifactId: entry.artifactId })
  }
  return references
}

export function parseRequest(snapshot: string | null, fallbackModel: string): ProviderRequest {
  if (!snapshot) throw new Error('task has no requestSnapshot')
  const parsed = JSON.parse(snapshot) as { model?: unknown; input?: unknown; parameters?: unknown }
  return {
    model: typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : fallbackModel,
    input: isRecord(parsed.input) ? parsed.input : {},
    parameters: isRecord(parsed.parameters) ? parsed.parameters : {},
  }
}

/**
 * The two fields that define what a request is billed at are made explicit here, at
 * submit time, because the snapshot was written before this candidate was picked.
 * The base seed the pipeline recorded rotates with the attempt: the same snapshot with
 * the same seed would have the vendor reproduce identical bytes, so a QC rework would
 * pay for a copy. And the delivery tier is pinned from the capability row's own spec —
 * the only place that lists, in the model's own dialect ('1080P' and '1080p' are
 * different vendors' spellings), the values it accepts. A spec with no resolutions
 * declares nothing, so nothing is guessed: the vendor default stays the only provable
 * number.
 */
export function pinBilledParameters(
  request: ProviderRequest,
  capability: ProviderCapability,
  spec: unknown,
  attempt: number,
): Record<string, unknown> {
  const billed: Record<string, unknown> = {}
  if (typeof request.parameters.seed === 'number') {
    request.parameters.seed += Math.max(attempt - 1, 0)
    billed.seed = request.parameters.seed
  }
  if (capability.modality === 't2v' || capability.modality === 'i2v' || capability.modality === 'r2v') {
    const declared = isRecord(spec) && Array.isArray(spec.resolutions) ? spec.resolutions.filter((value): value is string => typeof value === 'string') : []
    if (declared.length > 0 && typeof request.parameters.resolution !== 'string') {
      const tier = deliveryTier(declared)
      if (tier) {
        request.parameters.resolution = tier
        billed.resolution = tier
      }
    }
  }
  return billed
}

/**
 * The tier this product delivers at: the 1080 class when the model offers it, otherwise
 * the highest class below it. 4K is never picked by default — it is a different price
 * bracket, and quietly raising the billed tier is exactly what this function exists to
 * prevent.
 */
export function deliveryTier(resolutions: readonly string[]): string | undefined {
  const rank = (value: string): number => {
    const lines = /^(\d{3,4})\s*[ip]?$/i.exec(value)
    if (lines) return Number(lines[1])
    return /4k|2160/i.test(value) ? 2160 : Number.NaN
  }
  const tiers = resolutions.map(value => ({ value, lines: rank(value) })).filter(tier => Number.isFinite(tier.lines))
  if (tiers.length === 0) return undefined
  const preferred = tiers.find(tier => tier.lines === 1080)
  if (preferred) return preferred.value
  const belowFourK = tiers.filter(tier => tier.lines < 2160)
  const pool = belowFourK.length > 0 ? belowFourK : tiers
  return pool.reduce((best, tier) => (tier.lines > best.lines ? tier : best)).value
}

function promptOf(request: ProviderRequest): string {
  return typeof request.input.prompt === 'string' ? request.input.prompt : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function label(candidate: RunTaskCandidate): string {
  return `${candidate.provider}/${candidate.model}`
}
