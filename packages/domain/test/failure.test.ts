import { describe, expect, it } from 'vitest'
import { callEvidenceKey, classifyFailure, isTerminalFailure, reduceCallEvidence, type CallEvidenceRow } from '../src/index.js'

// 每条夹具都是 2026-09-26 从本机库 GenerationTask.errorSnapshot 里原样抄出来的报文，
// 不是编的形状：分类器错一条，界面上就是一句假的原因。
const REAL = {
  quota: '["dashscope/wan2.7-t2v: AllocationQuota.FreeTierOnly | Free quota exhausted. To continue accessing the model on a paid basis, please add funds or disable the \\"use free tier only\\" mode in the managem',
  access: '["dashscope/fun-music-v1: AccessDenied | Access denied. For details, see: https://help.aliyun.com/zh/model-studio/error-code#access-denied | request_id=9d2c8a87-315e-91cb-8928-ad66c8bc2fba"]',
  param: '["dashscope/qwen3.8-max: InvalidParameter | url error, please check url！ For details, see: https://help.aliyun.com/zh/model-studio/error-code#error-url | request_id=26b1eea7"]',
  network: '["dashscope/qwen3-tts-flash: fetch failed"]',
  audit: 'visual-audit: threshold not met after 3 attempts',
  // 2026-09-27 从「红色房产证」这条素材的候选链里原样抄回：同一条链上审查、额度、
  // 参数三种因并存，界面上只能说一种，说错就把人推向充值页。
  moderation:
    '["dashscope/wan2.2-t2i-flash: DataInspectionFailed | Input data may contain inappropriate content. For details, see: https://help.aliyun.com/zh/model-studio/error-code#inappropriate-content | request_id=06df0643", "dashscope/qwen-image-3.0: AllocationQuota.FreeTierOnly | Free quota exhausted.", "dashscope/qwen-image-3.0-pro: DataInspectionFailed | Green net check rejected text (input)", "dashscope/qwen-image-edit: InvalidParameter | For image editing, the message must contain 1~3 image content items. Got 0 image items."]',
} as const

describe('classifyFailure', () => {
  it('把额度耗尽认成 quota，而不是「没过线」', () => {
    expect(classifyFailure(REAL.quota)).toBe('quota')
  })

  it('认得 AccessDenied / InvalidParameter / 网络断 / 审计没过线', () => {
    expect(classifyFailure(REAL.access)).toBe('access')
    expect(classifyFailure(REAL.param)).toBe('param')
    expect(classifyFailure(REAL.network)).toBe('network')
    expect(classifyFailure(REAL.audit)).toBe('audit')
  })

  it('审计判定优先于同句里的其它码：阈值句不得被认成额度', () => {
    expect(classifyFailure('["kling/x: visual-audit: threshold not met after 3 attempts"]')).toBe('audit')
  })

  it('空值与读不懂的报文退成 unknown，绝不猜一个原因上屏', () => {
    expect(classifyFailure(null)).toBe('unknown')
    expect(classifyFailure('')).toBe('unknown')
    expect(classifyFailure('something never seen before')).toBe('unknown')
  })

  it('候选链里只要出现过额度耗尽，就按额度说（终因优先于顺带的网络断）', () => {
    expect(classifyFailure('["a/m: fetch failed", "b/n: AllocationQuota.FreeTierOnly | Free quota exhausted"]')).toBe('quota')
  })

  it('内容审查排在额度之前：链上有额度的那台模型也是被内容拦下的，充值解决不了这一条', () => {
    expect(classifyFailure(REAL.moderation)).toBe('moderation')
    expect(classifyFailure('["dashscope/qwen-image-3.0-pro: DataInspectionFailed | Green net check rejected text (input)"]')).toBe('moderation')
  })
})

describe('isTerminalFailure', () => {
  it('重抽不会改变的因才算终因，网络抖动不算', () => {
    expect(isTerminalFailure('quota')).toBe(true)
    expect(isTerminalFailure('access')).toBe(true)
    expect(isTerminalFailure('param')).toBe(true)
    expect(isTerminalFailure('network')).toBe(false)
    expect(isTerminalFailure('audit')).toBe(false)
    // 审查拒收不算终因：模型和账号都是好的，改完描述再抽就能过；
    // 把它标成终因会让就绪度把一台当天成功过 5 次的模型红成不可用。
    expect(isTerminalFailure('moderation')).toBe(false)
    expect(isTerminalFailure('unknown')).toBe(false)
  })
})

function task(overrides: Partial<CallEvidenceRow>): CallEvidenceRow {
  return {
    provider: 'dashscope',
    model: 'wan2.7-t2v',
    status: 'FAILED',
    errorSnapshot: REAL.quota,
    updatedAt: new Date('2026-09-26T02:00:00Z'),
    ...overrides,
  }
}

describe('reduceCallEvidence', () => {
  it('失败任务里的整条候选链逐个记账：a → b 两个模型都真的试过并失败了', () => {
    const evidence = reduceCallEvidence([
      task({ model: 'qwen-image-3.0 → wan2.7-t2v', errorSnapshot: REAL.quota }),
    ])
    expect(evidence.get(callEvidenceKey('dashscope', 'qwen-image-3.0'))?.lastKind).toBe('quota')
    expect(evidence.get(callEvidenceKey('dashscope', 'wan2.7-t2v'))?.lastKind).toBe('quota')
  })

  it('胜负都计数，lastStatus 跟最后一次走', () => {
    const evidence = reduceCallEvidence([
      task({ status: 'SUCCEEDED', errorSnapshot: null, updatedAt: new Date('2026-09-24T00:00:00Z') }),
      task({ status: 'FAILED', updatedAt: new Date('2026-09-26T00:00:00Z') }),
      task({ status: 'SUCCEEDED', errorSnapshot: null, updatedAt: new Date('2026-09-25T00:00:00Z') }),
    ])
    const entry = evidence.get(callEvidenceKey('dashscope', 'wan2.7-t2v'))!
    expect(entry).toMatchObject({ ok: 2, failed: 1, lastStatus: 'FAILED', lastKind: 'quota' })
    expect(entry.lastAt.toISOString()).toBe(new Date('2026-09-26T00:00:00Z').toISOString())
  })

  it('provider 缺失也用同一个键，查得到而不是永远查不到', () => {
    const evidence = reduceCallEvidence([task({ provider: null })])
    expect(evidence.get(callEvidenceKey(null, 'wan2.7-t2v'))?.failed).toBe(1)
    expect(evidence.get(callEvidenceKey(undefined, ' wan2.7-t2v '))?.failed).toBe(1)
  })

  it('没有 model 的任务跳过：它证明不了任何一档模型通不通', () => {
    expect(reduceCallEvidence([task({ model: null })]).size).toBe(0)
  })
})
