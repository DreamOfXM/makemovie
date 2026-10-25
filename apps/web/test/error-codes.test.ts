import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { dictionaries } from '@/lib/i18n'

/**
 * 后端拒绝一次操作时，`{ error: '阶段:原因' }` 里的码串会直接被 lib/api-error.ts
 * 拿去查字典；查不到就退成「操作失败」——用户看到的是零信息的通用文案，排查的人
 * 只能在 console 里翻。SD-192 修的是其中一条，这条测试管住整类：
 * 新增一个码串却不写文案，这里就红。
 */
const webRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = join(webRoot, '..', '..')

function sources(dir: string, extensions: RegExp): string[] {
  const found: string[] = []
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const path = join(current, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (extensions.test(name)) found.push(path)
    }
  }
  if (existsSync(dir)) walk(dir)
  return found
}

/** 后端发出的 `x:y` 码串：只认 `{ error: 'x:y' }` 这一种旧式封套——
 *  统一封套（apiError()）走 body.code，不经过字典，抓进来只会误报。 */
function emittedCodes(): string[] {
  const codes = new Set<string>()
  for (const file of sources(join(repoRoot, 'apps/api/src'), /\.ts$/)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/error:\s*'([a-z][A-Za-z]*:[a-zA-Z]+)'/g)) {
      codes.add(match[1])
    }
  }
  return [...codes].sort()
}

/** 组件自己按码串分支的（弹层/确认框读 body，不查字典）。
 *  豁免不是免责：引用文件里读不到这条码串，说明分支已经不存在，测试必须红。 */
const INTERCEPTED: Record<string, string> = {
  'delivery:qualityGate': 'components/deliveries/delivery-panel.tsx',
  'script:rhythmGate': 'components/sources/sources-panel.tsx',
}

/** 端点在界面上零入口，所以码串永远走不到用户眼前。
 *  一旦有人在 web 里接了这个入口（route 字样出现在 web 源码），豁免立刻失效——
 *  那时补字典文案是必做项，而不是等用户报了「操作失败」再回头查。 */
const NO_UI_ENTRY: Record<string, string> = {
  'asr:notBound': 'audio-review',
  'delivery:mediaMissing': 'media-package',
  'delivery:mediaConformFailed': 'media-package',
}

describe('后端错误码的界面文案', () => {
  it('扫描器真的读到了后端码串（路径写错会让下面的判定变成空转）', () => {
    const codes = emittedCodes()
    expect(codes.length).toBeGreaterThan(20)
    expect(codes).toContain('delivery:noSubtitles')
  })

  it('每个 x:y 码串都有中英文案，或摊开在豁免表里', () => {
    const unmapped = emittedCodes().filter(code => {
      if (code in INTERCEPTED || code in NO_UI_ENTRY) return false
      return !(code in dictionaries.en && code in dictionaries.zh)
    })
    expect(unmapped).toEqual([])
  })

  it('豁免表每条都还站得住', () => {
    const stale: string[] = []
    for (const [code, file] of Object.entries(INTERCEPTED)) {
      const path = join(webRoot, file)
      if (!existsSync(path)) stale.push(`${code}：引用文件已不存在 ${file}`)
      else if (!readFileSync(path, 'utf8').includes(code)) stale.push(`${code}：${file} 里已不再按这条码串分支`)
    }
    const webSources = sources(join(webRoot, 'app'), /\.tsx?$/).concat(sources(join(webRoot, 'components'), /\.tsx?$/), sources(join(webRoot, 'lib'), /\.tsx?$/))
    for (const [code, route] of Object.entries(NO_UI_ENTRY)) {
      const caller = webSources.find(file => readFileSync(file, 'utf8').includes(route))
      if (caller) stale.push(`${code}：${relative(webRoot, caller)} 已经调用 ${route}，这条码串必须写字典文案`)
    }
    expect(stale).toEqual([])
  })

  it('下载类失败不把 HTTP 状态码当文案上屏', () => {
    // lib/api.ts 的兜底除外：读不出错误体时只剩状态码，那是最后一层，不是调用点的写法。
    const offenders: string[] = []
    for (const dir of ['app', 'components']) {
      for (const file of sources(join(webRoot, dir), /\.tsx?$/)) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            if (/throw new (?:ApiError|Error)\(\s*`HTTP/.test(line)) {
              offenders.push(`${relative(webRoot, file)}:${index + 1} ${line.trim()}`)
            }
          })
      }
    }
    expect(offenders).toEqual([])
  })
})
