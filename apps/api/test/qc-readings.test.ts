import { describe, expect, it } from 'vitest'
import { parseQcReadings } from '../src/lib/qc-readings.js'

describe('parseQcReadings', () => {
  it('reads the three readings out of a report the worker actually writes', () => {
    const report = JSON.stringify({
      kind: 'visual-audit',
      threshold: 0.7,
      reasons: ['visual-audit: 结构漂移'],
      findings: [{ dimension: 'continuity', severity: 'warning', message: '肩部结构件消失', evidenceTimeSeconds: 2.048 }],
      frameScores: [
        { position: 0, score: 0.92 },
        { position: 0.33, score: 0.74 },
        { position: 0.67, score: 0.41 },
        { position: 1, score: 0.28 },
      ],
      structureDrift: {
        measured: true,
        earlyLateDistance: 0.1585,
        firstMidDistance: 0.1132,
        maxStepDistance: 0.0741,
        sampleSeconds: [0, 0.45, 1.5, 2.55],
      },
      auditRepetition: { matchedArtifactId: 'artifact-prior', pictureDistance: 0.2419, status: 'repeated' },
    })

    expect(parseQcReadings(report)).toEqual({
      frameScores: [
        { position: 0, score: 0.92 },
        { position: 0.33, score: 0.74 },
        { position: 0.67, score: 0.41 },
        { position: 1, score: 0.28 },
      ],
      structureDrift: {
        measured: true,
        earlyLateDistance: 0.1585,
        firstMidDistance: 0.1132,
        maxStepDistance: 0.0741,
        sampleSeconds: [0, 0.45, 1.5, 2.55],
      },
      auditRepetition: { matchedArtifactId: 'artifact-prior', pictureDistance: 0.2419, status: 'repeated' },
    })
  })

  it('degrades garbage to null instead of throwing or smuggling a non-number onto the wire', () => {
    // 非 JSON / 空值 / 只有旧字段：整份没有读数。
    expect(parseQcReadings('not json')).toBeNull()
    expect(parseQcReadings('null')).toBeNull()
    expect(parseQcReadings('')).toBeNull()
    expect(parseQcReadings('   ')).toBeNull()
    expect(parseQcReadings(null)).toBeNull()
    expect(parseQcReadings(undefined)).toBeNull()
    expect(parseQcReadings('{"reasons":["threshold not met"]}')).toBeNull()
    expect(parseQcReadings('{"frameScores":[],"structureDrift":null,"auditRepetition":null}')).toBeNull()

    // 逐帧分：越界、类型不对、缺字段、非对象的条目逐条丢弃，有效的留下。
    expect(parseQcReadings(JSON.stringify({
      frameScores: [
        { position: 0, score: 1 },
        { position: 1.5, score: 0.5 },
        { position: 0.5, score: -0.1 },
        { position: '0.5', score: 0.5 },
        { position: 0.5 },
        null,
        { position: 0.25, score: 0.75 },
      ],
      structureDrift: { measured: 'yes' },
      auditRepetition: { status: 'nonsense' },
    }))).toEqual({
      frameScores: [{ position: 0, score: 1 }, { position: 0.25, score: 0.75 }],
      structureDrift: null,
      auditRepetition: null,
    })

    // 1e999 会被 JSON.parse 读成 Infinity：Number.isFinite 必须把它拦在边界上。
    expect(parseQcReadings('{"frameScores":[{"position":0.5,"score":1e999}]}')).toBeNull()

    // 结构漂移里坏掉的距离降成 null，样本时刻逐条过滤；measured:false 本身是有意义的读数。
    expect(parseQcReadings(JSON.stringify({
      structureDrift: { measured: true, earlyLateDistance: '0.2', firstMidDistance: 0.3, maxStepDistance: 1e999, sampleSeconds: [0, 'x', 1.5] },
    }))).toEqual({
      frameScores: [],
      structureDrift: { measured: true, earlyLateDistance: null, firstMidDistance: 0.3, maxStepDistance: null, sampleSeconds: [0, 1.5] },
      auditRepetition: null,
    })
    expect(parseQcReadings('{"structureDrift":{"measured":false,"earlyLateDistance":null,"firstMidDistance":null,"maxStepDistance":null,"sampleSeconds":[]}}'))
      .toEqual({
        frameScores: [],
        structureDrift: { measured: false, earlyLateDistance: null, firstMidDistance: null, maxStepDistance: null, sampleSeconds: [] },
        auditRepetition: null,
      })

    // 复印件读数：状态词表外的整条丢弃，词表内的坏距离降 null 但状态仍下发。
    expect(parseQcReadings('{"auditRepetition":{"matchedArtifactId":7,"pictureDistance":"0.2","status":"unknown"}}')).toEqual({
      frameScores: [],
      structureDrift: null,
      auditRepetition: { matchedArtifactId: null, pictureDistance: null, status: 'unknown' },
    })
  })

  it('clamps an oversized frame-score array to 24 instead of dropping the whole report', () => {
    const frameScores = Array.from({ length: 30 }, (_, index) => ({ position: index / 30, score: index / 30 }))
    const readings = parseQcReadings(JSON.stringify({ frameScores }))
    expect(readings?.frameScores).toHaveLength(24)
    expect(readings?.frameScores[0]).toEqual({ position: 0, score: 0 })
    expect(readings?.frameScores[23]).toEqual({ position: 23 / 30, score: 23 / 30 })
  })

  it('returns null for an empty report object', () => {
    expect(parseQcReadings('{}')).toBeNull()
  })
})
