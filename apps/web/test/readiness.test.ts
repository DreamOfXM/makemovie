import { describe, expect, it } from 'vitest'
import type { Binding, CallEvidenceMap, Capability, Catalog } from '@/lib/api'
import {
  bindableCapabilities,
  candidatesForSlot,
  isHeldUp,
  minimumConnections,
  mockCandidateForSlot,
  mockSlotAnnotations,
  MOCK_SLOT_MODELS,
  readyCount,
  requiredSlotCoverage,
  slotReadiness,
  wiredRequiredSlots,
  type CapabilitySlot,
} from '@/lib/models/readiness'
import { canBind } from '@studio/domain'
import { listCatalogs } from '../../../packages/providers/src/catalog'

/**
 * 就绪度的绿勾不许只凭探测时间戳亮着：额度用尽、权限被收回之后那个时间戳不会自己变红，
 * 所以「现在跑不跑得通」只能由真实调用履历决定（2026-09-26 全站验收 B2）。
 * `lastKind` 由服务端 classifyFailure 算好，这里只消费；报文形态见 domain 的履历测试。
 */
function capability(model: string, provider = 'dashscope'): Capability {
  return {
    id: `cap-${provider}-${model}`,
    model,
    displayName: null,
    modality: 'image',
    acceptsFirstFrame: false,
    acceptsReferenceImages: false,
    maxReferenceImages: 0,
    probeStatus: 'verified',
    probeMessage: null,
    entitlementVerifiedAt: '2026-09-20T00:00:00.000Z',
    credentialVerifiedAt: '2026-09-20T00:00:00.000Z',
    lastProbedAt: '2026-09-20T00:00:00.000Z',
    spec: null,
    specSource: 'catalog',
    durationEvidence: null,
    connection: { id: `conn-${provider}`, provider, name: provider, enabled: true },
  } as Capability
}

function binding(slot: string, cap: Capability, priority = 1): Binding {
  return {
    id: `bind-${slot}-${cap.model}`,
    slot,
    projectId: null,
    capabilityId: cap.id,
    priority,
    enabled: true,
    capability: cap,
  }
}

function failed(at: string, kind: CallEvidenceMap[string]['lastKind']): CallEvidenceMap[string] {
  return { ok: 0, failed: 1, lastStatus: 'FAILED', lastAt: at, lastKind: kind }
}

const imageCap = capability('qwen-image-3.0')
const videoCap = capability('wan2.7-t2v')

function readinessFor(evidence: CallEvidenceMap) {
  return slotReadiness([], [binding('image_gen', imageCap), binding('image_gen', videoCap)], evidence)
}

function imageSlot(evidence: CallEvidenceMap) {
  return readinessFor(evidence).find(item => item.slot === 'image_gen')!
}

describe('slotReadiness 的真实调用兜底', () => {
  it('本槽每个可用模型最近一次真调用都因额度用尽失败 → 槽位不再算就绪', () => {
    const item = imageSlot({
      'dashscope|qwen-image-3.0': failed('2026-09-25T02:00:00.000Z', 'quota'),
      'dashscope|wan2.7-t2v': failed('2026-09-26T02:00:00.000Z', 'quota'),
    })
    expect(item.state).toBe('ready')
    expect(item.callBlocked?.kind).toBe('quota')
    expect(item.callBlocked?.at).toBe('2026-09-26T02:00:00.000Z')
    expect(item.callBlocked?.models).toEqual(['qwen-image-3.0', 'wan2.7-t2v'])
    expect(isHeldUp(item)).toBe(true)
  })

  it('只要还有一个模型通着（或根本没调用过），就不许改口说跑不通', () => {
    const fallbackWorked = imageSlot({
      'dashscope|qwen-image-3.0': failed('2026-09-25T02:00:00.000Z', 'quota'),
      'dashscope|wan2.7-t2v': { ok: 3, failed: 0, lastStatus: 'SUCCEEDED', lastAt: '2026-09-26T02:00:00.000Z', lastKind: 'unknown' },
    })
    expect(fallbackWorked.callBlocked).toBeNull()
    expect(isHeldUp(fallbackWorked)).toBe(false)

    const neverCalled = imageSlot({ 'dashscope|qwen-image-3.0': failed('2026-09-25T02:00:00.000Z', 'access') })
    expect(neverCalled.callBlocked).toBeNull()
  })

  it('网络中断还能重抽，不构成配置层面的「跑不通」', () => {
    const item = imageSlot({
      'dashscope|qwen-image-3.0': failed('2026-09-25T02:00:00.000Z', 'network'),
      'dashscope|wan2.7-t2v': failed('2026-09-25T02:00:00.000Z', 'network'),
    })
    expect(item.callBlocked).toBeNull()
  })

  it('没有任何履历 = 未知，不是坏消息', () => {
    expect(imageSlot({}).callBlocked).toBeNull()
    expect(isHeldUp(imageSlot({}))).toBe(false)
  })

  it('必填槽位的得分把「跑不通」扣掉，缺模型的那一档本来就挡你', () => {
    const total = wiredRequiredSlots().length
    const clean = slotReadiness([], [])
    expect(readyCount(clean)).toBe(0)
    expect(total).toBeGreaterThan(0)

    const blocked = readinessFor({
      'dashscope|qwen-image-3.0': failed('2026-09-25T02:00:00.000Z', 'quota'),
      'dashscope|wan2.7-t2v': failed('2026-09-26T02:00:00.000Z', 'access'),
    })
    // 两条绑定都活着，但整档跑不通：得分必须诚实，探测时间戳不参与。
    expect(readyCount(blocked)).toBe(0)
    expect(blocked.filter(isHeldUp).map(item => item.slot)).toContain('image_gen')
  })
})

