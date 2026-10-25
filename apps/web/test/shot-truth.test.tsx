import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PreviewPanel } from '@/components/shotboard/workbench/preview-panel'
import { ShotHistory, ShotReadout } from '@/components/storyboards/shot-history'
import { shotClip } from '@/components/storyboards/storyboard-card'
import { dictionaries } from '@/lib/i18n'
import { buildShotEvents, type ShotEvent } from '@/lib/shot-history'
import type { ApiClient, GenerationArtifact, GenerationBatch, GenerationTask, ShotboardShot, ShotVideoCandidate, Storyboard } from '@/lib/api'

/**
 * 这一份钉的是「同一块制作台上，屏幕上那句读数说的得是真实那一件」：画布显示的与读数的
 * 口径不许互相否定，版本行报的时长必须是量到的而不是想要的。
 * 与 workbench-operations.test.tsx 的分工——那里用 t()⇒键名的替身钉结构与载荷，
 * 这里换成**真中文词典**，因为 SD-103 / SD-168 / SD-082 的缺陷形状是「说的是哪一句」，
 * 键名断言证明不了「正看：首帧」和「正看：视频片段」谁被选中，也证明不了回落原因带没带上。
 */

vi.mock('@/lib/session', () => ({
  useSession: () => ({
    api: (async () => ({})) as ApiClient,
    can: () => true,
    token: 'test-token',
    status: 'authenticated',
    me: null,
    organizationId: 'org-1',
    organizationName: 'Test Org',
    role: 'OWNER',
    signIn: vi.fn(),
    signOut: vi.fn(),
    switchOrganization: vi.fn(),
    refresh: vi.fn(),
    clear: vi.fn(),
  }),
  SessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/lib/i18n', async () => {
  const mod = await vi.importActual<typeof import('@/lib/i18n')>('@/lib/i18n')
  const t = (key: string, params?: Record<string, string | number>): string => {
    const raw = mod.dictionaries.zh[key] ?? mod.dictionaries.en[key] ?? key
    return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
  }
  return { ...mod, useI18n: () => ({ t, locale: 'zh' as const }) }
})

/** 词典自查：万一有人动了 i18n，这里先红，别让断言变成「键名当文案」的假绿。 */
for (const key of ['shotboard.ph.videoOnlyFrame', 'shotboard.reason.videoFailed', 'shotboard.reason.videoParked']) {
  if (!dictionaries.zh[key]) throw new Error(`i18n 缺键：${key}`)
}

const VIEWING_VIDEO = '正看：视频片段'
const VIEWING_FRAME = '正看：首帧'

function artifact(over: Partial<GenerationArtifact> = {}): GenerationArtifact {
  return {
    id: 'frame-1',
    mimeType: 'image/png',
    objectKey: 'org-1/frame-1.png',
    version: 1,
    width: 720,
    height: 1280,
    durationMs: null,
    downloadUrl: '/artifacts/frame-1/content',
    ...over,
  }
}

function clip(over: Partial<ShotVideoCandidate> = {}): ShotVideoCandidate {
  return {
    artifactId: 'v-parked',
    taskId: 't-parked',
    origin: 'generation',
    version: 1,
    mimeType: 'video/mp4',
    durationMs: 4000,
    createdAt: '2026-10-01T08:00:00.000Z',
    selected: false,
    qc: null,
    awaitingDecision: true,
    ...over,
  }
}

function shot(over: Partial<ShotboardShot> = {}): ShotboardShot {
  return {
    id: 'shot-6',
    number: 6,
    revision: 1,
    title: '灯塔下',
    durationMs: 4000,
    description: '雨夜巷口',
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
    stateRevision: 3,
    operations: [],
    usage: null,
    slot: 'empty',
    production: 'video',
    method: null,
    attention: [],
    storyboardGaps: [],
    staleFirstFrameArtifactId: null,
    waitingSince: null,
    ...over,
  }
}

/** activeProduct 初值恒为 'video'（面板打开即「正看成片」），静态渲染就是实拍第一眼。 */
function render(over: Partial<ShotboardShot> = {}, requestingStage: 'FIRST_FRAME' | 'VIDEO' | 'AUDIO' | null = null): string {
  return renderToStaticMarkup(
    <PreviewPanel
      shot={shot(over)}
      requestingStage={requestingStage}
      onRegenerate={() => {}}
      onChanged={() => {}}
      onPrev={() => {}}
      onNext={() => {}}
      hasPrev={false}
      hasNext={false}
      prevNumber={null}
      nextNumber={null}
    />,
  )
}

/**
 * SD-103（台账 line 146，实拍 s6 镜头 #6）：画布在没有成片时回落显示首帧，头部那句
 * 「正看」却按 activeProduct 报成片——同一区块两句话互相否定。修后两处共读 previewSurface。
 */
describe('「正看」说的是画布上那一件（SD-103）', () => {
  it('只有首帧的镜：画布显示静帧，头部就必须说「正看：首帧」', () => {
    const html = render({ firstFrame: artifact() })
    expect(html).toContain(VIEWING_FRAME)
    // 缺陷形状是「报的是哪一档」，不是「有没有这句话」：旧实现在这里输出「正看：视频片段」。
    expect(html).not.toContain(VIEWING_VIDEO)
    // 同一分支的角标仍说「还没抽成片」，两句必须同向而不是互相打脸。
    expect(html).toContain('只有首帧 · 还没抽成片')
  })

  it('成片在手的镜照旧说「正看：视频片段」，回落不许把有片说成没片', () => {
    const html = render({ firstFrame: artifact(), video: artifact({ id: 'v-1', mimeType: 'video/mp4', durationMs: 4000 }), videoCandidates: [clip({ artifactId: 'v-1', awaitingDecision: false, selected: true })] })
    expect(html).toContain(VIEWING_VIDEO)
    expect(html).not.toContain(VIEWING_FRAME)
    expect(html).not.toContain('只有首帧 · 还没抽成片')
  })

  it('成片正在产：画布是那一档的生成中蒙版，头部不许改口报首帧（蒙版转圈、嘴上说在看静帧）', () => {
    const html = render({ firstFrame: artifact() }, 'VIDEO')
    expect(html).toContain(VIEWING_VIDEO)
    expect(html).not.toContain(VIEWING_FRAME)
    expect(html).toContain('animate-spin')
  })

  it('一件产物都没有：头部不谎称在看首帧，空态照旧', () => {
    const html = render({})
    expect(html).not.toContain(VIEWING_FRAME)
    expect(html).toContain(VIEWING_VIDEO)
    expect(html).not.toContain('只有首帧 · 还没抽成片')
  })
})

/**
 * SD-168（台账 line 394，镜头 #9）：唯一那一版付费成片停在「等你裁决」，播放器放得出来，
 * 红条却写「成片重抽没过线 · 这一镜还没有画面」。修后：有可播那一版就说有画面、等你裁决；
 * 「还没有画面」只留给真的什么都没有的镜。
 */
describe('有可播产物不再说「还没有画面」（SD-168）', () => {
  const parkedOnly = { videoCandidates: [clip()] }

  it('播放器能放那一版时，红条说「有可播的成片 · 等你裁决」，且不再出现「还没有画面」', () => {
    const html = render({ ...parkedOnly, attention: ['video_failed'], videoError: 'visual-audit: threshold not met after 3 attempts' })
    expect(html).toContain('这一镜有可播的成片 · 没过线，等你裁决')
    expect(html).not.toContain('这一镜还没有画面')
    // 画布与读数是同一件事：这一版真的挂在播放器上，「正看」报成片、首帧角标不亮。
    expect(html).toContain(VIEWING_VIDEO)
    expect(html).not.toContain('只有首帧 · 还没抽成片')
  })

  it('真的一件产物都没有时照旧说「这一镜还没有画面」，口径不许反向失守', () => {
    const html = render({ attention: ['video_failed'], videoError: 'visual-audit: threshold not met after 3 attempts' })
    expect(html).toContain('成片重抽没过线 · 这一镜还没有画面')
    expect(html).not.toContain('这一镜有可播的成片')
  })

  it('内部报文仍不上屏（SD-121 同一块面板的红条）', () => {
    const html = render({ ...parkedOnly, attention: ['video_failed'], videoError: 'visual-audit: threshold not met after 3 attempts' })
    expect(html).not.toContain('visual-audit')
  })
})

/**
 * SD-168 的另一处同一裁决：流程页的分镜卡。播放器能放停在「等你裁决」上的那一版时，
 * 读数不许再写「还没有成片」——两处说的是同一镜有没有画面，口径必须一致。
 */
function storyboardRow(over: Partial<Storyboard> = {}): Storyboard {
  return {
    id: 'sb-1',
    episodeId: 'ep-1',
    scriptVersionId: null,
    revision: 1,
    supersededAt: null,
    generationTaskId: null,
    number: 9,
    title: '床头读秒',
    durationMs: 4000,
    description: '他盯着床头的电子钟',
    dialogue: '',
    speaker: null,
    sourceExcerpt: '',
    continuityIn: '',
    continuityOut: '',
    sceneNumber: null,
    production: 'video',
    status: 'DRAFT',
    video: null,
    ...over,
  }
}

function readout(over: Partial<Storyboard>) {
  const row = storyboardRow(over)
  return renderToStaticMarkup(
    <ShotReadout
      plannedMs={row.durationMs}
      clipMs={null}
      voiceMs={null}
      frameScore={null}
      clipScore={null}
      qcThreshold={undefined}
      hasClip={Boolean(shotClip(row))}
      characters={0}
    />,
  )
}

describe('流程页读数与播放器同一口径（SD-168）', () => {
  it('生效成片在：读数是「成片已出」', () => {
    expect(readout({ video: artifact({ id: 'clip-live', mimeType: 'video/mp4' }) })).toContain('成片已出')
  })

  it('只有一版停在等你裁决上：读数仍承认有片，不写「还没有成片」', () => {
    const html = readout({ videoParked: artifact({ id: 'clip-parked', mimeType: 'video/mp4' }) })
    expect(html).toContain('成片已出')
    expect(html).not.toContain('还没有成片')
  })

  it('真的一条成片都没有才说「还没有成片」，口径不许反向失守', () => {
    const html = readout({})
    expect(html).toContain('还没有成片')
    expect(html).not.toContain('成片已出')
  })

  it('生效版优先于等你裁决的那一版', () => {
    const live = artifact({ id: 'clip-live', mimeType: 'video/mp4' })
    expect(shotClip(storyboardRow({ video: live, videoParked: artifact({ id: 'clip-parked', mimeType: 'video/mp4' }) }))).toBe(live)
  })
})

/**
 * SD-082（台账 line 122，镜头 #3）：重跑完要能在版本行上看清「这一版是谁产的、买了多长」。
 * 两个缺陷形状分开钉：① 接口下发的厂商与分镜计划时长没进履历；② 行上只印一个裸秒数，
 * 2 秒计划被 seedance 的 4 秒地板抬成 4.1 秒后，那个数到底是买的还是得的分不出来。
 */
function task(over: Partial<GenerationTask> = {}): GenerationTask {
  return {
    id: 't-1',
    stage: 'VIDEO',
    storyboardId: 'sb-1',
    status: 'SUCCEEDED',
    attempts: 1,
    provider: 'seedance',
    connectionName: null,
    model: 'seedance-2.0-mini',
    error: null,
    createdAt: '2026-10-21T14:00:00.000Z',
    updatedAt: '2026-10-21T14:02:00.000Z',
    artifacts: [artifact({ id: 'clip-1', mimeType: 'video/mp4', durationMs: 4096 })],
    qc: null,
    scores: [0.92],
    retryTrace: null,
    review: null,
    ...over,
  }
}

function eventsOf(rows: Storyboard[], tasks: GenerationTask[]): ShotEvent[] {
  const batches: GenerationBatch[] = [{ id: 'b-1', stage: 'VIDEO', status: 'SUCCEEDED', plannedCount: tasks.length, createdAt: '2026-10-21T14:00:00.000Z', tasks }]
  return buildShotEvents(batches, rows).get(rows[0].number) ?? []
}

function historyHtml(events: ShotEvent[], props: { voiceLive?: boolean } = {}): string {
  return renderToStaticMarkup(
    <ShotHistory events={events} live canRetry canPin qcThreshold={undefined} voiceLive={props.voiceLive ?? true} busy={false} onRetry={() => {}} onPin={() => {}} />,
  )
}

describe('版本行报得出厂商、模型与实测时长（SD-082）', () => {
  it('批次下发的厂商与分镜计划时长进得了履历行：接口有这两项，此前没往下传', () => {
    const [event] = eventsOf([storyboardRow({ durationMs: 2000 })], [task()])
    expect(event).toMatchObject({ provider: 'seedance', model: 'seedance-2.0-mini', durationMs: 4096, plannedMs: 2000 })
  })

  it('被时长地板抬过的一律标出来：实测 4.1s 与计划 2s 并排，不是裸一个秒数', () => {
    const html = historyHtml(eventsOf([storyboardRow({ durationMs: 2000 })], [task()]))
    expect(html).toContain('实测 4.1s · 计划 2s')
    expect(html).toContain('seedance-2.0-mini')
    expect(html).toContain('厂商 seedance')
  })

  it('实测与计划一致时不制造噪音，只报实测', () => {
    const html = historyHtml(eventsOf([storyboardRow({ durationMs: 4000 })], [task({ artifacts: [artifact({ id: 'clip-1', mimeType: 'video/mp4', durationMs: 4000 })] })]))
    expect(html).toContain('实测 4s')
    expect(html).not.toContain('计划')
  })

  it('接口给了连接名就报连接，用户起的名字盖过厂商；没连接名才退回厂商', () => {
    const [event] = eventsOf([storyboardRow()], [task({ connectionName: '百炼免费额度' })])
    expect(event).toMatchObject({ connectionName: '百炼免费额度' })
    const html = historyHtml(eventsOf([storyboardRow()], [task({ connectionName: '百炼免费额度' })]))
    expect(html).toContain('连接 百炼免费额度')
    expect(html).not.toContain('厂商 seedance')
  })

  it('没量到就不谎称实测：行上写「计划 2s · 还没量到」，裸计划数不许占实测的位置', () => {
    const html = historyHtml(eventsOf([storyboardRow({ durationMs: 2000 })], [task({ artifacts: [artifact({ id: 'clip-1', mimeType: 'video/mp4', durationMs: null })] })]))
    expect(html).toContain('计划 2s · 还没量到')
    expect(html).not.toContain('实测')
  })
})

/**
 * SD-189 的履历半边：这一镜的声音来源是导入档时，云端配音产的是进不了母带的死轨，
 * 履历行尾那句「重试这一步」就是又一笔永远不上片的付费调用。入口必须跟卡片那格同一判据，
 * 不许一处收口、一处照给。
 */
describe('不生效的云端配音不在履历里挂重跑入口（SD-189）', () => {
  const failedVoice = () => task({ stage: 'AUDIO', status: 'FAILED', artifacts: [], error: 'dashscope quota exhausted' })

  it('云端配音不进母带：失败行仍说清为什么，但不给「重试这一步」', () => {
    const html = historyHtml(eventsOf([storyboardRow()], [failedVoice()]), { voiceLive: false })
    expect(html).not.toContain('重试这一步')
    expect(html).toContain('抽了 1 次')
  })

  it('云端配音真进母带：入口照给——收口只认不生效那一档，不许顺手把配音全锁死', () => {
    const html = historyHtml(eventsOf([storyboardRow()], [failedVoice()]), { voiceLive: true })
    expect(html).toContain('重试这一步')
  })

  it('同一判据下视频档不受影响：它不进母带的理由是声音，不是画面', () => {
    const html = historyHtml(eventsOf([storyboardRow()], [task({ stage: 'VIDEO', status: 'FAILED', artifacts: [], error: 'dashscope quota exhausted' })]), { voiceLive: false })
    expect(html).toContain('重试这一步')
  })
})
