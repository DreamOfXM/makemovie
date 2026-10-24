import { describe, expect, it } from 'vitest'
import { auditStoryboardShots, contractCardText, parseStoryboardContract } from '../src/index.js'

const SCRIPT = [
  '## 分镜表',
  '| # | 时间 | 时长 | 场景 | 画面 | 台词/VO | 声音 | 生成方式 |',
  '|---|---|---|---|---|---|---|---|',
  '| 1 | 0:00–0:03 | 3s | 卧室 | （全景·平视）陈默睁眼 | — | 低频 | 视频 |',
  '| 2 | 0:03–0:09 | 6s | 字卡 | 字幕：本片由 MakeMovie 生成 | — | 低频 | 字卡 |',
  '| 3 | 0:09–0:13 | 4s | 字卡 | 六个 7:08 时间戳叠化 | — | 低频 | 字卡 |',
  '| 4 | 0:13–0:17 | 4s | 字卡 | MakeMovie logo / URL | — | 收尾音 | 字卡 |',
  '| 合计 | | 17s | | | | | |',
].join('\n')

const SHOTS = [
  { description: '（全景·平视）陈默睁眼', durationMs: 3_000, continuityOut: '陈默睁着眼' },
  { description: '字幕：本片由 MakeMovie 生成', durationMs: 6_000, continuityIn: '陈默睁着眼', continuityOut: '黑底字幕' },
  { description: '六个 7:08 的时间戳从不同角落浮出，慢慢叠化在一起', durationMs: 4_000, continuityIn: '黑底字幕', continuityOut: '时间戳叠满画面' },
  { description: 'MakeMovie logo / URL', durationMs: 4_000, continuityIn: '时间戳叠满画面' },
]

function card(visual: string, method = '字卡') {
  return contractCardText({ number: 1, durationMs: 3_000, location: '', visual, dialogue: '', method, shotRole: '', transition: '', sound: '' })
}

describe('parseStoryboardContract', () => {
  it('reads every row, keeps the durations and stops at the total line', () => {
    const contract = parseStoryboardContract(SCRIPT)
    expect(contract).not.toBeNull()
    expect(contract!.rows.map(row => row.durationMs)).toEqual([3_000, 6_000, 4_000, 4_000])
    expect(contract!.rows.map(row => row.number)).toEqual([1, 2, 3, 4])
    expect(contract!.rows[1]!.method).toBe('字卡')
    expect(contract!.totalMs).toBe(17_000)
  })

  it('keeps the scene column as the place this shot happens in', () => {
    // 一个场次跨六个地点时，「场」回答不了「这一镜在哪个景」——场景主帧和
    // 场景素材绑定都只能靠这一列。
    const contract = parseStoryboardContract(SCRIPT)
    expect(contract!.rows.map(row => row.location)).toEqual(['卧室', '字卡', '字卡', '字卡'])
  })

  it('accepts a 地点 header too, and leaves location empty when there is no such column', () => {
    expect(parseStoryboardContract([
      '| 时长 | 地点 | 画面 |',
      '|---|---|---|',
      '| 3s | 天台 | a |',
      '| 4s | 街道 | b |',
      '| 5s | 卧室 | c |',
    ].join('\n'))!.rows.map(row => row.location)).toEqual(['天台', '街道', '卧室'])
    expect(parseStoryboardContract([
      '| 时长 | 画面 |',
      '|---|---|',
      '| 3s | a |',
      '| 4s | b |',
      '| 5s | c |',
    ].join('\n'))!.rows.map(row => row.location)).toEqual(['', '', ''])
  })

  it('accepts Chinese duration units and bare seconds', () => {
    const contract = parseStoryboardContract([
      '| 镜头 | 时长 | 画面 |',
      '|---|---|---|',
      '| 1 | 3秒 | a |',
      '| 2 | 6 | b |',
      '| 3 | 4s | c |',
    ].join('\n'))
    expect(contract!.rows.map(row => row.durationMs)).toEqual([3_000, 6_000, 4_000])
  })

  it('needs a real storyboard table, not any table with two matching headers', () => {
    expect(parseStoryboardContract('没有任何表格的剧本')).toBeNull()
    expect(parseStoryboardContract([
      '| 时长 | 画面 |',
      '|---|---|',
      '| 3s | a |',
      '| 4s | b |',
    ].join('\n'))).toBeNull()
  })
})

