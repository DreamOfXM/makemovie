import { describe, expect, it } from 'vitest'
import { readCompositionReview, reviewGapCodes } from '../src/index.js'

// 一集两镜的最小台账：每个用例只改自己要验的那一处，其余保持齐全。
// 键形状与 compose worker 落库那份逐字一致（resolved.shots + cuts + audio + beds）。
const S1 = 'sbx_0000000000000000000000001'
const S2 = 'sbx_0000000000000000000000002'

interface LedgerOptions {
  clipMs?: number[] | null
  kindAt?: string[] | null
  overlapMs?: number[] | null
  headFadeMs?: number
  tailFadeMs?: number
  blended?: boolean
  transitions?: (string | null)[]
  dialogues?: (string | null)[]
  voiceArtifactIds?: (string | null)[]
  modes?: (string | null)[]
  beds?: Array<{ imported: boolean }>
}

function ledger(options: LedgerOptions = {}): string {
  const clipMs = options.clipMs ?? [4000, 9000]
  return JSON.stringify({
    resolved: {
      shots: [S1, S2].map((storyboardId, index) => ({
        storyboardId,
        videoArtifactId: `art_${index}`,
        dialogue: options.dialogues?.[index] ?? (index === 0 ? '你回来了。' : null),
        subtitle: options.dialogues?.[index] ?? '',
        audioSource: 'tts',
        voiceArtifactId: options.voiceArtifactIds?.[index] ?? (index === 0 ? `voice_${index}` : null),
        ambienceArtifactId: null,
        transition: options.transitions === undefined ? 'cut' : options.transitions[index] ?? 'cut',
        transitionMs: 500,
      })),
      musicArtifactId: null,
    },
    audio: {
      [S1]: { mode: options.modes?.[0] ?? 'voice', voiceArtifactId: options.voiceArtifactIds?.[0] ?? 'voice_0', ambienceArtifactId: null },
      [S2]: { mode: options.modes?.[1] ?? null, voiceArtifactId: options.voiceArtifactIds?.[1] ?? null, ambienceArtifactId: null },
    },
    beds: options.beds ?? [],
    cuts: {
      blended: options.blended ?? false,
      fps: 25,
      kindAt: options.kindAt ?? ['cut', 'cut'],
      overlapMs: options.overlapMs ?? [0, 0],
      clipMs,
      shotStartMs: [0, clipMs[0]!],
      headFadeMs: options.headFadeMs ?? 0,
      tailFadeMs: options.tailFadeMs ?? 0,
      totalMs: clipMs.reduce((sum, ms) => sum + ms, 0),
      storyboardIds: [S1, S2],
    },
  })
}

