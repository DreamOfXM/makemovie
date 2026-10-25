import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dictionaries } from '@/lib/i18n'

/**
 * SD-102：首次生成也弹「该镜头的重新生成已创建」——这一镜此前没有任何产物，
 * 没有东西被「重新」。台账三次上屏复现（镜头 #6 首生、#8 首生视频、#8 首生批次），
 * 修复口径是回执与按钮同一分档：缺产物走「生成」，有产物走「重跑」，回执二选一，
 * 两句都不许出现可以说谎的形态。
 *
 * page.tsx 是重依赖客户端页面，node 环境整包 import 会把它牵进的组件图一并求值，
 * 并行编辑期不稳；这里按仓内既有做法（ui-rules.test.ts）直接读调用点源码 + 读真字典，
 * 键、分支、措辞三条都钉住。
 */

const PAGE_PATH = join('app', '(app)', 'projects', '[projectId]', 'episodes', '[episodeId]', 'page.tsx')
const pageSrc = readFileSync(PAGE_PATH, 'utf8')

describe('逐镜生成回执的首生/重跑分支（SD-102）', () => {
  it('成功回执按 regenerate 二选一，不再无条件说「重新生成」', () => {
    expect(pageSrc).toMatch(/toast\.success\(t\(\s*(?:options\.)?regenerate \?\s*'generations\.shotRegenerated'\s*:\s*'generations\.shotGenerated'/)
    expect(pageSrc).not.toMatch(/toast\.success\(t\('generations\.shotRegenerated'/)
  })

  it('zh：首生那句不含「重新生成」，重跑那句仍是原话', () => {
    expect(dictionaries.zh['generations.shotGenerated']).toContain('生成')
    expect(dictionaries.zh['generations.shotGenerated']).not.toContain('重新生成')
    expect(dictionaries.zh['generations.shotRegenerated']).toContain('重新生成')
  })

  it('en：首生那句不含 regeneration，重跑那句仍是原话', () => {
    expect(dictionaries.en['generations.shotGenerated'].toLowerCase()).toContain('generation')
    expect(dictionaries.en['generations.shotGenerated'].toLowerCase()).not.toContain('regen')
    expect(dictionaries.en['generations.shotRegenerated'].toLowerCase()).toContain('regeneration')
  })

  it('两个键双语齐备且 {stage} 占位符同形', () => {
    for (const key of ['generations.shotGenerated', 'generations.shotRegenerated']) {
      expect(dictionaries.en[key], `${key} 缺 en 文案`).toBeTruthy()
      expect(dictionaries.zh[key], `${key} 缺 zh 文案`).toBeTruthy()
      expect(dictionaries.en[key]).toContain('{stage}')
      expect(dictionaries.zh[key]).toContain('{stage}')
    }
  })
})

/**
 * SD-070：SD-102 只修了制作台那一侧。镜头总览的分镜卡另有一条逐镜入口，它把
 * regenerate 写死成 true（`regenerateShotMedia(id, stage, undefined, true)`），
 * 卡上的字样又只有「重生成首帧/重生成视频」一种句式——零产物的新镜点下去，
 * 按钮说重跑、请求是重跑、回执也跟着说重跑，三处一起骗人。
 * 这里钉三件事：判据只有一份（格子里的产物）、字样与请求读同一个变量、
 * 写死的 true 不许回来。
 */
const CARD_PATH = join('components', 'storyboards', 'storyboard-card.tsx')

describe('镜头总览逐镜入口的首生/重跑分支（SD-070）', () => {
  const cardSrc = readFileSync(CARD_PATH, 'utf8')

  it('首帧/视频那一格：动词由这一格有没有产物决定，请求带的是同一个判据', () => {
    expect(cardSrc).toMatch(/const rerun = Boolean\(artifact\)/)
    expect(cardSrc).toMatch(/onClick=\{\(\) => onRegenerate\(rerun\)\}/)
    expect(cardSrc).toMatch(/t\(\s*rerun \?\s*'workbench\.rerunStage'\s*:\s*'workbench\.generateStage'/)
    expect(cardSrc).toMatch(/t\(\s*rerun \?\s*'storyboards\.regenFrameHint'\s*:\s*'storyboards\.genFrameHint'/)
  })

  it('配音那一格同样按产物分档', () => {
    expect(cardSrc).toMatch(/onRegenerateStage\(storyboard\.id, 'AUDIO', Boolean\(voiceTrack\)\)/)
    expect(cardSrc).toMatch(/t\(voiceTrack \?\s*'storyboards\.regenVoiceHint'\s*:\s*'storyboards\.genVoiceHint'\)/)
  })

  it('页面不再把 regenerate 写死成 true', () => {
    expect(pageSrc).not.toMatch(/regenerateShotMedia\(id, stage, undefined, true\)/)
    expect(pageSrc).toMatch(/regenerateShotMedia\(id, stage, undefined, regenerate\)/)
  })

  it('第三种句式（重生成首帧/重生成视频/重做配音 + 逐阶段「生成中」）已从字典删除', () => {
    for (const key of ['storyboards.regenFrame', 'storyboards.regenClip', 'storyboards.regenVoice', 'storyboards.regenningFrame', 'storyboards.regenningClip', 'storyboards.regenningVoice']) {
      expect(dictionaries.en[key], `${key} 的 en 文案还留着`).toBeUndefined()
      expect(dictionaries.zh[key], `${key} 的 zh 文案还留着`).toBeUndefined()
      expect(cardSrc, `${key} 仍被卡片引用`).not.toContain(`'${key}'`)
    }
  })

  it('首生那句不许说「重新」，重跑那句仍说覆盖', () => {
    expect(dictionaries.zh['storyboards.genFrameHint']).not.toContain('重新')
    expect(dictionaries.zh['storyboards.genClipHint']).not.toContain('重新')
    expect(dictionaries.zh['storyboards.genVoiceHint']).not.toContain('重新')
    expect(dictionaries.zh['storyboards.regenFrameHint']).toContain('覆盖')
    expect(dictionaries.en['storyboards.regenFrameHint'].toLowerCase()).toContain('overwriting')
    // 首生那句必须留下「不覆盖」这个否定式，否则读不出两档的差别；但它自己不许承诺覆盖。
    expect(dictionaries.en['storyboards.genFrameHint'].toLowerCase()).toContain('nothing is overwritten')
    expect(dictionaries.en['storyboards.genFrameHint'].toLowerCase()).not.toContain('overwriting')
  })
})

/**
 * 撞键重排不是「什么都没发生」：pipeline 会把还欠结果的旧任务按当前绑定重新入队，
 * 那一笔照样花钱。回执必须有第三档，否则「未新建任务」会在付费调用发生时说假话。
 */
describe('重排队务与「未新建任务」分开（SD-070 的后端真相）', () => {
  it('requeued>0 先于 shotNotCreated 判定', () => {
    expect(pageSrc).toMatch(/result\?\.created === false && result\.requeued/)
    expect(pageSrc).toMatch(/toast\.info\(t\('generations\.shotRequeued'/)
  })

  it('shotRequeued 双语齐备、{count} 与 {stage} 同形，且不写「未新建」', () => {
    for (const key of ['generations.shotRequeued']) {
      expect(dictionaries.en[key], `${key} 缺 en 文案`).toBeTruthy()
      expect(dictionaries.zh[key], `${key} 缺 zh 文案`).toBeTruthy()
      expect(dictionaries.en[key]).toContain('{count}')
      expect(dictionaries.zh[key]).toContain('{count}')
    }
    expect(dictionaries.zh['generations.shotRequeued']).not.toContain('未新建')
    expect(dictionaries.en['generations.shotRequeued'].toLowerCase()).not.toContain('no new task')
  })
})
