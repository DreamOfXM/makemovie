/**
 * The readiness rules moved to @studio/domain so the API can run the exact same
 * sentences (`/api/system/readiness`, `/api/bindings/auto`) without a second
 * implementation. This module stays as the console's import path; the re-export is
 * explicit so nothing quietly starts reaching domain symbols through it.
 */
import { callEvidenceKey, servesSlot, type BindingLike, type CallEvidenceMapLike, type CapabilitySlot } from '@studio/domain'

export {
  bindableCapabilities,
  candidatesForSlot,
  gapSlots,
  isHeldUp,
  minimumConnections,
  planAutoBind,
  readyCount,
  requiredSlotCoverage,
  slotReadiness,
  unwiredSlots,
  wiredRequiredSlots,
} from '@studio/domain'
export type {
  AutoBindChoice,
  AutoBindPlan,
  BindableCapability,
  CallEvidenceLike,
  CallEvidenceMapLike,
  CapabilityLike,
  CapabilitySlot,
  CatalogLike,
  CatalogModelLike,
  ConnectionLike,
  BindingLike,
  MinimumConnectionsResult,
  SlotCallBlock,
  SlotCandidateProviders,
  SlotReadiness,
  SlotReadinessState,
  SlotUsage,
} from '@studio/domain'

/**
 * 一键 mock 的用途对照表：缺口槽位挑候选先按用途精确对号，不看排序第一名。
 * 剧本和分镜都是 text 模态，池子按目录序排第一名可能是 mock-script——分镜槽位
 * 绑上它，mock 按模型名返回剧本文本，解析必然失败（2026-10-19 新用户实测 UX-04
 * 的根因一）。模型 id 是 mock provider 的固定契约（mock.ts 按名字回答不同固定
 * 内容），目录改这些名字时这张表必须跟着改——readiness.test.ts 有对目录的不变
 * 式断言兜底。catalog 没有的能力（如 asr 转写）不进表，回落现有排序规则。
 */
export const MOCK_SLOT_MODELS: Partial<Record<CapabilitySlot, string>> = {
  script_text: 'mock-script',
  storyboard_text: 'mock-storyboard',
  image_gen: 'mock-image',
  video_t2v: 'mock-t2v',
  video_i2v: 'mock-i2v',
  video_r2v: 'mock-r2v',
  tts_voice: 'mock-tts',
  music_gen: 'mock-music',
  sfx: 'mock-sfx',
  visual_audit: 'mock-vlm',
}

/**
 * 一键 mock 为缺口槽位选定的候选：先取用途对号的 mock 模型（mock 连接上的
 * `MOCK_SLOT_MODELS[slot]`），对不上号才回落调用方传入的排序第一名。回落保持
 * 既有语义——非 mock 供应商的候选照样可选中，「只补缺口、不动已有有效绑定」
 * 的加法前提不在这里改变。
 */
export function mockCandidateForSlot<T extends { provider: string; model: string }>(
  candidates: readonly T[],
  slot: CapabilitySlot,
): T | undefined {
  const expected = MOCK_SLOT_MODELS[slot]
  const match = expected
    ? candidates.find(candidate => candidate.provider === 'mock' && candidate.model === expected)
    : undefined
  return match ?? candidates[0]
}

/** 一个槽位的 mock 标注：是否「离线演示」供应，以及有没有真实调用履历。 */
export interface MockSlotAnnotation {
  /**
   * 该槽位的可用绑定只落在 mock 连接上——就绪展示必须带「离线演示」标注，
   * 不得暗示真实模型效果。真供应商也在供应的槽位不算演示位。
   */
  demo: boolean
  /** 配置可用 ≠ 已验证运行：mock 模型有过真实调用履历（成功或失败都算跑过）才是后者。 */
  verifiedRun: boolean
}

/**
 * 逐槽位算「离线演示」标注：usable 绑定（`servesSlot` 同一条可用性规则）全部来自
 * mock 连接 → demo；其中任一 mock 模型在调用履历里出现过 → verifiedRun。履历为空
 * 是常态——一键 mock 刚绑完、还没跑过任何任务时，就绪只能说「配置可用」。
 */
export function mockSlotAnnotations(
  bindings: BindingLike[],
  evidence: CallEvidenceMapLike = {},
): Map<CapabilitySlot, MockSlotAnnotation> {
  const annotations = new Map<CapabilitySlot, MockSlotAnnotation>()
  for (const binding of bindings) {
    const slot = binding.slot as CapabilitySlot
    if (!servesSlot(binding, slot)) continue
    const provider = binding.capability?.connection?.provider
    const model = binding.capability?.model
    const current = annotations.get(slot) ?? { demo: true, verifiedRun: false }
    if (provider !== 'mock') {
      current.demo = false
    } else if (model) {
      const record = evidence[callEvidenceKey('mock', model)]
      if (record && (record.ok > 0 || record.failed > 0)) current.verifiedRun = true
    }
    annotations.set(slot, current)
  }
  return annotations
}