describe('contractCardText', () => {
  it('only keeps text that actually appears on screen', () => {
    expect(card('字幕：7:07')).toBe('7:07')
    expect(card('标题《第七次死亡》')).toBe('第七次死亡')
    expect(card('「没有完美的第一次」')).toBe('没有完美的第一次')
    expect(card('字幕：   ')).toBeNull()
  })

  it('treats a descriptive card row as a picture, not literal text', () => {
    // 第 20 行原文；模型补写成更完整的画面描述时不应被判成「字卡文字缺失」。
    expect(card('六个 7:08 时间戳叠化')).toBeNull()
    expect(card('MakeMovie logo / URL')).toBeNull()
  })
})

describe('分镜表契约审计', () => {
  it('passes a shot list that transcribes the table row by row', () => {
    expect(auditStoryboardShots(SHOTS, SCRIPT)).toEqual([])
  })

  it('catches a compressed shot list', () => {
    const codes = auditStoryboardShots(SHOTS.slice(0, 2), SCRIPT).map(finding => finding.code)
    expect(codes).toContain('storyboard:contractShotCount')
    expect(codes).toContain('storyboard:contractTotalDuration')
  })

  it('catches a shot whose duration was re-estimated', () => {
    const findings = auditStoryboardShots([{ ...SHOTS[0]!, durationMs: 2_000 }, SHOTS[1]!, SHOTS[2]!, SHOTS[3]!], SCRIPT)
    const codes = findings.map(finding => finding.code)
    expect(codes).toContain('storyboard:contractDuration')
    expect(codes).toContain('storyboard:contractTotalDuration')
    expect(findings.find(finding => finding.code === 'storyboard:contractDuration')!.detail).toContain('第 1 行')
  })

  it('catches a dropped card even when the shot count is right', () => {
    const findings = auditStoryboardShots([SHOTS[0]!, { ...SHOTS[1]!, description: '品牌收尾' }, SHOTS[2]!, SHOTS[3]!], SCRIPT)
    expect(findings.map(finding => finding.code)).toEqual(['storyboard:contractCard'])
    expect(findings[0]!.detail).toContain('本片由 MakeMovie 生成')
  })

  it('lets a descriptive card be described more fully', () => {
    // v4 真实输出：第 20 行写成了「六个 7:08 的时间戳从不同角落浮出，慢慢叠化在一起」。
    const script = [
      '| # | 时长 | 画面 | 生成方式 |',
      '|---|---|---|---|',
      '| 1 | 3s | 六个 7:08 时间戳叠化 | 字卡 |',
      '| 2 | 3s | 字幕：不管我做什么 | 字卡 |',
      '| 3 | 4s | 标题《第七次死亡》 | 字卡 |',
    ].join('\n')
    const shots = [
      { description: '（黑屏）六个 7:08 的时间戳从不同角落浮出，慢慢叠化在一起', durationMs: 3_000, continuityOut: '时间戳叠满画面' },
      { description: '字幕：不管我做什么，7:08 都会来。', durationMs: 3_000, continuityIn: '时间戳叠满画面', continuityOut: '黑底字幕' },
      { description: '黑底白字，标题《第七次死亡》', durationMs: 4_000, continuityIn: '黑底字幕' },
    ]
    expect(auditStoryboardShots(shots, script)).toEqual([])
  })

  it('still catches a rewritten subtitle', () => {
    const findings = auditStoryboardShots([SHOTS[0]!, { ...SHOTS[1]!, description: '字幕：本片由某平台生成' }, SHOTS[2]!, SHOTS[3]!], SCRIPT)
    expect(findings.map(finding => finding.code)).toEqual(['storyboard:contractCard'])
    expect(findings[0]!.detail).toContain('第 2 行')
  })

  it('does not invent a contract for a script without a storyboard table', () => {
    expect(auditStoryboardShots([{ description: '（全景·平视）陈默睁眼', durationMs: 1_000 }], '场景 1\n正文……')).toEqual([])
  })
})
