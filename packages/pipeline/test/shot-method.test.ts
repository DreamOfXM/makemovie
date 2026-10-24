import { describe, expect, it } from 'vitest'
import { needsGeneratedMedia, shotProduction } from '../src/shot-method.js'

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
