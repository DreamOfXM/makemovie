import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compositionTakeSignature, compositionTransitionSignature } from '@studio/pipeline'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv
let ownerToken: string
let projectId: string
let episodeId: string

const authHeaders = (token: string) => env.authHeaders(token)
const json = (token: string) => ({ ...authHeaders(token), 'content-type': 'application/json' })

beforeAll(async () => {
  env = await startTestEnv()
  const owner = await env.register('fresh-owner@example.com', 'Fresh Org')
  ownerToken = owner.token
  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: json(ownerToken), payload: { name: 'Fresh Drama' } })
  projectId = project.json().id as string
  const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: json(ownerToken), payload: { number: 1, title: 'EP1' } })
  episodeId = episode.json().id as string
  // UX-P03 后 GET 只在「有 live 分镜」时才初始化编辑(0 分镜返回空态且不落库),
  // 所以这里先建一镜再让 GET 建文档。
  await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: json(ownerToken), payload: { number: 1, title: 'SB1', durationMs: 5000, description: 'd', sourceExcerpt: 's', continuityIn: '', continuityOut: '' } })
}, 300_000)

afterAll(async () => { await env?.stop() })

describe('edit freshness (US-028)', () => {
  it('reports no_composition, then fresh, then stale after edit change', async () => {
    // 初始化编辑(隐式 via GET edit)。
    await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/edit`, headers: authHeaders(ownerToken) })

    // 无合成。
    const empty = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/edit/freshness`, headers: authHeaders(ownerToken) })
    expect(empty.statusCode).toBe(200)
    expect(empty.json().status).toBe('no_composition')

    // 造一个带指纹的合成(直接落库,模拟 worker 完成)。
    const edit = await env.db.episodeEdit.findUniqueOrThrow({ where: { episodeId }, include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } } })
    await env.db.composition.create({
      data: { episodeId, status: 'COMPLETED', manifest: '{}', editRevisionId: edit.revisions[0]!.id, inputFingerprint: edit.revisions[0]!.fingerprint },
    })
    const fresh = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/edit/freshness`, headers: authHeaders(ownerToken) })
    expect(fresh.json().status).toBe('fresh')
    // 快照是 S2d 之前落的（manifest 里没有段集指纹）：不能凭空判它过期，
    // 否则存量集会被自动接力反复重合成。
    expect(fresh.json().takeCutStale).toBe(false)

    // 改编辑(新修订 → 新指纹) → stale。编辑有一镜占位;改 fps 即新修订
    // (V3 起,占位 storyboardId 会被归属校验拒收,所以直接存空剪辑列表只改 fps)。
    await env.app.inject({
      method: 'PUT', url: `/api/episodes/${episodeId}/edit`,
      headers: json(ownerToken),
      payload: { expectedEditRevision: edit.headRevision, fps: { fpsNum: 30, fpsDen: 1 }, clips: [] },
    })
    const stale = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/edit/freshness`, headers: authHeaders(ownerToken) })
    expect(stale.json().status).toBe('stale')
    expect(stale.json().message).toContain('edit has changed')
  })

  it('reports stale on the segment axis alone and fresh again once the cut matches', async () => {
    // S2d 第二条过期轴：重跑拼接镜的任一段会产一颗新母带，编辑文档一个字没改，
    // 编辑指纹照样匹配。只认指纹就把「段是旧的」报成当前成片。
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: json(ownerToken), payload: { number: 2, title: 'EP2' } })
    const episodeTwo = episode.json().id as string
    const shot = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeTwo}/storyboards`, headers: json(ownerToken),
      payload: { number: 1, title: 'SB1', durationMs: 12000, description: 'd', sourceExcerpt: 's', continuityIn: '', continuityOut: '' },
    })
    const shotId = shot.json().id as string
    await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeTwo}/edit`, headers: authHeaders(ownerToken) })
    const head = (await env.db.episodeEdit.findUniqueOrThrow({ where: { episodeId: episodeTwo }, include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } } })).revisions[0]!
    const frozenManifest = (takeSignature: string) => JSON.stringify({ storyboardIds: [shotId], resolved: { takeCut: 'master-clip', takeSignature } })
    const composition = await env.db.composition.create({
      data: { episodeId: episodeTwo, status: 'COMPLETED', editRevisionId: head.id, inputFingerprint: head.fingerprint, manifest: frozenManifest('0'.repeat(64)) },
    })

    const stale = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeTwo}/edit/freshness`, headers: authHeaders(ownerToken) })
    expect(stale.json()).toMatchObject({ status: 'stale', takeCutStale: true, compositionId: composition.id })
    // 两轴要分得开：这条报文不能让人以为是自己改过剪辑。
    expect(stale.json().message).toContain('re-cut')
    expect(stale.json().message).not.toContain('edit has changed')

    await env.db.composition.update({ where: { id: composition.id }, data: { manifest: frozenManifest(compositionTakeSignature([{ storyboardId: shotId, videoArtifactId: null, takes: [] }])) } })
    const fresh = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeTwo}/edit/freshness`, headers: authHeaders(ownerToken) })
    expect(fresh.json()).toMatchObject({ status: 'fresh', takeCutStale: false })
  })

  it('reads a changed transition as its own stale axis', async () => {
    // S4② 第三条过期轴：分镜表把某一刀从硬切改成叠化，编辑文档与段集一个字没改。
    // 只认前两条轴，界面会把「按旧接法粘出来的母带」报成当前成片。
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${projectId}/episodes`, headers: json(ownerToken), payload: { number: 3, title: 'EP3' } })
    const episodeThree = episode.json().id as string
    const shot = await env.app.inject({
      method: 'POST', url: `/api/episodes/${episodeThree}/storyboards`, headers: json(ownerToken),
      payload: { number: 1, title: 'SB1', durationMs: 5000, description: 'd', sourceExcerpt: 's', continuityIn: '', continuityOut: '' },
    })
    const shotId = shot.json().id as string
    await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeThree}/edit`, headers: authHeaders(ownerToken) })
    const head = (await env.db.episodeEdit.findUniqueOrThrow({ where: { episodeId: episodeThree }, include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } } })).revisions[0]!
    const takes = compositionTakeSignature([{ storyboardId: shotId, videoArtifactId: null, takes: [] }])
    const frozen = (transitionSignature: string) => JSON.stringify({ storyboardIds: [shotId], resolved: { takeCut: 'master-clip', takeSignature: takes, transitionSignature } })
    const staleSignature = compositionTransitionSignature([{ storyboardId: shotId, transition: 'dissolve', transitionMs: 400 }])
    const composition = await env.db.composition.create({
      data: { episodeId: episodeThree, status: 'COMPLETED', editRevisionId: head.id, inputFingerprint: head.fingerprint, manifest: frozen(staleSignature) },
    })

    const stale = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeThree}/edit/freshness`, headers: authHeaders(ownerToken) })
    expect(stale.json()).toMatchObject({ status: 'stale', takeCutStale: false, transitionStale: true, compositionId: composition.id })
    // 三条轴得分得开：这条报文不能让人以为是自己改过剪辑或重跑过段。
    expect(stale.json().message).toContain('transition')
    expect(stale.json().message).not.toContain('edit has changed')
    expect(stale.json().message).not.toContain('re-cut')

    await env.db.composition.update({ where: { id: composition.id }, data: { manifest: frozen(compositionTransitionSignature([{ storyboardId: shotId, transition: 'cut', transitionMs: 0 }])) } })
    const fresh = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeThree}/edit/freshness`, headers: authHeaders(ownerToken) })
    expect(fresh.json()).toMatchObject({ status: 'fresh', transitionStale: false })
  })
})