describe('验收三读数', () => {
  it('三项齐全才允许验收', () => {
    const readings = readCompositionReview({ manifest: ledger({ clipMs: [4000, 9000] }), masterDurationMs: 13000 })
    expect(readings.complete).toBe(true)
    expect(reviewGapCodes(readings)).toEqual([])
  })

  it('节奏吃母带实测片长，不吃逐镜跨度求和', () => {
    // 转场重叠会真实缩短母带：跨度合计 13000、母带实测 12500，分母必须是后者。
    const readings = readCompositionReview({ manifest: ledger(), masterDurationMs: 12500 })
    expect(readings.rhythm.readings?.totalMs).toBe(12500)
    expect(readings.rhythm.readings?.avgShotMs).toBe(6250)
    expect(readings.rhythm.readings?.longTakeCount).toBe(1)
    expect(readings.rhythm.readings?.longTakeShare).toBeCloseTo(9000 / 12500, 5)
  })

  it('母带没探到时长只缺节奏一项，转场与声音照样读得出', () => {
    const readings = readCompositionReview({ manifest: ledger(), masterDurationMs: null })
    expect(readings.rhythm.gaps).toEqual(['masterDuration'])
    expect(readings.transition.present).toBe(true)
    expect(readings.sound.present).toBe(true)
    expect(reviewGapCodes(readings)).toEqual(['rhythm:masterDuration'])
  })

  it('旧合成只有 storyboardIds：三轴全缺，不拿标称值补一个假读数', () => {
    const readings = readCompositionReview({ manifest: JSON.stringify({ storyboardIds: [S1, S2] }), masterDurationMs: null })
    expect(readings.rhythm.readings).toBeNull()
    expect(readings.transition.kinds).toEqual([])
    expect(readings.complete).toBe(false)
    expect(reviewGapCodes(readings)).toEqual([
      'rhythm:masterDuration',
      'rhythm:shotSpans',
      'transition:cutTable',
      'sound:audioLedger',
    ])
  })

  it('台账坏 JSON / null 与旧合成同口径：读不出就是读不出', () => {
    for (const manifest of [null, undefined, '{not json']) {
      const readings = readCompositionReview({ manifest, masterDurationMs: 12000 })
      expect(readings.complete).toBe(false)
      expect(readings.rhythm.gaps).toContain('shotSpans')
    }
  })

  it('跨度表对不上刀数就整份算读不出——不做取到几个算几个的半真读数', () => {
    const readings = readCompositionReview({ manifest: ledger({ clipMs: [4000, 9000, 2000] }), masterDurationMs: 15000 })
    expect(readings.rhythm.gaps).toEqual(['shotSpans'])
    // 刀数本身还在，转场轴不受跨度表损坏牵连。
    expect(readings.transition.present).toBe(true)
  })

  it('零长度跨度当读不出：探针没给出数的镜子不能参与平均', () => {
    const readings = readCompositionReview({ manifest: ledger({ clipMs: [4000, 0] }), masterDurationMs: 4000 })
    expect(readings.rhythm.gaps).toEqual(['shotSpans'])
  })

  it('62 刀裸切不是缺项：一刀不使也照样有台账，只把刀数摆出来', () => {
    const readings = readCompositionReview({
      manifest: ledger({ transitions: ['cut', 'cut'], clipMs: [4000, 9000] }),
      masterDurationMs: 13000,
    })
    expect(readings.transition.present).toBe(true)
    expect(readings.transition.blended).toBe(false)
    expect(readings.transition.blendedSeamCount).toBe(0)
    expect(readings.transition.requestedNonCutCount).toBe(0)
    expect(readings.complete).toBe(true)
  })

  it('点了转场却没落进母带：两个数各自摆着，不替人判该不该拦', () => {
    const readings = readCompositionReview({
      manifest: ledger({ transitions: ['dissolve', 'fade_in'], blended: false, overlapMs: [0, 0] }),
      masterDurationMs: 13000,
    })
    expect(readings.transition.requestedNonCutCount).toBe(2)
    expect(readings.transition.blendedSeamCount).toBe(0)
    expect(readings.transition.present).toBe(true)
  })

  it('片头淡入也算一刀混合，哪怕中段全是硬切', () => {
    const readings = readCompositionReview({ manifest: ledger({ headFadeMs: 480, blended: true }), masterDurationMs: 13000 })
    expect(readings.transition.blendedSeamCount).toBe(1)
    expect(readings.transition.blended).toBe(true)
  })

  it('有台词却在母带里没人声 = 缺项（SD-181 那一类）', () => {
    const readings = readCompositionReview({
      manifest: ledger({ dialogues: ['你回来了。', '别走。'], voiceArtifactIds: ['voice_0', null], modes: ['voice', null] }),
      masterDurationMs: 13000,
    })
    expect(readings.sound.silentDialogueShots).toEqual([2])
    expect(readings.complete).toBe(false)
    expect(reviewGapCodes(readings)).toEqual(['sound:silentDialogue'])
  })

  it('原声档的人声就在素材自带音轨里，不算静音', () => {
    const readings = readCompositionReview({
      manifest: ledger({ dialogues: ['你回来了。', '别走。'], voiceArtifactIds: [null, null], modes: ['native', 'native'] }),
      masterDurationMs: 13000,
    })
    expect(readings.sound.silentDialogueShots).toEqual([])
    expect(readings.sound.dialogueShotCount).toBe(2)
    expect(readings.complete).toBe(true)
  })

  it('「原声+配音」缺配音件只是少一层叠加，不许判成静音', () => {
    const readings = readCompositionReview({
      manifest: ledger({ dialogues: ['你回来了。', '别走。'], voiceArtifactIds: [null, null], modes: ['voice_native', 'voice_native'] }),
      masterDurationMs: 13000,
    })
    expect(readings.sound.silentDialogueShots).toEqual([])
    expect(readings.complete).toBe(true)
  })

  it('没台词的镜子静音不算缺项：字卡镜本来就不该有人声', () => {
    const readings = readCompositionReview({
      manifest: ledger({ dialogues: ['你回来了。', null], voiceArtifactIds: ['voice_0', null] }),
      masterDurationMs: 13000,
    })
    expect(readings.sound.dialogueShotCount).toBe(1)
    expect(readings.sound.silentDialogueShots).toEqual([])
    expect(readings.complete).toBe(true)
  })

  it('声音台账没覆盖每一镜就判不了静音——缺项报 audioLedger 而不是"全都静音"', () => {
    const manifest = JSON.parse(ledger({ dialogues: ['你回来了。', '别走。'] }))
    delete manifest.audio[S2]
    const readings = readCompositionReview({ manifest: JSON.stringify(manifest), masterDurationMs: 13000 })
    expect(readings.sound.gaps).toEqual(['audioLedger'])
    expect(readings.sound.silentDialogueShots).toEqual([])
  })

  it('排队快照没有台词列时判不了该不该有人声', () => {
    const manifest = JSON.parse(ledger())
    delete manifest.resolved.shots
    const readings = readCompositionReview({ manifest: JSON.stringify(manifest), masterDurationMs: 13000 })
    expect(readings.sound.gaps).toContain('audioLedger')
    expect(readings.transition.requestedNonCutCount).toBeNull()
  })

  it('声床与配乐只摆数不拦验收：环境音没有生成通道（SD-185）', () => {
    const readings = readCompositionReview({
      manifest: ledger({ beds: [{ imported: true }, { imported: false }] }),
      masterDurationMs: 13000,
      hasMusic: true,
    })
    expect(readings.sound.bedCount).toBe(2)
    expect(readings.sound.importedBedCount).toBe(1)
    expect(readings.sound.hasMusic).toBe(true)
    expect(readings.complete).toBe(true)
  })

  it('节奏对照只摆数：碎不等于错，与 S1 同口径', () => {
    // 两镜都是短句，默认门槛（平均 4.5s / 长镜占比 20%）量出来一定不达标，但不许因此缺项。
    const readings = readCompositionReview({ manifest: ledger({ clipMs: [2000, 2500] }), masterDurationMs: 4500 })
    expect(readings.rhythm.gate.pass).toBe(false)
    expect(readings.rhythm.gate.failures).toEqual(['avgShot', 'longTakeShare'])
    expect(readings.rhythm.present).toBe(true)
    expect(readings.complete).toBe(true)
  })
})
