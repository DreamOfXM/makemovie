import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReviewAskCard } from '@/components/generations/generations-panel'
import type { GenerationReview, GenerationTask } from '@/lib/api'
import { I18nProvider } from '@/lib/i18n'
import { SessionProvider } from '@/lib/session'

/**
 * SD-170：「本集重抽额度」是现值，不是快照。
 * reviewSnapshot.budgetUsed 冻在那次裁决发生的那一刻（10-22 冻下 6/63、10-23 冻下 4/63，
 * 中间没人重跑整集）——把它直接印成「本集重抽额度」就是「冻结快照当现值展示」，
 * 两张卡并排读数互相「倒退」。面板现在只许把后端随列表下发的活算值印成现值；
 * 后端没下发时才退回带时点的措辞（「该次裁决时」）。
 * 用 react-dom/server 静态渲染（本仓测试跑在 node 环境，无 DOM；语言缺省 en）。
 */

function reviewWith(overrides: Partial<GenerationReview>): GenerationReview {
  return {
    state: 'pending',
    retryClass: 'technical',
    kind: 'provider-exhausted',
    reasons: [],
    findings: [],
    score: null,
    attempt: 2,
    cap: 3,
    retriesUsed: 1,
    budgetLimit: 63,
    budgetUsed: 0,
    policy: 'auto2',
    autoRetries: 2,
    askReason: 'policy',
    artifactId: null,
    error: null,
    createdAt: '2026-10-22T07:00:00.000Z',
    ...overrides,
  }
}

function renderCard(review: GenerationReview, retryBudget?: { used: number; limit: number } | null): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <SessionProvider>
        <ReviewAskCard
          task={{ id: 'task-1', storyboardId: null } as GenerationTask}
          review={review}
          storyboards={[]}
          retryBudget={retryBudget}
          onReviewed={() => {}}
        />
      </SessionProvider>
    </I18nProvider>,
  )
}

describe('SD-170 本集重抽额度读数', () => {
  it('两张冻结值不同的快照，配同一个活算值，屏幕上只能读出同一个现值', () => {
    // 台账真形：10-22 那份快照冻了 6/63，10-23 那份冻了 4/63；活账本此刻是 20/63。
    const oct22 = renderCard(reviewWith({ budgetUsed: 6 }), { used: 20, limit: 63 })
    const oct23 = renderCard(reviewWith({ budgetUsed: 4 }), { used: 20, limit: 63 })
    expect(oct22).toContain('episode retry budget 20/63')
    expect(oct23).toContain('episode retry budget 20/63')
    // 现值行里不许再出现任何一份冻结读数——那正是「倒退」的来源。
    expect(oct22).not.toContain('retry budget 6/63')
    expect(oct23).not.toContain('retry budget 4/63')
  })

  it('后端没下发活算值时，快照数字必须自带「该次裁决时」的时点措辞，不冒充现值', () => {
    const html = renderCard(reviewWith({ budgetUsed: 6 }))
    expect(html).toContain('episode retry budget 6/63 at that review')
    expect(html).not.toMatch(/retry budget 6\/63(?! at)/)
  })
})

/**
 * SD-199：问询卡上「所有候选模型都没跑成」那几行，曾经把候选链的厂商报文原样印成正文。
 * 2026-10-25 在第七次死亡 EP1 实拍到的三条形：`AllocationQuota.FreeTierOnly`、
 * `InvalidParameter … url error`、`request_id=…` 加一条帮助文档链接——既没说该修什么，
 * 又把内部标识搬上屏。认得出因的走全站 `failure.cause.*`，原文只留在「展开」后面。
 */
describe('SD-199 问询卡不印厂商报文', () => {
  const quotaReason =
    'dashscope/qwen-image-3.0-pro: provider rejected the submission before accepting it — moving to the next candidate. ' +
    'AllocationQuota.FreeTierOnly: free quota exhausted (request_id=7f3c1e9a-2b44)'
  const paramReason =
    'wan2.6-t2v: InvalidParameter: url error, see https://help.aliyun.com/document_detail/2848774.html (request_id=0d91aa)'

  it('额度耗尽的候选链，收起态只出现人话因，错误码与 request_id 一条都不上屏', () => {
    const html = renderCard(reviewWith({ reasons: [quotaReason] }))
    expect(html).toContain('Model quota is exhausted')
    expect(html).not.toContain('AllocationQuota')
    expect(html).not.toContain('FreeTierOnly')
    expect(html).not.toContain('request_id')
    // 原文没被删掉，只是收进「展开」后面——所以展开入口必须还在。
    expect(html).toMatch(/>more</)
  })

  it('参数被拒的候选链同样换成人话，不泄漏帮助文档链接', () => {
    const html = renderCard(reviewWith({ reasons: [paramReason] }))
    expect(html).not.toContain('InvalidParameter')
    expect(html).not.toContain('help.aliyun.com')
    expect(html).not.toContain('request_id')
  })

  it('认不出因的候选句不硬编成额度，改说「展开看原文」', () => {
    const html = renderCard(reviewWith({ reasons: ['candidate chain stopped for an undocumented reason'] }))
    expect(html).not.toContain('Model quota is exhausted')
    expect(html).toContain('expand to read the message')
    // 与批次表错误列同一口径：认不出也不把原句铺在正文里，原文只给展开后。
    expect(html).not.toContain('candidate chain stopped')
  })
})
