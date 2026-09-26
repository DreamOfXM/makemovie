import { describe, expect, it } from 'vitest'
import type { GenerationArtifact, ShotboardShot } from '@/lib/api'
import { dictionaries, type Locale } from '@/lib/i18n'
import { cardFailureCode, cardStage, retryWordForError, shotDemandText, shotFailureKind, shotVerdict, stageWord } from '@/lib/shot-verdict'

/**
 * 真文案，不是替身：断言直接读字典，所以键写错、少一门语言、或把「重抽无效」
 * 悄悄改回「重抽没过线」都会红。缺键时 t() 返回键本身，断言就撞在眼上。
 */
function translator(locale: Locale) {
  return (key: string, params?: Record<string, string | number>): string => {
    const raw = dictionaries[locale][key] ?? dictionaries.en[key] ?? key
    return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  }
}

const zh = translator('zh')

/** 与库里真实失败任务逐字同形的报文（GenerationTask.errorSnapshot 是文本列）。 */
const QUOTA_CHAIN = '["dashscope/wan2.7-t2v: AllocationQuota.FreeTierOnly | Free quota exhausted."]'
const ACCESS_DENIED = '["dashscope/fun-music-v1: AccessDenied | Access denied."]'
const NETWORK_DROP = '["dashscope/qwen3-tts-flash: fetch failed"]'
const AUDIT_MISSED = 'visual-audit: threshold not met after 3 attempts'

const anArtifact = { id: 'artifact-keep' } as GenerationArtifact

function shot(over: Partial<ShotboardShot>): ShotboardShot {
  return {
    id: 'shot-1',
    number: 1,
    revision: 1,
    title: '灯塔下',
    durationMs: 5000,
    description: '',
    dialogue: '',
    subtitleText: null,
    speaker: null,
    sourceExcerpt: '',
    continuityIn: '',
    continuityOut: '',
    status: 'DRAFT',
    assets: [],
    firstFrame: null,
    video: null,
    voice: null,
    firstFrameError: null,
    videoError: null,
    inflight: [],
    qc: [],
    selectedVideoArtifactId: null,
    audioSource: null,
    importedVoice: null,
    importedAmbience: null,
    videoCandidates: [],
    usage: null,
    slot: 'empty',
    attention: [],
    waitingSince: null,
    ...over,
  }
}

describe('失败归因', () => {
  it('认得出额度、权限、网络、质量四类原因', () => {
    expect(shotFailureKind(shot({ attention: ['frame_failed'], firstFrameError: QUOTA_CHAIN }))).toBe('quota')
    expect(shotFailureKind(shot({ attention: ['frame_failed'], firstFrameError: ACCESS_DENIED }))).toBe('access')
    expect(shotFailureKind(shot({ attention: ['frame_failed'], firstFrameError: NETWORK_DROP }))).toBe('network')
    expect(shotFailureKind(shot({ attention: ['frame_failed'], firstFrameError: AUDIT_MISSED }))).toBe('audit')
  })

  /** 卡片与放映条就是这么调的：档位由 cardStage 算，原因由同一镜的报文分类。 */
  const badge = (shot: ShotboardShot, compact = false) =>
    stageWord(zh, shotVerdict(shot), cardStage(shot, shotVerdict(shot)), compact, shotFailureKind(shot))

  it('额度用尽时徽章不再说「没过线」', () => {
    const failed = shot({ attention: ['frame_failed'], firstFrame: anArtifact, firstFrameError: QUOTA_CHAIN })
    expect(cardStage(failed, shotVerdict(failed))).toBe('retry')
    expect(badge(failed)).toBe('重抽解决不了')
    expect(badge(failed, true)).toBe('重抽无效')
  })

  it('网络中断说「没送达」，因为它确实还能重抽', () => {
    const failed = shot({ attention: ['frame_failed'], firstFrame: anArtifact, firstFrameError: NETWORK_DROP })
    expect(badge(failed)).toBe('这一抽没送达模型')
  })

  it('质量审计拒收保持原句，不动大多数镜头的说法', () => {
    const failed = shot({ attention: ['frame_failed'], firstFrame: anArtifact, firstFrameError: AUDIT_MISSED })
    expect(badge(failed)).toBe('重抽没过线')
    // 窄格用的那句必须真的短：上一版这里漏了 compact 分支，放映条一格在手机上被裁成空白。
    expect(badge(failed, true)).toBe('没过线')
    expect(shotDemandText(zh, failed, 'frame_failed')).toBe('首帧这一版还在 · 决定再抽一次还是收下')
  })

  /**
   * 队列一镜可能并列多行（首帧失败 + 等你审）。只有卡片正在说的那一档失败才许借用
   * 徽章那句，其余行说自己那一档——否则同一行里徽章报额度、诉求报放行。
   */
  it('队列只给卡片正在报的那一档失败换归因词，同镜的「等你审」行不动', () => {
    const failed = shot({
      status: 'NEEDS_REVIEW',
      attention: ['frame_failed', 'awaiting_review'],
      firstFrame: anArtifact,
      firstFrameError: QUOTA_CHAIN,
    })
    const verdict = shotVerdict(failed)
    expect(cardFailureCode(verdict)).toBe('frame_failed')
    const rowLabel = (code: string) =>
      code === cardFailureCode(verdict)
        ? stageWord(zh, verdict, cardStage(failed, verdict), false, shotFailureKind(failed))
        : zh(code === 'awaiting_review' ? 'shotboard.stage.review' : `attention.${code}`)
    expect(rowLabel('frame_failed')).toBe('重抽解决不了')
    expect(rowLabel('awaiting_review')).toBe('等你审')
  })

  it('格子角标吃这一格自己的报文：额度写成「重抽无效」，审计才是「没过线」', () => {
    expect(retryWordForError(zh, QUOTA_CHAIN)).toBe('重抽无效')
    expect(retryWordForError(zh, NETWORK_DROP)).toBe('没送达')
    expect(retryWordForError(zh, AUDIT_MISSED)).toBe('没过线')
  })

  it('待处理那句先报真因，再报这一镜手上还剩什么', () => {
    const kept = shot({ attention: ['frame_failed'], firstFrame: anArtifact, firstFrameError: QUOTA_CHAIN })
    expect(shotDemandText(zh, kept, 'frame_failed')).toBe('上一版首帧还挂在这一镜上 · 模型额度已用尽 · 先充值或关闭「仅用免费额度」，再抽也不会变')

    const empty = shot({ attention: ['video_failed'], videoError: ACCESS_DENIED })
    expect(shotDemandText(zh, empty, 'video_failed')).toBe('这一次没产出成片 · 模型拒绝本账号调用（AccessDenied）· 到模型中心换绑一个有权限的模型')
  })

  it('没有台词也没有产物的空闲镜头不会被判成失败', () => {
    const idle = shot({})
    expect(shotFailureKind(idle)).toBe('unknown')
    expect(cardStage(idle, shotVerdict(idle))).toBe('idle')
  })
})
