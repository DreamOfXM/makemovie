import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * UI 规范的机器检查（makemovie-ui-rules 条款落为断言，2026-09-29 用户定调：
 * "如果 skill 检查不出来，就是 skill 本身有问题"——能机器拦的不再靠人记）。
 *
 * 条款一：解释类（*Hint 结尾）文案只许经 HelpHint 的 text= 渲染。直接印进
 * JSX 文本 = 一段常驻说明占版面，用户三连打回的同一病根。
 * 例外：Hover 型容器（Tooltip）同为非常驻，放行。
 *
 * 条款二：空态框不得回到大内距撑高（py-14/py-16/py-20 曾把拆集框撑到 420px）。
 */

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? tsxFiles(path) : entry.name.endsWith('.tsx') ? [path] : []
  })
}

describe('UI 规范机器检查', () => {
  it('解释类（*Hint）文案只经 HelpHint 渲染，不落常驻 JSX 文本', () => {
    const offenders: string[] = []
    for (const file of [...tsxFiles('components'), ...tsxFiles('app')]) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, index) => {
        if (/HelpHint|TooltipContent|DialogDescription className="sr-only"/.test(line)) return
        const match = line.match(/t\('([a-zA-Z0-9:.]*Hint)'/)
        if (!match) return
        if (/text=\{/.test(line)) return
        offenders.push(`${file}:${index + 1} ${match[1]}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('空态框不再回到大内距撑高', () => {
    const src = readFileSync(join('components', 'ui', 'empty-state.tsx'), 'utf8')
    expect(src).not.toMatch(/py-(14|16|20)/)
  })
})
