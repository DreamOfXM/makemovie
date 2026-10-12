import { describe, expect, it } from 'vitest'
import { auditScriptText, auditStoryboardShots, describeFindings } from '../src/index.js'

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
  it('空镜头列表不算数', () => {
    expect(auditStoryboardShots([]).map(f => f.code)).toEqual(['storyboard:noShots'])
  })

  it('整集不带场次号不算错——旧模型不带该字段，与改造前行为一致', () => {
    const shots = [
      { description: '（中景·平视）她抬头' },
      { description: '（近景·平视）笔尖顿住' },
    ]
    expect(auditStoryboardShots(shots)).toEqual([])
  })

  it('场次号从 1 起连续就通过', () => {
    expect(
      auditStoryboardShots([
        { description: '（全景·平视）屋内', scene: 1 },
        { description: '（近景·平视）她抬头', scene: 2 },
        { description: '（中景·平视）杯子', scene: 3 },
      ]),
    ).toEqual([])
  })

  it('场次号有缺口、或不起于 1，都要拦', () => {
    expect(
      auditStoryboardShots([
        { description: '（全景·平视）屋内', scene: 1 },
        { description: '（近景·平视）她抬头', scene: 3 },
      ]).map(f => f.code),
    ).toEqual(['storyboard:sceneGap'])
    expect(auditStoryboardShots([{ description: '（全景·平视）屋内', scene: 2 }]).map(f => f.code)).toEqual([
      'storyboard:sceneGap',
    ])
  })

  it('空描述要拦——首帧没有可生成的画面，按镜头文本匹配的素材绑定也整片失效', () => {
    expect(
      auditStoryboardShots([
        { description: '（全景·平视）屋内', scene: 1 },
        { description: '   ', scene: 2 },
      ]).map(f => f.code),
    ).toEqual(['storyboard:blankDescription'])
  })

  it('非法场次号按缺失处理，不参与连续性判定', () => {
    const shots = [
      { description: '（全景·平视）屋内', scene: 0 },
      { description: '（近景·平视）她抬头', scene: -1 },
      { description: '（中景·平视）杯子', scene: 1.5 },
      { description: '（特写·平视）笔', scene: '2' },
    ]
    expect(auditStoryboardShots(shots)).toEqual([])
  })

  it('多个问题一次报全，并压成一行给日志', () => {
    const findings = auditStoryboardShots([
      { description: '', scene: 1 },
      { description: '（全景·平视）屋内', scene: 3 },
    ])
    expect(findings.map(f => f.code).sort()).toEqual(['storyboard:blankDescription', 'storyboard:sceneGap'])
    expect(describeFindings(findings)).toContain('storyboard:blankDescription')
  })
})
