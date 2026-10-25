import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * UI 规范的机器检查（makemovie-ui-rules 条款落为断言，2026-09-29 用户定调：
 * "如果 skill 检查不出来，就是 skill 本身有问题"——能机器拦的不再靠人记）。
 *
 * 条款一：解释类（*Hint 结尾）文案是「解释某个控件」的短句，必须落在非常驻载体上——
 * HelpHint / Tooltip 的 text=、组件的说明位 prop（hint= / emptyHint= / description=）、
 * 描述位元素（CardDescription / DialogDescription / EmptyState / 菜单项 / 页头）、
 * 以及 kbd 快捷键图例。落成常驻正文（<p>/<span> 里裸铺），或拿去当 placeholder /
 * aria-label，都算违规：前者是一段说明长期占版面，后者把解释塞进了错误的语义位。
 *
 * 判据按「这段文案绑在什么位置」判，不按行判。旧版只豁免 3 个容器、且只看同一行，
 * 把「作为 prop 传给组件」「Tooltip 里换了行」「卡片/对话框副标题」全判成违规，
 * 82 条里绝大多数是误伤——一条长期飘红的检查等于没有检查，所以重写。
 *
 * 条款二：空态框不得回到大内距撑高（py-14/py-16/py-20 曾把拆集框撑到 420px）。
 *
 * 条款三：「上一轮待裁决」是**这一跑**停下来的事实，不许挂在「已定稿」的豁免里——
 * 「已定稿」讲的是上一版，两者能同时成立（SD-105：重跑一个已定稿素材、付费候选被 QC
 * 拦停待裁决，制作台却三处零信号，人根本不知道有一笔钱卡在等自己裁决）。
 *
 * 条款四（SD-122）：可交互元素不许嵌在原生 `<button>` 里。按钮套按钮/套链接是非法 HTML，
 * React 报 hydration 错误并把整棵工作台退回客户端渲染；产物格在**加载失败那一态**才会
 * 长出重试钮，所以静态渲染拦不住，只能扫 JSX 源。宿主是按钮的产物格必须标 `retryless`。
 */

/** 文案落在这些元素里 = 落在设计好的说明位。 */
const SLOT_ELEMENTS = new Set([
  'CardDescription', 'DialogDescription', 'AlertDescription', 'SheetDescription', 'FormDescription',
  'EmptyState', 'PageHeader', 'TooltipContent', 'HelpHint', 'Hint',
  'DropdownMenuContent', 'DropdownMenuItem', 'DropdownMenuLabel', 'DropdownMenuCheckboxItem',
  'SelectItem', 'CommandItem', 'PopoverContent', 'HoverCardContent',
])
/** 以这些属性名传出去 = 交给组件在自己的说明位渲染。 */
const SLOT_ATTRS = new Set(['text', 'hint', 'emptyHint', 'description', 'reason', 'title', 'tooltip'])
/** 以这些属性名传出去 = 把解释放错了语义位。 */
const MISPLACED_ATTRS = new Set(['placeholder', 'aria-label', 'aria-description', 'alt'])

