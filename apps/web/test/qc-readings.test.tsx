import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QcReadings, type QcReadingsLike } from '@/components/shotboard/workbench/qc-readings'
import { I18nProvider, dictionaries } from '@/lib/i18n'

/**
 * SD-081：审核屏上只有一个总分，同一镜的多条 findings 又全挂在同一个时刻，
 * 于是「四秒里哪一秒崩了」读不出来。worker 一直有逐帧分/结构漂移/邻镜重复三组读数，
 * 这里钉住三件事：① 逐帧柱子的数量与位置就是报文里的采样点，不补点也不插值；
 * ② 「一帧都没量到」必须与「量到 0」分开说；③ 脏读数不出现 NaN、不把内部枚举上屏。
 */

function render(readings: QcReadingsLike | null, durationMs: number | null = 4096): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <QcReadings readings={readings} durationMs={durationMs} />
    </I18nProvider>,
  )
}

const scores = [
  { position: 0, score: 0.92 },
  { position: 0.25, score: 0.71 },
  { position: 0.5, score: 0.44 },
  { position: 0.75, score: 0.83 },
  { position: 1, score: 0.66 },
]

describe('质检读数上屏（SD-081）', () => {
  it('逐帧读数按采样点铺开：几条就几根柱子，横轴就是报文里的 position', () => {
    const html = render({ frameScores: scores })
    expect(html.match(/bg-primary\/70/g)).toHaveLength(scores.length)
    expect(html).toContain('left:50%')
    expect(html).toContain('height:44%')
    expect(html).toContain('5 samples')
    expect(html).toContain('4.1s')
  })

  it('结构漂移三项各报各的；缺哪项就不写哪项，不补 0', () => {
    const html = render({
      structureDrift: { measured: true, earlyLateDistance: 0.1585, firstMidDistance: null, maxStepDistance: 0.0123, sampleSeconds: [0, 2.048, 4.096] },
    })
    expect(html).toContain('0.16')
    expect(html).toContain('0.01')
    expect(html).toContain('early↔late')
    expect(html).toContain('max step')
    expect(html).not.toContain('first↔mid')
    expect(html).not.toContain('0.00')
  })

  it('「一帧都没量到」与「量到 0」是两句话', () => {
    const missing = render({ structureDrift: { measured: false, earlyLateDistance: null, firstMidDistance: null, maxStepDistance: null, sampleSeconds: [] } })
    expect(missing).toContain('not a single frame was measured')
    const measured = render({ structureDrift: { measured: true, earlyLateDistance: 0, firstMidDistance: 0, maxStepDistance: 0, sampleSeconds: [0, 1] } })
    expect(measured).toContain('0.00')
    expect(measured).not.toContain('not a single frame was measured')
  })

  it('邻镜重复四档都说人话：首镜不比、不同、几乎同图、无可比读数', () => {
    expect(render({ auditRepetition: { matchedArtifactId: null, pictureDistance: null, status: 'no-baseline' } })).toContain('first shot, nothing to compare')
    expect(render({ auditRepetition: { matchedArtifactId: 'a1', pictureDistance: 0.31, status: 'distinct' } })).toContain('distinct (distance 0.31)')
    const repeated = render({ auditRepetition: { matchedArtifactId: 'a2', pictureDistance: 0.02, status: 'repeated' } })
    expect(repeated).toContain('nearly the same picture')
    expect(repeated).toContain('a2')
    const unknown = render({ auditRepetition: { matchedArtifactId: null, pictureDistance: null, status: 'unknown' } })
    expect(unknown).toContain('no comparable reading')
    expect(unknown).not.toContain('auditRepetition')
  })

  it('脏读数不上屏：NaN、越界 position、非有限值逐个丢弃；全坏就整块不画', () => {
    const dirty = render({
      frameScores: [
        { position: Number.NaN, score: 0.5 },
        { position: 1.7, score: 0.5 },
        { position: 0.5, score: Number.POSITIVE_INFINITY },
        { position: 0.5, score: 0.6 },
      ],
      structureDrift: { measured: true, earlyLateDistance: Number.NaN, firstMidDistance: null, maxStepDistance: null, sampleSeconds: [] },
    })
    expect(dirty).not.toContain('NaN')
    expect(dirty).not.toContain('Infinity')
    expect(dirty.match(/bg-primary\/70/g)).toHaveLength(1)
    // measured=true 却一个距离都读不出来：那是「没可报的读数」，不是「一帧都没量到」。
    expect(dirty).toContain('no distances to report')
    expect(dirty).not.toContain('not a single frame was measured')
    expect(render({})).toBe('')
    expect(render(null)).toBe('')
  })

  it('两句都齐备：中英字典里每个键都有文案，且没有占位符错位', () => {
    for (const key of [
      'workbench.qc.frameScoresTitle',
      'workbench.qc.samples',
      'workbench.qc.frameScoresMissing',
      'workbench.qc.driftTitle',
      'workbench.qc.driftEarlyLate',
      'workbench.qc.driftFirstMid',
      'workbench.qc.driftMaxStep',
      'workbench.qc.driftMissing',
      'workbench.qc.driftUnreadable',
      'workbench.qc.repeat.noBaseline',
      'workbench.qc.repeat.distinct',
      'workbench.qc.repeat.repeated',
      'workbench.qc.repeat.unknown',
    ]) {
      expect(dictionaries.en[key], `${key} 缺 en 文案`).toBeTruthy()
      expect(dictionaries.zh[key], `${key} 缺 zh 文案`).toBeTruthy()
    }
    for (const key of ['workbench.qc.samples', 'workbench.qc.repeat.distinct', 'workbench.qc.repeat.repeated']) {
      expect(dictionaries.en[key]).toContain('{')
      expect(dictionaries.zh[key]).toContain('{')
    }
  })
})
