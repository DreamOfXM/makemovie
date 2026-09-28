import { describe, expect, it } from 'vitest'
import { failureKinds } from '@studio/domain'
import { assetFailureCopy, auditAttempts, FAILURE_CAUSE_KEY } from '@/lib/failure-cause'
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
