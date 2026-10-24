import { describe, expect, it } from 'vitest'
import {
  auditShotTakes,
  auditStoryboardShots,
  inferShotRole,
  normalizeShotLines,
  normalizeShotRole,
  normalizeTransition,
  parseStoryboardContract,
  planShotTakes,
  resolveTransition,
} from '../src/index.js'

describe('镜头类型词表', () => {
  it('接受中文与英文别名，空格/括号不参与匹配', () => {
    expect(normalizeShotRole('主镜')).toBe('main')
    expect(normalizeShotRole('插入镜')).toBe('insert')
    expect(normalizeShotRole('反应')).toBe('reaction')
    expect(normalizeShotRole('空 镜')).toBe('ambience')
    expect(normalizeShotRole('字卡')).toBe('card')
    expect(normalizeShotRole('MASTER')).toBe('main')
    expect(normalizeShotRole('（主镜）')).toBe('main')
  })

  it('认不出的词返回 null，不猜', () => {
    expect(normalizeShotRole('长镜头')).toBeNull()
    expect(normalizeShotRole('')).toBeNull()
    expect(normalizeShotRole(3)).toBeNull()
  })

  it('没有显式类型时保守推断：字卡 > 有台词=反应 > 插入', () => {
    expect(inferShotRole({ method: '字卡' })).toBe('card')
    expect(inferShotRole({ dialogue: '你来了' })).toBe('reaction')
    expect(inferShotRole({})).toBe('insert')
  })
})

describe('转场词表', () => {
  it('硬切恒为 0；其余夹在 50–1000ms', () => {
    expect(resolveTransition('硬切', 500)).toEqual({ transition: 'cut', transitionMs: 0 })
    expect(resolveTransition('叠化', 400)).toEqual({ transition: 'dissolve', transitionMs: 400 })
    expect(resolveTransition('黑场', 5)).toEqual({ transition: 'black', transitionMs: 50 })
    expect(resolveTransition('闪白', 3_000)).toEqual({ transition: 'flash', transitionMs: 1_000 })
  })

  it('未知转场退回硬切；缺时长时用该转场的缺省值', () => {
    expect(resolveTransition('划像', 300)).toEqual({ transition: 'cut', transitionMs: 0 })
    expect(resolveTransition('叠化', undefined)).toEqual({ transition: 'dissolve', transitionMs: 400 })
    expect(normalizeTransition('BLACK')).toBe('black')
    expect(normalizeTransition('闪白')).toBe('flash')
  })
})

describe('镜内多句台词', () => {
  it('至少两句才落库；单句仍走 dialogue', () => {
    expect(normalizeShotLines([{ speaker: '陈默', text: '你来了' }])).toBeNull()
    expect(normalizeShotLines({ speaker: '陈默', text: '你来了' })).toBeNull()
    expect(normalizeShotLines([{ speaker: '陈默', text: '你来了' }, { speaker: '许知意', text: '坐吧' }])).toEqual([
      { speaker: '陈默', text: '你来了' },
      { speaker: '许知意', text: '坐吧' },
    ])
  })

  it('空文本与非法项被丢掉，剩下不足两句时为 null', () => {
    expect(normalizeShotLines([{ speaker: 'A', text: '  ' }, null, 'x'])).toBeNull()
    expect(normalizeShotLines(undefined)).toBeNull()
  })
})

