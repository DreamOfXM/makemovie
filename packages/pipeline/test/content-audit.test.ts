import { describe, expect, it } from 'vitest'
import { auditScriptText, auditStoryboardShots, DEFAULT_SHOT_RHYTHM, describeFindings, evaluateShotRhythm, measureShotRhythm, normalizeShotRhythm, resolveShotRhythm, SHORT_SHOT_MS } from '../src/index.js'

describe('剧本体检', () => {
  it('空正文不算数', () => {
    expect(auditScriptText('   \n  ').map(f => f.code)).toEqual(['script:empty'])
  })

  it('没有场景标记就不算数——prompt 把它列为最高优先级，分镜切块靠它', () => {
    const content = '许知意推开门，风灌进来。\n她没说第二句话。'
    expect(auditScriptText(content).map(f => f.code)).toEqual(['script:noSceneMarker'])
  })

  it('认中英两种标记，含中文数字与前置空白', () => {
    for (const marker of ['场景 1', '场景一', 'SCENE 1', 'Scene 12', 'scene 3', '  场景 3']) {
      expect(auditScriptText(`${marker}\n正文……`)).toEqual([])
    }
  })

  it('行内提到「场景 N」不算标记——匹配的是行首', () => {
    expect(auditScriptText('他想起那个场景 1 的夜晚，一切都很安静。').map(f => f.code)).toEqual(['script:noSceneMarker'])
  })

  it('一处标记就够——后续场次由分镜自己编号', () => {
    expect(auditScriptText('场景 1\n正文……\n\n场景 2\n继续……')).toEqual([])
  })
})

describe('分镜体检', () => {
  // 信息完整的一镜：每个用例只改自己要验的那个字段，其余杂音为零。
  const shot = (overrides: Record<string, unknown> = {}) => ({
    description: '（全景·平视）屋内',
    durationMs: 4000,
    continuityIn: '门口的地砖',
    continuityOut: '她站在窗边',
    ...overrides,
  })

  it('空镜头列表不算数', () => {
    expect(auditStoryboardShots([]).map(f => f.code)).toEqual(['storyboard:noShots'])
  })

  it('整集不带场次号不算错——旧模型不带该字段，与改造前行为一致', () => {
    const shots = [shot({ description: '（中景·平视）她抬头' }), shot({ description: '（近景·平视）笔尖顿住' })]
    expect(auditStoryboardShots(shots)).toEqual([])
  })

  it('场次号从 1 起连续就通过', () => {
    expect(
      auditStoryboardShots([shot({ scene: 1 }), shot({ scene: 2 }), shot({ scene: 3 })]),
    ).toEqual([])
  })

  it('场次号有缺口、或不起于 1，都要拦', () => {
    expect(
      auditStoryboardShots([shot({ scene: 1 }), shot({ scene: 3 })]).map(f => f.code),
    ).toEqual(['storyboard:sceneGap'])
    expect(auditStoryboardShots([shot({ scene: 2 })]).map(f => f.code)).toEqual(['storyboard:sceneGap'])
  })

  it('空描述要拦——首帧没有可生成的画面，按镜头文本匹配的素材绑定也整片失效', () => {
    expect(
      auditStoryboardShots([shot({ scene: 1 }), shot({ description: '   ', scene: 2 })]).map(f => f.code),
    ).toEqual(['storyboard:blankDescription'])
  })

  it('非法场次号按缺失处理，不参与连续性判定', () => {
    const shots = [
      shot({ scene: 0 }),
      shot({ scene: -1 }),
      shot({ scene: 1.5 }),
      shot({ scene: '2' }),
    ]
    expect(auditStoryboardShots(shots)).toEqual([])
  })

  it('时长缺失或非正要拦——asDuration 会静默补成 5000，界面与计费都对不上', () => {
    const findings = auditStoryboardShots([
      shot({ durationMs: undefined }),
      shot({ durationMs: 0 }),
      shot({ durationMs: -1 }),
      shot({ durationMs: '3000' }),
    ])
    expect(findings.map(f => f.code)).toEqual(['storyboard:durationMissing'])
    expect(findings[0]!.detail).toContain('第 1、2、3、4 镜')
  })

  it('第 2 镜起必须有起手状态；首镜允许留空——它前面没有镜头', () => {
    expect(
      auditStoryboardShots([shot({ continuityIn: '' }), shot({ continuityIn: '  ' })]).map(f => f.code),
    ).toEqual(['storyboard:continuityInMissing'])
    expect(
      auditStoryboardShots([shot({ continuityIn: '' }), shot({ continuityIn: '地砖' })]).map(f => f.code),
    ).toEqual([])
  })

  it('非末镜必须有末帧状态；末镜允许留空——它后面没有镜头要接', () => {
    expect(
      auditStoryboardShots([shot({ continuityOut: '' }), shot({ continuityOut: '' })]).map(f => f.code),
    ).toEqual(['storyboard:continuityOutMissing'])
    expect(
      auditStoryboardShots([shot({ continuityOut: '窗边' }), shot({ continuityOut: '' })]).map(f => f.code),
    ).toEqual([])
  })

  it('多个问题一次报全，并压成一行给日志', () => {
    const findings = auditStoryboardShots([
      shot({ description: '', scene: 1, durationMs: null }),
      shot({ description: '（全景·平视）屋内', scene: 3 }),
    ])
    expect(findings.map(f => f.code).sort()).toEqual([
      'storyboard:blankDescription',
      'storyboard:durationMissing',
      'storyboard:sceneGap',
    ])
    expect(describeFindings(findings)).toContain('storyboard:blankDescription')
  })
})

