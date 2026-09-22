import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv
let token: string

const authHeaders = () => env.authHeaders(token)

function multipartBody(filename: string, bytes: Buffer): { headers: Record<string, string>; payload: Buffer } {
  const boundary = '----studiobooktest'
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload }
}

async function uploadBook(projectId: string, filename: string, bytes: Buffer) {
  const { headers, payload } = multipartBody(filename, bytes)
  return env.app.inject({ method: 'POST', url: `/projects/${projectId}/source/upload`, headers: { ...authHeaders(), ...headers }, payload })
}

/** A dropped folder arrives as many parts: one per chapter file. */
function uploadFolder(projectId: string, files: Array<{ filename: string; bytes: Buffer }>) {
  const boundary = '----studiobooktest'
  const chunks: Buffer[] = []
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: text/plain\r\n\r\n`))
    chunks.push(file.bytes)
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return env.app.inject({
    method: 'POST',
    url: `/projects/${projectId}/source/upload`,
    headers: { ...authHeaders(), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks),
  })
}

const BOOK = [
  '楔子：巷口的灯忽明忽暗，纸人在灯下站了很多年。',
  '第一章 纸人开眼',
  '夜里有风，纸人睁了眼。',
  '第二章 契约',
  '契约写在灯下，落款是一个墨指印。',
].join('\n\n')

beforeAll(async () => {
  env = await startTestEnv()
  token = (await env.register('owner@studio.test', 'Book Org')).token
})

afterAll(async () => {
  await env.stop()
})

async function createProject(format: string): Promise<string> {
  const res = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(), payload: { name: `书项目 ${format}`, format } })
  expect(res.statusCode).toBe(201)
  return (res.json() as { id: string }).id
}

describe('project format', () => {
  it('paginates the project list on demand without touching the default shape', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(), payload: { name: `分页测压-${i}`, format: 'series' } })
      expect(res.statusCode).toBe(201)
    }
    const page1 = await env.app.inject({ method: 'GET', url: '/projects?limit=2', headers: authHeaders() })
    expect(page1.statusCode).toBe(200)
    const first = page1.json() as { projects: Array<{ id: string }>; nextCursor: string | null }
    expect(first.projects).toHaveLength(2)
    expect(first.nextCursor).toBe(first.projects[1].id)

    const page2 = await env.app.inject({ method: 'GET', url: `/projects?limit=2&before=${first.nextCursor}`, headers: authHeaders() })
    const second = page2.json() as { projects: Array<{ id: string }>; nextCursor: string | null }
    expect(second.projects.length).toBeGreaterThanOrEqual(1)
    expect(second.projects.map(p => p.id)).not.toContain(first.projects[0].id)

    const bad = await env.app.inject({ method: 'GET', url: '/projects?limit=0', headers: authHeaders() })
    expect(bad.statusCode).toBe(400)

    // The no-parameter call keeps the bare array every existing consumer reads.
    const legacy = await env.app.inject({ method: 'GET', url: '/projects', headers: authHeaders() })
    expect(Array.isArray(legacy.json())).toBe(true)
  })

  it('locks a film project to the single episode it is born with', async () => {
    const projectId = await createProject('film')
    const episodes = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/episodes`, headers: authHeaders() })
    expect(episodes.statusCode).toBe(200)
    const list = episodes.json() as Array<{ number: number; targetDurationMs: number | null }>
    expect(list).toHaveLength(1)
    expect(list[0].targetDurationMs).toBe(120 * 60_000)

    const extra = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(), payload: { number: 2, title: '多余的一集' } })
    expect(extra.statusCode).toBe(409)
    expect(extra.json()).toMatchObject({ error: 'episodes:filmLockedToOne' })
  })

  it('seeds series episodes with the 45-minute default and honours an explicit override', async () => {
    const projectId = await createProject('series')
    const seeded = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(), payload: { number: 1, title: '首集' } })
    expect(seeded.statusCode).toBe(201)
    expect((seeded.json() as { targetDurationMs: number }).targetDurationMs).toBe(45 * 60_000)

    const override = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(), payload: { number: 2, title: '大结局', targetDurationMs: 90 * 60_000 } })
    expect(override.statusCode).toBe(201)
    expect((override.json() as { targetDurationMs: number }).targetDurationMs).toBe(90 * 60_000)
  })

  it('accepts a project-level custom duration inside the format range and rejects outside it', async () => {
    // 90-second episodes: today's short-drama shape, not the 8-minute constant.
    const custom = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(), payload: { name: '九十秒短剧', format: 'short_drama', targetDurationMs: 90_000 } })
    expect(custom.statusCode).toBe(201)
    const projectId = (custom.json() as { id: string }).id
    const episode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(), payload: { number: 1, title: '第一集' } })
    expect((episode.json() as { targetDurationMs: number }).targetDurationMs).toBe(90_000)

    const tooShort = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(), payload: { name: '超短', format: 'short_drama', targetDurationMs: 5_000 } })
    expect(tooShort.statusCode).toBe(400)
    const tooLong = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(), payload: { name: '超长', format: 'film', targetDurationMs: 400 * 60_000 } })
    expect(tooLong.statusCode).toBe(400)

    // The film born with a 95-minute cut seeds its single episode accordingly.
    const film = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(), payload: { name: '九十五分钟电影', format: 'film', targetDurationMs: 95 * 60_000 } })
    expect(film.statusCode).toBe(201)
    const episodes = await env.app.inject({ method: 'GET', url: `/projects/${(film.json() as { id: string }).id}/episodes`, headers: authHeaders() })
    expect(((episodes.json() as Array<{ targetDurationMs: number }>)[0]).targetDurationMs).toBe(95 * 60_000)

    // Per-episode overrides are range-checked against the project's format.
    const badEpisode = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(), payload: { number: 2, title: '越界', targetDurationMs: 60 * 60_000 } })
    expect(badEpisode.statusCode).toBe(400)
  })
})