const TAG = /<(\/?)([A-Za-z][A-Za-z0-9.$]*)((?:[^<>"'{]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})*?)(\/?)>/g
const HINT_KEY = /t\('([A-Za-z0-9:._]*Hint)'/g

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? tsxFiles(path) : entry.name.endsWith('.tsx') ? [path] : []
  })
}

/** 这个 offset 是不是某个属性的值？返回属性名；其间出现过闭合的 `}` 就不算。 */
function attributeName(src: string, at: number): string | null {
  const head = src.slice(src.lastIndexOf('\n', at - 1) + 1, at)
  const pattern = /([A-Za-z-]+)\s*=\s*\{/g
  let last: RegExpExecArray | null = null
  for (let match; (match = pattern.exec(head)); ) last = match
  if (!last) return null
  const between = head.slice(last.index + last[0].length).replace(/\$\{[^}]*\}/g, '')
  if (between.includes('}')) return null
  return last[1]
}

/** 在给定源码里找出「解释类文案没落在说明位」的位置。 */
function analyzeSource(src: string, file: string): string[] {
  const lineOf = (offset: number) => src.slice(0, offset).split('\n').length

  const events: { kind: 'open' | 'close' | 'hint'; name: string; self: boolean; key: string; at: number }[] = []
  TAG.lastIndex = 0
  for (let match; (match = TAG.exec(src)); ) {
    events.push({ kind: match[1] ? 'close' : 'open', name: match[2], self: match[4] === '/', key: '', at: match.index })
  }
  HINT_KEY.lastIndex = 0
  for (let match; (match = HINT_KEY.exec(src)); ) {
    events.push({ kind: 'hint', name: '', self: false, key: match[1], at: match.index })
  }
  events.sort((a, b) => a.at - b.at)

  const stack: { name: string; start: number }[] = []
  const found: string[] = []
  for (const event of events) {
    if (event.kind === 'open') {
      if (!event.self) stack.push({ name: event.name, start: event.at })
      continue
    }
    if (event.kind === 'close') {
      const index = stack.map(entry => entry.name).lastIndexOf(event.name)
      if (index >= 0) stack.length = index
      continue
    }

    const attr = attributeName(src, event.at)
    if (attr) {
      if (MISPLACED_ATTRS.has(attr)) found.push(`${file}:${lineOf(event.at)} ${event.key} 放在 ${attr}= 上`)
      else if (!SLOT_ATTRS.has(attr)) found.push(`${file}:${lineOf(event.at)} ${event.key} 经 ${attr}= 传出`)
      continue
    }

    // 不是属性值：只有直接铺在 JSX 子节点上才算常驻正文，其余（赋值/return/三元）落点不在本行，不判。
    const lineStart = src.lastIndexOf('\n', event.at - 1) + 1
    const head = src.slice(lineStart, event.at)
    const line = src.slice(lineStart, src.indexOf('\n', event.at)).trim()
    const inlineChild = head.replace(/\{\s*$/, '').trim().endsWith('>')
    const ownLineChild = /^\{\s*t\(/.test(line) && /\}\s*$/.test(line)
    if (!inlineChild && !ownLineChild) continue

    if (stack.some(entry => SLOT_ELEMENTS.has(entry.name))) continue
    // kbd 快捷键图例：`←` `→` 这类键帽旁边的说明句，整块就是个图例。
    if (stack.some(entry => src.slice(entry.start, event.at).includes('<kbd'))) continue
    const parent = stack.length ? `<${stack[stack.length - 1].name}>` : '顶层'
    found.push(`${file}:${lineOf(event.at)} ${event.key} 裸铺在 ${parent} 里`)
  }
  return found
}

function hintOffenders(file: string): string[] {
  return analyzeSource(readFileSync(file, 'utf8'), file)
}

/** 取 `{cond && (JSX)}` 里那段括号配平的 JSX：从 marker 之后第一个 `(` 起算。 */
function guardedJsx(src: string, marker: RegExp): string {
  const hit = marker.exec(src)
  if (!hit) return ''
  const open = src.indexOf('(', hit.index + hit[0].length)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1)
  }
  return src.slice(open)
}

interface JsxTag {
  name: string
  close: boolean
  selfClose: boolean
  attrs: string
  at: number
}

/**
 * JSX 标签扫描。属性值里的引号与任意层 `{}`/`()`/`[]` 都要跳过：正则版只认两层，
 * 大预览按钮那种三层写法（`onClick={() => { … setReview({ … }) }}`）会被整个漏掉。
 */
function jsxTags(src: string): JsxTag[] {
  const tags: JsxTag[] = []
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '<') continue
    const close = src[i + 1] === '/'
    const start = close ? i + 2 : i + 1
    const name = /^([A-Za-z][A-Za-z0-9.$_]*)/.exec(src.slice(start, start + 60))?.[1]
    if (!name) continue
    let end = start + name.length
    let quote: string | null = null
    let depth = 0
    for (; end < src.length; end++) {
      const char = src[end]
      if (quote) {
        if (char === quote) quote = null
        continue
      }
      if (char === '"' || char === "'" || char === '`') quote = char
      else if (char === '{' || char === '(' || char === '[') depth++
      else if (char === '}' || char === ')' || char === ']') depth--
      else if (char === '>' && depth === 0) break
    }
    tags.push({ name, close, selfClose: src[end - 1] === '/', attrs: src.slice(start + name.length, end), at: i })
    i = end
  }
  return tags
}

/** 按钮里非法的可交互元素；ArtifactMedia 看它有没有声明「宿主是按钮」（retryless）。 */
const INTERACTIVE_TAGS = new Set(['button', 'Button', 'GuardedButton', 'a', 'Link', 'ArtifactLoadError'])

function nestedInteractive(src: string, file: string): string[] {
  const lineOf = (offset: number) => src.slice(0, offset).split('\n').length
  const stack: { name: string; at: number }[] = []
  const found: string[] = []
  for (const tag of jsxTags(src)) {
    if (tag.close) {
      const index = stack.map(entry => entry.name).lastIndexOf(tag.name)
      if (index >= 0) stack.length = index
      continue
    }
    const host = stack.find(entry => entry.name === 'button')
    if (host) {
      const where = `${file}:${lineOf(tag.at)}`
      if (INTERACTIVE_TAGS.has(tag.name)) found.push(`${where} <${tag.name}> 嵌在 <button>(:${lineOf(host.at)}) 里`)
      else if (tag.name === 'ArtifactMedia' && !/\bretryless/.test(tag.attrs)) found.push(`${where} <ArtifactMedia> 嵌在 <button>(:${lineOf(host.at)}) 里且没标 retryless`)
    }
    if (!tag.selfClose) stack.push({ name: tag.name, at: tag.at })
  }
  return found
}