/**
 * SD-187：后半段实拍密度塌陷——16 镜连续字卡墙推进剧情。上限 3 沿用 prompt 既有
 * 的三连界线（不许连续三镜同景别），落库前的硬检拒收超线的一抽。
 */
describe('连续字卡上限（SD-187）', () => {
  const shot = (overrides: Record<string, unknown> = {}) => ({
    description: '（全景·平视）屋内',
    durationMs: 4000,
    continuityIn: '门口的地砖',
    continuityOut: '她站在窗边',
    ...overrides,
  })

  it('四连字卡落库前被拒收——三连界线之后再起字卡就是卡墙，不是节奏', () => {
    const shots = [
      shot({ shotRole: '主镜' }),
      shot({ shotRole: '字卡' }),
      shot({ shotRole: '字卡' }),
      shot({ shotRole: '字卡' }),
      shot({ shotRole: '字卡' }),
      shot({ shotRole: '主镜' }),
    ]
    const findings = auditStoryboardShots(shots)
    expect(findings.map(f => f.code)).toEqual(['storyboard:cardWall'])
    expect(findings[0]!.detail).toContain('第 2–5 镜连续 4 张字卡')
  })

  it('三连字卡仍放行——章节或时码组本来就可能是三连，第四张起才拦', () => {
    const shots = [
      shot({ shotRole: '主镜' }),
      shot({ shotRole: '字卡' }),
      shot({ shotRole: '字卡' }),
      shot({ shotRole: '字卡' }),
      shot({ shotRole: '主镜' }),
    ]
    expect(auditStoryboardShots(shots)).toEqual([])
  })

  it('字卡身份只写在生成方式里也计数——镜头类型列缺失不代表模型没在排卡', () => {
    const shots = [
      shot(),
      shot({ method: '字卡' }),
      shot({ method: '字卡' }),
      shot({ method: '字卡' }),
      shot({ method: '字卡' }),
      shot(),
    ]
    expect(auditStoryboardShots(shots).map(f => f.code)).toEqual(['storyboard:cardWall'])
  })

  it('作者分镜表自己拍板的卡墙不在这里拒收——模型只能逐行转录，拦它等于无限重抽', () => {
    const script = [
      '## 分镜表',
      '| # | 时长 | 场景 | 画面 | 生成方式 |',
      '|---|---|---|---|---|',
      '| 1 | 5s | 卧室 | （全景·平视）陈默睁眼 | 视频 |',
      '| 2 | 2s | 字卡 | 黑底白字 第一次死亡 | 字卡 |',
      '| 3 | 2s | 字卡 | 黑底白字 第二次死亡 | 字卡 |',
      '| 4 | 2s | 字卡 | 黑底白字 第三次死亡 | 字卡 |',
      '| 5 | 2s | 字卡 | 黑底白字 第四次死亡 | 字卡 |',
      '| 6 | 5s | 卧室 | （中景·平视）他坐起身 | 视频 |',
    ].join('\n')
    const shots = [
      shot({ durationMs: 5000 }),
      shot({ durationMs: 2000, method: '字卡' }),
      shot({ durationMs: 2000, method: '字卡' }),
      shot({ durationMs: 2000, method: '字卡' }),
      shot({ durationMs: 2000, method: '字卡' }),
      shot({ durationMs: 5000 }),
    ]
    expect(auditStoryboardShots(shots, script)).toEqual([])
  })

  it('表里只有三连、模型自己多排一张成四连时照样拒收——超额的那张是模型的错，不是作者拍板', () => {
    const script = [
      '## 分镜表',
      '| # | 时长 | 场景 | 画面 | 生成方式 |',
      '|---|---|---|---|---|',
      '| 1 | 5s | 卧室 | （全景·平视）陈默睁眼 | 视频 |',
      '| 2 | 2s | 字卡 | 黑底白字 第一次死亡 | 字卡 |',
      '| 3 | 2s | 字卡 | 黑底白字 第二次死亡 | 字卡 |',
      '| 4 | 2s | 字卡 | 黑底白字 第三次死亡 | 字卡 |',
      '| 5 | 2s | 卧室 | （特写·平视）他攥紧拳 | 视频 |',
      '| 6 | 5s | 卧室 | （中景·平视）他坐起身 | 视频 |',
    ].join('\n')
    const shots = [
      shot({ durationMs: 5000 }),
      shot({ durationMs: 2000, method: '字卡' }),
      shot({ durationMs: 2000, method: '字卡' }),
      shot({ durationMs: 2000, method: '字卡' }),
      shot({ durationMs: 2000, method: '字卡' }),
      shot({ durationMs: 5000 }),
    ]
    expect(auditStoryboardShots(shots, script).map(f => f.code)).toContain('storyboard:cardWall')
  })
})

