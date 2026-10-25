// SD-131 孤儿租约回收的复验：worker 启动时把「队列里查不到 job」的 RUNNING
// 认领为 submission_unknown + FAILED（带成因说明），而不是留 RUNNING 把镜头卡
// 永久锁在「生成中」。判据两条：队列归属查得到就不碰；错误文案必须能被前端
// UNKNOWN_SUBMISSION 核对门（shot-verdict.ts）认出——这里用同一枚正则钉住契约。
import { describe, expect, it } from 'vitest'
import { startTestEnv } from './env.js'
import { jobIdFor } from '@studio/jobs'
import { orphanReclaimMessage, reclaimOrphanedSubmissions } from '../src/reclaim-orphans.js'

// apps/web/lib/shot-verdict.ts 的 UNKNOWN_SUBMISSION 同一条：文案换了词根
// 前端的「已核对，新建一版提交」出口就会哑火，这里跨包钉住。
const UNKNOWN_SUBMISSION = /submission ledger slot|submission unknown|manual verification required/i

describe('orphan RUNNING reclaim at worker boot (SD-131)', () => {
  it('reclaims a RUNNING task with no queue job: FAILED + submission_unknown with a named cause', async () => {
    const env = await startTestEnv()
    try {
      const seed = await env.seed()
      const task = await env.db.generationTask.update({
        where: { id: seed.taskId },
        data: { status: 'RUNNING', attempts: 1, claimToken: 'dead-process-token', leaseUntil: new Date(Date.now() + 600_000) },
      })
      await env.db.submissionAttempt.create({
        data: { taskId: task.id, attemptNumber: 1, slot: 0, status: 'submitting', provider: 'mock', model: 'mock-t2v', connectionId: seed.connectionId, capabilityId: seed.capabilityId },
      })

      const reclaimed = await reclaimOrphanedSubmissions(env.db, env.queue)
      expect(reclaimed).toHaveLength(1)
      expect(reclaimed[0]).toMatchObject({ taskId: task.id, attempt: 1, submissionRowsMarked: 1 })

      const after = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
      expect(after.status).toBe('FAILED')
      expect(after.claimToken).toBeNull()
      expect(after.leaseUntil).toBeNull()
      // 审计链：人读得懂的成因 + 前端核对门认得出的词。
      expect(after.errorSnapshot).toMatch(/worker restart/i)
      expect(after.errorSnapshot).toMatch(UNKNOWN_SUBMISSION)

      const attempt = await env.db.submissionAttempt.findFirstOrThrow({ where: { taskId: task.id, attemptNumber: 1, slot: 0 } })
      expect(attempt.status).toBe('submission_unknown')
      expect(attempt.errorSnapshot).toMatch(UNKNOWN_SUBMISSION)

      const logs = await env.db.generationLog.findMany({ where: { taskId: task.id, event: 'task.orphanReclaimed' } })
      expect(logs).toHaveLength(1)
      expect(logs[0]!.level).toBe('warn')
    } finally {
      await env.stop()
    }
  })

  it('leaves a RUNNING task untouched while its job still sits in the queue', async () => {
    const env = await startTestEnv()
    try {
      const seed = await env.seed()
      const task = await env.db.generationTask.update({
        where: { id: seed.taskId },
        data: { status: 'RUNNING', attempts: 1, claimToken: 'other-process', leaseUntil: new Date(Date.now() + 600_000) },
      })
      await env.db.submissionAttempt.create({
        data: { taskId: task.id, attemptNumber: 1, slot: 0, status: 'submitting', provider: 'mock', model: 'mock-t2v' },
      })
      // 与 jobIdFor 同约定的活投递：别的进程还在排队/在跑，回收不许掐。
      const payload = env.runPayload(seed, 1)
      await env.queue.add(payload.kind, payload, { jobId: jobIdFor(payload) })

      expect(await reclaimOrphanedSubmissions(env.db, env.queue)).toEqual([])
      const after = await env.db.generationTask.findUniqueOrThrow({ where: { id: task.id } })
      expect(after.status).toBe('RUNNING')
      const attempt = await env.db.submissionAttempt.findFirstOrThrow({ where: { taskId: task.id, attemptNumber: 1, slot: 0 } })
      expect(attempt.status).toBe('submitting')
    } finally {
      await env.stop()
    }
  })

  it('never re-judges an accepted submission: the providerTaskId row stays the resume credential', async () => {
    const env = await startTestEnv()
    try {
      const seed = await env.seed()
      const task = await env.db.generationTask.update({
        where: { id: seed.taskId },
        data: { status: 'RUNNING', attempts: 1, claimToken: 'dead-process', leaseUntil: new Date(Date.now() - 1000) },
      })
      await env.db.submissionAttempt.create({
        data: { taskId: task.id, attemptNumber: 1, slot: 0, status: 'accepted', providerTaskId: 'provider-abc', provider: 'mock', model: 'mock-t2v' },
      })
      await env.db.submissionAttempt.create({
        data: { taskId: task.id, attemptNumber: 1, slot: 1, status: 'submitting', provider: 'mock', model: 'mock-t2v' },
      })

      const reclaimed = await reclaimOrphanedSubmissions(env.db, env.queue)
      expect(reclaimed[0]!.submissionRowsMarked).toBe(1)
      expect(await env.db.submissionAttempt.count({ where: { taskId: task.id, providerTaskId: 'provider-abc', status: 'accepted' } })).toBe(1)
      expect(await env.db.submissionAttempt.count({ where: { taskId: task.id, slot: 1, status: 'submission_unknown' } })).toBe(1)
    } finally {
      await env.stop()
    }
  })

  it('skips tasks that are not RUNNING', async () => {
    const env = await startTestEnv()
    try {
      await env.seed()
      expect(await reclaimOrphanedSubmissions(env.db, env.queue)).toEqual([])
    } finally {
      await env.stop()
    }
  })

  it('names the restart cause and the gate tokens in one message', () => {
    const message = orphanReclaimMessage('task-1', 2)
    expect(message).toContain('attempt 2 of task task-1')
    expect(message).toMatch(UNKNOWN_SUBMISSION)
    expect(message).toMatch(/worker restart/i)
    expect(message).toMatch(/no queue job remains/i)
  })
})
