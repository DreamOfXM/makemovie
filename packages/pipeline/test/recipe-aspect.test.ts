import { describe, expect, it } from 'vitest'
import { projectAspect } from '../src/index.js'

describe('projectAspect', () => {
  it('reads the frame from the recipe pinned at creation', () => {
    expect(projectAspect(JSON.stringify({ aspect: '9:16' }), 'FILM')).toBe('9:16')
    expect(projectAspect(JSON.stringify({ aspect: '16:9' }), 'SHORT_DRAMA')).toBe('16:9')
  })

  it('falls back to the format for pre-recipe projects and unreadable snapshots', () => {
    expect(projectAspect(null, 'FILM')).toBe('16:9')
    expect(projectAspect(null, 'SHORT_DRAMA')).toBe('9:16')
    expect(projectAspect(null, 'SERIES')).toBe('9:16')
    expect(projectAspect('{not json', 'FILM')).toBe('16:9')
    expect(projectAspect(JSON.stringify({ aspect: '4:3' }), 'SHORT_DRAMA')).toBe('9:16')
  })
})
