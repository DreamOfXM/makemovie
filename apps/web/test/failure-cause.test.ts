import { describe, expect, it } from 'vitest'
import { composeBlockKinds, failureKinds } from '@studio/domain'
import { assetFailureCopy, auditAttempts, COMPOSE_BLOCK_KEY, FAILURE_CAUSE_KEY, failureCauseCopy, mediaFailureCopy, taskFailureCopy } from '@/lib/failure-cause'
import { dictionaries, type Locale } from '@/lib/i18n'

/** 与 shot-verdict.test.ts 同一套：断言直接读字典，键写错或少一门语言都会红。 */
function translator(locale: Locale) {
  return (key: string, params?: Record<string, string | number>): string => {
    const raw = dictionaries[locale][key] ?? dictionaries.en[key] ?? key
    return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  }
}

const zh = translator('zh')
const en = translator('en')

// 两条都是本机库里真发生过的报文（2026-09-27 素材批）。
const AUDIT_MISSED = 'visual-audit: threshold not met after 3 attempts'
const MODERATION_CHAIN =
  '["dashscope/wan2.2-t2i-flash: DataInspectionFailed | Input data may contain inappropriate content.", "dashscope/qwen-image-3.0: AllocationQuota.FreeTierOnly | Free quota exhausted."]'
const QUOTA_CHAIN = '["dashscope/wan2.7-t2v: AllocationQuota.FreeTierOnly | Free quota exhausted."]'

describe('素材红条那句人话', () => {
  /** 用户实测：红条上印着 `visual-audit: threshold not met after 3 attempts`，
   *  一句英文内部报文对着一整屏中文——这一条就是拦住它回归的。 */
  it('worker 的英文原文不再直接上屏', () => {
    const copy = assetFailureCopy(zh, AUDIT_MISSED)
    expect(copy).toBe('连抽 3 次都没过合格线 · 调整描述后重试')
    expect(copy).not.toMatch(/threshold|visual-audit|attempts/i)
  })

  it('内容审查与额度并存的候选链，说的是审查而不是充值', () => {
    expect(assetFailureCopy(zh, MODERATION_CHAIN)).toBe(
      '模型内容审查未通过 · 与额度无关，请调整描述中的敏感表述后重试',
    )
    expect(assetFailureCopy(zh, QUOTA_CHAIN)).toContain('模型额度已用尽')
  })

  it('认不出原因的报文退回通用句，宁可少说也不把报文顶上屏幕', () => {
    expect(assetFailureCopy(zh, 'something never seen before')).toBe('上一次生成失败了。')
    expect(assetFailureCopy(zh, null)).toBe('上一次生成失败了。')
  })

  it('英文那一侧同样不漏原文，也不缺句子', () => {
    expect(assetFailureCopy(en, AUDIT_MISSED)).toBe(
      'Re-rolled 3 times without clearing the quality line · adjust the description and retry',
    )
    expect(assetFailureCopy(en, MODERATION_CHAIN)).toBe(
      'Blocked by the model’s content review · this is not a quota problem, rephrase the description and re-roll',
    )
  })
})

describe('auditAttempts', () => {
  it('只报报文里真写了的次数，认不出就返回 null', () => {
    expect(auditAttempts(AUDIT_MISSED)).toBe(3)
    expect(auditAttempts('visual-audit: threshold not met after 1 attempt')).toBe(1)
    expect(auditAttempts('visual-audit: auditor could not judge')).toBeNull()
    expect(auditAttempts(null)).toBeNull()
  })
})

describe('原因表', () => {
  /** 新增一族失败却没配文案时，界面上印出来的就是键名。这一条把口子堵住。 */
  it('每个失败族都有归属：要么配了句子键，要么明写没有', () => {
    expect(Object.keys(FAILURE_CAUSE_KEY).sort()).toEqual([...failureKinds].sort())
    expect(FAILURE_CAUSE_KEY.audit).toBeNull()
    expect(FAILURE_CAUSE_KEY.unknown).toBeNull()
    for (const kind of failureKinds) {
      const key = FAILURE_CAUSE_KEY[kind]
      if (!key) continue
      expect(key, `${kind} 缺中英文案`).toBeTruthy()
      expect(dictionaries.en[key], `${kind} 缺英文`).toBeDefined()
      expect(dictionaries.zh[key], `${kind} 缺中文`).toBeDefined()
    }
  })
})

/**
 * SD-167/SD-168 的现场报文：库里这条 FAILED 任务的 errorSnapshot 就是这一句，
 * 而它对应的产物是一条 4 秒、放得出来、停在「等你裁决」上的付费成片。
 * 这一条同时是「红条印英文内部串」和「有画面却说没有画面」两个缺陷的输入。
 */
