import { describe, expect, it } from 'vitest'
import { referenceTraceCopy } from '@/components/generations/generations-panel'
import { shotReferenceDegradations } from '@/components/storyboards/storyboard-card'
import { dictionaries, type Locale } from '@/lib/i18n'
import type { GenerationStage, GenerationTask } from '@/lib/api'

/** 与 failure-cause.test.ts 同一套：断言直接读字典，键写错或少一门语言都会红。 */
function translator(locale: Locale) {
  return (key: string, params?: Record<string, string | number>): string => {
    const raw = dictionaries[locale][key] ?? dictionaries.en[key] ?? key
    return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  }
}

const zh = translator('zh')
const en = translator('en')

type Entry = Parameters<typeof referenceTraceCopy>[1]

const stamped = (channel: string, code: string, detail?: string): Entry => ({
  model: 'seedance-2.0-mini',
  conditioned: code === 'conditioned',
  reason: detail ? `[${channel}:${code}] ${detail}` : `[${channel}:${code}]`,
})

describe('SD-104 参考通道的人话映射', () => {
  // 台账实测原文（③）：worker 英文报文不许再上屏。
  const LEGACY_MODEL_REJECTS =
    'model "seedance-2.0-mini" does not take reference images; the generation ran without the approved asset sheets'

  it('两条通道分别命名，不再共用「参考图」一词', () => {
    const frame = referenceTraceCopy(zh, stamped('first_frame', 'conditioned'))
    const sheets = referenceTraceCopy(zh, stamped('asset_sheet', 'conditioned'))
    expect(frame.text).toContain('钦定首帧已作为视频起点')
    expect(sheets.text).toContain('素材定妆照已随本次生成送入')
    expect(frame.text).not.toBe(sheets.text)
    // 同模型一进一退（台账的 ②③ 矛盾）：两句必须分得开主次、不打对台。
    const skipped = referenceTraceCopy(zh, stamped('asset_sheet', 'model_rejects_reference_images', LEGACY_MODEL_REJECTS))
    expect(skipped.text).toContain('素材定妆照未参与本次生成')
    expect(skipped.text).toContain('seedance-2.0-mini')
  })

  it('内部报文不上屏、人话上屏、原文进 Tooltip', () => {
    for (const entry of [
      stamped('asset_sheet', 'model_rejects_reference_images', LEGACY_MODEL_REJECTS),
      stamped('first_frame', 'artifact_missing', 'the referenced first frame is no longer stored'),
      stamped('first_frame', 'gate_rejected', 'image is 4096 bytes over the 512 byte ceiling'),
      stamped('asset_sheet', 'unexpected_error', 'read failure'),
    ]) {
      const copy = referenceTraceCopy(zh, entry)
      expect(copy.text).not.toMatch(/reference images|no longer stored|bytes|failure/i)
      // Tooltip 兜原文：排查时证据不丢。
      expect(copy.raw).toBe(entry.reason)
    }
  })

  it('SD-104 之前的旧行（纯英文 reason、无机器码）也被映射，不原样上屏', () => {
    const legacy: Entry = { model: 'seedance-2.0-mini', conditioned: false, reason: LEGACY_MODEL_REJECTS }
    expect(referenceTraceCopy(zh, legacy).text).toContain('素材定妆照未参与本次生成')
    const legacySheetGone: Entry = { model: 'qwen-image-3.0', conditioned: false, reason: 'the referenced asset sheet is no longer stored' }
    expect(referenceTraceCopy(zh, legacySheetGone).text).toContain('该定妆照产物已不在存储中')
    // 完全认不出的报文：宁可通用句 + Tooltip，也不把报文顶上屏幕。
    const unknown: Entry = { model: 'm', conditioned: false, reason: 'never seen before' }
    expect(referenceTraceCopy(zh, unknown).text).not.toContain('never seen before')
    expect(referenceTraceCopy(zh, unknown).raw).toBe('never seen before')
  })

  it('旧数据（conditioned 无 reason）保持旧句，新码认不出时退回通用句', () => {
    const legacyUsed: Entry = { model: 'mock-i2v', conditioned: true }
    expect(referenceTraceCopy(zh, legacyUsed).text).toContain('mock-i2v')
    const futureCode = stamped('first_frame', 'brand_new_code')
    expect(referenceTraceCopy(zh, futureCode).text).toContain('原因见悬停原文')
  })

  it('英文一侧同样有条句、也不漏 worker 原文', () => {
    const copy = referenceTraceCopy(en, stamped('asset_sheet', 'model_rejects_reference_images', LEGACY_MODEL_REJECTS))
    expect(copy.text).toContain('does not take reference images')
    expect(copy.text).toContain('costume sheets')
    expect(copy.text).not.toMatch(/the generation ran without the approved asset sheets$/)
  })
})

