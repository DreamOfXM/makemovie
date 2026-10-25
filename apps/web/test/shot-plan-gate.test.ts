import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * SD-136 / #164：预审门只挂在流程页的批量按钮上，逐镜入口（镜头卡、制作台右栏）
 * 直接 POST `/generations`——第一次点击就扣钱，且看不到会派哪个模型、买多长。
 * 修法不是加一句提示，而是让逐镜入口走同一条门：先取 generation-plan，确认
 * 才提交，且确认框里的两项决议（时长缺口、超长镜三选一）必须原样进入请求。
 *
 * page.tsx 是重依赖客户端页面，node 环境整包 import 会把组件图一并求值；这里按
 * 仓内既有做法直接读调用点源码（同 generation-toast.test.ts）。
 */

const PAGE_PATH = join('app', '(app)', 'projects', '[projectId]', 'episodes', '[episodeId]', 'page.tsx')
const pageSrc = readFileSync(PAGE_PATH, 'utf8')

/** 取一个 `async function` 的整段源码，止于缩进两格的收尾大括号（函数体内部的收尾都是四格）。 */
function functionBody(name: string): string {
  const match = pageSrc.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n  \\}\\n`))
  if (!match) throw new Error(`page.tsx 里找不到 ${name} 的函数体`)
  return match[0]
}

describe('逐镜入口先过预审门（SD-136 / #164）', () => {
  const gate = functionBody('regenerateShotMedia')
  const spend = functionBody('postShotGeneration')

  it('逐镜入口先读计划，不再直接提交付费请求', () => {
    expect(gate).toContain('generation-plan')
    expect(gate).toContain('storyboardIds: storyboardId')
    expect(gate).not.toContain('`/episodes/${episodeId}/generations`')
    // 花钱那一下只留在 postShotGeneration 里：两处提交就会有一处重新长出旁路。
    expect(spend).toContain('`/episodes/${episodeId}/generations`')
  })

  it('计划里没有可跑的镜就不弹窗、不提交，说「这一击什么也不会发生」', () => {
    expect(gate).toMatch(/plan\.newCount \+ plan\.retryCount === 0/)
    expect(gate).toContain("t('generations.planNothingToDo')")
    // 「没有可跑的」那条分支不许顺手调用提交函数。
    const nothingBranch = gate.slice(gate.indexOf('plan.newCount + plan.retryCount === 0'), gate.indexOf('setPendingShotPlan'))
    expect(nothingBranch).not.toContain('postShotGeneration')
  })

  it('确认后提交：时长缺口与超长镜决议原样进入请求体', () => {
    expect(spend).toContain('acceptDurationGap: true')
    expect(spend).toMatch(/durationDecisions: options\.durationDecisions/)
    expect(pageSrc).toMatch(/postShotGeneration\(storyboardId, stage, \{ note, regenerate, acceptDurationGap, durationDecisions \}\)/)
  })

  it('弹窗读取的是逐镜计划，不再另造一份', () => {
    expect(pageSrc).toContain('<PlanDialog')
    expect(pageSrc).toMatch(/pending=\{pendingShotPlan && \{ stage: pendingShotPlan\.planStage/)
    expect(pageSrc).toMatch(/onConfirm=\{\(acceptDurationGap, durationDecisions\) => void confirmShotPlan\(acceptDurationGap, durationDecisions\)\}/)
  })

  it('首帧在计划里就是图像阶段（FIRST_FRAME 不是 GenerationStage）', () => {
    expect(gate).toMatch(/const planStage = stage === 'FIRST_FRAME' \? 'IMAGE' : stage/)
    expect(gate).toContain('stage: planStage')
  })
})
