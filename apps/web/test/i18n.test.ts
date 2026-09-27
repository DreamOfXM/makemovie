import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { dictionaries } from '@/lib/i18n'

/**
 * `t()` 缺键时退回英文、再退回键本身，所以少一条翻译不会崩、只会在界面上
 * 印出「failure.cause.quota」这种字符串。这条不变量写在注释里十几年，
 * 没有任何东西守着它——这里就是那个东西。
 */
describe('双语字典', () => {
  const en = Object.keys(dictionaries.en)
  const zh = Object.keys(dictionaries.zh)

  it('两套字典的键完全一致', () => {
    expect(zh.filter(key => !en.includes(key))).toEqual([])
    expect(en.filter(key => !zh.includes(key))).toEqual([])
  })

  it('没有空文案，也没有把键当文案填进去', () => {
    for (const [locale, table] of Object.entries(dictionaries)) {
      const bad = Object.entries(table).filter(([, value]) => value.trim() === '' || value.trim() === ' ')
      expect(bad, `${locale} 字典里的空文案`).toEqual([])
    }
  })

  it('同一占位符在两边都出现，插值不会只在一门语言里生效', () => {
    // 与 i18n.tsx 的 PLURAL_PATTERN 同形：英文的复数式先把整支折回 {count}，
    // 否则 one {cost # call} 里的 `{cost` 会被当成第二个占位符。
    const plural = /\{(\w+),\s*plural,\s*one\s*\{[^{}]*\}\s*other\s*\{[^{}]*\}\}/g
    const params = (text: string) =>
      [...new Set([...text.replace(plural, '{$1}').matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort().join(',')
    const mismatched = en.filter(key => params(dictionaries.en[key]) !== params(dictionaries.zh[key]))
    expect(mismatched).toEqual([])
  })

  it('源码里引用的每个静态键都在字典里，界面上不会印出键名', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.tsx?$/.test(name)) files.push(path)
      }
    }
    for (const dir of ['app', 'components', 'lib']) walk(join(root, dir))

    const missing: string[] = []
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, index) => {
        for (const match of line.matchAll(/\bt\(\s*'([\w.]+)'/g)) {
          if (!(match[1] in dictionaries.en)) missing.push(`${relative(root, file)}:${index + 1} ${match[1]}`)
        }
      })
    }
    expect(missing).toEqual([])
  })
})