/**
 * SD-104(d)：镜头卡上必须自己说一遍「这一镜没吃进定妆照」。
 * 台账实测 `shot_card_reference_lines: []`——降级只在展开批次深处可见，
 * 人逐镜评审时读不到，就会把画面质感当成已审批定妆照撑起来的。
 */
function refTask(stage: GenerationStage, reference: unknown[]): GenerationTask {
  return { stage, retryTrace: { attempt: 1, candidateErrors: [], reference } } as unknown as GenerationTask
}

const SHOT = 'shot-1'

describe('SD-104(d) 镜头卡的参考图降级行', () => {
  const rejects = [{ model: 'seedance-2.0-mini', conditioned: false, reason: '[asset_sheet:model_rejects_reference_images] ' + 'model "seedance-2.0-mini" does not take reference images' }]
  const conditioned = [{ model: 'wan2.6-i2v', conditioned: true, reason: '[asset_sheet:conditioned]' }]

  it('首帧与视频各有一条未条件化记录时，两行都上屏且各有出处', () => {
    const shots = new Map([
      [`${SHOT}:IMAGE`, refTask('IMAGE', conditioned)],
      [`${SHOT}:VIDEO`, refTask('VIDEO', rejects)],
    ])
    const lines = shotReferenceDegradations(zh, SHOT, shots)
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toContain('素材定妆照未参与本次生成')
    expect(lines[0].text).toContain('seedance-2.0-mini')
  })

  it('两个阶段都掉参考图时报两行，不合并成一句含混的「这次没吃进」', () => {
    const shots = new Map([
      [`${SHOT}:IMAGE`, refTask('IMAGE', rejects)],
      [`${SHOT}:VIDEO`, refTask('VIDEO', rejects)],
    ])
    expect(shotReferenceDegradations(zh, SHOT, shots)).toHaveLength(2)
  })

  it('正常吃进定妆照时零行——这不是故障也不是等你，不许天天占屏', () => {
    const shots = new Map([
      [`${SHOT}:IMAGE`, refTask('IMAGE', conditioned)],
      [`${SHOT}:VIDEO`, refTask('VIDEO', conditioned)],
    ])
    expect(shotReferenceDegradations(zh, SHOT, shots)).toEqual([])
  })

  it('旧数据（无 retryTrace / 无该镜任务 / 整个 map 缺失）不炸也不编造', () => {
    expect(shotReferenceDegradations(zh, SHOT, new Map([[`${SHOT}:IMAGE`, { stage: 'IMAGE', retryTrace: null } as unknown as GenerationTask]]))).toEqual([])
    expect(shotReferenceDegradations(zh, SHOT, new Map())).toEqual([])
    expect(shotReferenceDegradations(zh, SHOT, undefined)).toEqual([])
  })

  it('只认画面两阶段：配音通道的记录不混进这一行', () => {
    const shots = new Map([[`${SHOT}:AUDIO`, refTask('AUDIO', rejects)]])
    expect(shotReferenceDegradations(zh, SHOT, shots)).toEqual([])
  })

  it('上屏的是人话，worker 原文只留 Tooltip', () => {
    const shots = new Map([[`${SHOT}:VIDEO`, refTask('VIDEO', rejects)]])
    const [line] = shotReferenceDegradations(zh, SHOT, shots)
    expect(line.text).not.toMatch(/does not take reference images/i)
    expect(line.raw).toContain('does not take reference images')
  })
})
