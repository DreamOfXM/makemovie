import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { Prisma, syncBatchStatus } from '@studio/db'
import { DURATION_KEY, capDurationSpec, classifyFailure, durationSecondsOf, isContentLocale, isTerminalFailure, pinDuration, readDurationEvidence, readDurationSpec } from '@studio/domain'
import type { RunTaskCandidate, RunTaskPayload } from '@studio/jobs'
import { buildObjectKey, concatVideoClips, extensionFor, extractEndFrame, type MediaMeta, probeMediaMeta, REFERENCE_IMAGE_MAX_BYTES_10MB, synthesizeMockMedia, toDataUrl, toReferenceImage } from '@studio/media'
import {
  advancePipeline,
  classifyQcFailure,
  recordJobIntent,
  buildStoryboardPrompt,
  mergeStoryboardReplies,
  planStoryboardSegments,
  recordAssetVersion,
  targetShotDurationPlan,
} from '@studio/pipeline'
import { createAdapter, type MediaReference, type ModelCapability as ProviderCapability, type PollResult, type ProviderAdapter, type ProviderRequest } from '@studio/providers'
import { decryptSecret } from '@studio/security'
import { ContentRejectedError, recordGeneratedContent } from './content.js'
import type { PipelineDeps } from './deps.js'
import { taskLog, type LogAnchor } from './execution-log.js'
import { errorMessage, pollToSettled, toCapability, type SettledResult } from './provider-call.js'
import { HashQualityChecker, QC_THRESHOLD, type QcVerdict, type ShotIntent } from './qc.js'
import { buildReviewSnapshot, decideRetry } from './retry-policy.js'
import { runCharacterVoice } from './voice.js'

export type TaskRow = Prisma.GenerationTaskGetPayload<{ include: { batch: { include: { episode: { include: { project: true } } } } } }>

type CandidateOutcome =
  | { status: 'paused' }
  | { status: 'succeeded' }
  | { status: 'rework' }
  | { status: 'exhausted' }
  | { status: 'next'; error: string; retryClass?: 'creative' }
  | { status: 'blocked'; error: string }
  | { status: 'fenced' }

export interface Material {
  bytes: Uint8Array
  mimeType: string
  width?: number
  height?: number
  durationMs?: number
}

const MOCK_DURATION_MS = 1_000

// ffmpeg chooses the container from the output file extension, so the temp name has to
// match the modality before synthesizeMockMedia can tell us the real mime type.
const MOCK_EXTENSION: Record<string, string> = { image: 'png', t2v: 'mp4', i2v: 'mp4', r2v: 'mp4', tts: 'wav', music: 'wav', sfx: 'wav' }

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

/** V01 租约兜底:领取者最长活过一轮轮询超时后仍算失联——再短会把慢消费者误判死。 */
const LEASE_GRACE_MS = 120_000

/** V01:任务领取的 fencing token 载体——终态写回都以「租约仍是我的」为前提。 */
interface TaskLease {
  token: string
}

/**
 * V01 原子领取:同一任务的并发投递只有一个消费者能抢到。QUEUED 直接抢;
 * RUNNING 只在租约过期(上一个消费者失联)后可接管;BLOCKED 只有「已受理待查询」
 * (台账里有 providerTaskId 且未落定)才可重投续查——提交未知(无 providerTaskId)
 * 是持久终止态,重投必须先人工裁决。
 */
