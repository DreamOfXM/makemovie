import { describe, expect, it } from 'vitest'
import { METHOD_WORDS, needsGeneratedMedia, parseMethod, shotProduction } from '../src/shot-method.js'

/**
 * 分镜表「生成方式」列的人话分类。字卡/屏幕录制/合成/UI 由人在剪辑里做，
 * 平台只排「视频」——分类错了就是整集 63 镜一起进计费队列。
 */
describe('分镜生成方式', () => {
  it('认得出五种写法，组合写法按「视频优先」', () => {
    expect(shotProduction('视频')).toBe('video')
    expect(shotProduction('字卡')).toBe('title-card')
    expect(shotProduction('屏幕录制')).toBe('screen-recording')
    expect(shotProduction('合成')).toBe('composition')
    expect(shotProduction('UI')).toBe('ui')
    expect(shotProduction('合成/视频')).toBe('video')
    expect(shotProduction('UI+VO')).toBe('ui')
  })

  it('英文项目按同义写法认，不落回视频——认不出就是整镜进计费队列', () => {
    expect(shotProduction('Title card')).toBe('title-card')
    expect(shotProduction('Screen recording')).toBe('screen-recording')
    expect(shotProduction('Composition')).toBe('composition')
    expect(shotProduction('UI')).toBe('ui')
  })

  it('空列按视频处理：老分镜没有这一列，不能因此整批不生成', () => {
    expect(shotProduction(null)).toBe('video')
    expect(shotProduction('')).toBe('video')
    expect(shotProduction('   ')).toBe('video')
  })

  it('只有视频镜需要平台生成画面', () => {
    expect(needsGeneratedMedia('视频')).toBe(true)
    expect(needsGeneratedMedia('合成/视频')).toBe(true)
    expect(needsGeneratedMedia('字卡')).toBe(false)
    expect(needsGeneratedMedia('UI')).toBe(false)
    expect(needsGeneratedMedia('合成')).toBe(false)
    expect(needsGeneratedMedia('屏幕录制')).toBe(false)
  })
})

/**
 * 人写这一栏的入口（SD-109）。此前只有模型写、人不能改：档位一旦错判，
 * 唯一的修法是把整份分镜重跑一遍（付费）。界面下拉与分类器必须共用一张字表，
 * 否则「选了字卡、分类器仍按视频排进计费队列」这种事故只在生产环境才暴露。
 */
describe('生成方式的人写入口', () => {
  it('五档字表逐档被自己的分类器认回同一档', () => {
    for (const [production, word] of Object.entries(METHOD_WORDS)) {
      expect(parseMethod(word)).toEqual({ ok: true, value: word })
      expect(shotProduction(word)).toBe(production)
    }
  })

  it('空栏等于交回模型口径，不算非法值', () => {
    expect(parseMethod(null)).toEqual({ ok: true, value: null })
    expect(parseMethod('')).toEqual({ ok: true, value: null })
    expect(parseMethod('  字卡  ')).toEqual({ ok: true, value: '字卡' })
  })

  it('挡住自由文本：写进分类器认不出的档位，等于把这一镜悄悄排进计费队列', () => {
    expect(parseMethod('画面').ok).toBe(false)
    // 分类器为旧数据保留的英文同义写法，不作为人写的档位——界面只给五档人话。
    expect(parseMethod('UI').ok).toBe(false)
    expect(parseMethod('字卡/视频').ok).toBe(false)
    expect(parseMethod(42).ok).toBe(false)
    expect(parseMethod({ method: '字卡' }).ok).toBe(false)
  })
})
