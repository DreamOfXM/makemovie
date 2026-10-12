import { describe, expect, it } from 'vitest'
import type { Binding, CallEvidenceMap, Capability, Catalog } from '@/lib/api'
import {
  isHeldUp,
  minimumConnections,
  readyCount,
  requiredSlotCoverage,
  slotReadiness,
  wiredRequiredSlots,
} from '@/lib/models/readiness'
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
