import { describe, expect, it } from 'vitest'
import { shotsAwaitingApproval, storyboardBatchFailure, storyboardFailureCopy } from '@/components/episode/episode-flow'
import type { Storyboard } from '@/lib/api'

/**
 * SD-022 / SD-020 的门禁数学（纯函数，node 环境可测）：
 * 「分镜完成」= 每条活体镜头都被读并整批批准（status=APPROVED），不是「有行」；
 * 最近一次 STORYBOARD 批次 BLOCKED/FAILED = 这一步带着失败，不许读成安静地完成。
 */

const shot = (id: string, status: string): Storyboard => ({ id, status, supersededAt: null } as unknown as Storyboard)

describe('shotsAwaitingApproval（分镜整批批准门禁）', () => {
  it('全 DRAFT 的 63 镜一镜都没被批准：门禁不放行', () => {
    const live = Array.from({ length: 63 }, (_, index) => shot(`s${index}`, 'DRAFT'))
    expect(shotsAwaitingApproval(live)).toHaveLength(63)
  })

  it('混有 needs_review / READY 的镜头同样算未批准——只认 APPROVED', () => {
    const live = [shot('a', 'APPROVED'), shot('b', 'NEEDS_REVIEW'), shot('c', 'READY'), shot('d', 'APPROVED')]
    expect(shotsAwaitingApproval(live).map(item => item.id)).toEqual(['b', 'c'])
  })

  it('全部 APPROVED 时门禁开启', () => {
    expect(shotsAwaitingApproval([shot('a', 'APPROVED'), shot('b', 'APPROVED')])).toHaveLength(0)
  })
})

describe('storyboardBatchFailure（最近一次分镜批次的失败信号）', () => {
  it('BLOCKED 批次是失败信号，FAILED 一并认（旧数据）', () => {
    expect(storyboardBatchFailure({ status: 'BLOCKED', error: 'boom' })).toEqual({ error: 'boom' })
    expect(storyboardBatchFailure({ status: 'FAILED', error: null })).toEqual({ error: null })
  })

  it('没有批次、成功批次、在途批次都不报失败', () => {
    expect(storyboardBatchFailure(null)).toBeNull()
    expect(storyboardBatchFailure({ status: 'COMPLETED', error: null })).toBeNull()
    expect(storyboardBatchFailure({ status: 'RUNNING', error: null })).toBeNull()
    expect(storyboardBatchFailure({ status: 'DRAFT', error: null })).toBeNull()
    expect(storyboardBatchFailure({ status: 'NEEDS_REVIEW', error: null })).toBeNull()
  })
})

describe('storyboardFailureCopy（失败条的人话）', () => {
  const t = (key: string) => key

  it('认得出的因复用全站 failure.cause.* 文案，原始报文不上屏', () => {
    expect(storyboardFailureCopy(t, '["AllocationQuota.FreeTierOnly: free quota exhausted"]')).toBe('failure.cause.quota')
    expect(storyboardFailureCopy(t, 'The API key is invalid (InvalidApiKey)')).toBe('failure.cause.access')
  })

  it('认不出的退回专用通用句，绝不把报文当正文', () => {
    expect(storyboardFailureCopy(t, null)).toBe('stepper.storyboardBatchFailed.fallback')
    expect(storyboardFailureCopy(t, 'some vendor payload that matches nothing')).toBe('stepper.storyboardBatchFailed.fallback')
  })
})
