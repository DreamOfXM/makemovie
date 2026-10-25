import { describe, expect, it } from 'vitest'
import { callEvidenceKey, classifyComposeBlock, classifyFailure, composeBlockKinds, isTerminalFailure, reduceCallEvidence, type CallEvidenceRow, type ComposeBlockKind } from '../src/index.js'

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
  // 2026-10-23 从第 1 集 16 个卡死镜头的 SubmissionAttempt.errorSnapshot 原样抄回：
  // 火山同步回了「预扣费没通过」——钱没扣、单没接，可这套报文当年不在模式里，分类
  // 落成 unknown → 台账按「上游可能已接单」永久占槽，界面重抽一次撞一次槽位。
  seedanceQuota: 'insufficient_user_quota | 预扣费额度失败, 用户剩余额度: 灵感2.180000, 需要预扣费额度: 灵感2.300000',
} as const

describe('classifyFailure', () => {
  it('把额度耗尽认成 quota，而不是「没过线」', () => {
    expect(classifyFailure(REAL.quota)).toBe('quota')
  })

  it('火山的「预扣费额度失败」是额度，不是含糊的未知提交', () => {
    expect(classifyFailure(REAL.seedanceQuota)).toBe('quota')
    expect(isTerminalFailure(classifyFailure(REAL.seedanceQuota))).toBe(true)
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

// 合成整集停在「已阻塞」时，worker 写进 Composition.errorSnapshot 的原文（逐条从
// apps/worker/src/compose.ts 的 throw 抄回，占位符换成真实形状的 id）。界面不说原文，
// 只说这一档归类翻成人话的那句——归错档就等于给用户一句错的修法。
const COMPOSE_RAW: readonly { kind: ComposeBlockKind; raw: string }[] = [
  { kind: 'seam_unconditioned', raw: "storyboard sbx01: take 2 is not conditioned on take 1's end frame — the splice has a visible seam and will not render as one shot" },
  { kind: 'snapshot_drift', raw: "storyboard sbx01: the frozen take set no longer matches the master's own segments — the master was rebuilt after this composition was queued; re-compose to pick up the current cuts" },
  { kind: 'snapshot_drift', raw: 'storyboard sbx01: the frozen snapshot splice takes 3 segments but the video artifact is not a spliced master — re-compose this episode' },
  { kind: 'selection_stale', raw: "storyboard's locked video selection art0001 no longer resolves — fix the selection before composing" },
  { kind: 'selection_stale', raw: 'storyboard has lockedVideoSelection but no selectedVideoArtifactId — lock means "keep this", so a selection must exist' },
  { kind: 'selection_stale', raw: 'storyboard sbx01: frozen video artifact art0001 no longer resolves — re-compose this episode' },
  { kind: 'edit_clip_unknown', raw: 'edit clip clip-1 references artifact art0002 that is not a video of this shot — fix the edit before composing' },
  { kind: 'edit_clip_unknown', raw: 'edit track trk-1 anchors a hidden or unknown clip — fix the edit before composing' },
  { kind: 'edit_source_missing', raw: 'edit track trk-1 source artifact art0003 not found — fix the edit before composing' },
  { kind: 'clip_not_editable', raw: 'failed to conform clip for storyboard sbx01 to 25/1 CFR before trimming — raw source is not editable media' },
  { kind: 'trim_failed', raw: 'failed to trim clip for storyboard sbx01 [0,125) at 25.000fps' },
  { kind: 'wrong_episode', raw: 'storyboard sbx01 does not belong to episode ep0001' },
  { kind: 'missing_video', raw: 'storyboard sbx01 has no succeeded video artifact (resolved at queue time)' },
  { kind: 'missing_video', raw: 'storyboard sbx01 has no succeeded video artifact' },
]

describe('classifyComposeBlock', () => {
  it('每一条 worker 原文归到它自己那一档', () => {
    for (const { kind, raw } of COMPOSE_RAW) expect(classifyComposeBlock(raw), raw).toBe(kind)
  })

  it('除 unknown 外每一档都有真句子够得着——字典里的句子不会空挂', () => {
    expect(new Set(COMPOSE_RAW.map(entry => entry.kind))).toEqual(new Set(composeBlockKinds.filter(kind => kind !== 'unknown')))
  })

  it('认不出的原文落进 unknown，绝不硬套一档给用户一句错的修法', () => {
    expect(classifyComposeBlock('ffmpeg exited with code 137')).toBe('unknown')
    expect(classifyComposeBlock(null)).toBe('unknown')
  })

  it('裁切失败里「源不是可剪画面」优先于泛用的裁切失败', () => {
    // 同一句里两个模式都能命中，归错档界面上就只说「文件可能坏了」，用户会重生成一个照样剪不动的镜头。
    expect(classifyComposeBlock(COMPOSE_RAW.find(entry => entry.kind === 'clip_not_editable')!.raw)).toBe('clip_not_editable')
  })
})
