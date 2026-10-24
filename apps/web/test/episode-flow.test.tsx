import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EpisodeFlow, mediaQueue, type StageBlock } from '@/components/episode/episode-flow'
import type { Storyboard } from '@/lib/api'
import { I18nProvider } from '@/lib/i18n'
import { SessionProvider } from '@/lib/session'

/**
 * UX-P02 / UX-05：流程块与面板按 data-flow-step 声明的稳定 id 关联，不再按数组
 * 位置配对。用 react-dom/server 静态渲染（本仓测试跑在 node 环境，无 DOM）：
 * effects 不执行，useEpisodeProgress 停在初始 loading——进度恒为「source 是当前
 * 步」，恰好是断言折叠行为需要的确定状态。断言锚点用 data-flow-* 属性与既有
 * en 字典文案，不依赖尚待补齐的新 i18n 键的值。
 */

/** 与剧集页相同的 6 块结构：step-quality 是不占步骤的固定槽。 */
const BLOCKS: StageBlock[] = [
  { id: 'step-source', steps: ['source', 'script'] },
  { id: 'step-assets', steps: ['assets'] },
  { id: 'step-storyboards', steps: ['storyboards'] },
  { id: 'block-media', steps: ['media', 'composition'] },
  { id: 'step-quality', steps: [] },
  { id: 'step-delivery', steps: ['delivery'] },
]

function panel(id: string) {
  return (
    <div key={id} data-flow-step={id}>
      {`PANEL-${id}`}
    </div>
  )
}

function renderFlow(children: ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <SessionProvider>
        <EpisodeFlow episodeId="ep-1" storyboards={[]} blocks={BLOCKS}>
          {children}
        </EpisodeFlow>
      </SessionProvider>
    </I18nProvider>,
  )
}

const SIX_PANELS = [
  panel('step-source'),
  panel('step-assets'),
  panel('step-storyboards'),
  panel('block-media'),
  panel('step-quality'),
  panel('step-delivery'),
]

function shot(production: Storyboard['production'], firstFrame: boolean, video: boolean): Storyboard {
  return {
    id: `shot-${production}-${firstFrame}-${video}`,
    production,
    firstFrame: firstFrame ? { id: 'f' } : null,
    video: video ? { id: 'v' } : null,
  } as unknown as Storyboard
}

describe('流程页的生成队列', () => {
  it('只排视频镜：字卡/合成镜不进首帧与视频队列，也不虚报待生成数', () => {
    const { frameless, clipless } = mediaQueue([
      shot('video', false, false),
      shot('title-card', false, false),
      shot('composition', true, false),
      shot('screen-recording', false, false),
      shot('video', true, false),
      shot('video', true, true),
    ])
    expect(frameless.map(item => item.id)).toEqual(['shot-video-false-false'])
    expect(clipless.map(item => item.id)).toEqual(['shot-video-true-false'])
  })
})

describe('剧集流程的块与面板关联', () => {  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('6 块 6 面板：当前步骤面板展开，未到的步骤收起，步骤引导不丢', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const html = renderFlow(SIX_PANELS)
    // 引导在：步骤条 + 「还有 N 步没到」分组线。
    expect(html).toContain('This episode')
    expect(html).toContain('steps not reached')
    // 当前步骤（初始 loading 下是 source）的面板展开。
    expect(html).toContain('PANEL-step-source')
    // 未到的步骤收起：面板本体不渲染。
    expect(html).not.toContain('PANEL-step-assets')
    expect(html).not.toContain('PANEL-step-delivery')
    // steps=[] 的质检块不受折叠数学影响，也不出现「已完成 0 步」的空分组线。
    expect(html).toContain('PANEL-step-quality')
    expect(html).not.toContain('0 steps done')
    expect(html).not.toContain('data-flow-missing')
    expect(warn).not.toHaveBeenCalled()
  })

  it('6 块 8 面板（多两个非步骤面板）：步骤引导仍在，非步骤区可见且不折叠', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const html = renderFlow([
      ...SIX_PANELS,
      <div key="timeline">TIMELINE-PANEL</div>,
      <div key="extra">EXTRA-PANEL</div>,
    ])
    // 多出的面板不再触发整页回退：引导、当前步骤、折叠全部照常。
    expect(html).toContain('This episode')
    expect(html).toContain('steps not reached')
    expect(html).toContain('PANEL-step-source')
    expect(html).not.toContain('PANEL-step-delivery')
    // 非步骤区渲染两个多出的面板。
    expect(html).toContain('data-flow-nonstep')
    expect(html).toContain('TIMELINE-PANEL')
    expect(html).toContain('EXTRA-PANEL')
    // 合法的非步骤面板不是异常，不告警。
    expect(warn).not.toHaveBeenCalled()
  })

  it('缺一块面板：不静默丢弃——占位可见、其余结构照常，并 console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // step-source 的面板没有渲染：当前块只剩占位。
    const html = renderFlow(SIX_PANELS.slice(1))
    expect(html).toContain('data-flow-missing="step-source"')
    // 缺面板只影响那一块：步骤条、未到步骤的折叠、非步骤区（本例没有）照常。
    expect(html).toContain('This episode')
    expect(html).toContain('steps not reached')
    expect(html).not.toContain('PANEL-step-delivery')
    expect(html).not.toContain('data-flow-nonstep')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('step-source'))
  })

  it('声明不存在的块 id 与重复 id：告警，面板落到非步骤区而不是消失或串位', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const html = renderFlow([
      ...SIX_PANELS,
      panel('step-nope'),
      <div key="dup-delivery" data-flow-step="step-delivery">
        DUP-DELIVERY-PANEL
      </div>,
    ])
    // 未知 id 与重复 id 的面板都进非步骤区，可见不丢弃。
    expect(html).toContain('data-flow-nonstep')
    expect(html).toContain('PANEL-step-nope')
    expect(html).toContain('DUP-DELIVERY-PANEL')
    // 重复声明保留第一个：真正的 step-delivery 面板仍归块所有（当前收起不渲染），
    // 落到非步骤区的是第二个（DUP-），没有串位。
    expect(html).not.toContain('PANEL-step-delivery')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('step-nope'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate data-flow-step="step-delivery"'))
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
