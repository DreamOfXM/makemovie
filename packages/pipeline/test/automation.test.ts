import { describe, expect, it } from 'vitest'
import { automationGates, defaultAutomationGate } from '@studio/domain'
import { PIPELINE_STAGES, stageProceedsUnder } from '../src/index.js'

describe('制作档位的自动推进判定', () => {
  it('beforeSpend 档逐阶段等价于引入档位之前那行硬编码 if', () => {
    // 旧逻辑（2026-10-13 之前）：
    //   options.auto && stage !== 'SCRIPT' && stage !== 'STORYBOARD' → 停下来等人
    // 这条断言是「零行为变更」的锚点：默认档只要与它对得上，这次改造就没有改变任何
    // 既有项目的运行结果——新增的只是此前够不着的能力。
    for (const stage of PIPELINE_STAGES) {
      const oldStops = stage !== 'SCRIPT' && stage !== 'STORYBOARD'
      expect(stageProceedsUnder('beforeSpend', stage)).toBe(!oldStops)
    }
  })

  it('everyStage 档一律停，连剧本也不放行', () => {
    for (const stage of PIPELINE_STAGES) {
      expect(stageProceedsUnder('everyStage', stage)).toBe(false)
    }
  })

  it('auto 档全放行——素材定稿与交付验收由 nextRunnableStage 的结构保证，不在本表内', () => {
    for (const stage of PIPELINE_STAGES) {
      expect(stageProceedsUnder('auto', stage)).toBe(true)
    }
  })

  it('auto 与 beforeSpend 的差别，恰好是花钱阶段放不放行', () => {
    const moneyStages = PIPELINE_STAGES.filter(stage => stage !== 'SCRIPT' && stage !== 'STORYBOARD')
    expect(moneyStages.length).toBeGreaterThan(0)
    for (const stage of moneyStages) {
      expect(stageProceedsUnder('beforeSpend', stage)).toBe(false)
      expect(stageProceedsUnder('auto', stage)).toBe(true)
    }
  })

  it('每个 gate 取值都有判定，不留落空的分支', () => {
    for (const gate of automationGates) {
      for (const stage of PIPELINE_STAGES) {
        expect(typeof stageProceedsUnder(gate, stage)).toBe('boolean')
      }
    }
  })

  it('默认值是引入档位之前的行为', () => {
    expect(defaultAutomationGate).toBe('beforeSpend')
  })

  it('档位取值覆盖三种节奏，且默认档在其中', () => {
    expect([...automationGates].sort()).toEqual(['auto', 'beforeSpend', 'everyStage'])
    expect(automationGates).toContain(defaultAutomationGate)
  })
})
