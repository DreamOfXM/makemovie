import { describe, expect, it } from 'vitest'
import type { GenerationArtifact, ShotboardShot } from '@/lib/api'
import { dictionaries, type Locale } from '@/lib/i18n'
import { cardFailureCode, cardStage, isUnknownSubmission, productionWord, retryWordForError, shotDemandText, shotFailureKind, shotVerdict, stageWord, stripIsEmpty } from '@/lib/shot-verdict'

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
const MODERATION = '["dashscope/wan2.2-t2i-flash: DataInspectionFailed | Green net check rejected text (input)"]'

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
    transition: 'cut',
    transitionMs: 0,
    sceneNumber: null,
    status: 'DRAFT',
    assets: [],
    firstFrame: null,
    video: null,
    voice: null,
    firstFrameError: null,
    videoError: null,
    inflight: [],
    inflightAttempts: [],
    qc: [],
    selectedVideoArtifactId: null,
    selectedFrameArtifactId: null,
    selectedVoiceArtifactId: null,
    audioSource: null,
    importedVoice: null,
    importedAmbience: null,
    ambience: null,
    videoCandidates: [],
    frameCandidates: [],
    voiceCandidates: [],
    stateRevision: 0,
    operations: [],
    usage: null,
    slot: 'empty',
    production: 'video',
    attention: [],
    storyboardGaps: [],
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

  /**
   * 内容审查既不是「没过线」（画面根本没生成），也不是「重抽无效」（改了描述就过）。
   * 这句必须指向唯一有效的动作：先改描述。少这一档，用户会对着红条反复点重抽。
   */
  it('内容审查拒收说「先改描述」，不混进「没过线」也不混进「重抽无效」', () => {
    expect(retryWordForError(zh, MODERATION)).toBe('改描述')
    const failed = shot({ attention: ['frame_failed'], firstFrame: anArtifact, firstFrameError: MODERATION })
    expect(badge(failed)).toBe('重抽前先改描述')
    expect(shotFailureKind(failed)).toBe('moderation')
    expect(shotDemandText(zh, failed, 'frame_failed')).toBe('上一版首帧还挂在这一镜上 · 模型内容审查未通过 · 与额度无关，请调整描述中的敏感表述后重试')
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

  /**
   * 分镜表写明「字卡/界面/合成/录屏」的镜头，平台永远不会给它出画面。此前它和普通
   * 生成镜一样显示「还没开始」、放映条画斜纹，整集 30 个手工镜被读成 30 笔生成欠账。
   */
  it('手工制作的镜头写「手工制作」，不写「还没开始」，放映条也不画斜纹', () => {
    const titleCard = shot({ production: 'title-card', slot: 'local' })
    const stage = cardStage(titleCard, shotVerdict(titleCard))
    expect(stage).toBe('local')
    expect(badge(titleCard)).toBe('手工制作')
    expect(badge(titleCard, true)).toBe('手工')
    expect(stripIsEmpty(titleCard, stage)).toBe(false)
    expect(productionWord(zh, titleCard.production)).toBe('字卡')
  })

  it('手工镜头一旦有了画面仍写「手工制作」，不翻成「等你启动生成」', () => {
    // SD-108 实拍（镜头 #7 渲染字卡后）：徽章从「手工 · 字卡」翻成「等你启动生成」,
    // 因为判定把首帧当成每个镜头都欠的一件东西——而分镜表明写这一镜平台永不拍首帧。
    // 结果平台在用户刚做完它要他做的事之后，催他启动一次永远不会发生的生成。
    const rendered = shot({ production: 'title-card', slot: 'local', video: anArtifact })
    const verdict = shotVerdict(rendered)
    expect(cardStage(rendered, verdict)).toBe('local')
    expect(verdict.done).toBe(verdict.total)
    expect(badge(rendered)).toBe('手工制作')
    // 同一镜型在旧判据下会走 'start' 档，那句文案就是这次要消掉的谎。
    // SD-112：'start' 档本身也必须报数——生成镜「首帧+成片都已在手、只差一条配音」时，
    // 不报数的「等你启动生成」和零产物镜读起来是同一句话，用户分不清哪镜真的没动工。
    expect(stageWord(zh, { ...verdict, done: 2, total: 3 }, 'start')).toBe('已出 2/3 · 等你启动生成')
  })
})

/**
 * 2026-09-28 事故回放：用户点了一次配音生成，12 镜台词全部合成成功，斜纹却全灭——
 * 旧判定把「任何一件产物落地」当成「这一格不空」，配音让每镜 done≥1，放映条
 * 整条变纯色，读不出画面欠账。斜纹的语义是「画面一件都没有」，与声音无关。
 */
