import { describe, expect, it } from 'vitest'
import { splitChapters } from '../src/chapters.js'

describe('splitChapters', () => {
  it('splits on 第N章 markers and keeps the unmarked lead as its own segment', () => {
    const book = '楔子：巷口的灯忽明忽暗。\n\n第一章 纸人开眼\n夜里有风。\n纸人睁了眼。\n\n第二章 契约\n契约写在灯下。'
    const segments = splitChapters(book)
    expect(segments).toHaveLength(3)
    expect(segments[0]).toMatchObject({ title: null, marked: false })
    expect(segments[0].content).toContain('楔子')
    expect(segments[1]).toMatchObject({ title: '第一章 纸人开眼', marked: true })
    expect(segments[1].content).toContain('纸人睁了眼')
    expect(segments[2]).toMatchObject({ title: '第二章 契约', marked: true })
    // Segments in order concatenate back to the whole book.
    expect(segments.map(s => s.content).join('\n')).toBe(book)
  })

  it('recognizes Chinese numerals, 卷/节/回 markers and English Chapter headings', () => {
    const book = '第十二卷 归途\n正文。\n第一百零三回 终局\n正文。\nChapter 4 Epilogue\nBody.'
    const segments = splitChapters(book)
    expect(segments.map(s => s.title)).toEqual(['第十二卷 归途', '第一百零三回 终局', 'Chapter 4 Epilogue'])
    expect(segments.every(s => s.marked)).toBe(true)
  })

  it('returns the whole book as one unmarked segment when no marker exists', () => {
    const book = '一整段没有任何章节标记的长文本，从头到尾。'
    expect(splitChapters(book)).toEqual([{ title: null, marked: false, content: book }])
  })

  it('normalizes BOM and CRLF before splitting', () => {
    const book = '\uFEFF第一章 试\r\n正文一。\r\n第二章 式\r\n正文二。'
    const segments = splitChapters(book)
    expect(segments).toHaveLength(2)
    expect(segments[0].content).not.toContain('\r')
    expect(segments[1].content).toContain('正文二。')
  })

  it('drops a whitespace-only lead instead of an empty unmarked segment', () => {
    const segments = splitChapters('\n\n  \n第一章 起\n正文。')
    expect(segments).toHaveLength(1)
    expect(segments[0].marked).toBe(true)
  })

  it('recognizes markdown ## 第N章 headings and headlines them without the hashes', () => {
    const book = '## 第一章：日常的边界\n\n一\n\n“林工，三区有异常。”\n\n## 第二章：回响\n\n风暴在数据层成形。'
    const segments = splitChapters(book)
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ title: '第一章：日常的边界', marked: true })
    expect(segments[0].content.startsWith('## 第一章：日常的边界')).toBe(true)
    expect(segments[1]).toMatchObject({ title: '第二章：回响', marked: true })
    expect(segments.map(s => s.content).join('\n')).toBe(book)
  })

  it('treats # 第N章 and ## Chapter N headings the same as bare ones', () => {
    const segments = splitChapters('# 第1章 起\n正文。\n## Chapter 2 End\nBody.')
    expect(segments.map(s => s.title)).toEqual(['第1章 起', 'Chapter 2 End'])
    expect(segments.every(s => s.marked)).toBe(true)
  })

  it('does not treat a prose paragraph that opens with 第二部 as a chapter', () => {
    const prose = '第二部走到这里，并没有把问题彻底解决。清理协议只是被冻结，陈明远只是被暂时逼退，社会还没真正承受过真相落地后的震荡。'
    const segments = splitChapters(`第一章 起\n正文一。\n${prose}\n正文二。`)
    expect(segments).toHaveLength(1)
    expect(segments[0].title).toBe('第一章 起')
    expect(segments[0].content).toContain(prose)
  })

  it('splits a header glued onto the previous （…完） tail by a missing trailing newline', () => {
    const book = '## 第三章：苏晚晴\n正文三。\n\n（第三章完）## 第四章 灰域里的半截人\n正文四。'
    const segments = splitChapters(book)
    expect(segments).toHaveLength(2)
    expect(segments[0].title).toBe('第三章：苏晚晴')
    expect(segments[0].content.trimEnd().endsWith('（第三章完）')).toBe(true)
    expect(segments[1]).toMatchObject({ title: '第四章 灰域里的半截人', marked: true })
    expect(segments[1].content.startsWith('## 第四章 灰域里的半截人')).toBe(true)
  })

  it('leaves a mid-sentence 第N章 reference alone when no （…完） tail precedes it', () => {
    const segments = splitChapters('第一章 起\n详见第四章附录的对照表，这里不再展开。')
    expect(segments).toHaveLength(1)
    expect(segments[0].content).toContain('详见第四章附录')
  })
})
