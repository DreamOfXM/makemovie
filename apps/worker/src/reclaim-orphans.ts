// SD-131 孤儿租约回收:worker 进程被掐死在提交途中(`tsx watch` 一改 providers/dist
// 就重启子进程,实测 22:52:39 写盘 → 22:52:44 新子进程),任务行留 RUNNING、
// 提交行留 submitting,而队列里已没有任何 job 会再来收尾——前端的 busy 态由
// RUNNING 派生,镜头卡就此永久「生成中」、按钮永久禁用,没有任何出口。
//
// 判据照台账的最小改法:本进程启动时,「队列里查不到 job」的 RUNNING 认领为
// submission_unknown(同 SD-128 的核对门语义:上游可能已接单,不自动重试、
// 不静默复用,人工核对后新建一版),而不是留 RUNNING。错误文案必须带
// 「submission unknown / manual verification required」字样——前端的
// UNKNOWN_SUBMISSION 判据(shot-verdict.ts)靠它认出这条该走核对出口。
//
// 这不是通用租约续期系统:只在启动时扫一轮,查不到活的队列归属才动手;
// 别的进程正在跑的活(RUNNING + 队列里有 waiting/active/delayed 的 job)一律不碰。
import type { PrismaClient } from '@studio/db'
import type { Queue } from 'bullmq'
import { jobIdFor, type PipelinePayload } from '@studio/jobs'
import { taskLog } from './execution-log.js'

/** 队列归属按 @studio/jobs 的 jobIdFor 唯一约定查——不另写一条 id 拼接的第二判据。 */
function queuedJobLookup(task: { id: string; organizationId: string; attempts: number }): string {
  return jobIdFor({ kind: 'run-task', taskId: task.id, organizationId: task.organizationId, attempt: task.attempts, candidates: [] })
}

/** 队列里仍会被任何消费者处理的状态——有这些状态的 job 就不是孤儿。 */
const LIVE_JOB_STATES = new Set(['wait', 'waiting', 'active', 'delayed', 'delay', 'prioritized', 'waiting-children', 'paused'])

/**
 * 回收错误文案:既写明成因(worker 重启、租约成孤儿、队列无作业),也带上
 * SD-128 核对门的识别词,让镜头卡与预览面板给出「已核对，新建一版提交」的出口。
 */
export function orphanReclaimMessage(taskId: string, attempt: number): string {
  return `orphan reclaimed at worker boot: submission unknown — attempt ${attempt} of task ${taskId} was cut mid-submit by a worker restart and no queue job remains for it (orphaned lease, this process does not own it); the provider may already have accepted it, manual verification required before any retry — check the provider console, then submit a new version`
}

export interface ReclaimedOrphan {
  taskId: string
  attempt: number
  /** 被认领为 submission_unknown 的台账行数(submitting/prepared 且无 providerTaskId)。 */
  submissionRowsMarked: number
}

/**
 * 启动一轮:凡 RUNNING 且队列里查不到可再处理 job 的任务,写 FAILED +
 * 说明成因的 errorSnapshot(解除前端 busy 死锁),并把该任务没有受理凭据的
 * submitting/prepared 台账行认领为 submission_unknown。已受理(providerTaskId
 * 在手)的行绝不改判——那是 V01 续查的凭据，不是孤儿。
 */
export async function reclaimOrphanedSubmissions(
  db: PrismaClient,
  queue: Queue<PipelinePayload>,
): Promise<ReclaimedOrphan[]> {
  const running = await db.generationTask.findMany({
    where: { status: 'RUNNING' },
    select: {
      id: true,
      attempts: true,
      organizationId: true,
      stage: true,
      batch: { select: { id: true, episodeId: true } },
    },
  })
  if (running.length === 0) return []

  const reclaimed: ReclaimedOrphan[] = []
  for (const task of running) {
    let state: string | null = null
    try {
      const job = await queue.getJob(queuedJobLookup(task))
      state = job ? await job.getState() : null
    } catch (error) {
      // Redis 不可用时整轮放弃:判不出队列归属就动手,等于在没有证据时判案。
      process.stderr.write(`orphan reclaim aborted (queue unavailable): ${error instanceof Error ? error.message : String(error)}\n`)
      return reclaimed
    }
    // 队列里仍有可被处理的投递:那是别的活消费者的续命凭据,不碰。
    // getJob 返回 null(键不存在)或 job 已 completed/failed(不会再有人处理)才算孤儿。
    if (state !== null && LIVE_JOB_STATES.has(state)) continue

    const message = orphanReclaimMessage(task.id, task.attempts)
    const written = await db.generationTask.updateMany({
      where: { id: task.id, status: 'RUNNING' },
      data: { status: 'FAILED', errorSnapshot: message, claimToken: null, leaseUntil: null },
    })
    if (written.count !== 1) continue

    // 台账侧同一条改判:没有 providerTaskId 的在途提交认领为 submission_unknown。
    // providerTaskId 为 null 的硬条件保护已受理待查询的行(V01 续查不许被改判)。
    const marked = await db.submissionAttempt.updateMany({
      where: { taskId: task.id, status: { in: ['submitting', 'prepared'] }, providerTaskId: null },
      data: { status: 'submission_unknown', errorSnapshot: message },
    })

    await taskLog(
      db,
      { organizationId: task.organizationId, taskId: task.id, batchId: task.batch.id, episodeId: task.batch.episodeId, stage: task.stage },
      'warn',
      'task.orphanReclaimed',
      message,
      { attempt: task.attempts, submissionRowsMarked: marked.count },
    )
    reclaimed.push({ taskId: task.id, attempt: task.attempts, submissionRowsMarked: marked.count })
  }
  return reclaimed
}
