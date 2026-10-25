import { describe, expect, it } from 'vitest'
import { needsGeneratedMedia, screenTextPolicy, shotTextRule } from '../src/index.js'

const ZH = 'zh' as const

/**
 * 逐镜画面文字规则（SD-085）。这三档是付费出片的第一道闸：把「短文字一律清晰可读」
 * 当成实拍镜的默认档，等于平台自己在提示词里要求画面出现可读字符——2026-10-21
 * 镜头 #4 的首帧就是这么长出读数「138」的数字钟的。判档输入散在镜头文本、随附素材
 * 外观、已定稿道具读数三处，任何一处漏读都会让模型自己补一只带随机数的钟。
 * 审核端（screenTextPolicy）从同一份措辞反推政策，所以这里的断言同时是审核的契约。
 */
describe('逐镜画面文字规则（SD-085）', () => {
  it('实拍镜默认禁字，并附正向约束——不点名招牌证书，免得 prompt 自己递素材', () => {
    const rule = shotTextRule({ title: '镜头1', description: '雨夜路灯下的对视', method: '视频' }, {}, ZH)
    expect(rule).toContain('画面中不出现任何文字或可读字符')
    expect(rule).toContain('不添加描述之外的道具与装饰')
    for (const bait of ['招牌', '证书', '海报', '报纸']) expect(rule).not.toContain(bait)
    expect(screenTextPolicy(`x\n\n${rule}`)).toEqual({ mode: 'no-text' })
  })

  it('描述点名读数时只放行那一个读数，逐字一致', () => {
    const rule = shotTextRule({ title: '床头钟', description: '特写钟面 7:07', method: '视频' }, {}, ZH)
    expect(rule).toContain('唯一允许出现的可读字符是数字读数 7:07')
    expect(rule).toContain('除此之外不出现任何文字')
    expect(screenTextPolicy(`x\n\n${rule}`)).toEqual({ mode: 'whitelist', readout: '7:07' })
  })

  it('全角冒号的读数同样认，读数取文本里第一个', () => {
    expect(shotTextRule({ title: '镜头', description: '屏上 11：58 亮起', method: '视频' }, {}, ZH)).toContain('数字读数 11：58')
  })

  it('镜内没写读数、但随附素材与已定稿道具摆着读数时，沿用道具的白名单', () => {
    const fromAsset = shotTextRule({ title: '镜头', description: '卧室全景', method: '视频' }, { assetText: '床头钟，金属外壳，钟面显示 7:07' }, ZH)
    expect(screenTextPolicy(fromAsset)).toEqual({ mode: 'whitelist', readout: '7:07' })
    const fromProp = shotTextRule({ title: '镜头', description: '卧室全景', method: '视频' }, { approvedPropReadouts: ['钟面 3:12'] }, ZH)
    expect(screenTextPolicy(fromProp)).toEqual({ mode: 'whitelist', readout: '3:12' })
    // 镜头自己的读数优先于素材的：这一镜要的是它写的那个时间。
    const both = shotTextRule({ title: '镜头', description: '钟面 7:07', method: '视频' }, { assetText: '另一只钟 9:41' }, ZH)
    expect(screenTextPolicy(both)).toEqual({ mode: 'whitelist', readout: '7:07' })
  })

  it('字卡/UI/录屏/合成这类本机镜仍走文字档——画面本身就是排版', () => {
    for (const method of ['字卡', '屏幕录制', '合成', 'UI']) {
      expect(needsGeneratedMedia(method)).toBe(false)
      const rule = shotTextRule({ title: '第 N 次', description: '黑底白字', method }, {}, ZH)
      expect(rule).toContain('标题、标签、招牌等短文字一律使用简体中文')
      expect(screenTextPolicy(rule)).toEqual({ mode: 'text-allowed' })
    }
    // 空列 = 老分镜，按实拍处理，不许因为没写生成方式就要求画面出现文字。
    expect(screenTextPolicy(shotTextRule({ title: '镜头', description: '雨夜' }, {}, ZH))).toEqual({ mode: 'no-text' })
  })

  it('英文项目同档同判：三档各有英文措辞，审核端反推得出同一个模式', () => {
    expect(shotTextRule({ title: 'S1', description: 'a rainy night', method: '视频' }, {}, 'en')).toContain('no text or readable characters')
    const card = shotTextRule({ title: 'S1', description: 'a title card', method: '字卡' }, {}, 'en')
    expect(card).toContain('must be in English')
    expect(screenTextPolicy(card)).toEqual({ mode: 'text-allowed' })
    expect(screenTextPolicy(shotTextRule({ title: 'S1', description: 'clock reads 7:07', method: '视频' }, {}, 'en'))).toEqual({ mode: 'whitelist', readout: '7:07' })
  })

  it('没有文字规则的 prompt 报 unknown，审核不许拿 unknown 当放行', () => {
    expect(screenTextPolicy('一段没有任何规则的裸提示词')).toEqual({ mode: 'unknown' })
  })
})
