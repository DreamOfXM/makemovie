/**
 * Mechanical chapter detection for whole-book uploads: locate 「第 N 章」-style
 * markers (or English "Chapter N") in the raw text, no model involved. The
 * allocation UI's contract is: every segment is a contiguous slice of the book,
 * segments in index order concatenate back to the whole (up to the line breaks
 * re-inserted where a glued （…完） chapter tail was repaired), and a segment
 * without a marker is the unmarked run in front of the first chapter (or the
 * entire book when no marker exists at all).
 */

export interface ChapterSegment {
  title: string | null
  marked: boolean
  content: string
}

const CN_NUM = '[0-9０-９〇零一二两三四五六七八九十百千万]+'
// Markdown exports headline chapters as 「## 第N章 …」, so an ATX heading
// prefix is as much a marker as a bare one.
const HEADING = '(?:#{1,6}[ \\t]*)?'
const MARKER_CORE = `第[ \\t]*${CN_NUM}[ \\t]*(?:之[ \\t]*)?[上下中]?[ \\t]*[章节卷部集回][ \\t]*[^\\n]*|(?:Chapter|CHAPTER)[ \\t]+[0-9IVXLCivxlc]+[^\\n]*`
const MARKER = new RegExp(`^[ \\t]*${HEADING}(?:${MARKER_CORE})$`)

// A 第N章 mentioned mid-sentence is usually a reference, not a header — so the
// missing line break is only re-inserted after an explicit （…完） chapter tail.
const GLUED_TAIL = new RegExp(`^(（[^）\\n]{0,30}完）|\\([^)\\n]{0,30}完\\))[ \\t]*(?=${HEADING}(?:${MARKER_CORE}))`, 'gm')

// A marker is a title line, not a paragraph: prose often opens with 第N部/第N章
// (「第二部走到这里，并没有把问题彻底解决。…」), and a line that runs this long
// is body text that happens to start with a marker — never a heading.
const MARKER_MAX_LENGTH = 50

/** Whether a single line (or a filename stem) reads as a chapter marker. Folder
 *  uploads use this to decide whether the filename itself can headline the
 *  chapter or a synthesized 第N章 header is needed. */
export function isChapterMarkerLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.length > 0 && trimmed.length <= MARKER_MAX_LENGTH && MARKER.test(trimmed)
}

export function splitChapters(raw: string): ChapterSegment[] {
  // Exports concatenated without trailing newlines glue the previous chapter's
  // tail onto the next header on one line（（第三章完）## 第四章 …）; re-insert
  // the missing break so the header can headline its own chapter.
  const text = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(GLUED_TAIL, '$1\n')
  const lines = text.split('\n')
  const segments: ChapterSegment[] = []
  let buffer: string[] = []
  let current: ChapterSegment | null = null

  const flushUnmarked = () => {
    const content = buffer.join('\n')
    buffer = []
    if (content.trim().length > 0) {
      segments.push({ title: null, marked: false, content })
    }
  }

  for (const line of lines) {
    if (isChapterMarkerLine(line)) {
      if (current) {
        current.content = buffer.join('\n')
        segments.push(current)
        buffer = []
      } else {
        flushUnmarked()
      }
      current = { title: line.trim().replace(/^#{1,6}[ \t]*/, ''), marked: true, content: '' }
      buffer = [line]
    } else {
      buffer.push(line)
    }
  }

  if (current) {
    current.content = buffer.join('\n')
    segments.push(current)
  } else {
    flushUnmarked()
  }

  // A book that split into nothing is still one segment: the matrix must always
  // have at least one row to allocate.
  if (segments.length === 0 && text.trim().length > 0) {
    segments.push({ title: null, marked: false, content: text })
  }
  return segments
}
