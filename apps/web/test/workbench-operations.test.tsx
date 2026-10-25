import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PreviewPanel, requestArtifactOperation, type ArtifactApplyPolicy } from '@/components/shotboard/workbench/preview-panel'
import { AudioSourceRow } from '@/components/shotboard/workbench/audio-source-row'
import { ShotEditor } from '@/components/shotboard/workbench/shot-editor'
import { TransitionRow } from '@/components/shotboard/workbench/transition-row'
import { VersionCompare } from '@/components/shotboard/workbench/version-compare'
import { ArtifactLoadError } from '@/components/generations/artifact-media'
import type { ApiClient, GenerationArtifact, ShotboardShot, ShotOperation, ShotVideoCandidate } from '@/lib/api'

/**
 * UX-P04：延长/定向编辑入口必须真的渲染出来、载荷与端点契约一致、操作状态数据驱动，
 * 以及 VersionCompare 在多候选时挂载（媒体鉴权走 ArtifactMedia 既有链路）。
 *
 * 本仓组件测试跑在 node 环境（无 DOM），走 react-dom/server 静态渲染 + i18n/session
 * 注入层 mock：t() 恒回键名让断言不随后续补字典漂移，can() 恒真走有权限分支。
 */

/** 渲染出的 HTML 里不许有落在原生 button 内的可交互元素（SD-122：非法 HTML 会让整棵工作台 hydration 失败退回 CSR）。 */
function htmlInteractiveNesting(html: string): string[] {
  const found: string[] = []
  const stack: string[] = []
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g
  for (let match; (match = tagRe.exec(html)); ) {
    const [, slash, name, attrs] = match
    if (slash) {
      const index = stack.lastIndexOf(name)
      if (index >= 0) stack.length = index
      continue
    }
    if (stack.includes('button') && ((name === 'button' && !/type="submit"/.test(attrs)) || name === 'a')) {
      found.push(`<${name}${attrs.slice(0, 40)}>`)
    }
    if (!/\/$/.test(attrs) && !['br', 'img', 'input', 'hr'].includes(name)) stack.push(name)
  }
  return found
}

const sessionMock = vi.hoisted(() => {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const api = (async (path: string, init?: RequestInit) => {
    calls.push({ path, init })
    return {}
  }) as ApiClient
  return { calls, api }
})

vi.mock('@/lib/session', () => ({
  useSession: () => ({
    api: sessionMock.api,
    can: () => true,
    token: 'test-token',
    status: 'authenticated',
    me: null,
    organizationId: 'org-1',
    organizationName: 'Test Org',
    role: 'EDITOR',
    signIn: vi.fn(),
    signOut: vi.fn(),
    switchOrganization: vi.fn(),
    refresh: vi.fn(),
    clear: vi.fn(),
  }),
  SessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en' }),
  I18nProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  translateEnum: (value: string) => value,
}))

function candidate(over: Partial<ShotVideoCandidate> = {}): ShotVideoCandidate {
  return {
    artifactId: 'a-1',
    taskId: 't-1',
    origin: 'generation',
    version: 1,
    mimeType: 'video/mp4',
    durationMs: 3000,
    createdAt: '2026-10-01T08:00:00.000Z',
    selected: false,
    qc: null,
    ...over,
  }
}

function operation(over: Partial<ShotOperation> = {}): ShotOperation {
  return { id: 'op-1', kind: 'video_extend', status: 'QUEUED', error: null, createdAt: '2026-10-01T08:00:00.000Z', ...over }
}