async function claimGenerationTask(
  db: PipelineDeps['db'],
  taskId: string,
  attempt: number,
  leaseMs: number,
): Promise<{ owned: true; lease: TaskLease } | { owned: false }> {
  const now = new Date()
  const token = randomUUID()
  const claim = await db.generationTask.updateMany({
    where: {
      id: taskId,
      // US-035 暂停 Run:暂停的批次不再派发新消费者——QUEUED 保持排队,租约过期
      // 的 RUNNING 与待查询的 BLOCKED 也等恢复后再接管。已受理的上游调用不掐:
      // 钱已花,结果照常落定结算。
      batch: { paused: false },
      OR: [
        { status: 'QUEUED' },
        { status: 'RUNNING', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        { status: 'BLOCKED', claimToken: null },
      ],
    },
    data: { status: 'RUNNING', attempts: attempt, claimToken: token, leaseUntil: new Date(now.getTime() + leaseMs) },
  })
  return claim.count === 1 ? { owned: true, lease: { token } } : { owned: false }
}

/**
 * V01 续查凭据:台账里已受理(providerTaskId 在手)且尚未落定的提交——重投/接管
 * 的消费者续查它,而不是再提交一次。已落定(succeeded/failed)的行不复查:
 * 成功的工作要么已写回任务,要么已被质检判过,复查只会重放旧结果。
 *
 * 唯一的例外是 `settled/unjudged` 且产物已落盘:那笔钱已经花过、图已经在存储里,
 * 缺的只是审核这一环。重试它等于重审同一份产物,不是第二次提交——不让它进续查,
 * 重试就会撞上自己的台账并永久 BLOCKED(SD-036)。
 */
async function resumableAttempt(db: PipelineDeps['db'], taskId: string, attempt: number) {
  return db.submissionAttempt.findFirst({
    where: {
      taskId,
      attemptNumber: attempt,
      providerTaskId: { not: null },
      OR: [
        { status: { in: ['accepted', 'running', 'result_ready'] } },
        { status: 'settled', resolution: 'succeeded' },
        { status: 'settled', resolution: 'unjudged', artifactId: { not: null } },
      ],
    },
    orderBy: { id: 'desc' },
  }).catch(() => null)
}

/** updateMany 的 data 入参类型(按 id+claimToken 条件写终态用)。 */
type TaskUpdateData = Prisma.GenerationTaskUncheckedUpdateManyInput

/**
 * V01 fenced 写回:只有仍持有租约的消费者才能写终态。count=0 说明租约易主——
 * 本消费者的结果作废(不写任务行、不接力),避免旧消费者覆盖新消费者的结论。
 */
async function fencedTaskWrite(db: PipelineDeps['db'], taskId: string, token: string, data: TaskUpdateData, apply?: (tx: Prisma.TransactionClient) => Promise<void>): Promise<boolean> {
  // 成功写回必须清掉上一次失败留下的 errorSnapshot:任务列表把该列当“当前错误”展示,
  // 不清就会出现批次已完成、任务已成功、错误栏还红着上次的原始堆栈 (SD-012)。
  const patch: TaskUpdateData = data.status === 'SUCCEEDED' && data.errorSnapshot === undefined
    ? { ...data, errorSnapshot: null }
    : data
  if (apply) return db.$transaction(async tx => {
    const written = await tx.generationTask.updateMany({ where: { id: taskId, claimToken: token }, data: { ...patch, claimToken: null, leaseUntil: null } })
    if (written.count !== 1) return false
    await apply(tx)
    return true
  }, { timeout: 30_000 })
  const written = await db.generationTask.updateMany({ where: { id: taskId, claimToken: token }, data: { ...patch, claimToken: null, leaseUntil: null } }).catch(() => ({ count: 0 }))
  return written.count === 1
}

/** Linearization point for a new paid submission; accepted work only resumes polling. */
async function guardNewSubmission(task: TaskRow, lease: TaskLease, deps: PipelineDeps): Promise<{ status: 'paused' | 'fenced' } | null> {
  const now = new Date()
  const reserved = await deps.db.generationTask.updateMany({
    where: { id: task.id, claimToken: lease.token, leaseUntil: { gt: now }, batch: { paused: false } },
    data: { leaseUntil: new Date(now.getTime() + deps.pollTimeoutMs + LEASE_GRACE_MS) },
  })
  if (reserved.count === 1) return null
  const batch = await deps.db.generationBatch.findUnique({ where: { id: task.batchId }, select: { paused: true } })
  return { status: batch?.paused ? 'paused' : 'fenced' }
}

/**
 * §17/US-035 迟到结果:成功写回被 fencing 拒绝时,本结果已是"迟到者"。若任务已被
 * 更新的 attempt 接管完成,或已被人工改判完成,本次成功只作候选——把本次 attempt
 * 的台账行 resolution 标 'late_result' 留证,绝不覆盖既有结论(产物行照留,版本
 * 天然可作候选)。没有更新 attempt 且任务未完成时,维持原 fenced 语义:结果作废,
 * 等接管者续走。
 */
async function markLateResult(
  db: PipelineDeps['db'],
  taskId: string,
  attemptNumber: number,
): Promise<boolean> {
  const [newer, task] = await Promise.all([
    db.submissionAttempt.findFirst({ where: { taskId, attemptNumber: { gt: attemptNumber } }, select: { id: true } }).catch(() => null),
    db.generationTask.findUnique({ where: { id: taskId }, select: { status: true } }).catch(() => null),
  ])
  if (!newer && task?.status !== 'SUCCEEDED') return false
  await db.submissionAttempt
    .updateMany({ where: { taskId, attemptNumber, resolution: 'succeeded' }, data: { resolution: 'late_result' } })
    .catch(() => ({ count: 0 as number }))
  return true
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

/**
 * UX-P01（2026-10-19 实测 UX-04 根因二）：显式重试的提交身份修复。撞键重试路径把
 * FAILED 任务行 attempts 归零后按 attempt 1 重新入队，而上一轮真实烧过的
 * SubmissionAttempt 台账还占着 (taskId, 1, slot)——候选循环会把新绑定的模型当成
 * 「已终局失败的旧提交」整排跳过（"previous candidate already failed"），改绑后的
 * 模型永远没有执行机会。
 *
 * 识别形态：入队 attempt 比领取前任务行记录的 attempts 新（只有重试重置会产生这种
 * 落差；崩溃重放/陈旧投递的 attempt 与任务行相等），且该 attempt 空间的台账已全部
 * 终局落败（settled failed/content_rejected）。命中时按既有 qc 重抽的同一契约换基到
 * 全新 attempt：释放租约、同事务登记新投递意图（新 jobId `run-<taskId>-<N>`、新
 * SubmissionAttempt 空间），旧失败提交不再拦截新候选。
 *
 * 安全边界：能复查的提交（受理号在手、尚未落定）永远不进这条路——交给下面的 resume
 * 分支续查，绝不另开一次付费提交。
 *
 * 「未知提交」按报文分两类（2026-10-23 第 1 集 16 个镜头卡死实测）：
 * `insufficient_user_quota | 预扣费额度失败` 这类是供应商同步回业务码、明确没接单，
 * 钱一分没扣，只是当年分类器认不出来才落成 submission_unknown。它和 settled failed
 * 同属「这一槽位已死」，不放行就等于把这 16 个镜头永久判死——BLOCKED 任务没有审核
 * 快照，问询重抽/豁免端点（只 CAS status=FAILED）根本够不到它，界面上唯一的按钮每点
 * 一次撞一次槽位。断线、超时、空报文（分类 unknown/network）仍是未知提交：不进这条路，
 * 保持「人工查单」唯一出口。
 */
async function rebaseExplicitRetryOntoFreshAttempt(
  db: PipelineDeps['db'],
  task: TaskRow,
  payload: RunTaskPayload,
  attemptsAtRead: number,
  lease: TaskLease,
  enqueueJob: PipelineDeps['enqueueJob'],
  anchor: LogAnchor,
): Promise<'rebased' | 'fenced' | null> {
  if (attemptsAtRead >= payload.attempt) return null
  const ledger = await db.submissionAttempt.findMany({
    where: { taskId: task.id, attemptNumber: payload.attempt },
    select: { status: true, resolution: true, providerTaskId: true, errorSnapshot: true },
  })
  if (ledger.length === 0) return null
  const allDead = ledger.every(row =>
    (row.status === 'settled' && (row.resolution === 'failed' || row.resolution === 'content_rejected'))
    || (!row.providerTaskId && isTerminalFailure(classifyFailure(row.errorSnapshot))),
  )
  if (!allDead) return null
  const highest = await db.submissionAttempt.aggregate({ where: { taskId: task.id }, _max: { attemptNumber: true } })
  const nextAttempt = (highest._max.attemptNumber ?? payload.attempt) + 1
  const released = await fencedTaskWrite(
    db,
    task.id,
    lease.token,
    { status: 'QUEUED' },
    async tx => { await recordJobIntent(tx, { ...payload, attempt: nextAttempt }) },
  )
  // 租约易主：本次投递作废（接管者自会继续），不换基、不重复入队。
  if (!released) return 'fenced'
  await taskLog(db, anchor, 'info', 'task.retryRebased', `explicit retry arrived as attempt ${payload.attempt} whose submission ledger is already dead (settled failed, or rejected without an acceptance handle) — rebased to attempt ${nextAttempt} (fresh jobId and ledger space) so the current bindings actually run`, { from: payload.attempt, to: nextAttempt })
  await enqueueJob({ ...payload, attempt: nextAttempt })
  return 'rebased'
}

/**
 * 质检判回后的唯一处置口：失败分档（技术/一致性/创作性）、每镜上限、每集额度
 * 都在 decideRetry 里算，这里只负责把「自动重抽」或「停下并问」写进任务行。
 * 单产物与分段分镜两条质检链共用这一份，禁止各写一套阈值判断。
 */
async function settleQcRework(args: {
  deps: PipelineDeps
  task: TaskRow
  payload: RunTaskPayload
  lease: TaskLease
  anchor: LogAnchor
  candidate: RunTaskCandidate
  verdict: Extract<QcVerdict, { decision: 'rework' }>
  artifactId: string | null
  segment?: number
}): Promise<{ status: 'rework' } | { status: 'exhausted' } | { status: 'fenced' }> {
  const { deps, task, payload, lease, anchor, verdict } = args
  const retryClass = classifyQcFailure(verdict.findings ?? [])
  const decision = await decideRetry({
    db: deps.db,
    episodeId: task.batch.episode.id,
    project: task.batch.episode.project,
    retryClass,
    attempt: payload.attempt,
    budgetApplies: task.storyboardId !== null,
  })
  const where = args.segment ? ` on segment ${args.segment}` : ''
  if (decision.askReason !== null) {
    const snapshot = buildReviewSnapshot({
      decision,
      kind: verdict.kind,
      reasons: verdict.reasons,
      findings: verdict.findings ?? [],
      score: verdict.score,
      attempt: payload.attempt,
      candidates: payload.candidates,
      artifactId: args.artifactId,
      error: `${verdict.kind}: threshold not met${where}`,
    })
    await taskLog(
      deps.db,
      anchor,
      'warn',
      'qc.ask',
      `quality threshold not met (score ${verdict.score})${where} — stopped to ask (${decision.askReason}; ${retryClass} ${decision.policy}, ${decision.retriesUsed}/${decision.cap} retries, budget ${decision.budgetUsed}/${decision.budgetLimit ?? 'n/a'})`,
      { reasons: verdict.reasons, retryClass, askReason: decision.askReason },
    )
    const written = await fencedTaskWrite(deps.db, task.id, lease.token, {
      status: 'FAILED',
      errorSnapshot: `${verdict.kind}: threshold not met${where} — awaiting review (${decision.askReason})`,
      reviewSnapshot: JSON.stringify(snapshot),
      provider: args.candidate.provider,
      model: args.candidate.model,
    })
    return written ? { status: 'exhausted' } : { status: 'fenced' }
  }
  const nextAttempt = payload.attempt + 1
  await taskLog(
    deps.db,
    anchor,
    'warn',
    'qc.rework',
    `quality threshold not met (score ${verdict.score})${where} — retrying (attempt ${decision.retriesUsed + 1}/${decision.cap}, ${retryClass} ${decision.policy}; budget ${decision.budgetUsed}/${decision.budgetLimit ?? 'n/a'})`,
    { reasons: verdict.reasons, retryClass },
  )
  // V01:重排前释放租约——下一 attempt 的领取不能再被本消费者的租约挡住。
  const released = await fencedTaskWrite(deps.db, task.id, lease.token, { status: 'QUEUED' }, async tx => { await recordJobIntent(tx, { ...payload, attempt: nextAttempt }) })
  if (!released) return { status: 'fenced' }
  await deps.enqueueJob({ ...payload, attempt: nextAttempt })
  return { status: 'rework' }
}

export async function runTask(payload: RunTaskPayload, deps: PipelineDeps): Promise<'paused' | void> {
  const task = await deps.db.generationTask.findUnique({
    where: { id: payload.taskId },
    // assets：素材任务的版本作用域要按「任务↔素材」多对多圈全集（见 nextArtifactVersion）。
    include: { batch: { include: { episode: { include: { project: true } } } }, assets: { select: { id: true } } },
  })
  if (!task) throw new Error(`generation task ${payload.taskId} not found`)
  if (task.status === 'CANCELLED') return
  // P7 守卫拦下的任务从不排队;万一有陈旧作业撞上,也绝不代烧——fail-closed。
  // 提交未知的 BLOCKED 同理是持久终止态(见 claimGenerationTask);已受理待查询的
  // BLOCKED 由下面的领取分支放行续查。
  if (task.status === 'SUCCEEDED') return
  if (task.status === 'BLOCKED') {
    const resumable = await resumableAttempt(deps.db, task.id, payload.attempt)
    if (!resumable) return
  }

  // V01 原子领取:查后无条件写 RUNNING 的旧路径让两条投递各烧一次钱——现在
  // 抢不到租约的重投直接退出,上游 submit 恰好一次(并发)或零次(顺序重投)。
  const leaseMs = deps.pollTimeoutMs + LEASE_GRACE_MS
  const claim = await claimGenerationTask(deps.db, task.id, payload.attempt, leaseMs)
  if (!claim.owned) {
    const batch = await deps.db.generationBatch.findUnique({ where: { id: task.batchId }, select: { paused: true } })
    if (batch?.paused) return 'paused'
    return
  }
  const lease = claim.lease
  await syncBatchStatus(deps.db, task.batchId)
  const owned = async (data: TaskUpdateData) => fencedTaskWrite(deps.db, task.id, lease.token, data)

  const anchor = { organizationId: task.organizationId, taskId: task.id, batchId: task.batchId, episodeId: task.batch.episode.id, stage: task.stage }
  // 显式重试落在已被旧失败提交占满的 attempt 空间上时，先换基到新 attempt 再开跑；
  // task.start 只留给真正执行的那次投递。
  const rebased = await rebaseExplicitRetryOntoFreshAttempt(deps.db, task, payload, task.attempts, lease, deps.enqueueJob, anchor)
  if (rebased === 'rebased' || rebased === 'fenced') return
  await taskLog(deps.db, anchor, 'info', 'task.start', `attempt ${payload.attempt} with ${payload.candidates.length} candidate(s): ${payload.candidates.map(label).join(' → ') || 'none'}`, { attempt: payload.attempt, candidates: payload.candidates.map(label) })

  const errors: string[] = []
  // Which candidates actually got their turn before the task failed. Only success used to
  // stamp provider/model, so a failed task showed "—" in the console and the reader could
  // not tell which model burned out without expanding the error. The chain joins every
  // model tried, because a fallback that also failed is exactly what the reader needs
  // to see before rebinding the slot.
  const tried: RunTaskCandidate[] = []
  // 候选链里只要有一抽是「模型回了话但内容不合契约」，整条链就按创作性失败处置：
  // 默认先问，不再拿同一条提示词自动连买两抽。
  let contentRejected = false
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

  // V01 accepted resume-on-restart: if the previous consumer has already obtained a providerTaskId (accepted/running)
  // and then went offline, the new consumer resumes polling that upstream task — re-submission is duplicate billing.
  // This step comes before the candidate loop, and the resume candidate comes entirely from the ledger's recorded identity,
  // unrelated to the candidate list in the current payload.
  const resumeRow = await resumableAttempt(deps.db, task.id, payload.attempt)
  if (resumeRow?.providerTaskId && resumeRow.connectionId && resumeRow.capabilityId && resumeRow.provider && resumeRow.model) {
    const resumeCandidate: RunTaskCandidate = {
      provider: resumeRow.provider,
      model: resumeRow.model,
      connectionId: resumeRow.connectionId,
      capabilityId: resumeRow.capabilityId,
    }
    await taskLog(
      deps.db,
      anchor,
      'info',
      'task.resume',
      resumeRow.artifactId
        ? `re-auditing the stored artifact of provider task ${resumeRow.providerTaskId} (${resumeCandidate.provider}/${resumeCandidate.model}) — no new provider submission`
        : `resuming poll of provider task ${resumeRow.providerTaskId} (${resumeCandidate.provider}/${resumeCandidate.model}) instead of re-submitting`,
    )
    let resumeOutcome: CandidateOutcome
    try {
      resumeOutcome = await runCandidate(task, resumeCandidate, payload, deps, referenceLog, errors, anchor, lease, {
        providerTaskId: resumeRow.providerTaskId,
        attemptRowId: resumeRow.id,
        promptChars: resumeRow.promptChars,
        resultSnapshot: resumeRow.resultSnapshot,
        artifactId: resumeRow.artifactId,
      })
    } catch (error) {
      resumeOutcome = { status: 'next', error: `${label(resumeCandidate)}: resume failed: ${errorMessage(error)}` }
    }
    if (resumeOutcome.status === 'paused') {
      await owned({ status: 'QUEUED' })
      return 'paused'
    }
    if (resumeOutcome.status === 'blocked') {
      await owned({ status: 'BLOCKED', errorSnapshot: resumeOutcome.error })
      await taskLog(deps.db, anchor, 'error', 'task.blocked', resumeOutcome.error)
      // 批次状态由任务汇总而来:漏掉这次刷新,界面会一直显示运行中且无法重试。
      await syncBatchStatus(deps.db, task.batchId)
      return
    }
    if (resumeOutcome.status === 'next') {
      await taskLog(deps.db, anchor, 'warn', 'candidate.skip', `resumed provider task settled as failed — falling through to candidates: ${resumeOutcome.error}`)
    } else {
      // succeeded/rework/exhausted/fenced have all been wrapped up — same as inside the loop.
      if (resumeOutcome.status === 'fenced') {
        await markLateResult(deps.db, task.id, payload.attempt)
        return
      }
      // rework（任务已重排）与 exhausted（任务已 FAILED 或停在问）同样要刷新批次
      // 状态；只有 succeeded 才配写成功日志并接力下一阶段。
      const status = await syncBatchStatus(deps.db, task.batchId)
      if (resumeOutcome.status === 'succeeded') {
        await taskLog(deps.db, anchor, 'info', 'task.success', `completed via resumed provider task (${label(resumeCandidate)})`)
        if (status === 'COMPLETED') await autoAdvance(deps, task)
      }
      return
    }
  } else if (resumeRow?.providerTaskId) {
    // The ledger has a providerTaskId but lacks resume identity (old-format row): cannot rebuild adapter,
    // and resubmitting would be double billing — fail-closed, manual verification.
    const message = `submission ledger row ${resumeRow.id} has provider task ${resumeRow.providerTaskId} but no recorded connection/capability identity — manual verification required before any retry`
    await owned({ status: 'BLOCKED', errorSnapshot: message })
    await taskLog(deps.db, anchor, 'error', 'task.blocked', message)
    await syncBatchStatus(deps.db, task.batchId)
    return
  }

  for (const [slot, candidate] of payload.candidates.entries()) {
    let outcome: CandidateOutcome
    await taskLog(deps.db, anchor, 'info', 'candidate.start', `trying ${label(candidate)}`)
    try {
      outcome = await runCandidate(task, candidate, payload, deps, referenceLog, errors, anchor, lease, undefined, slot)
    } catch (error) {
      outcome = { status: 'next', error: `${label(candidate)}: ${errorMessage(error)}` }
    }
    if (outcome.status === 'paused') {
      await owned({ status: 'QUEUED' })
      return 'paused'
    }
    if (outcome.status === 'blocked') {
      // submission_unknown/settle-unknown: stop all candidates — the upstream may have accepted the job,
      // any subsequent submission could result in duplicate billing. The fenced write prevents an old consumer with an expired lease from overwriting.
      await owned({ status: 'BLOCKED', errorSnapshot: outcome.error })
      await taskLog(deps.db, anchor, 'error', 'task.blocked', outcome.error)
      await syncBatchStatus(deps.db, task.batchId)
      return
    }
    if (outcome.status === 'fenced') {
      // Lease ownership changed: our results are void, another consumer is continuing the same task.
      await markLateResult(deps.db, task.id, payload.attempt)
      return
    }
    if (outcome.status === 'next') {
      errors.push(outcome.error)
      if (outcome.retryClass === 'creative') contentRejected = true
      tried.push(candidate)
      await taskLog(deps.db, anchor, 'warn', 'candidate.skip', outcome.error)
      continue
    }
    // rework/exhausted 已在 runCandidate 里写了自己的终态：批次要刷新，但绝不能
    // 记成成功，也不能接力下一阶段（分镜被打回时继续跑首帧就是拿废稿烧钱）。
    const status = await syncBatchStatus(deps.db, task.batchId)
    if (outcome.status === 'succeeded') {
      await taskLog(deps.db, anchor, 'info', 'task.success', `completed via ${label(candidate)}`)
      if (status === 'COMPLETED') await autoAdvance(deps, task)
    }
    return
  }

  const triedLabel = tried.length > 0 ? { provider: tried[0].provider, model: tried.map(candidate => candidate.model).join(' → ') } : {}
  // 有候选真正跑过才谈得上重抽：候选链为空是绑定配置问题，再排一次也只会原地失败。
  if (tried.length > 0) {
    const retryClass = contentRejected ? 'creative' : 'technical'
    const decision = await decideRetry({
      db: deps.db,
      episodeId: task.batch.episode.id,
      project: task.batch.episode.project,
      retryClass,
      attempt: payload.attempt,
      budgetApplies: task.storyboardId !== null,
    })
    if (decision.askReason === null) {
      const nextAttempt = payload.attempt + 1
      await taskLog(deps.db, anchor, 'warn', 'task.retry', `all ${tried.length} candidate(s) failed — auto-retrying (attempt ${decision.retriesUsed + 1}/${decision.cap}, ${retryClass} ${decision.policy}; budget ${decision.budgetUsed}/${decision.budgetLimit ?? 'n/a'})`, { errors })
      const released = await fencedTaskWrite(deps.db, task.id, lease.token, { status: 'QUEUED' }, async tx => { await recordJobIntent(tx, { ...payload, attempt: nextAttempt }) })
      if (!released) {
        await markLateResult(deps.db, task.id, payload.attempt)
        return
      }
      await deps.enqueueJob({ ...payload, attempt: nextAttempt })
      return
    }
    const snapshot = buildReviewSnapshot({
      decision,
      kind: contentRejected ? 'content-rejected' : 'provider-exhausted',
      reasons: errors,
      score: null,
      attempt: payload.attempt,
      candidates: payload.candidates,
      artifactId: null,
      error: `all ${tried.length} candidate(s) failed`,
    })
    await taskLog(deps.db, anchor, 'error', 'task.fail', `all ${tried.length} candidate(s) failed — stopped to ask (${decision.askReason})`, { errors })
    await owned({
      status: 'FAILED',
      errorSnapshot: JSON.stringify(errors.length > 0 ? errors : ['no candidates supplied']),
      reviewSnapshot: JSON.stringify(snapshot),
      ...triedLabel,
    })
    await syncBatchStatus(deps.db, task.batchId)
    return
  }

  await owned({
    status: 'FAILED',
    errorSnapshot: JSON.stringify(['no candidates supplied']),
  })
  await taskLog(deps.db, anchor, 'error', 'task.fail', 'no candidates supplied — nothing to retry', { errors })
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

/** V01:续查凭据——跳过提交,直接轮询台账里的上游任务。 */
interface ResumeRef {
  providerTaskId: string
  attemptRowId: string
  promptChars: number | null
  resultSnapshot?: string | null
  artifactId?: string | null
}

async function runCandidate(
  task: TaskRow,
  candidate: RunTaskCandidate,
  payload: RunTaskPayload,
  deps: PipelineDeps,
  referenceLog: ReferenceRecord[],
  errors: string[],
  anchor: LogAnchor,
  lease: TaskLease,
  resume?: ResumeRef,
  slot = 0,
): Promise<CandidateOutcome> {
  // 拼接段的台账槽位是「段号×100+候选序号」。续查路径不进 runCandidate，但重投
  // 时会带着不带 slot 的候选重跑，这里按候选在快照里的位置现算一次，保证重投落回
  // 同一格（同一候选不会因调用方没给 slot 就另开一行重复计费）。
  const candidateSlot = slot || Math.max(0, payload.candidates.findIndex(entry => entry.connectionId === candidate.connectionId && entry.capabilityId === candidate.capabilityId))
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
  const billed = pinBilledParameters(request, capability, capabilityRow.spec, payload.attempt, capabilityRow.durationEvidence)
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
    request.input.media = [{ type: 'first_frame', url: frame.publicUrl ?? frame.dataUrl }]
    await taskLog(deps.db, anchor, 'info', 'video.frameReference', `first frame handed to ${candidate.model} as ${frame.publicUrl ? 'the vendor-hosted public URL' : 'inline base64'}`, { via: frame.publicUrl ? 'public-url' : 'base64' })
    reference = frame
  }
  // 帧已经带上时,t2v 候选没有画面槽:跑它只会产出与首帧无关的"成功"片段——
  // 用户拿到的是一段冒名顶替的幻觉,不是成果。这里直接跳过该候选,错误链写明
  // "带首帧的任务需要图生视频模型",让失败原因(通常是 i2v 额度耗尽)直达用户。
  if (frame?.conditioned && capability.modality === 't2v') {
    return { status: 'next', error: `${label(candidate)}: skipped — the task carries an approved first frame, which a text-to-video model cannot honor (bind or fund an image-to-video model)` }
  }
  // r2v 的硬前提是 ≥1 张定妆照参考图(adapter 会直接拒);计划层已按镜头筛过,
  // 这里是同一条规则在执行侧的兜底——比如人工把无绑定素材的镜头塞进了重试。
  if (capability.modality === 'r2v' && readFrameReferences(task.requestSnapshot, 'reference_image').length === 0) {
    return { status: 'next', error: `${label(candidate)}: skipped — reference-to-video needs the shot's approved asset sheets; this shot has none` }
  }
  // 首帧的定妆照同理不能静默降级:不吃参考图的出图模型跑带参考图的任务,产出的是
  // 一张没有任何锚点的陌生脸,却照样计费、照样 SUCCEEDED、照样过审(2026-10-21
  // SD-066 实测)。计划层已拦新任务,这里兜住绑定改动后被回放的旧任务。
  if (task.stage === 'FIRST_FRAME' && !capability.acceptsReferenceImages && readFrameReferences(task.requestSnapshot, 'reference_image').length > 0) {
    return { status: 'next', error: `${label(candidate)}: skipped — the shot carries approved asset sheets, which this image model cannot accept (bind a model that takes reference images to the first-frame slot)` }
  }
  // 定妆照参考图:首帧任务带上镜头绑定素材的已定稿图,让声明接受参考图的图像模型
  // (qwen-image-3.0 / 2.0-pro 一代)画出同一批人;视频侧 r2v/i2v 同吃这批图——主体一致
  // 的锚就是这批定妆照(可灵主体库同路)。首帧不吃参考图的候选已在上面跳过;
  // 视频侧仍可凭文字与首帧成片,降级原因记进 responseSnapshot.reference 供排查。
  if (capability.modality === 'image' || capability.modality === 'i2v' || capability.modality === 'r2v') {
    const sheets = await resolveAssetReferences(task, capability, capabilityRow.spec, deps, referenceLog)
    if (sheets) request.input.media = [...(Array.isArray(request.input.media) ? request.input.media : []), ...sheets]
  }
  const apiKey = decryptSecret(connection.encryptedSecret, deps.masterKey)
  const accessKey = connection.accessKeyEncrypted ? decryptSecret(connection.accessKeyEncrypted, deps.masterKey) : undefined
  const adapter = createAdapter(connection.provider, { apiKey, accessKey, baseUrl: connection.baseUrl })

  // 4b 分段分镜:长剧本(或按目标时长估算的镜头数)超阈值时不整篇塞一个请求——
  // 那是今天的隐性截断。执行时按剧本的场景标记切块、逐段重建 prompt 调用,拼接
  // 后全局重编号写回同一 revision。阈值内返回 null,下面的单次调用路径原样保留。
  if (task.stage === 'STORYBOARD') {
    const segmentRequests = await storyboardSegmentRequests(task, request, deps)
    if (segmentRequests) return runSegmentedStoryboard(task, candidate, capability, adapter, segmentRequests, payload, deps, errors, anchor, lease)
  }

  // 4c 同镜拼接:镜头意图超过单次能力时,快照里带着已批准的连续段。每段单独下单,
  // 第 2 段起用上一段抽出的末帧当条件帧——这条链只有图生视频模型能接。
  const videoTakes = task.stage === 'VIDEO' ? readVideoTakePlan(task.requestSnapshot) : null
  if (videoTakes) {
    if (capability.modality !== 'i2v') {
      return { status: 'next', error: `${label(candidate)}: skipped — a spliced shot conditions each take on the previous take's end frame, which only an image-to-video model can do` }
    }
    return runSplicedVideo(task, candidate, capability, capabilityRow, adapter, request, videoTakes, payload, deps, errors, anchor, lease, referenceLog, candidateSlot, reference)
  }

  // V01 续查:跳过提交与请求组装,直接轮询台账里的上游任务。
  let submitted: { taskId: string }
  let attempt: { id: string }
  let promptChars: number
  if (resume) {
    submitted = { taskId: resume.providerTaskId }
    attempt = { id: resume.attemptRowId }
    promptChars = resume.promptChars ?? promptOf(request).length
  } else {
    const prior = await deps.db.submissionAttempt.findUnique({ where: { taskId_attemptNumber_slot: { taskId: task.id, attemptNumber: payload.attempt, slot } } })
    if (prior?.status === 'settled' && ['failed', 'content_rejected'].includes(prior.resolution ?? '')) return { status: 'next', error: 'previous candidate already failed' }
    const submissionGuard = await guardNewSubmission(task, lease, deps)
    if (submissionGuard) return submissionGuard
    // US-035/V01:逐次提交留痕,留痕失败禁止无记录提交——没有台账就没有恢复凭据,
    // 盲提交等于把「上游可能已接单」变成不可审计的重复计费。唯一键冲突=同槽位
    // 已有提交者(在途或失联),一律按提交未知处理,绝不覆盖重提。
    try {
      promptChars = promptOf(request).length
      attempt = await deps.db.submissionAttempt.create({
        data: {
          taskId: task.id,
          attemptNumber: payload.attempt,
          slot,
          status: 'submitting',
          provider: candidate.provider,
          model: candidate.model,
          connectionId: candidate.connectionId,
          capabilityId: candidate.capabilityId,
          promptChars,
        },
      })
    } catch (ledgerError) {
      if (isUniqueViolation(ledgerError)) {
        const existing = await deps.db.submissionAttempt.findUnique({
          where: { taskId_attemptNumber_slot: { taskId: task.id, attemptNumber: payload.attempt, slot } },
        }).catch(() => null)
        // 该槽位已由上游裁决失败:本次是崩溃后重放,直接让位下一候选,不再提交。
        if (existing?.providerTaskId && existing.status === 'settled' && existing.resolution === 'failed') {
          return { status: 'next', error: `${label(candidate)}: attempt ${payload.attempt} slot ${slot} already settled as failed upstream — moving to the next candidate without re-submitting` }
        }
        // 已有更新的尝试在跑:本次是陈旧投递,静默退出。
        const newer = await deps.db.submissionAttempt.findFirst({ where: { taskId: task.id, attemptNumber: { gt: payload.attempt } }, select: { id: true } }).catch(() => null)
        if (newer) return { status: 'fenced' }
        return {
          status: 'blocked',
          error: `${label(candidate)}: submission ledger slot (${payload.attempt}/${slot}) is already occupied — refusing to re-submit; manual verification required`,
        }
      }
      return {
        status: 'blocked',
        error: `${label(candidate)}: submission ledger unavailable (${errorMessage(ledgerError)}) — refusing to submit without an auditable attempt record`,
      }
    }
    try {
      submitted = await adapter.submit(capability, request)
      await deps.db.submissionAttempt.update({
        where: { id: attempt.id },
        data: { status: 'accepted', providerTaskId: submitted.taskId },
      }).catch(() => undefined)
    } catch (submitError) {
      const submitMessage = errorMessage(submitError)
      // 同步 4xx 是确定没接单(额度耗尽/鉴权/参数):台账记为已失败的尝试,让候选链
      // 继续降级——免费额度耗尽时下一个模型还能跑。只有真正含糊的失败(断线、超时、
      // 回包丢失)才进 submission_unknown:上游可能已接单,任何重提都可能重复计费。
      if (isTerminalFailure(classifyFailure(submitMessage))) {
        await deps.db.submissionAttempt.update({
          where: { id: attempt.id },
          data: { status: 'settled', resolution: 'failed', errorSnapshot: submitMessage },
        }).catch(() => undefined)
        return {
          status: 'next',
          error: `${label(candidate)}: provider rejected the submission before accepting it — moving to the next candidate. ${submitMessage}`,
        }
      }
      // 提交阶段崩溃/网络断:标记 submission_unknown——不自动重试(可能重复计费)。
      // R01:unknown 是持久终止态,不是可回退的失败——上游可能已接单,任何后续
      // 候选提交或 BullMQ 重投都可能重复扣费。带足来源(provider/model/attempt)
      // 供人工查单;blocked 由外层循环收尾并挡住任务重投(入口按终态去重)。
      await deps.db.submissionAttempt.update({
        where: { id: attempt.id },
        data: { status: 'submission_unknown', errorSnapshot: submitMessage },
      }).catch(() => undefined)
      return {
        status: 'blocked',
        error: `${label(candidate)}: submission unknown — the provider may have accepted task (attempt ${payload.attempt}, provider ${candidate.provider}, model ${candidate.model}); manual verification required before any retry. ${submitMessage}`,
      }
    }
  }
  // 重新审核已付费产物:台账里已落盘的 artifact 就是本次要审的对象。字节从存储
  // 读回,不再向供应商轮询或下载——重试买的是审核,不是第二次生成(SD-036)。
  const existingArtifact = resume?.artifactId
    ? await deps.db.mediaArtifact.findFirst({ where: { id: resume.artifactId, taskId: task.id, organizationId: task.organizationId } })
    : null
  const result = resume?.resultSnapshot
    ? restoreProviderResult(resume.resultSnapshot)
    : existingArtifact
      ? { status: 'completed' as const }
      : await pollToSettled(adapter, capability, submitted.taskId, {
          intervalMs: deps.pollIntervalMs,
          timeoutMs: deps.pollTimeoutMs,
        })
  if (result.status === 'timeout') {
    // V01:本地等待超时≠供应商失败——上游任务仍在跑。进 BLOCKED(待查询),台账
    // 保持 accepted:重投凭 providerTaskId 续查,人工裁决前绝不烧下一候选。
    await deps.db.submissionAttempt.update({
      where: { id: attempt.id },
      data: { status: 'accepted', errorSnapshot: result.error },
    }).catch(() => undefined)
    return {
      status: 'blocked',
      error: `${label(candidate)}: provider task ${submitted.taskId} accepted but did not settle within ${deps.pollTimeoutMs}ms — pending query, redelivery resumes polling; no fallback submit. ${result.error}`,
    }
  }
  await deps.db.submissionAttempt.update({
    where: { id: attempt.id },
    data: result.status === 'failed' ? { status: 'settled', resolution: 'failed' } : { status: 'result_ready', resultSnapshot: saveProviderResult(result) },
  }).catch(() => undefined)
  if (result.status === 'failed') return { status: 'next', error: `${label(candidate)}: ${result.error ?? 'provider reported failure'}` }

  const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-artifact-'))
  try {
    const material = existingArtifact
      ? {
          bytes: await deps.storage.read(existingArtifact.objectKey),
          mimeType: existingArtifact.mimeType,
          ...(existingArtifact.width !== null ? { width: existingArtifact.width } : {}),
          ...(existingArtifact.height !== null ? { height: existingArtifact.height } : {}),
          ...(existingArtifact.durationMs !== null ? { durationMs: existingArtifact.durationMs } : {}),
        }
      : await materialize(result, capability.modality, workdir)
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
    const stored = existingArtifact ? { key: existingArtifact.objectKey, checksum: existingArtifact.checksum, mimeType: existingArtifact.mimeType, sizeBytes: material.bytes.length } : await deps.storage.put(objectKey, material.bytes, material.mimeType)
    const artifact = existingArtifact ?? await deps.db.mediaArtifact.create({
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

    await deps.db.submissionAttempt.update({ where: { id: attempt.id }, data: { artifactId: artifact.id } })
    const checker = deps.checker ?? new HashQualityChecker(task.id, payload.attempt, deps.qcMode)
    const priorCheck = existingArtifact ? await deps.db.qualityCheck.findFirst({ where: { artifactId: artifact.id, status: 'APPROVED' }, orderBy: { id: 'desc' } }) : null
    const priorReport = priorCheck ? JSON.parse(priorCheck.report) : null
    if (existingArtifact && !priorCheck) {
      await taskLog(deps.db, anchor, 'info', 'task.reaudit', `artifact ${artifact.id} was already paid for and stored — re-running the audit on those bytes instead of generating again`, { artifactId: artifact.id })
    }
    const shotIntent = await readShotIntent(deps.db, task.storyboardId)
    const verdict = priorCheck ? { kind: priorCheck.kind as import('./qc.js').QcKind, decision: 'pass' as const, score: priorCheck.score ?? 1, findings: priorReport.findings ?? [], frameScores: priorReport.frameScores ?? [] } : await checker.check({
      taskId: task.id,
      organizationId: task.organizationId,
      projectId: task.batch.episode.project.id,
      stage: task.stage,
      modality: capability.modality,
      mimeType: material.mimeType,
      bytes: material.bytes,
      prompt: promptOf(request),
      workdir,
      durationMs: material.durationMs,
      ...(shotIntent ? { shotIntent } : {}),
      ...(reference ? { referenceDataUrl: reference.dataUrl } : {}),
    })
    if (!priorCheck) await deps.db.qualityCheck.create({
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
          ...(verdict.decision !== 'unjudged' ? { findings: verdict.findings ?? [], frameScores: verdict.frameScores ?? [] } : {}),
        }),
        artifactId: artifact.id,
      },
    })
    if (verdict.decision !== 'unjudged') {
      for (const [index, finding] of (verdict.findings ?? []).entries()) {
        await deps.db.qualityFinding.upsert({
          where: { compositionId_findingKey: { compositionId: `artifact:${artifact.id}`, findingKey: `visual:${index}` } },
          create: { ...finding, organizationId: task.organizationId, episodeId: task.batch.episodeId, compositionId: `artifact:${artifact.id}`, fingerprint: artifact.checksum, findingKey: `visual:${index}`, artifactId: artifact.id, storyboardId: task.storyboardId },
          update: {},
        })
      }
    }
    await deps.db.submissionAttempt.update({ where: { id: attempt.id }, data: { status: 'settled', resolution: verdict.decision === 'pass' ? 'succeeded' : verdict.decision } })
    const qcScore = verdict.decision === 'unjudged' ? null : verdict.score
    await taskLog(deps.db, anchor, verdict.decision === 'pass' ? 'info' : 'warn', 'qc.verdict', `${verdict.kind}: ${verdict.decision} (score ${qcScore ?? 'n/a'})`, { decision: verdict.decision, score: qcScore, reasons: verdict.decision === 'pass' ? [] : verdict.reasons })

    // An auditor that could not judge is a fault of the audit, not of the content.
    // Regenerating would pay for an artifact nobody rejected, and quietly scoring
    // it with the hash instead would pretend a judgment happened, so the task stops.
    if (verdict.decision === 'unjudged') {
      await taskLog(deps.db, anchor, 'error', 'task.fail', `${verdict.kind}: auditor could not judge — ${verdict.reasons.join('; ') || 'no verdict'}`)
      const written = await fencedTaskWrite(deps.db, task.id, lease.token, { status: 'FAILED', errorSnapshot: `${verdict.kind}: ${verdict.reasons.join('; ') || 'no verdict'}`, provider: candidate.provider, model: candidate.model })
      return written ? { status: 'exhausted' } : { status: 'fenced' }
    }

    if (verdict.decision === 'rework') {
      return settleQcRework({ deps, task, payload, lease, anchor, candidate, verdict, artifactId: artifact.id })
    }

    // Write AI-generated episode content into the domain before the task is
    // marked succeeded, so an unparseable result fails this attempt (and falls
    // through to the next candidate) rather than leaving a succeeded task with
    // nothing to show for it.
    await taskLog(deps.db, anchor, 'info', 'candidate.success', `${label(candidate)} produced ${capability.modality} artifact (QC ${verdict.decision}, score ${verdict.score ?? 'n/a'})`, { artifactId: artifact.id })

    // V01 fenced 终态:租约已易主时本结果作废,不写任务行、不接力。
    const succeeded = await fencedTaskWrite(deps.db, task.id, lease.token, {
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
        // (2026-10-21 首帧链上编辑模型被厂商拒、回落到文生图模型,没有这条记录就只能盲猜。)
        ...(errors.length > 0 ? { candidateErrors: errors } : {}),
        // The frames are reported as ids and verdicts: their bytes would turn a per-task
        // text column into a media store, and the artifact rows already hold them.
        ...(referenceLog.length > 0 ? { reference: referenceLog } : {}),
        ...(resume ? { resumedFrom: resume.providerTaskId } : {}),
      }),
    }, async tx => {
    if (task.stage === 'SCRIPT' || task.stage === 'STORYBOARD') {
      await recordGeneratedContent(tx, task, new TextDecoder().decode(material.bytes))
    }

    await tx.usageLedger.create({
      data: {
        organizationId: task.organizationId,
        taskId: task.id,
        provider: candidate.provider,
        model: candidate.model,
        modality: capability.modality,
        inputUnits: promptChars,
        outputUnits: stored.sizeBytes,
      },
    })
      await recordAssetVersion(tx as PipelineDeps['db'], task, artifact.id, promptOf(request))
    })
    if (!succeeded) {
      // V01 fenced + §17 迟到结果:租约易主后本次成功不得写回。若任务已被更新的
      // attempt 或人工改判完成,本次结果降级为 late_result 候选留证。
      const late = await markLateResult(deps.db, task.id, payload.attempt)
      if (late) {
        await taskLog(deps.db, anchor, 'warn', 'attempt.lateResult', `attempt ${payload.attempt} (${label(candidate)}) settled after the task was already completed — recorded as a late-result candidate, existing verdict untouched`, { attempt: payload.attempt, candidate: label(candidate) })
      }
      return { status: 'fenced' }
    }
    return { status: 'succeeded' }
  } catch (error) {
    if (error instanceof ContentRejectedError) {
      await deps.db.submissionAttempt.update({ where: { id: attempt.id }, data: { status: 'settled', resolution: 'content_rejected' } })
      // 模型回了话但内容不合契约（结构体检不过）：这属于创作性失败，不是链路故障。
      // 默认先问，避免拿同一条提示词自动连买两抽。
      return { status: 'next', error: error.message, retryClass: 'creative' }
    }
    return { status: 'blocked', error: `provider result is durable; local persistence needs retry: ${errorMessage(error)}` }
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

/**
 * SD-098: the audit needs the shot's own script, not just the generation prompt. Without it
 * a fade-out or an entering character that this shot was *asked* to show is scored as a
 * continuity break, and the only way out is another paid take of the same defect-free clip.
 * A shot that no longer exists simply isn't given an intent — the audit stays the old one.
 */
async function readShotIntent(db: PipelineDeps['db'], storyboardId: string | null): Promise<ShotIntent | undefined> {
  if (!storyboardId) return undefined
  const shot = await db.storyboard.findUnique({ where: { id: storyboardId }, select: { description: true, continuityOut: true } })
  return shot ?? undefined
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
  const durationPlan = await targetShotDurationPlan(deps.db, task.organizationId, episode.projectId)
  const segments = planStoryboardSegments(script.content, { targetDurationMs: episode.targetDurationMs ?? undefined, shotMs: durationPlan.maxMs })
  if (segments.length === 0) return null
  const locale = isContentLocale(episode.project.contentLocale) ? episode.project.contentLocale : 'zh'
  return segments.map(segment => ({
    ...request,
    input: {
      ...request.input,
      prompt: buildStoryboardPrompt(locale, segment.content, { ...durationPlan, totalMs: segment.targetDurationMs }, segment.shotBudget),
    },
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
  lease: TaskLease,
): Promise<CandidateOutcome> {
  const texts: string[] = []
  const artifactIds: string[] = []
  const billed: Array<{ inputUnits: number; outputUnits: number }> = []
  const checker = deps.checker ?? new HashQualityChecker(task.id, payload.attempt, deps.qcMode)
  for (const [index, segmentRequest] of requests.entries()) {
    await taskLog(deps.db, anchor, 'info', 'storyboard.segment', `segment ${index + 1}/${requests.length}`, { segment: index + 1, count: requests.length })
    // V01:分段提交与单次调用同一条台账纪律——slot=段号,提交未知/超时一律阻断,
    // 不再绕过台账裸提交(分段失败重跑同样可能重复计费)。
    const prior = await deps.db.submissionAttempt.findUnique({ where: { taskId_attemptNumber_slot: { taskId: task.id, attemptNumber: payload.attempt, slot: index + 1 } } })
    if (prior?.status === 'settled' && prior.resolution === 'succeeded' && prior.artifactId) {
      const artifact = await deps.db.mediaArtifact.findUniqueOrThrow({ where: { id: prior.artifactId } })
      const bytes = await deps.storage.read(artifact.objectKey)
      artifactIds.push(artifact.id)
      texts.push(new TextDecoder().decode(bytes))
      billed.push({ inputUnits: prior.promptChars ?? promptOf(segmentRequest).length, outputUnits: bytes.length })
      continue
    }
    let attemptId: string
    if (prior) {
      if (!prior.providerTaskId || !['accepted', 'running', 'result_ready'].includes(prior.status)) {
        return { status: 'blocked', error: `segment ${index + 1} requires manual submission reconciliation` }
      }
      attemptId = prior.id
    } else {
      const submissionGuard = await guardNewSubmission(task, lease, deps)
    if (submissionGuard) return submissionGuard
      try {
      attemptId = (await deps.db.submissionAttempt.create({
        data: {
          taskId: task.id,
          attemptNumber: payload.attempt,
          slot: index + 1,
          status: 'submitting',
          provider: candidate.provider,
          model: candidate.model,
          connectionId: candidate.connectionId,
          capabilityId: candidate.capabilityId,
          promptChars: promptOf(segmentRequest).length,
        },
      })).id
    } catch (ledgerError) {
      if (isUniqueViolation(ledgerError)) {
        const newer = await deps.db.submissionAttempt.findFirst({ where: { taskId: task.id, attemptNumber: { gt: payload.attempt } }, select: { id: true } }).catch(() => null)
        if (newer) return { status: 'fenced' }
        return { status: 'blocked', error: `${label(candidate)}: submission ledger slot (${payload.attempt}/${index + 1}) is already occupied — refusing to re-submit segment ${index + 1}` }
      }
      return { status: 'blocked', error: `${label(candidate)}: submission ledger unavailable (${errorMessage(ledgerError)}) — refusing to submit segment ${index + 1} without an auditable attempt record` }
    }
    }
    let submitted: { taskId: string }
    if (prior?.providerTaskId) {
      submitted = { taskId: prior.providerTaskId }
    } else {
      try {
        submitted = await adapter.submit(capability, segmentRequest)
        await deps.db.submissionAttempt.update({ where: { id: attemptId }, data: { status: 'accepted', providerTaskId: submitted.taskId } })
      } catch (error) {
        await deps.db.submissionAttempt.update({ where: { id: attemptId }, data: { status: 'submission_unknown', errorSnapshot: errorMessage(error) } })
        return { status: 'blocked', error: `submission unknown on segment ${index + 1}: ${errorMessage(error)}` }
      }
    }
    const result = prior?.resultSnapshot ? restoreProviderResult(prior.resultSnapshot) : await pollToSettled(adapter, capability, submitted.taskId, { intervalMs: deps.pollIntervalMs, timeoutMs: deps.pollTimeoutMs })
    if (result.status === 'timeout') {
      await deps.db.submissionAttempt.update({
        where: { id: attemptId },
        data: { status: 'accepted', errorSnapshot: result.error },
      }).catch(() => undefined)
      return {
        status: 'blocked',
        error: `${label(candidate)}: provider task ${submitted.taskId} (segment ${index + 1}) accepted but did not settle within ${deps.pollTimeoutMs}ms — pending query, no fallback submit. ${result.error}`,
      }
    }
    await deps.db.submissionAttempt.update({
      where: { id: attemptId },
      data: result.status === 'failed' ? { status: 'settled', resolution: 'failed' } : { status: 'result_ready', resultSnapshot: saveProviderResult(result) },
    }).catch(() => undefined)
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
        const written = await fencedTaskWrite(deps.db, task.id, lease.token, { status: 'FAILED', errorSnapshot: `${verdict.kind}: ${verdict.reasons.join('; ') || 'no verdict'}`, provider: candidate.provider, model: candidate.model })
        return written ? { status: 'exhausted' } : { status: 'fenced' }
      }
      if (verdict.decision === 'rework') {
        return settleQcRework({ deps, task, payload, lease, anchor, candidate, verdict, artifactId: artifact.id, segment: index + 1 })
      }
      await deps.db.submissionAttempt.update({ where: { id: attemptId }, data: { status: 'settled', resolution: 'succeeded', artifactId: artifact.id } })
      // 记账先攒着,整段任务成功才落 usage——与单次调用路径同口径:失败尝试不记账。
      billed.push({ inputUnits: promptOf(segmentRequest).length, outputUnits: stored.sizeBytes })
      texts.push(new TextDecoder().decode(material.bytes))
    } catch (error) {
      return { status: 'blocked', error: `segment ${index + 1} result is durable; retry local persistence: ${errorMessage(error)}` }
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  }

  const merged = mergeStoryboardReplies(texts)
  if (!merged) throw new ContentRejectedError('storyboard generation returned no parseable shot list')
  await taskLog(deps.db, anchor, 'info', 'candidate.success', `${label(candidate)} produced storyboard segments across ${requests.length} calls`, { artifactIds })
  const written = await fencedTaskWrite(deps.db, task.id, lease.token, {
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
  }, async tx => {
  await recordGeneratedContent(tx, task, merged)
  for (const entry of billed) {
    await tx.usageLedger.create({
      data: { organizationId: task.organizationId, taskId: task.id, provider: candidate.provider, model: candidate.model, modality: capability.modality, ...entry },
    })
  }
  })
  if (!written) {
    // 与单次调用同一条迟到结果纪律:被更新的 attempt/人工改判抢先完成后,本次
    // 分段成功只作候选,该 attempt 的台账行标 late_result。
    const late = await markLateResult(deps.db, task.id, payload.attempt)
    if (late) {
      await taskLog(deps.db, anchor, 'warn', 'attempt.lateResult', `attempt ${payload.attempt} (${label(candidate)}) storyboard segments settled after the task was already completed — recorded as a late-result candidate, existing verdict untouched`, { attempt: payload.attempt, candidate: label(candidate) })
    }
    return { status: 'fenced' }
  }
  return { status: 'succeeded' }
}

/**
 * 同镜拼接的执行计划：镜头意图超过单次能力时，pipeline 已经把它拆成连续段并随
 * 请求快照下发。缺一段就不算拼接任务——返回 null 走原来的单次调用路径。
 */
interface VideoTakePlan {
  intentMs: number
  ceilingMs: number
  perTakeMs: number
  takes: Array<{ order: number; plannedMs: number; promptDelta: string }>
}

function readVideoTakePlan(snapshot: string | null): VideoTakePlan | null {
  if (!snapshot) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(snapshot)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !isRecord(parsed.durationPlan)) return null
  const plan = parsed.durationPlan
  if (plan.strategy !== 'splice' || !Array.isArray(plan.takes) || plan.takes.length < 2) return null
  const takes: VideoTakePlan['takes'] = []
  for (const entry of plan.takes) {
    if (!isRecord(entry) || typeof entry.order !== 'number' || typeof entry.plannedMs !== 'number' || typeof entry.promptDelta !== 'string') return null
    takes.push({ order: entry.order, plannedMs: entry.plannedMs, promptDelta: entry.promptDelta })
  }
  const intentMs = typeof plan.intentMs === 'number' ? plan.intentMs : 0
  const ceilingMs = typeof plan.ceilingMs === 'number' ? plan.ceilingMs : 0
  const perTakeMs = typeof plan.perTakeMs === 'number' ? plan.perTakeMs : 0
  if (intentMs <= 0 || ceilingMs <= 0) return null
  return { intentMs, ceilingMs, perTakeMs, takes }
}

interface ShotTakeRow {
  order: number
  status: string
  videoArtifactId: string | null
  endFrameArtifactId: string | null
  firstFrameArtifactId: string | null
}

interface TakeRunResult {
  order: number
  plannedMs: number
  videoArtifactId: string
  endFrameArtifactId: string
  firstFrameArtifactId: string | null
  durationMs: number
  score: number
  kind: string
  reused: boolean
  providerTaskId?: string
}

/**
 * 同镜拼接的执行路径：一颗镜头按已批准的连续段逐段下单，第 2 段起把上一段抽出的
 * 末帧本体当条件帧，全部过审后把段拼成整镜母带写回任务。
 *
 * 与分段分镜共用同一套台账纪律：每段一个 slot（段号×100+候选序号）、提交先留痕、
 * 超时/提交未知一律阻断、已付过的段不重买。区别是段的产物必须留痕成可引用的
 * artifact（末帧要当下一条的条件帧，任务被中断后重投也靠它续链）。
 */
async function runSplicedVideo(
  task: TaskRow,
  candidate: RunTaskCandidate,
  capability: ProviderCapability,
  capabilityRow: { spec: unknown; durationEvidence: unknown },
  adapter: ProviderAdapter,
  request: ProviderRequest,
  plan: VideoTakePlan,
  payload: RunTaskPayload,
  deps: PipelineDeps,
  errors: string[],
  anchor: LogAnchor,
  lease: TaskLease,
  referenceLog: ReferenceRecord[],
  candidateSlot: number,
  // 第 1 段的条件帧就是候选入口已经解析过的那张首帧。字节已经读过、编码已经做过、
  // referenceLog 也已经落了一笔，段循环不能再解析一遍——那等于同一张图读两次、
  // 台账里出现两条一模一样的「条件成功」。
  firstFrame?: Extract<FrameOutcome, { conditioned: true }>,
): Promise<CandidateOutcome> {
  if (!task.storyboardId) {
    return { status: 'next', error: `${label(candidate)}: a spliced video task has no storyboard to store its takes against` }
  }
  const storyboardId = task.storyboardId
  const sheets = Array.isArray(request.input.media)
    ? (request.input.media as MediaReference[]).filter(reference => reference.type === 'reference_image')
    : []
  const startFrameId = readFrameReferences(task.requestSnapshot, 'first_frame')[0]?.artifactId ?? null
  if (!startFrameId) {
    return { status: 'next', error: `${label(candidate)}: take 1 of this spliced shot has no approved first frame to start from — the chain would begin on an invented frame` }
  }
  const existingRows = await deps.db.shotTake.findMany({ where: { storyboardId }, orderBy: { order: 'asc' } })
  // 显式形状断开 Prisma 载荷的推断链：下面要拿「上一段末帧」反复比较指针，
  // 任何隐式 any 都会让帧链判定在编译期失效。
  const rowByOrder = new Map<number, ShotTakeRow>(
    existingRows.map(row => [row.order, row]),
  )
  const shotIntent = await readShotIntent(deps.db, storyboardId)
  const checker = deps.checker ?? new HashQualityChecker(task.id, payload.attempt, deps.qcMode)
  const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-splice-'))
  let conditioningLogged = firstFrame !== undefined

  /** 末帧是本段的出片凭据，也是下一段的条件帧；落成可引用的 artifact 才能跨任务续链。 */
  const ensureEndFrame = async (videoFile: string, durationMs: number, takeOrder: number, videoArtifactId: string): Promise<string> => {
    const frameFile = path.join(workdir, `take-${takeOrder}-end.jpg`)
    await extractEndFrame(videoFile, frameFile, durationMs)
    const bytes = new Uint8Array(await readFile(frameFile))
    const stored = await deps.storage.put(buildObjectKey({
      tenantId: task.organizationId,
      projectId: task.batch.episode.project.id,
      episodeId: task.batch.episode.id,
      stage: 'FIRST_FRAME',
      entityId: `${task.id}-take${takeOrder}-end-${randomUUID()}`,
      version: 1,
      extension: 'jpg',
    }), bytes, 'image/jpeg')
    const artifact = await deps.db.mediaArtifact.create({
      data: {
        organizationId: task.organizationId,
        // 段产物不挂任务、不挂镜头：它是母带的中间件，不是这一镜的可选版本；
        // 归属只写在 metadata 里，供审计从母带回跳每一段。
        taskId: null,
        storyboardId: null,
        stage: 'FIRST_FRAME',
        objectKey: stored.key,
        checksum: stored.checksum,
        mimeType: stored.mimeType,
        version: 1,
        metadata: JSON.stringify({ role: 'take-end-frame', taskId: task.id, storyboardId, takeOrder, videoArtifactId }),
      },
    })
    return artifact.id
  }

  const storedEndFrame = async (artifactId: string | null | undefined): Promise<string | null> => {
    if (!artifactId) return null
    const artifact = await deps.db.mediaArtifact.findFirst({ where: { id: artifactId, organizationId: task.organizationId }, select: { id: true } })
    return artifact?.id ?? null
  }

  try {
    const files: string[] = []
    const results: TakeRunResult[] = []
    let expectedFirstFrame: string | null = startFrameId

    for (const [takeIndex, take] of plan.takes.entries()) {
      const takeRow = rowByOrder.get(take.order)
      // 已付过且过审的段不重买；但只在帧链仍然对得上时复用——上一段若重拍，这一段
      // 的首帧条件已经变了，沿用旧片就接不上。
      const reusableRow: ShotTakeRow | null = takeRow?.status === 'SUCCEEDED' && takeRow.videoArtifactId && takeRow.firstFrameArtifactId === expectedFirstFrame ? takeRow : null
      const reusable: { id: string; objectKey: string; mimeType: string; durationMs: number | null } | null = reusableRow
        ? await deps.db.mediaArtifact.findFirst({ where: { id: reusableRow.videoArtifactId!, organizationId: task.organizationId } })
        : null
      const reusableCheck: { score: number | null; kind: string } | null = reusable
        ? await deps.db.qualityCheck.findFirst({ where: { artifactId: reusable.id, status: 'APPROVED' }, orderBy: { id: 'desc' } })
        : null
      if (reusableRow && reusable && reusableCheck) {
        const bytes = await deps.storage.read(reusable.objectKey)
        const file = path.join(workdir, `take-${take.order}.${extensionFor(reusable.mimeType)}`)
        await writeFile(file, bytes)
        const durationMs: number = reusable.durationMs ?? (await probeMediaMeta(file))?.durationMs ?? take.plannedMs
        const endFrameArtifactId: string = (await storedEndFrame(reusableRow.endFrameArtifactId)) ?? await ensureEndFrame(file, durationMs, take.order, reusable.id)
        await deps.db.shotTake.updateMany({ where: { storyboardId, order: take.order }, data: { endFrameArtifactId } })
        files.push(file)
        results.push({
          order: take.order,
          plannedMs: take.plannedMs,
          videoArtifactId: reusable.id,
          endFrameArtifactId,
          firstFrameArtifactId: reusableRow.firstFrameArtifactId,
          durationMs,
          score: reusableCheck.score ?? 1,
          kind: reusableCheck.kind,
          reused: true,
        })
        expectedFirstFrame = endFrameArtifactId
        await taskLog(deps.db, anchor, 'info', 'video.takeReused', `take ${take.order}/${plan.takes.length} was already produced and audited — reused, no new submission`, { take: take.order, artifactId: reusable.id })
        continue
      }

      const requestedSeconds = Math.max(1, Math.ceil(take.plannedMs / 1000))
      const takeRequest = parseRequest(task.requestSnapshot, candidate.model)
      takeRequest.input.prompt = `${promptOf(takeRequest)}\n\n${take.promptDelta}`
      if (typeof takeRequest.parameters.seed === 'number') takeRequest.parameters.seed += take.order - 1
      takeRequest.parameters[DURATION_KEY] = requestedSeconds
      const billed = pinBilledParameters(takeRequest, capability, capabilityRow.spec, payload.attempt, capabilityRow.durationEvidence)
      const pinnedSeconds = typeof billed.duration === 'number' ? billed.duration : null
      if (pinnedSeconds !== null && pinnedSeconds < requestedSeconds) {
        return {
          status: 'next',
          error: `${label(candidate)}: this model can only buy ${pinnedSeconds}s but take ${take.order} is planned at ${requestedSeconds}s — a shortened take breaks the shot's planned length; bind a model that can do the take in one call`,
        }
      }

      const takeFrame = !expectedFirstFrame
        ? null
        : takeIndex === 0 && firstFrame
          ? firstFrame
          : await resolveFrame(task, capability, capabilityRow.spec, deps, expectedFirstFrame)
      if (expectedFirstFrame && (!takeFrame || !takeFrame.conditioned)) {
        return {
          status: 'next',
          error: `${label(candidate)}: take ${take.order} cannot be conditioned on the previous take's end frame — ${takeFrame && !takeFrame.conditioned ? takeFrame.reason : 'the frame is not stored'}`,
        }
      }
      if (takeFrame?.conditioned && !conditioningLogged) {
        referenceLog.push({ model: candidate.model, conditioned: true })
        conditioningLogged = true
      }
      takeRequest.input.media = [
        ...(takeFrame?.conditioned ? [{ type: 'first_frame' as const, url: takeFrame.publicUrl ?? takeFrame.dataUrl }] : []),
        ...sheets,
      ]
      await taskLog(deps.db, anchor, 'info', 'video.takeStart', `take ${take.order}/${plan.takes.length}: buying ${pinnedSeconds ?? 'vendor-default'}s planned at ${take.plannedMs}ms`, {
        take: take.order,
        plannedMs: take.plannedMs,
        seconds: pinnedSeconds,
        conditioned: Boolean(takeFrame?.conditioned),
        ...(Object.keys(billed).length > 0 ? { billed } : {}),
      })

      // 段号进 slot：同一候选的每一段是一条独立提交，任一段失败/超时只影响它自己。
      const slotBase = take.order * 100
      const prior = await deps.db.submissionAttempt.findFirst({
        where: { taskId: task.id, attemptNumber: payload.attempt, slot: { gte: slotBase, lt: slotBase + 100 } },
        orderBy: { id: 'desc' },
      })
      const sameIdentity = prior ? prior.connectionId === candidate.connectionId && prior.capabilityId === candidate.capabilityId : true
      const inFlight = prior !== null && prior.providerTaskId !== null && ['accepted', 'running', 'result_ready'].includes(prior.status)
      if (prior && !sameIdentity && inFlight) {
        return {
          status: 'blocked',
          error: `${label(candidate)}: take ${take.order} already has an in-flight submission on ${prior.provider}/${prior.model} — manual reconciliation required before buying it twice`,
        }
      }
      // 崩溃落在「账已结、镜头段指针还没写回」之间：产物与审核都在，直接接着用，
      // 不再提交也不再记账。
      const recovered = prior?.status === 'settled' && prior.resolution === 'succeeded' && prior.artifactId
        ? await deps.db.mediaArtifact.findFirst({ where: { id: prior.artifactId, organizationId: task.organizationId } })
        : null
      if (prior?.status === 'settled' && prior.resolution === 'succeeded' && !recovered) {
        return { status: 'blocked', error: `${label(candidate)}: take ${take.order} was settled upstream but its artifact is missing — manual verification required` }
      }
      if (prior && !recovered && !sameIdentity) {
        return { status: 'next', error: `${label(candidate)}: take ${take.order} was already attempted in this attempt — moving to the next candidate` }
      }
      if (prior && !recovered && !inFlight) {
        if (prior.status === 'submission_unknown') {
          return { status: 'blocked', error: `${label(candidate)}: take ${take.order} submission unknown — the provider may have accepted it; manual verification required before any retry` }
        }
        return { status: 'next', error: `${label(candidate)}: take ${take.order} already settled as ${prior.resolution ?? prior.status} in attempt ${payload.attempt} — not re-submitting` }
      }

      if (recovered && prior) {
        const bytes = await deps.storage.read(recovered.objectKey)
        const file = path.join(workdir, `take-${take.order}.${extensionFor(recovered.mimeType)}`)
        await writeFile(file, bytes)
        const durationMs = recovered.durationMs ?? (await probeMediaMeta(file))?.durationMs ?? take.plannedMs
        const endFrameArtifactId = (await storedEndFrame(takeRow?.endFrameArtifactId)) ?? await ensureEndFrame(file, durationMs, take.order, recovered.id)
        const check = await deps.db.qualityCheck.findFirst({ where: { artifactId: recovered.id, status: 'APPROVED' }, orderBy: { id: 'desc' } })
        await deps.db.shotTake.updateMany({
          where: { storyboardId, order: take.order },
          data: { status: 'SUCCEEDED', videoArtifactId: recovered.id, endFrameArtifactId, firstFrameArtifactId: takeFrame?.conditioned ? expectedFirstFrame : null },
        })
        files.push(file)
        results.push({
          order: take.order,
          plannedMs: take.plannedMs,
          videoArtifactId: recovered.id,
          endFrameArtifactId,
          firstFrameArtifactId: takeFrame?.conditioned ? expectedFirstFrame : null,
          durationMs,
          score: check?.score ?? 1,
          kind: check?.kind ?? 'hash',
          reused: true,
          ...(prior.providerTaskId ? { providerTaskId: prior.providerTaskId } : {}),
        })
        expectedFirstFrame = endFrameArtifactId
        await taskLog(deps.db, anchor, 'info', 'video.takeRecovered', `take ${take.order}/${plan.takes.length} settled before the previous consumer stopped — reused its stored artifact`, { take: take.order, artifactId: recovered.id })
        continue
      }

      let attemptRowId: string
      let submitted: { taskId: string }
      const promptChars = promptOf(takeRequest).length
      if (prior) {
        attemptRowId = prior.id
        submitted = { taskId: prior.providerTaskId! }
      } else {
        const submissionGuard = await guardNewSubmission(task, lease, deps)
        if (submissionGuard) return submissionGuard
        try {
          attemptRowId = (await deps.db.submissionAttempt.create({
            data: {
              taskId: task.id,
              attemptNumber: payload.attempt,
              slot: slotBase + candidateSlot,
              status: 'submitting',
              provider: candidate.provider,
              model: candidate.model,
              connectionId: candidate.connectionId,
              capabilityId: candidate.capabilityId,
              promptChars,
            },
          })).id
        } catch (ledgerError) {
          if (isUniqueViolation(ledgerError)) {
            const occupant = await deps.db.submissionAttempt.findUnique({ where: { taskId_attemptNumber_slot: { taskId: task.id, attemptNumber: payload.attempt, slot: slotBase + candidateSlot } } }).catch(() => null)
            if (occupant?.providerTaskId && occupant.status === 'settled' && occupant.resolution === 'failed') {
              return { status: 'next', error: `${label(candidate)}: take ${take.order} already settled as failed upstream — moving to the next candidate without re-submitting` }
            }
            const newer = await deps.db.submissionAttempt.findFirst({ where: { taskId: task.id, attemptNumber: { gt: payload.attempt } }, select: { id: true } }).catch(() => null)
            if (newer) return { status: 'fenced' }
            return { status: 'blocked', error: `${label(candidate)}: submission ledger slot (${payload.attempt}/${slotBase + candidateSlot}) is occupied — refusing to re-submit take ${take.order}; manual verification required` }
          }
          return { status: 'blocked', error: `${label(candidate)}: submission ledger unavailable (${errorMessage(ledgerError)}) — refusing to submit take ${take.order} without an auditable attempt record` }
        }
        try {
          submitted = await adapter.submit(capability, takeRequest)
          await deps.db.submissionAttempt.update({ where: { id: attemptRowId }, data: { status: 'accepted', providerTaskId: submitted.taskId } }).catch(() => undefined)
        } catch (submitError) {
          const submitMessage = errorMessage(submitError)
          if (isTerminalFailure(classifyFailure(submitMessage))) {
            await deps.db.submissionAttempt.update({ where: { id: attemptRowId }, data: { status: 'settled', resolution: 'failed', errorSnapshot: submitMessage } }).catch(() => undefined)
            return { status: 'next', error: `${label(candidate)}: provider rejected take ${take.order} before accepting it — moving to the next candidate. ${submitMessage}` }
          }
          await deps.db.submissionAttempt.update({ where: { id: attemptRowId }, data: { status: 'submission_unknown', errorSnapshot: submitMessage } }).catch(() => undefined)
          return { status: 'blocked', error: `${label(candidate)}: take ${take.order} submission unknown — the provider may have accepted it (attempt ${payload.attempt}, provider ${candidate.provider}, model ${candidate.model}); manual verification required before any retry. ${submitMessage}` }
        }
      }

      const result = prior?.resultSnapshot
        ? restoreProviderResult(prior.resultSnapshot)
        : await pollToSettled(adapter, capability, submitted.taskId, { intervalMs: deps.pollIntervalMs, timeoutMs: deps.pollTimeoutMs })
      if (result.status === 'timeout') {
        await deps.db.submissionAttempt.update({ where: { id: attemptRowId }, data: { status: 'accepted', errorSnapshot: result.error } }).catch(() => undefined)
        return {
          status: 'blocked',
          error: `${label(candidate)}: provider task ${submitted.taskId} (take ${take.order}) accepted but did not settle within ${deps.pollTimeoutMs}ms — pending query, redelivery resumes this take; no fallback submit. ${result.error}`,
        }
      }
      await deps.db.submissionAttempt.update({
        where: { id: attemptRowId },
        data: result.status === 'failed' ? { status: 'settled', resolution: 'failed' } : { status: 'result_ready', resultSnapshot: saveProviderResult(result) },
      }).catch(() => undefined)
      if (result.status === 'failed') return { status: 'next', error: `${label(candidate)}: take ${take.order} — ${result.error ?? 'provider reported failure'}` }

      const takeWorkdir = path.join(workdir, `take-${take.order}-work`)
      await mkdir(takeWorkdir, { recursive: true })
      const material = await materialize(result, capability.modality, takeWorkdir)
      const file = path.join(workdir, `take-${take.order}.${extensionFor(material.mimeType)}`)
      await writeFile(file, material.bytes)
      const durationMs = material.durationMs ?? (await probeMediaMeta(file))?.durationMs ?? take.plannedMs
      const stored = await deps.storage.put(buildObjectKey({
        tenantId: task.organizationId,
        projectId: task.batch.episode.project.id,
        episodeId: task.batch.episode.id,
        stage: 'VIDEO',
        entityId: `${task.id}-take${take.order}-${randomUUID()}`,
        version: 1,
        extension: extensionFor(material.mimeType),
      }), material.bytes, material.mimeType)
      const artifact = await deps.db.mediaArtifact.create({
        data: {
          organizationId: task.organizationId,
          taskId: null,
          storyboardId: null,
          stage: 'VIDEO',
          objectKey: stored.key,
          checksum: stored.checksum,
          mimeType: stored.mimeType,
          version: 1,
          width: material.width,
          height: material.height,
          durationMs: material.durationMs,
          metadata: JSON.stringify({ ...result, role: 'take-video', taskId: task.id, storyboardId, takeOrder: take.order, plannedMs: take.plannedMs }),
        },
      })
      const endFrameArtifactId = await ensureEndFrame(file, durationMs, take.order, artifact.id)
      const verdict = await checker.check({
        taskId: task.id,
        organizationId: task.organizationId,
        projectId: task.batch.episode.project.id,
        stage: 'VIDEO',
        modality: capability.modality,
        mimeType: material.mimeType,
        bytes: material.bytes,
        prompt: promptOf(takeRequest),
        workdir: takeWorkdir,
        durationMs,
        ...(shotIntent ? { shotIntent } : {}),
        ...(takeFrame?.conditioned ? { referenceDataUrl: takeFrame.dataUrl } : {}),
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
            take: take.order,
            plannedMs: take.plannedMs,
            reasons: verdict.decision === 'pass' ? [] : verdict.reasons,
            ...(verdict.decision !== 'unjudged' ? { findings: verdict.findings ?? [], frameScores: verdict.frameScores ?? [] } : {}),
          }),
          artifactId: artifact.id,
        },
      })
      if (verdict.decision !== 'unjudged') {
        for (const [index, finding] of (verdict.findings ?? []).entries()) {
          await deps.db.qualityFinding.upsert({
            where: { compositionId_findingKey: { compositionId: `artifact:${artifact.id}`, findingKey: `visual:${index}` } },
            create: { ...finding, organizationId: task.organizationId, episodeId: task.batch.episodeId, compositionId: `artifact:${artifact.id}`, fingerprint: artifact.checksum, findingKey: `visual:${index}`, artifactId: artifact.id, storyboardId },
            update: {},
          })
        }
      }
      if (verdict.decision === 'unjudged') {
        await deps.db.submissionAttempt.update({ where: { id: attemptRowId }, data: { status: 'settled', resolution: 'unjudged', artifactId: artifact.id } }).catch(() => undefined)
        await deps.db.shotTake.updateMany({ where: { storyboardId, order: take.order }, data: { status: 'REJECTED', videoArtifactId: artifact.id, endFrameArtifactId, firstFrameArtifactId: takeFrame?.conditioned ? expectedFirstFrame : null } })
        await taskLog(deps.db, anchor, 'error', 'task.fail', `${verdict.kind}: auditor could not judge take ${take.order} — ${verdict.reasons.join('; ') || 'no verdict'}`)
        const written = await fencedTaskWrite(deps.db, task.id, lease.token, { status: 'FAILED', errorSnapshot: `${verdict.kind}: ${verdict.reasons.join('; ') || 'no verdict'}`, provider: candidate.provider, model: candidate.model })
        return written ? { status: 'exhausted' } : { status: 'fenced' }
      }
      if (verdict.decision === 'rework') {
        await deps.db.submissionAttempt.update({ where: { id: attemptRowId }, data: { status: 'settled', resolution: 'rework', artifactId: artifact.id } }).catch(() => undefined)
        await deps.db.shotTake.updateMany({ where: { storyboardId, order: take.order }, data: { status: 'REJECTED', videoArtifactId: artifact.id, endFrameArtifactId, firstFrameArtifactId: takeFrame?.conditioned ? expectedFirstFrame : null } })
        return settleQcRework({ deps, task, payload, lease, anchor, candidate, verdict, artifactId: artifact.id, segment: take.order })
      }

      await deps.db.submissionAttempt.update({ where: { id: attemptRowId }, data: { status: 'settled', resolution: 'succeeded', artifactId: artifact.id } })
      // 段一过审就记账，而不是等整镜收尾：后面某一段失败时，前面已付的段不该从
      // 账本里消失——重试复用它们，也不会再记第二笔。
      await deps.db.usageLedger.create({
        data: {
          organizationId: task.organizationId,
          taskId: task.id,
          provider: candidate.provider,
          model: candidate.model,
          modality: capability.modality,
          inputUnits: promptChars,
          outputUnits: stored.sizeBytes,
        },
      })
      await deps.db.shotTake.updateMany({
        where: { storyboardId, order: take.order },
        data: { status: 'SUCCEEDED', videoArtifactId: artifact.id, endFrameArtifactId, firstFrameArtifactId: takeFrame?.conditioned ? expectedFirstFrame : null },
      })
      files.push(file)
      results.push({
        order: take.order,
        plannedMs: take.plannedMs,
        videoArtifactId: artifact.id,
        endFrameArtifactId,
        firstFrameArtifactId: takeFrame?.conditioned ? expectedFirstFrame : null,
        durationMs,
        score: verdict.score,
        kind: verdict.kind,
        reused: false,
        ...(submitted.taskId ? { providerTaskId: submitted.taskId } : {}),
      })
      expectedFirstFrame = endFrameArtifactId
      await taskLog(deps.db, anchor, 'info', 'video.takeSucceeded', `take ${take.order}/${plan.takes.length} produced ${Math.round(durationMs / 100) / 10}s and its end frame is now take ${take.order + 1}'s first frame`, { take: take.order, artifactId: artifact.id, endFrameArtifactId })
    }

    const masterPath = path.join(workdir, 'shot.mp4')
    await concatVideoClips(files, masterPath, workdir)
    const masterBytes = new Uint8Array(await readFile(masterPath))
    const masterMeta = await probeMediaMeta(masterPath)
    const masterVersion = await nextArtifactVersion(deps.db, task)
    const masterStored = await deps.storage.put(buildObjectKey({
      tenantId: task.organizationId,
      projectId: task.batch.episode.project.id,
      episodeId: task.batch.episode.id,
      stage: 'VIDEO',
      entityId: task.id,
      version: masterVersion,
      extension: 'mp4',
    }), masterBytes, 'video/mp4')
    const master = await deps.db.mediaArtifact.create({
      data: {
        organizationId: task.organizationId,
        taskId: task.id,
        stage: 'VIDEO',
        objectKey: masterStored.key,
        checksum: masterStored.checksum,
        mimeType: masterStored.mimeType,
        version: masterVersion,
        width: masterMeta?.width,
        height: masterMeta?.height,
        durationMs: masterMeta?.durationMs,
        metadata: JSON.stringify({
          role: 'spliced-master',
          splice: { intentMs: plan.intentMs, ceilingMs: plan.ceilingMs, perTakeMs: plan.perTakeMs, takeCount: results.length },
          takes: results.map(result => ({ order: result.order, plannedMs: result.plannedMs, durationMs: result.durationMs, videoArtifactId: result.videoArtifactId, endFrameArtifactId: result.endFrameArtifactId, firstFrameArtifactId: result.firstFrameArtifactId, reused: result.reused })),
        }),
      },
    })
    // 母带的过审结论是各段结论的合成：每一段都过了，整镜才算过；分数取最差那段。
    // 报告写明 aggregated，回看时不会把这条当成对母带字节重新审过一遍。
    const worst = results.reduce((acc, result) => (result.score < acc.score ? result : acc), results[0]!)
    await deps.db.qualityCheck.create({
      data: {
        status: 'APPROVED',
        kind: worst.kind,
        score: worst.score,
        report: JSON.stringify({
          kind: worst.kind,
          threshold: QC_THRESHOLD,
          mode: deps.qcMode,
          candidate,
          aggregated: true,
          splice: { intentMs: plan.intentMs, takeCount: results.length },
          takes: results.map(result => ({ order: result.order, plannedMs: result.plannedMs, durationMs: result.durationMs, score: result.score, kind: result.kind, reused: result.reused })),
          reasons: [],
        }),
        artifactId: master.id,
      },
    })

    await taskLog(deps.db, anchor, 'info', 'candidate.success', `${label(candidate)} produced a ${results.length}-take spliced shot (${Math.round((masterMeta?.durationMs ?? 0) / 100) / 10}s master, all takes audited)`, { artifactId: master.id, takeCount: results.length })
    const written = await fencedTaskWrite(deps.db, task.id, lease.token, {
      status: 'SUCCEEDED',
      provider: candidate.provider,
      model: candidate.model,
      responseSnapshot: JSON.stringify({
        attempt: payload.attempt,
        candidate,
        splice: { intentMs: plan.intentMs, ceilingMs: plan.ceilingMs, perTakeMs: plan.perTakeMs, takeCount: results.length },
        takes: results.map(result => ({
          order: result.order,
          plannedMs: result.plannedMs,
          durationMs: result.durationMs,
          artifactId: result.videoArtifactId,
          endFrameArtifactId: result.endFrameArtifactId,
          firstFrameArtifactId: result.firstFrameArtifactId,
          reused: result.reused,
          ...(result.providerTaskId ? { providerTaskId: result.providerTaskId } : {}),
        })),
        artifactId: master.id,
        durationMs: masterMeta?.durationMs ?? null,
        qc: { score: worst.score, threshold: QC_THRESHOLD, aggregated: true },
        ...(errors.length > 0 ? { candidateErrors: errors } : {}),
        ...(referenceLog.length > 0 ? { reference: referenceLog } : {}),
      }),
    })
    if (!written) {
      const late = await markLateResult(deps.db, task.id, payload.attempt)
      if (late) {
        await taskLog(deps.db, anchor, 'warn', 'attempt.lateResult', `attempt ${payload.attempt} (${label(candidate)}) spliced shot settled after the task was already completed — recorded as a late-result candidate, existing verdict untouched`, { attempt: payload.attempt, candidate: label(candidate) })
      }
      return { status: 'fenced' }
    }
    return { status: 'succeeded' }
  } catch (error) {
    if (error instanceof ContentRejectedError) {
      return { status: 'next', error: error.message, retryClass: 'creative' }
    }
    return { status: 'blocked', error: `provider result is durable; spliced local persistence needs retry: ${errorMessage(error)}` }
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}