const PARKED_MSG = 'visual-audit: threshold not met — awaiting review (policy)'

describe('镜头卡与逐镜履历那句人话（SD-167）', () => {
  it('内部报文从任何一档都不上屏', () => {
    for (const stage of ['frame', 'video', 'audio'] as const) {
      for (const state of [
        { playable: false },
        { playable: true },
        { playable: true, parked: true },
      ]) {
        const copy = mediaFailureCopy(zh, stage, PARKED_MSG, state)
        expect(copy, `${stage} 把报文顶上了屏幕`).not.toMatch(/threshold|visual-audit|policy|awaiting review/i)
        expect(copy, `${stage} 界面上印的是键名`).not.toMatch(/^(shotboard|storyboards|assets|failure)\./)
      }
    }
  })

  /** 这就是 SD-168 的另一半：同一个面板一边放得出来，一边说没有画面。 */
  it('有可播的那一版、停在等你裁决的那一版、一件没有，三档分开说', () => {
    const none = mediaFailureCopy(zh, 'video', PARKED_MSG, { playable: false })
    const playable = mediaFailureCopy(zh, 'video', PARKED_MSG, { playable: true })
    const parked = mediaFailureCopy(zh, 'video', PARKED_MSG, { playable: true, parked: true })
    expect(none).toBe(dictionaries.zh['shotboard.reason.videoFailed'])
    expect(playable).toBe(dictionaries.zh['shotboard.reason.videoRetry'])
    expect(parked).toBe(dictionaries.zh['shotboard.reason.videoParked'])
    expect(new Set([none, playable, parked]).size).toBe(3)
    expect(none).toContain('还没有画面')
    expect(parked).toContain('可播')
  })

  it('没过线且报得出次数时报次数，终因时报终因而不是「再抽一次」', () => {
    expect(mediaFailureCopy(zh, 'video', AUDIT_MISSED, { playable: false }))
      .toBe(dictionaries.zh['assets.failure.audit'].replace('{count}', '3'))
    expect(mediaFailureCopy(zh, 'video', QUOTA_CHAIN, { playable: false })).toContain('模型额度已用尽')
    expect(mediaFailureCopy(zh, 'frame', QUOTA_CHAIN, { playable: false })).not.toContain('重抽')
  })

  it('英文那一侧同样不漏报文，也不缺句子', () => {
    expect(mediaFailureCopy(en, 'video', PARKED_MSG, { playable: true, parked: true }))
      .toBe(dictionaries.en['shotboard.reason.videoParked'])
    expect(mediaFailureCopy(en, 'audio', 'some never seen message', { playable: false }))
      .toBe(dictionaries.en['storyboards.voiceFailed'])
    expect(mediaFailureCopy(en, 'frame', PARKED_MSG, { playable: false })).not.toMatch(/threshold|visual-audit/i)
  })
})

/**
 * 履历行每一行都是「某一版」的记录：那一版有没有画面由行本身和状态徽章说。
 * 把镜头卡那句搬过来，会在一条放得出来的 4s 旁边写「这一镜还没有画面」，
 * 所以这一档只报认得出的因，认不出就闭嘴。
 */
describe('履历行只报因（SD-167）', () => {
  it('终因给出那一句，没过线与认不出都返回 null', () => {
    expect(failureCauseCopy(zh, QUOTA_CHAIN)).toBe(dictionaries.zh['failure.cause.quota'])
    expect(failureCauseCopy(zh, MODERATION_CHAIN)).toBe(dictionaries.zh['failure.cause.moderation'])
    expect(failureCauseCopy(zh, PARKED_MSG)).toBeNull()
    expect(failureCauseCopy(zh, AUDIT_MISSED)).toBeNull()
    expect(failureCauseCopy(zh, 'something never seen before')).toBeNull()
    expect(failureCauseCopy(zh, null)).toBeNull()
  })

  it('非空的返回永远是一句人话，两套语言都在字典里', () => {
    for (const locale of ['zh', 'en'] as Locale[]) {
      const say = translator(locale)
      for (const raw of [QUOTA_CHAIN, MODERATION_CHAIN, 'AccessDenied', 'InvalidParameter x', 'fetch failed']) {
        const copy = failureCauseCopy(say, raw)
        expect(copy, `${raw} 在 ${locale} 下没有句子`).not.toBeNull()
        expect(copy).not.toMatch(/^(shotboard|storyboards|assets|failure)\./)
        expect(copy).not.toMatch(/visual-audit|threshold not met/i)
      }
    }
  })
})