function shot(over: Partial<ShotboardShot> = {}): ShotboardShot {
  return {
    id: 'shot-1',
    number: 1,
    revision: 1,
    title: '巷口相遇',
    durationMs: 3000,
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

function renderPreview(over: Partial<ShotboardShot> = {}): string {
  const board = shot(over)
  return renderToStaticMarkup(
    <PreviewPanel
      shot={board}
      requestingStage={null}
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

describe('延长/定向编辑入口（preview-panel）', () => {
  it('有视频候选时渲染「调整这一镜」动词菜单入口（不再是只有 handler 没有按钮）', () => {
    const html = renderPreview({ videoCandidates: [candidate()] })
    // Radix 下拉触发器的结构特征：菜单入口真实挂载。
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('preview.adjustShot')
    // 延长/修改表单收进菜单后才展开——默认渲染里不该出现表单本体。
    expect(html).not.toContain('preview.extendSubmit')
    expect(html).not.toContain('preview.editSubmit')
  })

  it('版本行如实标注来源：生成/延长/定向修改都在候选格上', () => {
    const html = renderPreview({
      videoCandidates: [
        candidate({ artifactId: 'a-edit', version: 1, origin: 'directed_edit', taskId: null, createdAt: '2026-10-03T08:00:00.000Z' }),
        candidate({ artifactId: 'a-extend', version: 1, origin: 'extend', taskId: null, createdAt: '2026-10-02T08:00:00.000Z' }),
        candidate({ artifactId: 'a-gen', version: 1, origin: 'generation', createdAt: '2026-10-01T08:00:00.000Z' }),
      ],
    })
    expect(html).toContain('candidate.origin.directed_edit')
    expect(html).toContain('candidate.origin.extend')
    expect(html).toContain('candidate.origin.generation')
    // 已有数据字段照旧：版本号可读。
    expect(html).toContain('v1')
  })

  it('已收下的低分版本不再标「被否」：红标只认审计未通过，重抽计数也不再算它', () => {
    const accepted = renderPreview({
      videoCandidates: [candidate({ version: 2, qc: { kind: 'visual-audit', status: 'APPROVED', score: 0.62, reasons: ['钟从胸口沉到腰部'] } })],
    })
    expect(accepted).not.toContain('workbench.rejected')
    expect(accepted).toContain('62')
    expect(accepted).not.toContain('workbench.reworkCost')

    const rejected = renderPreview({
      videoCandidates: [candidate({ version: 2, qc: { kind: 'visual-audit', status: 'NEEDS_REVIEW', score: 0.62, reasons: ['钟从胸口沉到腰部'] } })],
    })
    expect(rejected).toContain('workbench.rejected')
    expect(rejected).toContain('workbench.reworkCost')
  })

  it('操作在途与失败由 shot.operations 数据驱动：延长中占位、失败就地亮出', () => {
    const running = renderPreview({
      videoCandidates: [candidate()],
      operations: [operation({ status: 'RUNNING', kind: 'video_extend' })],
    })
    expect(running).toContain('preview.opExtendRunning')
    const editing = renderPreview({
      videoCandidates: [candidate()],
      operations: [operation({ status: 'RUNNING', kind: 'video_edit' })],
    })
    expect(editing).toContain('preview.opEditRunning')
    const pending = renderPreview({
      videoCandidates: [candidate()],
      operations: [operation({ status: 'BLOCKED' })],
    })
    expect(pending).toContain('preview.opPending')
    const failed = renderPreview({
      videoCandidates: [candidate()],
      operations: [operation({ status: 'FAILED', error: 'provider boom' })],
    })
    expect(failed).toContain('preview.opFailed')
    // SD-121：英文报文退出扫描面，只留「查看报错原文」这颗取证的入口。
    // 静态渲染下 Tooltip 未展开不渲染正文——「原文不上屏」这条正是靠它可证。
    expect(failed).toContain('workbench.rawErrorTrigger')
    expect(failed).not.toContain('provider boom')
  })
})

/**
 * SD-189：不生效的旧档不许挂着付费重跑入口。生效声档是「导入音频」时，母带里这一镜
 * 的人声只认导入件（compose manifest 的 audio 档与 cloudVoiceEntersMaster 同一口径），
 * 云端配音永远不上片——配音区块头的读数必须是「不进母带」这句，而不是冒充生效链的
 * 「自动取最新 / ✓ 已钦定」；它的钦定与「重跑「配音」」（一次真计费的云端调用）整段收口
 * （按钮在展开区，静态渲染下由 shot-verdict.test.ts 的 cloudVoiceEntersMaster 钉判据）。
 */
describe('导入声档的云端配音收口（preview-panel）', () => {
  const importedFile: GenerationArtifact = {
    id: 'imp-1',
    mimeType: 'audio/wav',
    objectKey: 'org-1/shot-1-voice.wav',
    version: 1,
    width: null,
    height: null,
    durationMs: 4600,
    downloadUrl: '/artifacts/imp-1/content',
  }

  it('audioSource=IMPORTED：配音区块头说「云端配音不进母带」，不再写「自动取最新」', () => {
    const html = renderPreview({
      dialogue: '你来了。',
      audioSource: 'IMPORTED',
      importedVoice: importedFile,
      voice: { ...importedFile, id: 'cloud-1' },
      voiceCandidates: [candidate({ artifactId: 'cloud-1', origin: 'generation' })],
    })
    expect(html).toContain('workbench.voiceCloudBypass')
    expect(html).not.toContain('workbench.autoPinned')
    expect(html).not.toContain('✓ workbench.voicePinned')
  })

  it('云端配音仍在生效链上时（VOICE 档）不动旧读数：区块头照旧说自动取最新/已钦定', () => {
    const html = renderPreview({
      dialogue: '你来了。',
      audioSource: 'VOICE',
      voice: { ...importedFile, id: 'cloud-1' },
      voiceCandidates: [candidate({ artifactId: 'cloud-1', origin: 'generation' })],
    })
    expect(html).not.toContain('workbench.voiceCloudBypass')
    expect(html).toContain('workbench.autoPinned')
  })
})

/**
 * SD-168：唯一那一版付费成片停在「等你裁决」时，红条必须换口径。
 * 这里只钉「用的是哪条键」（真句子与真词典在 test/shot-truth.test.tsx），
 * 因为旧判据只看生效链、把「有可播那一版」和「真没产物」压成同一句「这一镜还没有画面」。
 */
describe('有可播产物却没过线的读数口径（preview-panel）', () => {
  const auditFailure = 'visual-audit: threshold not met after 3 attempts'

  it('候选里有停在等你裁决那一版 → 说 videoParked，不再说 videoFailed', () => {
    const html = renderPreview({
      attention: ['video_failed'],
      videoError: auditFailure,
      videoCandidates: [candidate({ awaitingDecision: true })],
    })
    expect(html).toContain('shotboard.reason.videoParked')
    expect(html).not.toContain('shotboard.reason.videoFailed')
  })

  it('真的什么都没有时照旧说 videoFailed，判据不许反向失守', () => {
    const html = renderPreview({ attention: ['video_failed'], videoError: auditFailure })
    expect(html).toContain('shotboard.reason.videoFailed')
    expect(html).not.toContain('shotboard.reason.videoParked')
  })

  it('放大入口只认「有没有能播的画面」：有停判那一版就给，空镜不给', () => {
    expect(renderPreview({ videoCandidates: [candidate({ awaitingDecision: true })] })).toContain('workbench.zoom')
    expect(renderPreview()).not.toContain('workbench.zoom')
  })
})

describe('操作提交层（requestArtifactOperation）', () => {
  const api = sessionMock.api

  async function lastBody(): Promise<Record<string, unknown>> {
    const call = sessionMock.calls[sessionMock.calls.length - 1]!
    return JSON.parse(call.init?.body as string) as Record<string, unknown>
  }

  it('extend：POST /artifacts/:id/extend，带 durationMs 与采用策略；默认不带 CAS 修订号', async () => {
    sessionMock.calls.length = 0
    await requestArtifactOperation(api, 'a-1', 'extend', { durationMs: 5000, applyPolicy: 'candidate_only', expectedShotRevision: 3 })
    expect(sessionMock.calls[0]).toMatchObject({ path: '/artifacts/a-1/extend' })
    expect(await lastBody()).toEqual({ applyPolicy: 'candidate_only', durationMs: 5000 })
  })

  it('extend + apply_if_unchanged：才把 expectedShotRevision 带上（端点支持的参数一个不假造）', async () => {
    sessionMock.calls.length = 0
    await requestArtifactOperation(api, 'a-1', 'extend', { durationMs: 2000, applyPolicy: 'apply_if_unchanged' as ArtifactApplyPolicy, expectedShotRevision: 3 })
    expect(await lastBody()).toEqual({ applyPolicy: 'apply_if_unchanged', durationMs: 2000, expectedShotRevision: 3 })
  })

  it('edit：POST /artifacts/:id/edit-video，只带 instruction 与端点支持的策略（无时长/无修订号）', async () => {
    sessionMock.calls.length = 0
    await requestArtifactOperation(api, 'a-1', 'edit', { instruction: '把伞改成红色', applyPolicy: 'apply_if_empty' })
    expect(sessionMock.calls[0]).toMatchObject({ path: '/artifacts/a-1/edit-video' })
    expect(await lastBody()).toEqual({ applyPolicy: 'apply_if_empty', instruction: '把伞改成红色' })
  })
})

describe('每镜字幕入口（audio-source-row）', () => {
  // 字幕是合成时才画进画面的，与有没有配音、有没有台词无关。这一整行曾只在
  // 「导入过音频或已写过字幕」时渲染，于是最需要它的镜（没台词的计数镜、地点镜）
  // 根本没有入口——写它的 POST /storyboards/:id/subtitle 一直都在。
  function renderAudio(over: Partial<ShotboardShot> = {}): string {
    return renderToStaticMarkup(<AudioSourceRow shot={shot(over)} onChanged={() => {}} />)
  }

  it('没有台词也没有导入的镜照样给字幕入口', () => {
    const html = renderAudio()
    expect(html).toContain('shotboard.audio.subtitle')
    expect(html).toContain('shotboard.audio.subtitleAdd')
    // 没有台词就没有「沿用台词」这一档：合成取的是 subtitleText ?? dialogue，
    // 空台词下选它等于选「不上字」，不该伪装成一格可选状态。
    expect(html).not.toContain('shotboard.audio.subtitleDialogue')
  })

  it('有台词的镜给两档：沿用台词 / 改为本镜', () => {
    const html = renderAudio({ dialogue: '你来了。' })
    expect(html).toContain('shotboard.audio.subtitleDialogue')
    expect(html).toContain('shotboard.audio.subtitleCustom')
    expect(html).not.toContain('shotboard.audio.subtitleAdd')
  })

  it('已写过字幕的镜亮出内容态；没有台词时给「移除字幕」而不是「沿用台词」', () => {
    const silent = renderAudio({ subtitleText: '第 1 次' })
    expect(silent).toContain('shotboard.audio.subtitleCustom')
    expect(silent).toContain('shotboard.audio.subtitleClear')
    expect(silent).not.toContain('shotboard.audio.subtitleDialogue')

    const voiced = renderAudio({ dialogue: '你来了。', subtitleText: '第 1 次' })
    expect(voiced).toContain('shotboard.audio.subtitleDialogue')
    expect(voiced).not.toContain('shotboard.audio.subtitleClear')
  })
})

/**
 * 分镜表「声音」列的落点。这一列是作者拍板的声床（plan_2026-10-24 §5）：平台不生成
 * 环境音，所以它唯一的出路是被人在导入那一行看见、再照着导。库里存了、界面上不出现，
 * 等于剧本写下的雨声永远进不了成片。
 */
describe('剧本「声音」列 → 本镜环境音（audio-source-row）', () => {
  const bed = {
    id: 'bed-1',
    mimeType: 'audio/wav',
    objectKey: 'org-1/shot-1-ambience-bed.wav',
    version: 1,
    width: null,
    height: null,
    durationMs: 3000,
    downloadUrl: '/artifacts/bed-1/content',
    filename: '街声.wav',
  } satisfies GenerationArtifact

  function renderBed(over: Partial<ShotboardShot> = {}): string {
    return renderToStaticMarkup(<AudioSourceRow shot={shot(over)} onChanged={() => {}} />)
  }

  it('剧本点名要底、一条还没导时空态点名要导哪条', () => {
    const html = renderBed({ ambience: '雨打铁皮棚' })
    expect(html).toContain('shotboard.audio.ambienceAskedEmpty')
    expect(html).not.toContain('shotboard.audio.ambienceEmpty')
    // 没点名（旧数据、或自由拆解不带这一列）时仍是原来那句，不凭空造一条欠账。
    expect(renderBed()).toContain('shotboard.audio.ambienceEmpty')
  })

  it('作者写「无」就是不要底，不催导入', () => {
    for (const written of ['无', 'none', '—', ' 无 ']) {
      const html = renderBed({ ambience: written })
      expect(html).not.toContain('shotboard.audio.ambienceAskedEmpty')
      expect(html).toContain('shotboard.audio.ambienceEmpty')
    }
  })

  it('导入以后把剧本要的那条摆在文件旁边核对', () => {
    const html = renderBed({ ambience: '雨打铁皮棚', importedAmbience: bed })
    expect(html).toContain('shotboard.audio.ambienceAsked')
    // 剧本没写的镜不该冒出这句核对话。
    expect(renderBed({ importedAmbience: bed })).not.toContain('shotboard.audio.ambienceAsked')
  })

  it('底与画面的长度差仍按导入底那两句说，不是配音那两句', () => {
    expect(renderBed({ ambience: null, importedAmbience: { ...bed, durationMs: 1000 } })).toContain('shotboard.audio.ambienceShorter')
    expect(renderBed({ ambience: null, importedAmbience: { ...bed, durationMs: 5000 } })).toContain('shotboard.audio.ambienceLonger')
    expect(renderBed({ ambience: null, importedAmbience: { ...bed, durationMs: 3050 } })).not.toContain('shotboard.audio.ambienceShorter')
  })
})

describe('转场格（transition-row）', () => {
  function renderTransition(over: Partial<ShotboardShot> = {}) {
    const s = shot(over)
    return renderToStaticMarkup(<TransitionRow transition={s.transition} transitionMs={s.transitionMs} disabled={false} onChange={() => {}} />)
  }

  it('亮的永远是库里那一格，且六格都在轨道里', () => {
    const html = renderTransition({ transition: 'dissolve', transitionMs: 600 })
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    // 选中态按词表逐格判定：亮的那一格必须是叠化，不是别的。
    expect(html.match(/<button[^>]*aria-pressed="true"[^>]*>([^<]*)</)?.[1]).toBe('storyboards.transition.dissolve')
    expect(html.match(/border-primary\/70/g)).toHaveLength(1)
    for (const key of ['storyboards.transition.cut', 'storyboards.transition.dissolve', 'storyboards.transition.fade_in', 'storyboards.transition.fade_out', 'storyboards.transition.black', 'storyboards.transition.flash']) {
      expect(html).toContain(key)
    }
    // 毫秒按秒显示（0.6），不是裸 600——输入框的单位写在标签上。
    expect(html).toContain('value="0.6"')
  })

  it('硬切不给时长框：那一刀没有重叠，填数只会骗人', () => {
    expect(renderTransition({ transition: 'cut', transitionMs: 0 })).not.toContain('storyboards.transition.ms')
    expect(renderTransition({ transition: 'cut', transitionMs: 0 })).toContain('storyboards.transition.eff.cut')
  })

  it('存了 0 毫秒的叠化抬回该档缺省值，绝不显示会被合成判成硬切的数', () => {
    // resolveTransition 把 <50ms 的重叠降回硬切：控件若照抄 0，用户点了叠化、
    // 母带上还是裸切，这一格就成了假账。
    expect(renderTransition({ transition: 'dissolve', transitionMs: 0 })).toContain('value="0.4"')
    expect(renderTransition({ transition: 'black', transitionMs: 0 })).toContain('value="0.5"')
    // 上界同样夹住：1000ms 以上母带会吃掉整镜。
    expect(renderTransition({ transition: 'flash', transitionMs: 9999 })).toContain('value="1"')
  })

  it('词表外的存档值不冒充某一格，照实说这一刀按硬切渲染', () => {
    const html = renderTransition({ transition: 'wipe', transitionMs: 400 })
    expect(html).not.toContain('aria-pressed="true"')
    expect(html).toContain('storyboards.transition.unknownWord')
    expect(html).not.toContain('storyboards.transition.eff.')
  })

  it('编辑器把这一格挂在衔接字段之后，读写走同一条 PATCH', () => {
    const html = renderToStaticMarkup(
      <ShotEditor
        shot={shot({ transition: 'fade_in', transitionMs: 500 })}
        episodeAssets={[]}
        canWrite
        onBindAssets={async () => {}}
        onChangeStatus={() => {}}
        onOpenShot={() => {}}
        onOpenStoryboardCard={() => {}}
        onOpenAsset={() => {}}
        onSaved={() => {}}
      />,
    )
    expect(html).toContain('storyboards.transition.title')
    expect(html).toContain('value="0.5"')
  })
})

describe('版本比较（shot-editor + version-compare）', () => {
  const editorProps = {
    episodeAssets: [],
    canWrite: true,
    onBindAssets: async () => {},
    onChangeStatus: () => {},
    onOpenShot: () => {},
    onOpenStoryboardCard: () => {},
    onOpenAsset: () => {},
    onSaved: () => {},
  }

  it('≥2 条视频候选时出现「比较版本」入口；单候选不出现', () => {
    const two = renderToStaticMarkup(<ShotEditor shot={shot({ videoCandidates: [candidate({ artifactId: 'a-1' }), candidate({ artifactId: 'a-2', version: 2 })] })} {...editorProps} />)
    expect(two).toContain('workbench.compareVersions')
    const one = renderToStaticMarkup(<ShotEditor shot={shot({ videoCandidates: [candidate()] })} {...editorProps} />)
    expect(one).not.toContain('workbench.compareVersions')
  })

  it('VersionCompare 双侧渲染采用动作；媒体走带会话头的 blob 链路，不裸放 downloadUrl', () => {
    const html = renderToStaticMarkup(
      <VersionCompare
        storyboardId="shot-1"
        artifacts={[
          { id: 'a-1', version: 1, mimeType: 'video/mp4', downloadUrl: '/artifacts/a-1/content' },
          { id: 'a-2', version: 2, mimeType: 'video/mp4', downloadUrl: '/artifacts/a-2/content', label: 'candidate.origin.extend' },
        ]}
        onAdopted={() => {}}
      />,
    )
    // 两侧各有采用按钮与版本选项。
    expect(html.match(/compare\.adopt/g)).toHaveLength(2)
    expect(html).toContain('value="a-1"')
    expect(html).toContain('value="a-2"')
    expect(html).toContain('candidate.origin.extend')
    // 静态渲染下 blob 尚未取回（Skeleton 占位）——src 里绝不能是裸 downloadUrl：
    // 媒体元素带不了 Bearer，鉴权必须经 useArtifactUrl 的会话头取流。
    expect(html).not.toContain('src="/artifacts/a-1/content"')
    expect(html).toContain('animate-pulse')
  })

  it('VersionCompare 少于两条候选时整体不渲染', () => {
    const html = renderToStaticMarkup(
      <VersionCompare storyboardId="shot-1" artifacts={[{ id: 'a-1', version: 1, mimeType: 'video/mp4', downloadUrl: '/artifacts/a-1/content' }]} />,
    )
    expect(html).toBe('')
  })
})

/**
 * SD-122：大预览格与候选格本身就是 `<button>`，而产物加载失败时格子里长出的重试钮
 * 曾直接嵌进去——`<button>` 落在 `<button>` 里是非法 HTML，React 报 hydration 错误并把
 * 整棵工作台退回客户端渲染。现在 retryless 宿主只报事实，重试入口落在按钮之外。
 */
describe('失败态重试不嵌进可点格子（SD-122）', () => {
  it('制作台渲染出的 HTML 里没有任何落在 button 内的可交互元素', () => {
    const html = renderPreview({
      videoCandidates: [candidate()],
      frameCandidates: [candidate({ artifactId: 'f-1' })],
      voiceCandidates: [candidate({ artifactId: 'v-1', mimeType: 'audio/wav' })],
    })
    expect(html).toContain('aria-haspopup="menu"')
    expect(htmlInteractiveNesting(html)).toEqual([])
  })

  it('失败条默认带一枚真按钮；标了 retryless 就一个可交互元素都不留', () => {
    const withRetry = renderToStaticMarkup(<ArtifactLoadError onRetry={() => {}} />)
    expect(withRetry).toContain('<button')
    const retryless = renderToStaticMarkup(<ArtifactLoadError onRetry={() => {}} retryless />)
    expect(retryless).not.toContain('<button')
    expect(retryless).not.toContain('<a ')
    // 失败事实本身不因为摘掉按钮而消失。
    expect(retryless).toContain('generations.loadFailed')
  })
})
