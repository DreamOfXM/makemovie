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
})
