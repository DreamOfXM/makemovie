import { describe, expect, it } from 'vitest'
import { inspectStoryboardGaps, type StoryboardGapShot } from '../src/index.js'

const shot = (id: string, overrides: Partial<StoryboardGapShot> = {}): StoryboardGapShot => ({
  id,
  description: '（中景·平视·固定）她坐在长桌边',
  dialogue: '',
  speaker: null,
  continuityIn: '门口的地砖',
  continuityOut: '她双手放在桌面',
  durationMs: 5000,
  method: 'video',
  ...overrides,
})

const codes = (shots: readonly StoryboardGapShot[], id: string, options = {}) =>
  inspectStoryboardGaps(shots, options).get(id) ?? []

describe('分镜文本体检', () => {
  it('信息完整的镜头零缺口', () => {
    expect(codes([shot('a')], 'a')).toEqual([])
  })

  it('没有镜头语言要提示——画面描述必须以（景别·机位·运动）开头', () => {
    expect(codes([shot('a', { description: '她坐在长桌边' })], 'a')).toEqual(['camera_mark_missing'])
  })

  it('镜头语言不足三段要提示', () => {
    expect(codes([shot('a', { description: '（中景·平视）她抬头' })], 'a')).toEqual(['camera_movement_missing'])
    expect(codes([shot('a', { description: '（中景··平视·固定）她抬头' })], 'a')).toEqual([])
  })

  it('非视频镜头不查镜头语言——字卡、屏幕录制没有摄影机', () => {
    for (const method of ['字卡', '屏幕录制', '合成', 'UI']) {
      expect(codes([shot('a', { method, description: '第三日 11:59' })], 'a')).toEqual([])
    }
  })

  it('起手状态从第 2 镜起必须写；首镜留空不算错', () => {
    const shots = [shot('a', { continuityIn: '' }), shot('b', { continuityIn: '  ' })]
    expect(inspectStoryboardGaps(shots)).toEqual(new Map([['b', ['continuity_in_missing']]]))
  })

  it('末帧状态除末镜外必须写；末镜留空不算错', () => {
    const shots = [shot('a', { continuityOut: '' }), shot('b', { continuityOut: '' })]
    expect(inspectStoryboardGaps(shots)).toEqual(new Map([['a', ['continuity_out_missing']]]))
  })

  it('末帧写成连环过程要提示——下一镜接不住一段动作，只接得住一帧画面', () => {
    expect(codes([shot('a', { continuityOut: '她随后起身，然后走向窗边' })], 'a')).toEqual(['continuity_out_process'])
    expect(codes([shot('a', { continuityOut: '她随后起身' })], 'a')).toEqual([])
  })

  it('有台词没写说话人要提示', () => {
    expect(codes([shot('a', { dialogue: '你来了。', speaker: null })], 'a')).toEqual(['dialogue_without_speaker'])
    expect(codes([shot('a', { dialogue: '你来了。', speaker: '许知意' })], 'a')).toEqual([])
  })

  it('说话人不在角色档案里要提示；声源标记与带括注的名字不算越名', () => {
    const options = { castNames: ['许知意', '林岸'] }
    expect(codes([shot('a', { speaker: '周屿' })], 'a', options)).toEqual(['speaker_not_in_cast'])
    expect(codes([shot('a', { speaker: '许知意（28岁）' })], 'a', options)).toEqual([])
    expect(codes([shot('a', { speaker: 'VO' })], 'a', options)).toEqual([])
    expect(codes([shot('a', { speaker: '系统音' })], 'a', options)).toEqual([])
    expect(codes([shot('a', { speaker: '周屿' })], 'a')).toEqual([])
  })

  it('画面里的读数必须取剧本给定的值，全角冒号与前导零不制造假缺口', () => {
    const options = { scriptContent: '场景 1\n钟面停在 11:59，她抬头。' }
    expect(codes([shot('a', { description: '（特写·平视·固定）钟面 11:58' })], 'a', options)).toEqual(['readout_not_in_script'])
    expect(codes([shot('a', { description: '（特写·平视·固定）钟面 11：59' })], 'a', options)).toEqual([])
    expect(codes([shot('a', { description: '（特写·平视·固定）钟面 11:58' })], 'a')).toEqual([])
  })

  it('实拍镜不许在画面描述里要字——这类字只能由本机字卡或字幕层画', () => {
    expect(codes([shot('a', { description: '（近景·高角度俯拍·跟随）他把钟扔进水里。黑屏。字幕：第 1 次。' })], 'a')).toEqual(['on_screen_text_in_shot'])
    expect(codes([shot('a', { description: '（全景·平视·固定）火焰吞掉画面。第 2 次。' })], 'a')).toEqual(['on_screen_text_in_shot'])
    expect(codes([shot('a', { description: '（中景·平视·固定）标题《第七次死亡》压在墙上' })], 'a')).toEqual(['on_screen_text_in_shot'])
    expect(codes([shot('a', { description: '(medium·eye level·static) a subtitle line fades in' })], 'a')).toEqual(['on_screen_text_in_shot'])
  })

  it('句中用法不是要字：黑屏的手机、第 3 次尝试，都不许多报一条', () => {
    expect(codes([shot('a', { description: '（特写·平视·固定）他盯着黑屏的手机' })], 'a')).toEqual([])
    expect(codes([shot('a', { description: '（特写·平视·固定）这是他第 3 次按下开关' })], 'a')).toEqual([])
  })

  it('「字幕」「字卡」出现即报——画面描述里没有正当的句中用法', () => {
    expect(codes([shot('a', { description: '（特写·平视·固定）墙上有字幕两个字' })], 'a')).toEqual(['on_screen_text_in_shot'])
  })

  it('非实拍镜不查这条：字卡与 UI 就是用来上屏写字的', () => {
    for (const method of ['字卡', 'UI', '合成', '屏幕录制']) {
      expect(codes([shot('a', { method, description: '黑屏。字幕：第 1 次。' })], 'a')).toEqual([])
    }
  })

  it('短于绑定链地板要提示；没给地板或本就没填时长时不报', () => {
    expect(codes([shot('a', { durationMs: 3000 })], 'a', { minDurationMs: 5000 })).toEqual(['duration_below_floor'])
    expect(codes([shot('a', { durationMs: 3000 })], 'a')).toEqual([])
    expect(codes([shot('a', { durationMs: 0 })], 'a', { minDurationMs: 5000 })).toEqual([])
  })

  it('一镜多处缺口逐条列全', () => {
    const findings = codes([shot('a', { description: '她坐在长桌边', dialogue: '你来了。', speaker: null })], 'a')
    expect(findings).toEqual(['camera_mark_missing', 'dialogue_without_speaker'])
  })
})