describe('放映条斜纹', () => {
  it('只有配音、画面一件没有的镜仍画斜纹（事故形态：done=1 → start）', () => {
    const voiceOnly = shot({ dialogue: '我妈第二次开口，要我的房子。', voice: anArtifact })
    const stage = cardStage(voiceOnly, shotVerdict(voiceOnly))
    expect(stage).toBe('start')
    expect(stripIsEmpty(voiceOnly, stage)).toBe(true)
  })

  it('首帧或视频在手的镜不画斜纹', () => {
    const framed = shot({ firstFrame: anArtifact })
    expect(stripIsEmpty(framed, cardStage(framed, shotVerdict(framed)))).toBe(false)
  })

  it('无台词无产物的镜照旧画斜纹；在产或等你审的镜不画', () => {
    const silent = shot({})
    expect(stripIsEmpty(silent, cardStage(silent, shotVerdict(silent)))).toBe(true)

    const running = shot({ inflight: ['FIRST_FRAME'] as ShotboardShot['inflight'] })
    expect(stripIsEmpty(running, cardStage(running, shotVerdict(running)))).toBe(false)

    const reviewing = shot({ status: 'NEEDS_REVIEW' })
    expect(stripIsEmpty(reviewing, cardStage(reviewing, shotVerdict(reviewing)))).toBe(false)
  })
})

/**
 * 「上一笔提交成没成，平台自己也不知道」这一档必须被认出来（SD-128 / SD-130，
 * 2026-10-22 #19、#20 两次现场）。认不出来的后果不是文案不准，是死按钮：
 * 「只补缺」对同一幂等键只会拿到 created:false，屏上报成功而系统什么都没做。
 * 三条报文逐字取自 worker 的写出点（run-task.ts:731 / :770 / :462）。
 */
describe('提交状态未知的报文', () => {
  const LEDGER_SLOT =
    'dashscope/qwen-image-3.0-pro: submission ledger slot (1/0) is already occupied — refusing to re-submit; manual verification required'
  const SUBMIT_UNKNOWN =
    'dashscope/qwen-image-3.0-pro: submission unknown — the provider may have accepted task (attempt 1, provider dashscope, model qwen-image-3.0-pro); manual verification required before any retry. fetch failed'
  const ORPHAN_LEDGER =
    'submission ledger row cmvjigeun000l1m9q has provider task 8f2c1 but no recorded connection/capability identity — manual verification required before any retry'

  it.each([
    ['台账槽位被自己那行未终局的 submitting 占住', LEDGER_SLOT],
    ['提交超时、厂商可能已接单', SUBMIT_UNKNOWN],
    ['台账行认不出连接身份', ORPHAN_LEDGER],
  ])('%s → 进核对门', (_label, raw) => {
    expect(isUnknownSubmission(raw)).toBe(true)
  })

  it('额度耗尽与没过线都不是「状态未知」，不许误开门多计费一次', () => {
    expect(isUnknownSubmission(QUOTA_CHAIN)).toBe(false)
    expect(isUnknownSubmission('visual-audit: threshold not met after 3 attempts')).toBe(false)
    expect(isUnknownSubmission(null)).toBe(false)
    expect(isUnknownSubmission('')).toBe(false)
  })
})

/**
 * 导入环境音的两句长度读数，必须说混音层真做的事。旧句写「尾巴空着」「切在这一镜末尾」，
 * 那是 S4① 之前的行为；现在导入底会接上自己循环补满这一镜，并在切点后再拖 0.2 秒淡出
 * （packages/media 的 planAudioBridges 与 AUDIO_BRIDGE_TAIL_MS，那边有真 ffmpeg 断言钉
 * 行为）。这里钉的是界面别重新骗人。
 */
describe('导入环境音的长短读数', () => {
  const bed = (key: string, audio: string, picture: string, gap: string) => zh(key, { audio, picture, gap })

  it('短了说的是循环，不是尾巴空着', () => {
    const line = bed('shotboard.audio.ambienceShorter', '1.0s', '3.0s', '2.0s')
    expect(line).toContain('循环')
    expect(line).not.toContain('配音底下是空的')
  })

  it('长了说的是切点后拖 0.2 秒淡出，不是切在这一镜末尾', () => {
    const line = bed('shotboard.audio.ambienceLonger', '5.0s', '3.0s', '2.0s')
    expect(line).toContain('0.2')
    expect(line).not.toContain('不会进下一镜')
  })

  it('剧本点名的底，两处都带着那一列的原文', () => {
    expect(zh('shotboard.audio.ambienceAskedEmpty', { bed: '雨打铁皮棚', mode: '只用原声' })).toContain('雨打铁皮棚')
    expect(zh('shotboard.audio.ambienceAsked', { bed: '雨打铁皮棚' })).toContain('雨打铁皮棚')
  })
})