/**
 * 批次表「错误」列（SD-167 的另一处）：一行可能是任何阶段，句子不许替它猜阶段——
 * 镜头卡那句「这一镜还没有画面」和素材那句「调整描述后重试」搬到这里都会说错话。
 */
describe('批次表错误列（SD-167）', () => {
  it('内部报文收进展开，收起态永远是一句人话', () => {
    for (const raw of [PARKED_MSG, AUDIT_MISSED, QUOTA_CHAIN, MODERATION_CHAIN, 'something never seen before', null]) {
      for (const locale of ['zh', 'en'] as Locale[]) {
        const copy = taskFailureCopy(translator(locale), raw)
        expect(copy, `${raw} 在 ${locale} 下把报文顶上了屏幕`).not.toMatch(/threshold|visual-audit|DataInspectionFailed|AllocationQuota/i)
        expect(copy, `${raw} 在 ${locale} 下印的是键名`).not.toMatch(/^(shotboard|storyboards|assets|failure|generations)\./)
      }
    }
  })

  it('只报这一行自己的事，不替别的表面下结论', () => {
    expect(taskFailureCopy(zh, PARKED_MSG)).toBe(dictionaries.zh['generations.errorCause.audit'])
    expect(taskFailureCopy(zh, AUDIT_MISSED)).toBe('连抽 3 次都没过合格线')
    expect(taskFailureCopy(zh, 'something never seen before')).toBe(dictionaries.zh['generations.errorCause.unknown'])
    expect(taskFailureCopy(zh, QUOTA_CHAIN)).toBe(dictionaries.zh['failure.cause.quota'])
    // 「这一镜还没有画面」归镜头卡，「调整描述后重试」归素材行——批次表都不该说。
    expect(taskFailureCopy(zh, PARKED_MSG)).not.toContain('没有画面')
    expect(taskFailureCopy(zh, AUDIT_MISSED)).not.toContain('调整描述')
  })
})

/** 2026-09-28 事故集回放：断言用真实事故里抄来的报文原文，档位必须可分辨。
 *  新增失败形态先到这里补一条——红条上的每档人话都对应一种用户动作。 */
describe('事故回放：四档可分辨', () => {
  it('内容审查（红色房产证原文）→ 改词档', () => {
    const raw = 'dashscope/wan2.2-t2i-flash: DataInspectionFailed | Input data may contain inappropriate content. For details: see: https://help.aliyun.com'
    expect(assetFailureCopy(zh, raw)).toBe(dictionaries.zh['failure.cause.moderation'])
  })

  it('审计失声（楼道 no parseable verdict 原文）→ 重跑档', () => {
    expect(assetFailureCopy(zh, 'visual-audit: dashscope/qwen3-vl-flash returned no parseable verdict'))
      .toBe(dictionaries.zh['assets.failure.auditorSilent'])
  })

  it('没过线（房屋转让协议原文）→ 改描述档并带次数', () => {
    expect(assetFailureCopy(zh, 'visual-audit: threshold not met after 3 attempts'))
      .toBe(dictionaries.zh['assets.failure.audit'].replace('{count}', '3'))
  })
})

/**
 * SD-177：合成停在「已阻塞」时卡片上那句人话。Record 的穷举由编译期保证，这里保证另一半
 * ——每一档在两套字典里都真有一句话，且每句都带着「去哪修」而不是复述一遍状态。
 */
describe('合成阻塞原因表', () => {
  it('每一档阻塞都有中英两句', () => {
    expect(Object.keys(COMPOSE_BLOCK_KEY).sort()).toEqual([...composeBlockKinds].sort())
    for (const kind of composeBlockKinds) {
      const key = COMPOSE_BLOCK_KEY[kind]
      expect(dictionaries.en[key], `${kind} 缺英文`).toBeDefined()
      expect(dictionaries.zh[key], `${kind} 缺中文`).toBeDefined()
    }
  })

  it('每句话都给得出下一步动作', () => {
    for (const kind of composeBlockKinds) {
      const sentence = zh(COMPOSE_BLOCK_KEY[kind])
      expect(sentence, `${kind} 在界面上印出的是键名`).not.toBe(COMPOSE_BLOCK_KEY[kind])
      // unknown 是承不起原因的那一档，只能承认说不出、把原文留给悬停提示。
      if (kind === 'unknown') continue
      expect(sentence, `${kind} 只报了状态，没说去哪修`).toMatch(/重新合成|重跑/)
    }
  })
})