describe('超长镜拆连续段', () => {
  it('不超过单次能力时保持一颗镜头，不拆', () => {
    expect(planShotTakes({ durationMs: 12_000, maxTakeMs: 15_000 })).toEqual({
      takes: [{ order: 1, plannedMs: 12_000, promptDelta: '' }],
      splitAt: 'none',
      warnings: [],
    })
  })

  it('按台词句间停顿切，段长合计等于原镜头且每段不超上限', () => {
    const lines = [
      { speaker: '陈默', text: '你来了' },
      { speaker: '许知意', text: '坐吧' },
      { speaker: '陈默', text: '为什么是现在' },
      { speaker: '许知意', text: '因为门要关了' },
    ]
    const plan = planShotTakes({ durationMs: 24_000, maxTakeMs: 10_000, lines })
    expect(plan.splitAt).toBe('lines')
    expect(plan.takes).toHaveLength(3)
    expect(plan.takes.reduce((sum, take) => sum + take.plannedMs, 0)).toBe(24_000)
    expect(plan.takes.every(take => take.plannedMs <= 10_000)).toBe(true)
    expect(plan.takes[0]!.promptDelta).toContain('第 1/3 段')
    expect(plan.takes[1]!.promptDelta).toContain('第 2/3 段')
  })

  it('没有足够台词时按动作完成点均分，每段都写拆点说明', () => {
    const plan = planShotTakes({ durationMs: 30_000, maxTakeMs: 12_000 })
    expect(plan.splitAt).toBe('even')
    expect(plan.takes.map(take => take.order)).toEqual([1, 2, 3])
    expect(plan.takes.reduce((sum, take) => sum + take.plannedMs, 0)).toBe(30_000)
    expect(plan.takes[1]!.promptDelta).toContain('严格从上一段末帧起手')
  })

  it('台词不足段数时退回均分——不拿半句台词硬切', () => {
    const plan = planShotTakes({ durationMs: 30_000, maxTakeMs: 10_000, lines: [{ speaker: 'A', text: '一' }, { speaker: 'B', text: '二' }] })
    expect(plan.splitAt).toBe('even')
  })

  it('相邻段的交棒/承接逐字相等——两个独立请求描述同一个瞬间', () => {
    const lines = [
      { speaker: '陈默', text: '你来了' },
      { speaker: '许知意', text: '坐吧，茶还热着' },
      { speaker: '陈默', text: '为什么是现在' },
      { speaker: '许知意', text: '因为门要关了' },
    ]
    const plan = planShotTakes({ durationMs: 24_000, maxTakeMs: 10_000, lines })
    for (let index = 1; index < plan.takes.length; index += 1) {
      const previous = plan.takes[index - 1]!
      const current = plan.takes[index]!
      expect(previous.continuityOut).toBe(current.continuityIn)
      expect(previous.promptDelta).toContain(`交棒下段：${current.continuityIn}`)
      expect(current.promptDelta).toContain(`承接上段：${previous.continuityOut}`)
      expect(previous.continuityOut).not.toBe('同上')
    }
  })

  it('整镜声床写进每一段，跨接缝不许换氛围', () => {
    const plan = planShotTakes({ durationMs: 36_000, maxTakeMs: 12_000, ambience: '雨打铁皮棚，远处车流不断' })
    expect(plan.takes).toHaveLength(3)
    for (const take of plan.takes) {
      expect(take.promptDelta).toContain('雨打铁皮棚')
      expect(take.promptDelta).toContain('跨接缝不停')
    }
  })

  it('没有声床时也明写同一条声床，避免每段各起一个环境', () => {
    const plan = planShotTakes({ durationMs: 24_000, maxTakeMs: 10_000 })
    expect(plan.takes.every(take => take.promptDelta.includes('声床：与上一段同一条声床'))).toBe(true)
  })

  /**
   * 分镜 prompt 允许作者在「声音」列写「无」。这一列原文直进这里，上一版会拼出
   * 「声床：无（与上一段同一条声床，跨接缝不停）」——一句自相矛盾的话进了付费请求，
   * 模型收到的指令是「不要氛围，但别停」。作者说不要就得跟没说一样。
   */
  it('作者写「无」就是不要底，不许把它当氛围名塞进请求', () => {
    for (const none of ['无', 'none', '—']) {
      const plan = planShotTakes({ durationMs: 24_000, maxTakeMs: 10_000, ambience: none })
      for (const take of plan.takes) {
        expect(take.promptDelta).toContain('声床：与上一段同一条声床')
        expect(take.promptDelta).not.toContain(`声床：${none}`)
      }
    }
    // 反面对照：只是话里带「无」的正常描述仍要原样进请求，否则剧本要的底被悄悄删掉。
    const kept = planShotTakes({ durationMs: 24_000, maxTakeMs: 10_000, ambience: '巷口无风，只有远处车流' })
    expect(kept.takes[1].promptDelta).toContain('声床：巷口无风，只有远处车流')
  })
})

describe('连续段落库校验', () => {
  const takes = [
    { order: 1, plannedMs: 10_000, promptDelta: '', firstFrameArtifactId: 'f1', endFrameArtifactId: 'e1', videoArtifactId: 'v1', status: 'SUCCEEDED' },
    {
      order: 2,
      plannedMs: 8_000,
      promptDelta: '第 2/2 段\n承接上段：他推门的手停在门把上\n交棒下段：—\n声床：雨声（与上一段同一条声床，跨接缝不停）',
      firstFrameArtifactId: 'e1',
      endFrameArtifactId: 'e2',
      videoArtifactId: 'v2',
      status: 'SUCCEEDED',
    },
  ]

  it('段序、段长、帧链都对时通过', () => {
    expect(auditShotTakes({ durationMs: 18_000, maxTakeMs: 10_000, takes })).toEqual([])
  })

  it('帧链必须逐字相等：下一段首帧不是上一段末帧即断链', () => {
    const broken = [takes[0]!, { ...takes[1]!, firstFrameArtifactId: 'other' }]
    expect(auditShotTakes({ durationMs: 18_000, maxTakeMs: 10_000, takes: broken }).map(f => f.code)).toEqual(['shotTake:frameChainBroken'])
  })

  it('段长合计不符、超上限、拆点说明缺失都报出来', () => {
    const bad = [
      takes[0]!,
      { ...takes[1]!, plannedMs: 12_000, promptDelta: '同上\n声床：雨声（与上一段同一条声床，跨接缝不停）' },
    ]
    const codes = auditShotTakes({ durationMs: 18_000, maxTakeMs: 10_000, takes: bad }).map(f => f.code).sort()
    expect(codes).toEqual(['shotTake:durationMismatch', 'shotTake:overCeiling', 'shotTake:promptMissing'])
  })

  it('已出片却没抽末帧时，下一段无从接起', () => {
    const missing = [{ ...takes[0]!, endFrameArtifactId: null }, { ...takes[1]!, firstFrameArtifactId: null }]
    expect(auditShotTakes({ durationMs: 18_000, maxTakeMs: 10_000, takes: missing }).map(f => f.code)).toContain('shotTake:endFrameMissing')
  })
})