/** 已受理的轮询结果要落成台账快照:重投时凭它续查/取货,不再重复提交。 */
export function saveProviderResult(result: SettledResult): string {
  return JSON.stringify(result, (_key, value) => {
    if (value instanceof Uint8Array) return { binaryBase64: Buffer.from(value).toString('base64') }
    // Buffer.toJSON runs before the replacer, unlike a plain Uint8Array.
    if (value?.type === 'Buffer' && Array.isArray(value.data)) return { binaryBase64: Buffer.from(value.data).toString('base64') }
    return value
  })
}
export function restoreProviderResult(snapshot: string): PollResult & { status: 'completed' } {
  return JSON.parse(snapshot, (_key, value) => value && typeof value === 'object' && typeof value.binaryBase64 === 'string' ? new Uint8Array(Buffer.from(value.binaryBase64, 'base64')) : value)
}

export async function materialize(result: PollResult, modality: string, workdir: string): Promise<Material> {
  // A vendor that returns bytes has already done the download the worker cannot: its
  // media sits behind an authenticated GET or came inline as base64.
  if (result.inlineArtifact) return measureMissingMeta({ ...result.inlineArtifact }, workdir)
  const artifactUrl = result.artifactUrl
  if (artifactUrl?.startsWith('mock://')) {
    const target = path.join(workdir, `artifact.${MOCK_EXTENSION[modality] ?? 'bin'}`)
    // mock extend 产物带 durationMs 参数——解析它作为输出时长;带 source= 参数时
    // durationMs 语义是「追加段时长」,源片数据由 materialize 拼接保留(Q05)。
    const durMatch = /[?&]durationMs=(\d+)/.exec(artifactUrl)
    const durationMs = durMatch ? Number(durMatch[1]) : MOCK_DURATION_MS
    const sourceMatch = /[?&]source=([^&]+)/.exec(artifactUrl)
    const extendSource = sourceMatch ? decodeURIComponent(sourceMatch[1]) : undefined
    const media = await synthesizeMockMedia(modality, target, { durationMs, ...(extendSource !== undefined ? { extendSource } : {}) })
    return { bytes: new Uint8Array(await readFile(target)), ...media }
  }
  if (artifactUrl) {
    const response = await fetch(artifactUrl)
    if (!response.ok) throw new Error(`artifact download failed: HTTP ${response.status}`)
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
    return measureMissingMeta({ bytes: new Uint8Array(await response.arrayBuffer()), mimeType: contentType || 'application/octet-stream' }, workdir)
  }
  if (typeof result.text === 'string') return { bytes: new TextEncoder().encode(result.text), mimeType: 'text/plain' }
  throw new Error('provider completed without an artifact')
}

