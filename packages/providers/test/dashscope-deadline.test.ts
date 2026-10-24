import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SUBMIT_TIMEOUT_MS } from '../src/dashscope.js'

/**
 * 「一次厂商调用悬死」这一类事故的两条硬拦（2026-10-22，SD-129 / SD-130）：
 * 同步出图把整次生成挂在一个 HTTP 响应上，没有截止时间的 fetch 会永远悬着——任务停在
 * RUNNING、台账停在 submitting，之后的每一次重试都撞上自己那行未终局的台账（#19 死结）。
 * 而截止时间一旦设进正常出图的分布里，它会砍掉合法生成并照样计费（#20 被 180 秒误杀）。
 */

const SOURCE = readFileSync(join(__dirname, '..', 'src', 'dashscope.ts'), 'utf8')

/** 本空间 2026-10-22 实测：35 次成功的首帧提交（含同步生成全程）p50=172s、p90=231s、max=299s。 */
const MEASURED_SLOWEST_SUCCESS_MS = 299_000

/** 返回没有 AbortSignal 截止时间的 fetch 站点序号（1-based）。 */
function fetchSitesWithoutDeadline(src: string): number[] {
  return src
    .split('await fetch(')
    .slice(1)
    .map((site, i) => (site.slice(0, 600).includes('signal: AbortSignal.timeout(') ? 0 : i + 1))
    .filter(n => n > 0)
}

describe('dashscope 每一处厂商调用都必须带截止时间', () => {
  it('四处 fetch 全部挂 AbortSignal.timeout', () => {
    expect(SOURCE.split('await fetch(').length - 1).toBe(4)
    expect(fetchSitesWithoutDeadline(SOURCE)).toEqual([])
  })

  /** 作弊夹具：摘掉一处 signal，检查必须变红——否则这条断言看不见它要防的东西。 */
  it('摘掉任一站点的截止时间即被拦下', () => {
    const doctored = SOURCE.replace('signal: AbortSignal.timeout(POLL_TIMEOUT_MS)', 'headers')
    expect(doctored).not.toBe(SOURCE)
    expect(fetchSitesWithoutDeadline(doctored)).toEqual([1])
  })
})

describe('提交截止点不得砍掉正常出图', () => {
  it('SUBMIT_TIMEOUT_MS 高于实测最慢一次成功', () => {
    expect(SUBMIT_TIMEOUT_MS).toBeGreaterThan(MEASURED_SLOWEST_SUCCESS_MS)
  })

  it('轮询超时保持短（下一轮照常续查，不重复计费）', () => {
    expect(SOURCE).toMatch(/const POLL_TIMEOUT_MS = 30_000/)
  })
})
