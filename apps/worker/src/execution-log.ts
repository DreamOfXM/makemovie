// 执行日志:任务全程的打点沉淀。没有它,中间过程(候选为什么被跳过、提交
// 是否成功、质检判了什么)只活在进程的临时输出里,出了问题无法追溯。
// 打点自身绝不能拖垮执行:写入失败只降级到 stderr。
import type { PrismaClient } from '@studio/db'

export interface LogAnchor {
  organizationId: string
  taskId: string
  batchId: string
  episodeId: string
  stage: string
}

export type LogLevel = 'info' | 'warn' | 'error'

export function taskLog(
  db: PrismaClient,
  anchor: LogAnchor,
  level: LogLevel,
  event: string,
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  return db.generationLog
    .create({
      data: {
        organizationId: anchor.organizationId,
        taskId: anchor.taskId,
        batchId: anchor.batchId,
        episodeId: anchor.episodeId,
        stage: anchor.stage,
        level,
        event,
        message,
        ...(data === undefined ? {} : { data: data as object }),
      },
    })
    .then(() => undefined)
    .catch((error: unknown) => {
      process.stderr.write(`execution log write failed (${event}): ${error instanceof Error ? error.message : String(error)}\n`)
    })
}