/**
 * SD-068：供应商下载回执只有字节，落库的 width/height/durationMs 全 NULL，而下游
 * 把 NULL 当素材长度用——时间线按分镜计划时长冒充，4.04 秒已付费成片被裁成 2 秒。
 * 拿到字节就地实测补齐，只填缺的、不覆盖供应商给过的值。探测失败原样返回：一条已
 * 付费的产物绝不能因为读不出元数据而失败。
 */
export async function measureMissingMeta(material: Material, workdir: string): Promise<Material> {
  if (material.width !== undefined && material.height !== undefined && material.durationMs !== undefined) return material
  if (material.mimeType.startsWith('text/')) return material
  let meta: MediaMeta | null = null
  const probeFile = path.join(workdir, `probe.${extensionFor(material.mimeType)}`)
  try {
    await writeFile(probeFile, material.bytes)
    meta = await probeMediaMeta(probeFile)
  } catch {
    meta = null
  } finally {
    await rm(probeFile, { force: true }).catch(() => undefined)
  }
  if (!meta) return material
  const measured: Material = { ...material }
  if (measured.width === undefined && meta.width !== undefined) measured.width = meta.width
  if (measured.height === undefined && meta.height !== undefined) measured.height = meta.height
  if (measured.durationMs === undefined && meta.durationMs !== undefined) measured.durationMs = meta.durationMs
  return measured
}