describe('分镜表镜头类型/转场列', () => {
  const SCRIPT = [
    '| # | 时长 | 场景 | 镜头类型 | 画面 | 转场 | 声音 |',
    '|---|---|---|---|---|---|---|',
    '| 1 | 8s | 卧室 | 主镜 | （中景）他推门进来 | 黑场 | 雨声 |',
    '| 2 | 3s | 卧室 | 反应 | （近景）她抬头 | 硬切 | 雨声 |',
    '| 3 | 4s | 楼道 | 空镜 | （全景）空楼道 | 叠化 | 脚步 |',
  ].join('\n')

  it('逐行读到镜头类型、转场与声音', () => {
    const rows = parseStoryboardContract(SCRIPT)!.rows
    expect(rows.map(row => row.shotRole)).toEqual(['主镜', '反应', '空镜'])
    expect(rows.map(row => row.transition)).toEqual(['黑场', '硬切', '叠化'])
    expect(rows.map(row => row.sound)).toEqual(['雨声', '雨声', '脚步'])
  })

  it('没有这三列时全为空串，旧剧本行为不变', () => {
    const rows = parseStoryboardContract([
      '| 时长 | 画面 |',
      '|---|---|',
      '| 3s | a |',
      '| 4s | b |',
      '| 5s | c |',
    ].join('\n'))!.rows
    expect(rows.map(row => [row.shotRole, row.transition, row.sound])).toEqual([['', '', ''], ['', '', ''], ['', '', '']])
  })
})

describe('分镜层硬检只在声明了字段时生效', () => {
  const shot = (overrides: Record<string, unknown> = {}) => ({
    description: '（全景·平视）屋内',
    durationMs: 4_000,
    continuityIn: '门口的地砖',
    continuityOut: '她站在窗边',
    ...overrides,
  })

  it('旧分镜不带镜头类型/转场时，一条也不拦', () => {
    expect(auditStoryboardShots([shot({ scene: 1 }), shot({ scene: 2 })])).toEqual([])
  })

  it('一场没有主镜要拦——那一场最重要的连续动作没有承载镜', () => {
    const findings = auditStoryboardShots([
      shot({ scene: 1, shotRole: '插入' }),
      shot({ scene: 1, shotRole: '反应' }),
      shot({ scene: 2, shotRole: '主镜' }),
    ])
    expect(findings.map(f => f.code)).toEqual(['storyboard:sceneNoMainShot'])
    expect(findings[0]!.detail).toContain('场次 1')
  })

  it('有人写了类型但有人没写，要拦——半份契约不是契约', () => {
    const codes = auditStoryboardShots([
      shot({ scene: 1, shotRole: '主镜' }),
      shot({ scene: 1 }),
    ]).map(f => f.code)
    expect(codes).toEqual(['storyboard:shotRoleInvalid'])
  })

  it('认不出的转场要拦——否则合成时静默退回硬切，作者却以为加了叠化', () => {
    const findings = auditStoryboardShots([
      shot({ scene: 1, shotRole: '主镜', transition: '硬切' }),
      shot({ scene: 1, shotRole: '插入', transition: '划像' }),
    ])
    expect(findings.map(f => f.code)).toEqual(['storyboard:transitionInvalid'])
  })

  it('契约行里的值优先：模型漏抄由表补齐，不判失败', () => {
    const script = [
      '| # | 时长 | 场景 | 镜头类型 | 画面 | 转场 |',
      '|---|---|---|---|---|---|',
      '| 1 | 4s | 卧室 | 主镜 | （全景）他推门 | 硬切 |',
      '| 2 | 4s | 卧室 | 反应 | （近景）她抬头 | 硬切 |',
      '| 3 | 4s | 楼道 | 主镜 | （全景）空楼道 | 叠化 |',
    ].join('\n')
    const shots = [
      shot({ scene: 1 }),
      shot({ scene: 1 }),
      shot({ scene: 2 }),
    ]
    expect(auditStoryboardShots(shots, script)).toEqual([])
  })
})
