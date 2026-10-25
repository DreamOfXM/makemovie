import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dictionaries } from '@/lib/i18n'

/**
 * SD-065 / ledger #201：预审框曾把「等场景主帧」的镜算进本轮派出，还给整批只报
 * 一条模型链——真触发时那一镜整镜 BLOCKED，一个模型都不会派。对话框这一侧要
 * 钉两件事：每行把这一镜真会用的模型写出来；有等待时在列表上方把「本轮派出」
 * 与「等待场景主帧」分开报，且不向用户冒出「波次/wave」这种内部说法。
 *
 * 组件依赖整条客户端组件图，node 环境整包 import 会牵动并行编辑的邻居；按仓内
 * 既有做法（generation-toast.test.ts）直接读调用点源码 + 读真字典。
 */

const DIALOG_PATH = join('components', 'generations', 'plan-dialog.tsx')
const dialogSrc = readFileSync(DIALOG_PATH, 'utf8')

const KEYS = ['generations.planDispatched', 'generations.planWaitingMaster'] as const

function placeholders(copy: string): string[] {
  return [...copy.matchAll(/\{(\w+)\}/g)].map(match => match[1]!).sort()
}

describe('预审对话框的派出数/场景主帧（SD-065）', () => {
  it('每行在有条目模型时把它排在标签下面', () => {
    expect(dialogSrc).toMatch(/\{item\.model\s*&&\s*<p[^>]*>\s*\{item\.model\}\s*<\/p>\}/)
  })

  it('等待通知只在 deferred 非空时出现，并同时报本轮派出数与等待数', () => {
    expect(dialogSrc).toMatch(/\{plan\.deferred\.length > 0\s*&&\s*\(/)
    expect(dialogSrc).toMatch(/t\('generations\.planDispatched',\s*\{\s*count:\s*plan\.dispatchCount\s*\}\)/)
    expect(dialogSrc).toMatch(/t\('generations\.planWaitingMaster',\s*\{\s*count:\s*plan\.deferredCount,\s*shots:\s*plan\.deferred\.map\(/)
  })

  it('两个键在中英字典里都存在，占位符同形', () => {
    for (const key of KEYS) {
      expect(dictionaries.en[key], `${key} 缺 en 文案`).toBeTruthy()
      expect(dictionaries.zh[key], `${key} 缺 zh 文案`).toBeTruthy()
      expect(placeholders(dictionaries.en[key]!), `${key} 的 en 占位符与 zh 不一致`)
        .toEqual(placeholders(dictionaries.zh[key]!))
    }
    expect(placeholders(dictionaries.en['generations.planDispatched']!)).toEqual(['count'])
    expect(placeholders(dictionaries.en['generations.planWaitingMaster']!)).toEqual(['count', 'shots'])
  })

  it('两句文案都不向用户说「波次/wave」', () => {
    for (const key of KEYS) {
      expect(dictionaries.zh[key]).not.toContain('波次')
      expect(dictionaries.en[key]!.toLowerCase()).not.toContain('wave')
    }
  })
})