describe('UI 规范机器检查', () => {
  it('解释类（*Hint）文案落在说明位，不铺成常驻正文、不当 placeholder/aria-label', () => {
    const offenders = [...tsxFiles('components'), ...tsxFiles('app')].flatMap(hintOffenders)
    expect(offenders).toEqual([])
  })

  it('判据本身有效：裸铺、placeholder、aria-label 都抓得到，说明位则放行', () => {
    // 没有这条自检的话，判据被改坏成恒真也没人知道——检查工具的假绿灯比没有检查更糟。
    expect(analyzeSource('<p className="x">{t(\'demo.exampleHint\')}</p>\n', 'demo.tsx')).toHaveLength(1)
    expect(analyzeSource('<p>{t(\'demo.exampleHint\')}</p>\n', 'demo.tsx')[0]).toContain('裸铺在 <p>')
    expect(analyzeSource('<textarea placeholder={t(\'demo.exampleHint\')} />\n', 'demo.tsx')[0]).toContain('placeholder=')
    expect(analyzeSource('<Link aria-label={t(\'demo.exampleHint\')} />\n', 'demo.tsx')[0]).toContain('aria-label=')
    expect(analyzeSource('const hint = t(\'demo.exampleHint\')\n', 'demo.tsx')).toEqual([])
    expect(analyzeSource('<HelpHint text={t(\'demo.exampleHint\')} />\n', 'demo.tsx')).toEqual([])
    expect(analyzeSource('<CardDescription>{t(\'demo.exampleHint\')}</CardDescription>\n', 'demo.tsx')).toEqual([])
    expect(analyzeSource('<Field hint={cond ? t(\'demo.exampleHint\') : undefined} />\n', 'demo.tsx')).toEqual([])
  })

  it('空态框不再回到大内距撑高', () => {
    const src = readFileSync(join('components', 'ui', 'empty-state.tsx'), 'utf8')
    expect(src).not.toMatch(/py-(14|16|20)/)
  })

  it('待裁决信号不藏在「已定稿」豁免之后', () => {
    const src = readFileSync(join('components', 'shotboard', 'workbench', 'asset-inspector.tsx'), 'utf8')
    expect(src).toContain('reviewPending')
    expect(guardedJsx(src, /asset\.status !== 'APPROVED'/)).not.toContain('reviewPending')
    // 正向对照：把提示嵌回豁免块里必须被这套判据抓到，否则上面的绿灯是恒真。
    const nested = "{runFailed && asset.status !== 'APPROVED' && (<div>{asset.run.reviewPending}</div>)}"
    expect(guardedJsx(nested, /asset\.status !== 'APPROVED'/)).toContain('reviewPending')
  })

  it('可交互元素不嵌在原生 button 里（宿主是按钮的产物格必须标 retryless）', () => {
    const offenders = [...tsxFiles('components'), ...tsxFiles('app')].flatMap(file => nestedInteractive(readFileSync(file, 'utf8'), file))
    expect(offenders).toEqual([])
  })

  it('条款四判据本身有效：嵌套与漏标都抓得到，兄弟节点与 retryless 则放行', () => {
    expect(nestedInteractive('<button type="button"><div><Button variant="outline">重试</Button></div></button>\n', 'demo.tsx')).toHaveLength(1)
    expect(nestedInteractive('<button type="button"><a href="/x">下载</a></button>\n', 'demo.tsx')[0]).toContain('<a> 嵌在 <button>')
    expect(nestedInteractive('<button type="button"><ArtifactMedia artifact={a} /></button>\n', 'demo.tsx')[0]).toContain('没标 retryless')
    expect(nestedInteractive('<button type="button"><ArtifactMedia retryless artifact={a} /></button>\n', 'demo.tsx')).toEqual([])
    // 兄弟节点写法（大预览那一处）不算违规。
    expect(nestedInteractive('<><button type="button">格</button><Button onClick={f}>重试</Button></>\n', 'demo.tsx')).toEqual([])
    // 三层括号写在同一个开标签里也必须被识别成按钮宿主，不许因解析退化而漏判。
    expect(nestedInteractive('<button type="button" onClick={() => { if (a) setReview({ artifactId: null }) }}><Button /></button>\n', 'demo.tsx')).toHaveLength(1)
  })
})