/**
 * What this candidate did with the shot's frame, or `null` when there was nothing to
 * decide: no frame in the snapshot, or a candidate that cannot take one. `null` is what
 * keeps the text-to-video path byte-identical to the one it had before conditioning existed.
 */
type FrameOutcome =
  | { conditioned: true; dataUrl: string; publicUrl?: string }
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
  frameArtifactId?: string,
): Promise<FrameOutcome | null> {
  // A text-to-video candidate has no slot for a frame and the adapter says so; reading the
  // bytes for it would spend storage traffic on an image nobody is going to look at.
  if (capability.modality !== 'i2v') return null
  // 连续段的第 2 段起不再吃快照里那一张首帧，而是吃上一段刚抽出来的末帧——帧链的
  // 条件帧由执行侧给出；不给时才退回快照（单段任务与第 1 段的老行为）。
  const references = readFrameReferences(task.requestSnapshot, 'first_frame')
  if (!frameArtifactId && references.length === 0) return null
  const artifactId = frameArtifactId ?? references[0]!.artifactId

  try {
    const artifact = await deps.db.mediaArtifact.findFirst({
      where: { id: artifactId, organizationId: task.organizationId },
      select: { objectKey: true, mimeType: true, metadata: true },
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
      const dataUrl = toDataUrl(frame.bytes, frame.mimeType)
      // 一份公开地址有时是硬前提:2026-10-21 实测中转站在提交阶段就按「参考素材必须是公网
      // http/https URL，不支持 base64」拒掉了首帧(seedance.ts 的注释只对官方 Ark 成立)。
      // 厂商每次出片都回一份带签名的公网副本,本地字节没被重编码过、签名没过期时它就是
      // 同一张图的公开引用;拿不到才退回 base64。
      const publicUrl = frame.reencoded ? null : storedPublicUrl(artifact.metadata)
      if (publicUrl && (await isReachable(publicUrl))) return { conditioned: true, dataUrl, publicUrl }
      return { conditioned: true, dataUrl }
    } finally {
      await rm(workdir, { recursive: true, force: true })
    }
  } catch (error) {
    return { conditioned: false, reason: errorMessage(error) }
  }
}

/**
 * The vendor's own copy of an artifact, kept on the row when the generation returned a
 * hosted file. Only an http(s) address counts; `mock://` and a missing key are not leads.
 */
function storedPublicUrl(metadata: string | null): string | null {
  if (!metadata) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(metadata)
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed.artifactUrl !== 'string') return null
  return /^https?:\/\//.test(parsed.artifactUrl) ? parsed.artifactUrl : null
}

