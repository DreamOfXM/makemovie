import { describe, expect, it } from 'vitest'
import { planAutoBind, wiredRequiredSlots, type BindingLike, type CapabilityLike, type ConnectionLike } from '../src/readiness.js'

/**
 * planAutoBind 是「贴一把 key → 必填槽自动就绪」的那半条路径，语义上有三条不许破：
 * 加法（已就绪的槽绝不重绑）、合法（只选 canBind 通过的候选）、可导（推荐档由
 * 调用方注入，规则本身不知道 catalog 是什么）。
 */

function capability(id: string, model: string, modality: CapabilityLike['modality'], overrides: Partial<CapabilityLike> = {}): CapabilityLike {
  return {
    id,
    model,
    displayName: null,
    modality,
    acceptsFirstFrame: false,
    acceptsReferenceImages: false,
    maxReferenceImages: 0,
    entitlementVerifiedAt: '2026-10-13T00:00:00.000Z',
    credentialVerifiedAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  }
}

function connection(provider: string, capabilities: CapabilityLike[], enabled = true): ConnectionLike {
  return { id: `conn-${provider}`, provider, name: provider, enabled, capabilities }
}

function boundBinding(slot: string, capabilityId: string): BindingLike {
  return {
    slot,
    enabled: true,
    capabilityId,
    projectId: null,
    capability: {
      model: capabilityId,
      entitlementVerifiedAt: '2026-10-13T00:00:00.000Z',
      credentialVerifiedAt: '2026-10-13T00:00:00.000Z',
      connection: { provider: 'dashscope', enabled: true },
    },
  }
}

describe('planAutoBind', () => {
  it('给每个空必填槽选第一个合法候选；已就绪的槽一律跳过（加法语义）', () => {
    const connections = [
      connection('dashscope', [
        capability('cap-script', 'qwen3.7-plus', 'text'),
        capability('cap-image', 'wan2.6-t2i', 'image'),
        capability('cap-video', 'wan2.7-t2v', 't2v'),
      ]),
    ]
    // script_text 已经有可用绑定，不该出现在计划里。
    const bindings = [boundBinding('script_text', 'cap-script')]
    const plan = planAutoBind(connections, bindings, wiredRequiredSlots())
    expect(plan.planned.map(item => item.slot)).toEqual(['storyboard_text', 'image_gen', 'video_t2v'])
    expect(plan.unfulfilled).toEqual([])
    expect(plan.planned.every(item => item.capabilityId === `cap-${item.slot === 'storyboard_text' ? 'script' : item.slot === 'image_gen' ? 'image' : 'video'}`)).toBe(true)
  })

  it('modality 不符的候选进不了计划，缺候选的槽落进 unfulfilled 而不是被硬塞', () => {
    const connections = [connection('openai', [capability('cap-text', 'gpt-x', 'text'), capability('cap-img', 'gpt-image', 'image')])]
    const plan = planAutoBind(connections, [], wiredRequiredSlots())
    // openai 目录故意没有视频行：video_t2v 无解，其余三槽照常补。
    expect(plan.planned.map(item => item.slot)).toEqual(['script_text', 'storyboard_text', 'image_gen'])
    expect(plan.unfulfilled).toEqual(['video_t2v'])
  })

  it('未探测（entitlement/credential 都没有）的能力不算候选——自动绑定不得绑一个没验过的 key', () => {
    const connections = [
      connection('dashscope', [capability('cap-text', 'qwen3.7-plus', 'text', { entitlementVerifiedAt: null, credentialVerifiedAt: null })]),
    ]
    const plan = planAutoBind(connections, [], ['script_text'])
    expect(plan.planned).toEqual([])
    expect(plan.unfulfilled).toEqual(['script_text'])
  })

  it('isPreferred 让显式推荐档盖过池序（池序即探测时的目录序，旗舰行在前）', () => {
    const connections = [
      connection('dashscope', [
        capability('cap-max', 'qwen3.8-max', 'text'),
        capability('cap-plus', 'qwen3.7-plus', 'text'),
      ]),
    ]
    const byOrder = planAutoBind(connections, [], ['script_text'])
    expect(byOrder.planned[0]?.model).toBe('qwen3.8-max')

    const preferred = planAutoBind(connections, [], ['script_text'], candidate => candidate.model === 'qwen3.7-plus')
    expect(preferred.planned[0]?.model).toBe('qwen3.7-plus')
  })

  it('连接被停用后其能力不再参与补绑', () => {
    const connections = [connection('dashscope', [capability('cap-text', 'qwen3.7-plus', 'text')], false)]
    const plan = planAutoBind(connections, [], ['script_text'])
    expect(plan.unfulfilled).toEqual(['script_text'])
  })

  it('Date 与 ISO 字符串两种履历形态算出同一结论（服务端行 vs 控制台 DTO）', async () => {
    const { slotReadiness } = await import('../src/readiness.js')
    const bindings = [
      {
        ...boundBinding('image_gen', 'wan2.6-t2i'),
        capability: {
          model: 'wan2.6-t2i',
          entitlementVerifiedAt: new Date('2026-10-10T00:00:00Z'),
          credentialVerifiedAt: new Date('2026-10-10T00:00:00Z'),
          connection: { provider: 'dashscope', enabled: true },
        },
      },
    ]
    const evidence = { 'dashscope|wan2.6-t2i': { ok: 0, failed: 1, lastStatus: 'FAILED', lastAt: new Date('2026-10-12T02:00:00Z'), lastKind: 'quota' as const } }
    const rows = slotReadiness([], bindings, evidence)
    const image = rows.find(item => item.slot === 'image_gen')!
    expect(image.callBlocked?.kind).toBe('quota')
    // 暴露给 UI 的 at 必须是可 slice 的 ISO 字符串，不管进来的是 Date 还是字符串。
    expect(image.callBlocked?.at).toBe('2026-10-12T02:00:00.000Z')
  })
})