describe('whole-book upload', () => {
  it('accepts a txt upload, splits it mechanically and serves the matrix payload', async () => {
    const projectId = await createProject('series')
    const upload = await uploadBook(projectId, 'book.txt', Buffer.from(BOOK, 'utf8'))
    expect(upload.statusCode).toBe(201)
    const created = upload.json() as { version: { version: number; charCount: number }; segments: number }
    expect(created.version.version).toBe(1)
    expect(created.segments).toBe(3)

    const matrix = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source`, headers: authHeaders() })
    expect(matrix.statusCode).toBe(200)
    const payload = matrix.json() as {
      version: { version: number } | null
      format: string
      segments: Array<{ index: number; title: string | null; marked: boolean; charCount: number; episodeId: string | null }>
      episodes: Array<{ number: number }>
    }
    expect(payload.version?.version).toBe(1)
    expect(payload.format).toBe('SERIES')
    expect(payload.segments.map(s => s.title)).toEqual([null, '第一章 纸人开眼', '第二章 契约'])
    expect(payload.segments.every(s => s.episodeId === null)).toBe(true)
  })

  it('accepts a pasted book through the JSON door and rejects a duplicate of it', async () => {
    const projectId = await createProject('series')
    const paste = await env.app.inject({
      method: 'POST',
      url: `/projects/${projectId}/source`,
      headers: authHeaders(),
      payload: { content: BOOK },
    })
    expect(paste.statusCode).toBe(201)
    const created = paste.json() as { version: { filename: string; version: number }; segments: number }
    expect(created.version.version).toBe(1)
    expect(created.version.filename).toBe('粘贴的整本.txt')
    expect(created.segments).toBe(3)

    const dup = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/source`, headers: authHeaders(), payload: { content: BOOK } })
    expect(dup.statusCode).toBe(409)
    expect(dup.json()).toMatchObject({ error: 'projectSources:duplicate' })

    const matrix = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source`, headers: authHeaders() })
    expect(((matrix.json() as { segments: unknown[] }).segments)).toHaveLength(3)
  })

  it('keeps the promised 1M ceiling reachable through the paste door', async () => {
    const projectId = await createProject('series')
    // Just past the ceiling: the business check must answer with a readable 400
    // — not a transport 413 from Fastify's default 1 MB JSON cap.
    const over = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/source`, headers: authHeaders(), payload: { content: '章'.repeat(1_000_001) } })
    expect(over.statusCode).toBe(400)
    expect(over.json()).toMatchObject({ error: 'projectSources:tooLarge' })
    // Inside the ceiling (~2.5 MB of UTF-8) the door holds.
    const within = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/source`, headers: authHeaders(), payload: { content: '章'.repeat(900_000) } })
    expect(within.statusCode).toBe(201)
  })

  it('refuses bytes no supported encoding can decode instead of storing mojibake', async () => {
    const projectId = await createProject('series')
    // 0xFF is undefined in both UTF-8 and GB18030: decodes only via replacement.
    const upload = await uploadBook(projectId, 'broken.bin.txt', Buffer.from([0xff, 0xff, 0x41]))
    expect(upload.statusCode).toBe(400)
    expect(upload.json()).toMatchObject({ error: 'projectSources:badEncoding' })
  })

  it('rejects a repeated segment in one allocation payload instead of a raw 500', async () => {
    const projectId = await createProject('series')
    expect((await uploadBook(projectId, 'book.txt', Buffer.from(BOOK, 'utf8'))).statusCode).toBe(201)
    const ep = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(), payload: { number: 1, title: '第 1 集' } })
    const episodeId = (ep.json() as { id: string }).id
    const matrix = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source`, headers: authHeaders() })
    const segmentId = (matrix.json() as { segments: Array<{ id: string }> }).segments[0].id

    const dup = await env.app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}/source/allocations`,
      headers: authHeaders(),
      payload: { allocations: [
        { segmentId, episodeId },
        { segmentId, episodeId },
      ] },
    })
    expect(dup.statusCode).toBe(400)
    expect(dup.json()).toMatchObject({ error: 'projectSources:duplicateSegment' })
  })

  it('flags a re-intake of an older version hidden behind a newer one', async () => {
    const projectId = await createProject('series')
    expect((await uploadBook(projectId, 'a.txt', Buffer.from(BOOK, 'utf8'))).statusCode).toBe(201)
    expect((await uploadBook(projectId, 'b.txt', Buffer.from(`${BOOK}\n\n第四章 后记\n有人回来点灯。`, 'utf8'))).statusCode).toBe(201)
    // The first book is no longer the latest version — it must still be a duplicate.
    const again = await uploadBook(projectId, 'a-again.txt', Buffer.from(BOOK, 'utf8'))
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ error: 'projectSources:duplicate' })
  })

  it('auto-splits by target duration into new episodes and lands the whole book', async () => {
    // 1-minute target × 350 chars/min: chapters of 200/200/100 pack as [200] + [200,100].
    const custom = await env.app.inject({ method: 'POST', url: '/projects', headers: authHeaders(), payload: { name: '自动拆分靶', format: 'short_drama', targetDurationMs: 60_000 } })
    const projectId = (custom.json() as { id: string }).id
    const book = '第一章 灯\n' + '灯下有人。'.repeat(40) + '\n\n第二章 巷\n' + '巷口风大。'.repeat(40) + '\n\n第三章 归\n' + '有人归来。'.repeat(20)
    expect((await uploadBook(projectId, 'book.txt', Buffer.from(book, 'utf8'))).statusCode).toBe(201)

    const split = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/source/auto-split`, headers: authHeaders() })
    expect(split.statusCode).toBe(200)
    expect(split.json()).toMatchObject({ episodesCreated: 2, allocated: 3 })

    const applied = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/source/apply`, headers: authHeaders() })
    expect(applied.statusCode).toBe(200)
    expect(applied.json()).toMatchObject({ pendingSegments: 0 })
    const matrix = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source`, headers: authHeaders() })
    expect((matrix.json() as { version: { status: string } }).version.status).toBe('APPROVED')

    // Existing episodes are appended after, never renumbered or touched.
    const splitAgain = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/source/auto-split`, headers: authHeaders() })
    expect(splitAgain.statusCode).toBe(200)
    const episodes = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/episodes`, headers: authHeaders() })
    const list = episodes.json() as Array<{ number: number; title: string }>
    expect(list.map(e => e.number)).toEqual([1, 2, 3, 4])
    // Episodes are numbered artifacts, not chapter digests: the first chapter's
    // title must not leak into the episode's own name.
    expect(list.map(e => e.title)).toEqual(['第 1 集', '第 2 集', '第 3 集', '第 4 集'])
  })

  it('auto-split lands a film in its single born episode', async () => {
    const projectId = await createProject('film')
    expect((await uploadBook(projectId, 'film.txt', Buffer.from(BOOK, 'utf8'))).statusCode).toBe(201)
    const split = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/source/auto-split`, headers: authHeaders() })
    expect(split.statusCode).toBe(200)
    expect(split.json()).toMatchObject({ episodesCreated: 0, allocated: 3 })
    const episodes = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/episodes`, headers: authHeaders() })
    expect((episodes.json() as unknown[]).length).toBe(1)
  })

  it('keeps the whole book in draft while chapters remain unallocated', async () => {
    const projectId = await createProject('series')
    expect((await uploadBook(projectId, 'book.txt', Buffer.from(BOOK, 'utf8'))).statusCode).toBe(201)
    expect((await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(), payload: { number: 1, title: '纸人开眼' } })).statusCode).toBe(201)

    const matrix = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source`, headers: authHeaders() })
    const { segments, episodes } = matrix.json() as { segments: Array<{ id: string }>; episodes: Array<{ id: string }> }
    // Only the first marked chapter goes in this round.
    expect((await env.app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}/source/allocations`,
      headers: authHeaders(),
      payload: { allocations: [{ segmentId: segments[1].id, episodeId: episodes[0].id }] },
    })).statusCode).toBe(200)

    const partial = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/source/apply`, headers: authHeaders() })
    expect(partial.statusCode).toBe(200)
    expect(partial.json()).toMatchObject({ pendingSegments: 2 })
    const stillDraft = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source`, headers: authHeaders() })
    expect((stillDraft.json() as { version: { status: string } }).version.status).toBe('DRAFT')

    // Place every remaining segment (unmarked lead included) and apply again.
    const rest = segments.filter(segment => segment.id !== segments[1].id).map(segment => ({ segmentId: segment.id, episodeId: episodes[0].id }))
    expect((await env.app.inject({ method: 'PATCH', url: `/projects/${projectId}/source/allocations`, headers: authHeaders(), payload: { allocations: rest } })).statusCode).toBe(200)
    const complete = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/source/apply`, headers: authHeaders() })
    expect(complete.json()).toMatchObject({ pendingSegments: 0 })
    const approved = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source`, headers: authHeaders() })
    expect((approved.json() as { version: { status: string } }).version.status).toBe('APPROVED')
  })

  it('rejects a rename that tries to smuggle format fields', async () => {
    const projectId = await createProject('series')
    const res = await env.app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}`,
      headers: authHeaders(),
      payload: { name: '改名', format: 'film' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('decodes a GBK-encoded book without mojibake', async () => {
    const projectId = await createProject('series')
    // 纸巷 in GBK: invalid as UTF-8, decodable as GB18030.
    const upload = await uploadBook(projectId, 'gbk.txt', Buffer.from([0xd6, 0xbd, 0xcf, 0xef]))
    expect(upload.statusCode).toBe(201)
    const matrix = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source`, headers: authHeaders() })
    const payload = matrix.json() as { segments: Array<{ charCount: number }> }
    expect(payload.segments).toHaveLength(1)
    expect(payload.segments[0].charCount).toBe(2)
  })

  it('rejects docx for now and refuses a byte-identical re-upload', async () => {
    const projectId = await createProject('series')
    const docx = await uploadBook(projectId, 'book.docx', Buffer.from('PK\x03\x04'))
    expect(docx.statusCode).toBe(400)

    const first = await uploadBook(projectId, 'a.txt', Buffer.from(BOOK, 'utf8'))
    expect(first.statusCode).toBe(201)
    const dup = await uploadBook(projectId, 'b.txt', Buffer.from(BOOK, 'utf8'))
    expect(dup.statusCode).toBe(409)
    expect(dup.json()).toMatchObject({ error: 'projectSources:duplicate' })
  })

  it('treats a folder of chapter files as one book: one chapter per file, filename-titled', async () => {
    const projectId = await createProject('series')
    const res = await uploadFolder(projectId, [
      { filename: '第2章 奶奶的葬礼.txt', bytes: Buffer.from('葬礼的正文，没有内部章头。', 'utf8') },
      // Internal marker line duplicates the filename's — the filename wins.
      { filename: '第1章 雨夜寻人.txt', bytes: Buffer.from('第一章 雨夜寻人\n雨夜的正文。', 'utf8') },
      { filename: '第10章 巷底的灯.txt', bytes: Buffer.from('灯的正文。', 'utf8') },
    ])
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ files: 3, segments: 3 })

    const matrix = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source`, headers: authHeaders() })
    const { segments } = matrix.json() as { segments: Array<{ id: string; title: string | null }> }
    // Natural order: 第2章 sorts before 第10章 (lexicographic would flip them).
    expect(segments.map(segment => segment.title)).toEqual(['第1章 雨夜寻人', '第2章 奶奶的葬礼', '第10章 巷底的灯'])

    const detail = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source/segments/${segments[0].id}`, headers: authHeaders() })
    const content = (detail.json() as { segment: { content: string } }).segment.content
    expect(content).toContain('雨夜的正文。')
    expect(content).not.toContain('第一章 雨夜寻人')
  })

  it('synthesizes chapter numbers for plainly named files in natural order', async () => {
    const projectId = await createProject('series')
    const res = await uploadFolder(projectId, [
      { filename: '10.txt', bytes: Buffer.from('丙的内容。', 'utf8') },
      { filename: '2.txt', bytes: Buffer.from('乙的内容。', 'utf8') },
      { filename: '1.txt', bytes: Buffer.from('甲的内容。', 'utf8') },
    ])
    expect(res.statusCode).toBe(201)
    const matrix = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source`, headers: authHeaders() })
    const { segments } = matrix.json() as { segments: Array<{ id: string; title: string | null }> }
    // 1, 2, 10 — not 1, 10, 2 — and each file's body rides its position's chapter.
    expect(segments.map(segment => segment.title)).toEqual(['第1章', '第2章', '第3章'])
    const details = await Promise.all(segments.map(segment =>
      env.app.inject({ method: 'GET', url: `/projects/${projectId}/source/segments/${segment.id}`, headers: authHeaders() })))
    const bodies = await Promise.all(details.map(d => (d.json() as { segment: { content: string } }).segment.content))
    expect(bodies[0]).toContain('甲的内容。')
    expect(bodies[2]).toContain('丙的内容。')
  })

  it('skips OS droppings and non-text files inside a dropped folder', async () => {
    const projectId = await createProject('series')
    const res = await uploadFolder(projectId, [
      { filename: '.DS_Store', bytes: Buffer.from('junk', 'utf8') },
      { filename: 'notes.docx', bytes: Buffer.from('PK\x03\x04') },
      { filename: '第1章 正经的章.txt', bytes: Buffer.from('正文直接开始。', 'utf8') },
    ])
    expect(res.statusCode).toBe(201)
    const body = res.json() as { files?: number; segments: number; version: { filename: string } }
    expect(body.files).toBeUndefined()
    expect(body.segments).toBe(1)
    expect(body.version.filename).toBe('第1章 正经的章.txt')
  })

  it('refuses a folder when any chapter file cannot be decoded', async () => {
    const projectId = await createProject('series')
    const res = await uploadFolder(projectId, [
      { filename: '第1章 好文件.txt', bytes: Buffer.from('正文。', 'utf8') },
      { filename: '第2章 坏文件.txt', bytes: Buffer.from([0xff, 0xff, 0x41]) },
    ])
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'projectSources:badEncoding' })
  })
})

describe('allocation and apply', () => {
  it('moves chapters between episodes as data and materializes per-episode sources in book order', async () => {
    const projectId = await createProject('series')
    expect((await uploadBook(projectId, 'book.txt', Buffer.from(BOOK, 'utf8'))).statusCode).toBe(201)
    for (const [number, title] of [[1, '纸人开眼'], [2, '契约']] as const) {
      expect((await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(), payload: { number, title } })).statusCode).toBe(201)
    }

    const matrix = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source`, headers: authHeaders() })
    const { segments, episodes } = matrix.json() as { segments: Array<{ id: string }>; episodes: Array<{ id: string; number: number }> }
    const ep1 = episodes.find(e => e.number === 1)!.id
    const ep2 = episodes.find(e => e.number === 2)!.id

    const allocate = await env.app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}/source/allocations`,
      headers: authHeaders(),
      payload: { allocations: [
        { segmentId: segments[0].id, episodeId: ep1 },
        { segmentId: segments[1].id, episodeId: ep1 },
        { segmentId: segments[2].id, episodeId: ep2 },
      ] },
    })
    expect(allocate.statusCode).toBe(200)

    const apply = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/source/apply`, headers: authHeaders() })
    expect(apply.statusCode).toBe(200)
    const results = (apply.json() as { results: Array<{ number: number; version: number | null; skipped: boolean }> }).results
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ number: 1, version: 1, skipped: false }),
      expect.objectContaining({ number: 2, version: 1, skipped: false }),
    ]))

    const ep1Source = await env.app.inject({ method: 'GET', url: `/episodes/${ep1}/source-versions/1`, headers: authHeaders() })
    expect(ep1Source.statusCode).toBe(200)
    const source = ep1Source.json() as { version: { content: string } }
    // Book order is preserved: the unmarked lead precedes chapter one inside episode 1.
    expect(source.version.content.indexOf('楔子')).toBeLessThan(source.version.content.indexOf('第一章'))
    expect(source.version.content).not.toContain('第二章')

    // Re-applying the same map is a no-op per episode, not an error.
    const again = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/source/apply`, headers: authHeaders() })
    expect((again.json() as { results: Array<{ skipped: boolean }> }).results.every(r => r.skipped)).toBe(true)
  })

  it('refuses to fan a film book out across episodes', async () => {
    const projectId = await createProject('film')
    expect((await uploadBook(projectId, 'film.txt', Buffer.from(BOOK, 'utf8'))).statusCode).toBe(201)
    const other = await createProject('series')
    const ep = await env.app.inject({ method: 'POST', url: `/projects/${other}/episodes`, headers: authHeaders(), payload: { number: 1, title: '别家的集' } })
    const foreignEpisodeId = (ep.json() as { id: string }).id

    const matrix = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source`, headers: authHeaders() })
    const { segments } = matrix.json() as { segments: Array<{ id: string }> }

    const spread = await env.app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}/source/allocations`,
      headers: authHeaders(),
      payload: { allocations: [
        { segmentId: segments[0].id, episodeId: foreignEpisodeId },
        { segmentId: segments[1].id, episodeId: foreignEpisodeId },
      ] },
    })
    // The foreign episode is caught first: allocations may only reference this project's episodes.
    expect(spread.statusCode).toBe(409)
    expect(spread.json()).toMatchObject({ error: 'projectSources:episodeNotInProject' })
  })

  it('applies a film book onto its single episode as one source version', async () => {
    const projectId = await createProject('film')
    expect((await uploadBook(projectId, 'film.txt', Buffer.from(BOOK, 'utf8'))).statusCode).toBe(201)
    const matrix = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source`, headers: authHeaders() })
    const { segments, episodes } = matrix.json() as { segments: Array<{ id: string }>; episodes: Array<{ id: string }> }
    expect(episodes).toHaveLength(1)

    const allocate = await env.app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}/source/allocations`,
      headers: authHeaders(),
      payload: { allocations: segments.map(segment => ({ segmentId: segment.id, episodeId: episodes[0].id })) },
    })
    expect(allocate.statusCode).toBe(200)

    const apply = await env.app.inject({ method: 'POST', url: `/projects/${projectId}/source/apply`, headers: authHeaders() })
    expect(apply.statusCode).toBe(200)
    expect((apply.json() as { results: Array<{ version: number | null }> }).results[0].version).toBe(1)

    const whole = await env.app.inject({ method: 'GET', url: `/episodes/${episodes[0].id}/source-versions/1`, headers: authHeaders() })
    const source = whole.json() as { version: { content: string; contentLength: number } }
    expect(source.version.content).toContain('楔子')
    expect(source.version.content).toContain('第二章 契约')
  })

  it('serves one chapter\'s full text for row expansion, scoped to the owning org', async () => {
    const projectId = await createProject('series')
    expect((await uploadBook(projectId, 'book.txt', Buffer.from(BOOK, 'utf8'))).statusCode).toBe(201)
    const matrix = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source`, headers: authHeaders() })
    const { segments } = matrix.json() as { segments: Array<{ id: string; title: string | null; charCount: number }> }
    // The matrix reads shapes only; the detail read is where the words live.
    expect(segments[1]).not.toHaveProperty('content')

    const detail = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source/segments/${segments[1].id}`, headers: authHeaders() })
    expect(detail.statusCode).toBe(200)
    const segment = (detail.json() as { segment: { title: string | null; content: string; charCount: number } }).segment
    expect(segment.title).toBe('第一章 纸人开眼')
    expect(segment.content).toContain('夜里有风，纸人睁了眼。')
    expect(segment.content).not.toContain('第二章')
    expect(segment.charCount).toBe(segments[1].charCount)

    // A segment of another org's project is not addressable, and unknown ids 404.
    const outsider = (await env.register('outsider@studio.test', 'Outsider Org')).token
    const foreign = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source/segments/${segments[1].id}`, headers: env.authHeaders(outsider) })
    expect(foreign.statusCode).toBe(404)
    const unknown = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source/segments/does-not-exist`, headers: authHeaders() })
    expect(unknown.statusCode).toBe(404)
  })

  it('edits one chapter\'s text in place, re-deriving its char count', async () => {
    const projectId = await createProject('series')
    expect((await uploadBook(projectId, 'book.txt', Buffer.from(BOOK, 'utf8'))).statusCode).toBe(201)
    const matrix = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source`, headers: authHeaders() })
    const { segments } = matrix.json() as { segments: Array<{ id: string; charCount: number }> }

    const edit = await env.app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}/source/segments/${segments[1].id}`,
      headers: authHeaders(),
      payload: { content: '第一章 纸人开眼\n改写后的整章内容，只占一行。' },
    })
    expect(edit.statusCode).toBe(200)
    const saved = (edit.json() as { segment: { content: string; charCount: number } }).segment
    expect(saved.content).toContain('改写后的整章内容')
    expect(saved.charCount).toBe(saved.content.length)

    // The matrix reads the new shape without a re-upload.
    const reread = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source`, headers: authHeaders() })
    const row = ((reread.json() as { segments: Array<{ id: string; charCount: number }> }).segments).find(s => s.id === segments[1].id)
    expect(row?.charCount).toBe(saved.charCount)

    const empty = await env.app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}/source/segments/${segments[1].id}`,
      headers: authHeaders(),
      payload: { content: '   ' },
    })
    expect(empty.statusCode).toBe(400)
    expect(empty.json()).toMatchObject({ error: 'projectSources:empty' })
  })

  it('rides source statuses on the episode list so rows can flag drafts awaiting review', async () => {
    const projectId = await createProject('series')
    expect((await uploadBook(projectId, 'book.txt', Buffer.from(BOOK, 'utf8'))).statusCode).toBe(201)
    expect((await env.app.inject({ method: 'POST', url: `/projects/${projectId}/episodes`, headers: authHeaders(), payload: { number: 1, title: '纸人开眼' } })).statusCode).toBe(201)

    // Before apply: the episode exists but owes no source.
    const empty = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/episodes`, headers: authHeaders() })
    expect(((empty.json() as Array<{ sourceVersions: Array<{ status: string }> }>)[0]).sourceVersions).toEqual([])

    const matrix = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/source`, headers: authHeaders() })
    const { segments, episodes } = matrix.json() as { segments: Array<{ id: string }>; episodes: Array<{ id: string }> }
    await env.app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}/source/allocations`,
      headers: authHeaders(),
      payload: { allocations: segments.map(segment => ({ segmentId: segment.id, episodeId: episodes[0].id })) },
    })
    expect((await env.app.inject({ method: 'POST', url: `/projects/${projectId}/source/apply`, headers: authHeaders() })).statusCode).toBe(200)

    // After apply: the draft the project page must flag is right there in the list read.
    const list = await env.app.inject({ method: 'GET', url: `/projects/${projectId}/episodes`, headers: authHeaders() })
    const statuses = ((list.json() as Array<{ sourceVersions: Array<{ status: string }> }>)[0]).sourceVersions
    expect(statuses).toEqual([{ status: 'DRAFT' }])
  })
})