/** A signature that already lapsed answers 403 — the channel would receive a broken reference. */
async function isReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(5000) })
    return response.ok
  } catch {
    return false
  }
}

function referenceMaxBytes(spec: unknown): number {
  const declared = isRecord(spec) ? spec.referenceMaxBytes : undefined
  return typeof declared === 'number' && Number.isInteger(declared) && declared > 0 ? declared : REFERENCE_IMAGE_MAX_BYTES_10MB
}

/**
 * 首帧任务的定妆照参考图:requestSnapshot 带着触发时解析好的素材 APPROVED 版本 artifact。
 * 绑定的模型声明吃参考图(qwen-image-3.0 一代)才读字节、拍平、随请求发送;声明的上限之内
 * 逐张发送,单张失败只丢那张并记录原因,不拦任务——文字描述仍然在提示词里。
 */
async function resolveAssetReferences(
  task: TaskRow,
  capability: ProviderCapability,
  spec: unknown,
  deps: PipelineDeps,
  referenceLog: ReferenceRecord[],
): Promise<MediaReference[] | null> {
  const references = readFrameReferences(task.requestSnapshot, 'reference_image')
  if (references.length === 0) return null
  if (!capability.acceptsReferenceImages) {
    referenceLog.push({ model: capability.model, conditioned: false, reason: `model "${capability.model}" does not take reference images; the generation ran without the approved asset sheets` })
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

/** The frame/sheet references this task was planned with, as the pipeline wrote them.
 *  快照里 first_frame 与 reference_image 是同一数组的两种类型,取的时候必须按用途
 *  过滤——不过滤时首帧解析会拿到别人的定妆照,参考图解析会把首帧当定妆照送出。 */
function readFrameReferences(snapshot: string | null, type?: 'first_frame' | 'reference_image'): { artifactId: string }[] {
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
    if (type && entry.type !== type) continue
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
 * The fields that define what a request is billed at are made explicit here, at
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
  durationEvidence?: unknown,
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
    // A shot's planned length is a request, not a bill. The model that wins the slot decides
    // what can actually be bought, and a shot planned at 15 s that lands on a 12-second model
    // is still the same scene — so the value is bounded here and the number asked for is
    // recorded beside it. When the model declares nothing the canonical key is taken back
    // out, so the adapter sends no length at all, and the log says the clip's duration came
    // from the vendor: a fact worth recording, not a number to invent.
    const asked = durationSecondsOf(request.parameters)
    // 实测证伪过的声明在下单前先压低：文档写 30 s、这条连接实测只出过 8 s 时，
    // 按 30 s 钉住只会买回一段被厂商截短的片子，账单却按 30 s 记。
    const pinned = pinDuration(capDurationSpec(readDurationSpec(spec), readDurationEvidence(durationEvidence)), asked)
    if (pinned) {
      request.parameters[DURATION_KEY] = pinned.seconds
      billed.duration = pinned.seconds
      if (pinned.capped && asked !== undefined) billed.durationAsked = asked
    } else {
      delete request.parameters[DURATION_KEY]
      billed.duration = 'vendor-default'
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