/**
 * 节奏读数只对「作者已经把镜头写死」的剧本生效：分镜表是唯一的镜头长度来源，
 * 自由散文没有可量的镜头。门只两条，且不判内容好坏——它拦的是无意识签收。
 */
const RHYTHM_SCRIPT = [
  '## 分镜表',
  '| # | 时间 | 时长 | 场景 | 画面 | 台词/VO | 声音 | 生成方式 |',
  '|---|---|---|---|---|---|---|---|',
  '| 1 | 0:00–0:03 | 3s | 卧室 | （全景·平视）陈默睁眼 | — | 低频 | 视频 |',
  '| 2 | 0:03–0:11 | 8s | 卧室 | （中景·平视）他盯住门缝 | — | 低频 | 视频 |',
  '| 3 | 0:11–0:14 | 3s | 走廊 | （近景·平视）脚步停住 | — | 脚步 | 视频 |',
  '| 4 | 0:14–0:16 | 2s | 走廊 | （特写·平视）钥匙落地 | — | 金属 | 视频 |',
].join('\n')

describe('分镜节奏读数', () => {
  it('没有分镜表的正文读数为 null——不拿散文猜镜头', () => {
    expect(measureShotRhythm('场景 1\n她推开门。')).toBeNull()
    expect(measureShotRhythm('')).toBeNull()
  })

  it('按分镜表逐行计量：镜数、总长、平均、最长、长镜与短镜', () => {
    const readings = measureShotRhythm(RHYTHM_SCRIPT)!
    expect(readings.shotCount).toBe(4)
    expect(readings.totalMs).toBe(16_000)
    expect(readings.avgShotMs).toBe(4_000)
    expect(readings.maxShotMs).toBe(8_000)
    // 默认长镜门槛 8 秒：只有第 2 镜算长镜。
    expect(readings.longTakeCount).toBe(1)
    expect(readings.longTakeMs).toBe(8_000)
    expect(readings.longTakeShare).toBe(0.5)
    // 默认短镜带 3 秒（含）：第 1、3、4 镜。
    expect(readings.shortShotCount).toBe(3)
    expect(readings.shortShotShare).toBe(0.75)
    expect(SHORT_SHOT_MS).toBe(3_000)
  })

  it('长镜门槛从设置来：把门槛降到 3 秒，三颗 ≥3 秒的镜头都算长镜', () => {
    const readings = measureShotRhythm(RHYTHM_SCRIPT, { avgShotMs: 4_500, longTakeMinMs: 3_000, longTakeShareMin: 0.2 })!
    expect(readings.longTakeCount).toBe(3)
    expect(readings.longTakeMs).toBe(14_000)
    expect(readings.longTakeShare).toBe(14_000 / 16_000)
  })

  it('门只两条：平均镜长不够、长镜占比不够；读数缺失时不适用', () => {
    const readings = measureShotRhythm(RHYTHM_SCRIPT)!
    expect(evaluateShotRhythm(readings, { avgShotMs: 4_000, longTakeMinMs: 8_000, longTakeShareMin: 0.5 })).toEqual({ pass: true, failures: [] })
    expect(evaluateShotRhythm(readings, { avgShotMs: 4_001, longTakeMinMs: 8_000, longTakeShareMin: 0.2 })).toEqual({
      pass: false,
      failures: ['avgShot'],
    })
    expect(evaluateShotRhythm(readings, { avgShotMs: 4_000, longTakeMinMs: 8_000, longTakeShareMin: 0.51 })).toEqual({
      pass: false,
      failures: ['longTakeShare'],
    })
    expect(evaluateShotRhythm(null, DEFAULT_SHOT_RHYTHM)).toEqual({ pass: true, failures: [] })
  })

  it('设置越界或类型不对时回落到起始默认，而不是抛错', () => {
    expect(normalizeShotRhythm({})).toEqual(DEFAULT_SHOT_RHYTHM)
    expect(normalizeShotRhythm({ avgShotMs: 0, longTakeMinMs: 30_001, longTakeShareMin: 1.2 })).toEqual(DEFAULT_SHOT_RHYTHM)
    expect(normalizeShotRhythm({ avgShotMs: 5_000 })).toEqual({ ...DEFAULT_SHOT_RHYTHM, avgShotMs: 5_000 })
    // 部分更新：只写一项时其余沿用起始默认，而不是写回 0。
    expect(resolveShotRhythm(JSON.stringify({ longTakeShareMin: 0.3 }))).toEqual({ ...DEFAULT_SHOT_RHYTHM, longTakeShareMin: 0.3 })
  })

  it('库里的 JSON 坏掉或为空时回到起始默认，不让一列脏数据炸掉批准', () => {
    expect(resolveShotRhythm(null)).toEqual(DEFAULT_SHOT_RHYTHM)
    expect(resolveShotRhythm('not json')).toEqual(DEFAULT_SHOT_RHYTHM)
    expect(resolveShotRhythm('[1,2]')).toEqual(DEFAULT_SHOT_RHYTHM)
    expect(resolveShotRhythm('null')).toEqual(DEFAULT_SHOT_RHYTHM)
  })
})