/**
 * 覆盖率脚注的中立性：并列不得只报一家（旧 bestCatalogCoverage 在 dashscope 与
 * google 同为 4/4 时，稳定排序永远取注册序第一家），用户真问的问题是
 * 「覆盖必填槽最少要开几家连接」——按集合覆盖算，并列组合全部列出。
 */
function realCatalogs(): Catalog[] {
  return listCatalogs().map(catalog => ({
    provider: catalog.provider,
    label: catalog.label,
    defaultBaseUrl: catalog.defaultBaseUrl,
    catalogVersion: catalog.catalogVersion,
    requiresAccessKey: catalog.requiresAccessKey,
    models: catalog.models,
  }))
}

function withoutT2vRows(catalogs: Catalog[], providers: string[]): Catalog[] {
  return catalogs.map(catalog =>
    providers.includes(catalog.provider)
      ? { ...catalog, models: catalog.models.filter(model => model.modality !== 't2v') }
      : catalog,
  )
}

describe('目录覆盖：最少连接数与并列组合', () => {
  it('真实目录上 dashscope 与 google 并列 4/4，两组都要出现在最小组合里', () => {
    const result = minimumConnections(realCatalogs())
    expect(result.count).toBe(1)
    const combos = result.combinations.map(combo => combo.map(entry => entry.provider))
    expect(combos).toContainEqual(['dashscope'])
    expect(combos).toContainEqual(['google'])
    expect(result.truncated).toBe(false)
  })

  it('砍掉所有 t2v 行后最小值变 2，组合按目录序枚举且并列全收（超 K 截断）', () => {
    const catalogs = withoutT2vRows(realCatalogs(), ['dashscope', 'google'])
    const result = minimumConnections(catalogs)
    expect(result.count).toBe(2)
    expect(result.total).toBe(6)
    expect(result.combinations).toHaveLength(3)
    expect(result.truncated).toBe(true)
    expect(result.combinations.some(combo => combo.some(entry => entry.provider === 'dashscope'))).toBe(true)
  })

  it('某个必填槽没有任何候选厂商时报「无解」，不许显示 0 家', () => {
    const all = realCatalogs().map(catalog => catalog.provider)
    expect(minimumConnections(withoutT2vRows(realCatalogs(), all)).count).toBeNull()
  })

  it('mock 不需要密钥，永不进入组合——哪怕只剩它一家全包', () => {
    const onlyMock = realCatalogs().filter(catalog => catalog.provider === 'mock')
    expect(minimumConnections(onlyMock).count).toBeNull()
    const real = minimumConnections(realCatalogs())
    expect(real.combinations.every(combo => combo.every(entry => entry.provider !== 'mock'))).toBe(true)
  })

  it('逐槽候选家数：video_t2v 今天四家可选，顺序跟目录注册序', () => {
    const { perSlot, total } = requiredSlotCoverage(realCatalogs())
    expect(total).toBe(4)
    const video = perSlot.find(entry => entry.slot === 'video_t2v')
    expect(video?.providers.map(entry => entry.provider)).toEqual(['dashscope', 'seedance', 'kling', 'google'])
  })
})

/**
 * 一键 mock 的用途绑定（UX-P01，2026-10-19 实测 UX-04 根因一）：剧本和分镜都是
 * text 模态，取排序第一名会把剧本文本绑进分镜槽位，mock 按模型名回剧本文本、
 * 分镜解析必然失败。挑候选必须按用途对号，对不上才回落池子顺序。
 */
