/**
 * Mechanical chapter detection for whole-book uploads: locate 「第 N 章」-style
 * markers (or English "Chapter N") in the raw text, no model involved. The
 * allocation UI's contract is: every segment is a contiguous slice of the book,
 * segments in index order concatenate back to the whole, and a segment without
 * a marker is the unmarked run in front of the first chapter (or the entire
 * book when no marker exists at all).
 */

export interface ChapterSegment {
  title: string | null
  marked: boolean
  content: string
}

const CN_NUM = '[0-9０-９〇零一二两三四五六七八九十百千万]+'
const MARKER = new RegExp(`^[ \\t]*(?:第[ \\t]*${CN_NUM}[ \\t]*(?:之[ \\t]*)?[上下中]?[ \\t]*[章节卷部集回][ \\t]*[^\\n]*|(?:Chapter|CHAPTER)[ \\t]+[0-9IVXLCivxlc]+[^\\n]*)$`)

export function splitChapters(raw: string): ChapterSegment[] {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
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
    if (MARKER.test(line)) {
      if (current) {
        current.content = buffer.join('\n')
        segments.push(current)
        buffer = []
      } else {
        flushUnmarked()
      }
      current = { title: line.trim(), marked: true, content: '' }
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