describe('一键 mock 的用途绑定', () => {
  const mockCatalog = listCatalogs().find(catalog => catalog.provider === 'mock')!

  /** 目录序的 mock 池——bindableCapabilities 眼里的「一键 mock 之后」的样子。 */
  function mockPool() {
    return bindableCapabilities([
      {
        id: 'conn-mock',
        provider: 'mock',
        name: 'mock-preview',
        enabled: true,
        capabilities: mockCatalog.models.map((model, index) => ({
          id: `cap-mock-${index}`,
          model: model.model,
          displayName: model.displayName,
          modality: model.modality,
          acceptsFirstFrame: !!model.acceptsFirstFrame,
          acceptsReferenceImages: !!model.acceptsReferenceImages,
          maxReferenceImages: model.maxReferenceImages ?? 0,
          entitlementVerifiedAt: '2026-10-19T00:00:00.000Z',
        })),
      },
    ])
  }

  it('每个用途槽位对号到自己的 mock 模型，不取文本模态的排序第一名', () => {
    const pool = mockPool()
    // 剧本和分镜共享 text 模态；目录序第一名（mock-text）不是任何一个的用途模型。
    const storyboardCandidates = candidatesForSlot(pool, 'storyboard_text')
    expect(storyboardCandidates[0]!.model).not.toBe('mock-storyboard')
    const purpose: Array<[CapabilitySlot, string]> = [
      ['script_text', 'mock-script'],
      ['storyboard_text', 'mock-storyboard'],
      ['image_gen', 'mock-image'],
      ['video_t2v', 'mock-t2v'],
      ['video_i2v', 'mock-i2v'],
      ['video_r2v', 'mock-r2v'],
      ['tts_voice', 'mock-tts'],
      ['music_gen', 'mock-music'],
      ['sfx', 'mock-sfx'],
      ['visual_audit', 'mock-vlm'],
    ]
    for (const [slot, model] of purpose) {
      expect(mockCandidateForSlot(candidatesForSlot(pool, slot), slot)?.model, slot).toBe(model)
    }
  })

  it('用途对照表钉住真实 mock 目录：每个模型都存在，且绑定规则放行它进对应槽位', () => {
    const models = new Map(mockCatalog.models.map(model => [model.model, model]))
    for (const [slot, model] of Object.entries(MOCK_SLOT_MODELS)) {
      const row = models.get(model!)
      expect(row, `${slot} → ${model} 必须还是 mock catalog 里的真实模型`).toBeDefined()
      expect(canBind(slot as CapabilitySlot, {
        provider: 'mock',
        model: row!.model,
        modality: row!.modality,
        acceptsFirstFrame: !!row!.acceptsFirstFrame,
        acceptsReferenceImages: !!row!.acceptsReferenceImages,
        maxReferenceImages: row!.maxReferenceImages ?? 0,
      }).ok, `${slot} → ${model} 必须能通过 canBind`).toBe(true)
    }
  })

  it('目录里没有用途模型的槽位不进对照表（audio_transcribe 无 mock asr），挑候选回落池子顺序', () => {
    expect(MOCK_SLOT_MODELS.audio_transcribe).toBeUndefined()
    const pool = [
      {
        capabilityId: 'cap-dashscope-text',
        model: 'qwen3-max',
        displayName: null,
        modality: 'text',
        connectionId: 'conn-dashscope',
        connectionName: 'dashscope',
        provider: 'dashscope',
        acceptsFirstFrame: false,
        acceptsReferenceImages: false,
        maxReferenceImages: 0,
      },
    ]
    expect(mockCandidateForSlot(pool, 'script_text')?.model).toBe('qwen3-max')
  })
})

/**
 * mock 就绪的口径（UX-P01）：mock 供应的槽位必须标「离线演示」，且就绪只说明
 * 配置可用——mock 模型真跑过至少一次调用才叫「已验证运行」，未跑过不许暗示。
 */
describe('mock 就绪标注：配置可用 ≠ 已验证运行', () => {
  const mockStoryboard = capability('mock-storyboard', 'mock')

  it('mock 独家供应的槽位是演示位；没有任何履历时只算配置可用', () => {
    const annotations = mockSlotAnnotations([binding('storyboard_text', mockStoryboard)])
    expect(annotations.get('storyboard_text')).toEqual({ demo: true, verifiedRun: false })
  })

  it('mock 模型有过真实调用履历（成功或失败都算跑过）才是已验证运行', () => {
    const ran = mockSlotAnnotations([binding('storyboard_text', mockStoryboard)], {
      'mock|mock-storyboard': { ok: 2, failed: 0, lastStatus: 'SUCCEEDED', lastAt: '2026-10-19T08:00:00.000Z', lastKind: 'unknown' },
    })
    expect(ran.get('storyboard_text')).toEqual({ demo: true, verifiedRun: true })
    const failedRun = mockSlotAnnotations([binding('storyboard_text', mockStoryboard)], {
      'mock|mock-storyboard': { ok: 0, failed: 1, lastStatus: 'FAILED', lastAt: '2026-10-19T08:00:00.000Z', lastKind: 'quota' },
    })
    // 「已验证运行」答的是有没有真跑过，不是质量——质量另有 callBlocked 说。
    expect(failedRun.get('storyboard_text')?.verifiedRun).toBe(true)
  })

  it('真供应商也在供应的槽位不算演示位', () => {
    const annotations = mockSlotAnnotations([binding('storyboard_text', mockStoryboard), binding('storyboard_text', imageCap)])
    expect(annotations.get('storyboard_text')?.demo).toBe(false)
  })

  it('没跑过 mock 的槽位不进标注；mock 供应其他槽位互不影响', () => {
    const annotations = mockSlotAnnotations([binding('image_gen', imageCap)])
    expect(annotations.has('storyboard_text')).toBe(false)
    expect(annotations.get('image_gen')?.demo).toBe(false)
  })
})
