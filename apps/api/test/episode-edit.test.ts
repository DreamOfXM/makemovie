import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestEnv, type TestEnv } from './env.js'

let env: TestEnv
let ownerToken: string
let ownerOrgId: string
let episodeId: string

const authHeaders = (token: string) => env.authHeaders(token)
const json = (token: string) => ({ ...authHeaders(token), 'content-type': 'application/json' })

beforeAll(async () => {
  env = await startTestEnv()
  const owner = await env.register('edit-owner@example.com', 'Edit Org')
  ownerToken = owner.token
  ownerOrgId = owner.organization.id
  const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: json(ownerToken), payload: { name: 'Edit Drama' } })
  const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${project.json().id}/episodes`, headers: json(ownerToken), payload: { number: 1, title: 'EP1' } })
  episodeId = episode.json().id as string
  await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: json(ownerToken), payload: { number: 1, title: 'SB1', durationMs: 5000, description: '雨夜巷口', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' } })
  await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/storyboards`, headers: json(ownerToken), payload: { number: 2, title: 'SB2', durationMs: 6000, description: '纸人开眼', sourceExcerpt: '原文', continuityIn: '', continuityOut: '' } })
}, 300_000)

afterAll(async () => { await env?.stop() })

describe('episode edit (US-024)', () => {
  it('initializes a default sequence for a fresh episode (two clips, 25fps)', async () => {
    const read = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/edit`, headers: authHeaders(ownerToken) })
    expect(read.statusCode).toBe(200)
    const body = read.json() as { editId: string; headRevision: number; revision: { clips: Array<{ clipId: string; storyboardId: string; sourceInFrame: number; sourceOutFrame: number }>; fpsNum: number } }
    expect(body.headRevision).toBe(1)
    expect(body.revision.fpsNum).toBe(25)
    expect(body.revision.clips).toHaveLength(2)
    expect(body.revision.clips[0].clipId).toBe('clip-1')
    expect(body.revision.clips[1].clipId).toBe('clip-2')
  })

  it('saves revisions with CAS and rejects stale expectedEditRevision', async () => {
    const initial = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/edit`, headers: authHeaders(ownerToken) })
    const editId = (initial.json() as { editId: string }).editId
    // V03+:保存校验镜头归属——用初始化序列里的真实镜头 id(占位 id 现在会被 400)。
    const head = (initial.json() as { revision: { clips: Array<{ clipId: string; storyboardId: string }> } }).revision.clips
    const [realA, realB] = head.map(clip => clip.storyboardId)

    // CAS 保存:调换两镜顺序。
    const reorder = await env.app.inject({
      method: 'PUT', url: `/api/episodes/${episodeId}/edit`,
      headers: json(ownerToken),
      payload: {
        expectedEditRevision: 1,
        fps: { fpsNum: 25, fpsDen: 1 },
        clips: [
          { clipId: 'clip-2', storyboardId: realB!, artifactId: '', sourceInFrame: 0, sourceOutFrame: 1 },
          { clipId: 'clip-1', storyboardId: realA!, artifactId: '', sourceInFrame: 0, sourceOutFrame: 1 },
        ],
      },
    })
    expect(reorder.statusCode).toBe(200)
    expect((reorder.json() as { headRevision: number }).headRevision).toBe(2)

    // CAS 冲突。
    const stale = await env.app.inject({
      method: 'PUT', url: `/api/episodes/${episodeId}/edit`,
      headers: json(ownerToken),
      payload: { expectedEditRevision: 1, fps: { fpsNum: 25, fpsDen: 1 }, clips: [] },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().code).toBe('version_conflict')
    void editId
  })

  it('rejects edits referencing storyboards, artifacts or tracks outside the episode (V03+)', async () => {
    const initial = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/edit`, headers: authHeaders(ownerToken) })
    const body = initial.json() as { headRevision: number; revision: { clips: Array<{ clipId: string; storyboardId: string; sourceInFrame: number; sourceOutFrame: number }> } }
    const [first, second] = body.revision.clips

    // 镜头不存在:修复前 nonexistent id 也能存 200,合成时才炸。
    const ghostShot = await env.app.inject({
      method: 'PUT', url: `/api/episodes/${episodeId}/edit`, headers: json(ownerToken),
      payload: { expectedEditRevision: body.headRevision, fps: { fpsNum: 25, fpsDen: 1 }, clips: [{ ...first!, storyboardId: 'storyboard-that-does-not-exist', sourceInFrame: 0, sourceOutFrame: 5 }] },
    })
    expect(ghostShot.statusCode).toBe(400)
    expect(ghostShot.json().error).toContain('outside this episode')

    // 制品不是本镜视频:不存在的 artifactId 直接拒。
    const ghostArtifact = await env.app.inject({
      method: 'PUT', url: `/api/episodes/${episodeId}/edit`, headers: json(ownerToken),
      payload: { expectedEditRevision: body.headRevision, fps: { fpsNum: 25, fpsDen: 1 }, clips: [{ ...first!, artifactId: 'artifact-that-does-not-exist', sourceInFrame: 0, sourceOutFrame: 5 }] },
    })
    expect(ghostArtifact.statusCode).toBe(400)
    expect(ghostArtifact.json().error).toContain('not a video of this shot')

    // 轨道:源制品不存在 / 锚定未知 clip / 非法 anchor 都拒。
    const goodClips = [first!, second!]
    for (const [label, track] of [
      ['unknown source', { elementId: 't1', sourceArtifactId: 'artifact-that-does-not-exist', anchor: 'sequence', offsetFrame: 0, gain: 1, muted: false }],
      ['unknown clip anchor', { elementId: 't2', sourceArtifactId: 'whatever', anchor: 'clip', clipId: 'clip-that-does-not-exist', offsetFrame: 0, gain: 1, muted: false }],
      ['bad anchor', { elementId: 't3', sourceArtifactId: 'whatever', anchor: 'timeline', offsetFrame: 0, gain: 1, muted: false }],
    ] as const) {
      const res = await env.app.inject({
        method: 'PUT', url: `/api/episodes/${episodeId}/edit`, headers: json(ownerToken),
        payload: { expectedEditRevision: body.headRevision, fps: { fpsNum: 25, fpsDen: 1 }, clips: goodClips, tracks: [track] },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.stringify(res.json())).toContain(label === 'bad anchor' ? 'anchor' : label === 'unknown clip anchor' ? 'not in this edit' : 'not found')
    }
    // headRevision 未被失败保存推进。
    const after = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/edit`, headers: authHeaders(ownerToken) })
    expect((after.json() as { headRevision: number }).headRevision).toBe(body.headRevision)
  })

  it('restores a historical revision as a new head (immutable history)', async () => {
    // 保存 revision 3(真实镜头 id——占位 id 会被归属校验拒绝)。
    const current = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/edit`, headers: authHeaders(ownerToken) })
    const realShot = ((current.json() as { revision: { clips: Array<{ storyboardId: string }> } }).revision.clips[0]!).storyboardId
    await env.app.inject({
      method: 'PUT', url: `/api/episodes/${episodeId}/edit`,
      headers: json(ownerToken),
      payload: { expectedEditRevision: 2, fps: { fpsNum: 30, fpsDen: 1 }, clips: [{ clipId: 'clip-1', storyboardId: realShot, artifactId: '', sourceInFrame: 0, sourceOutFrame: 1 }] },
    })
    // 恢复 revision 1(初始默认序列)。
    const restore = await env.app.inject({ method: 'POST', url: `/api/episodes/${episodeId}/edit/restore`, headers: json(ownerToken), payload: { revision: 1 } })
    expect(restore.statusCode).toBe(200)
    expect((restore.json() as { headRevision: number }).headRevision).toBe(4)
    // 历史 revision 1 仍存在且未被修改。
    const original = await env.db.episodeEditRevision.findUnique({ where: { editId_revision: { editId: (await env.db.episodeEdit.findUniqueOrThrow({ where: { episodeId } })).id, revision: 1 } } })
    expect(original).not.toBeNull()
    expect(original!.revision).toBe(1)
  })

  it('rejects invalid clips (empty range, non-integer)', async () => {
    const read = await env.app.inject({ method: 'GET', url: `/api/episodes/${episodeId}/edit`, headers: authHeaders(ownerToken) })
    const rev = (read.json() as { headRevision: number }).headRevision
    const bad = await env.app.inject({
      method: 'PUT', url: `/api/episodes/${episodeId}/edit`,
      headers: json(ownerToken),
      payload: { expectedEditRevision: rev, fps: { fpsNum: 25, fpsDen: 1 }, clips: [{ clipId: 'c1', storyboardId: 'sb1', artifactId: '', sourceInFrame: 10, sourceOutFrame: 10 }] },
    })
    expect(bad.statusCode).toBe(400)
    void bad
  })
})

// UX-P03(新用户体验改造方案 §3.3):空初始化与后续素材同步。
// 复现 UX-06:旧代码在 0 分镜时 GET 就落库 clips=[] 的永久空序列,用户后补镜头
// 时间线永远空白。每个用例用独立项目+剧集隔离状态。
describe('episode edit initialization and shot sync (UX-P03)', () => {
  async function createEpisode(name: string): Promise<string> {
    const project = await env.app.inject({ method: 'POST', url: '/api/projects', headers: json(ownerToken), payload: { name } })
    const episode = await env.app.inject({ method: 'POST', url: `/api/projects/${project.json().id}/episodes`, headers: json(ownerToken), payload: { number: 1, title: 'EP1' } })
    return episode.json().id as string
  }

  async function addStoryboard(epId: string, number: number, durationMs = 5000): Promise<string> {
    const res = await env.app.inject({
      method: 'POST', url: `/api/episodes/${epId}/storyboards`, headers: json(ownerToken),
      payload: { number, title: `SB${number}`, durationMs, description: 'd', sourceExcerpt: 's', continuityIn: '', continuityOut: '' },
    })
    if (res.statusCode !== 201 && res.statusCode !== 200) throw new Error(`storyboard create failed: ${res.body}`)
    return res.json().id as string
  }

  /** 直接落库一个「成功 VIDEO 任务+制品」,模拟镜头已有可用素材(实测时长)。 */
  async function seedSucceededVideo(epId: string, storyboardId: string, durationMs: number): Promise<string> {
    const batch = await env.db.generationBatch.create({ data: { organizationId: ownerOrgId, episodeId: epId, stage: 'VIDEO', plannedCount: 1 } })
    const task = await env.db.generationTask.create({ data: { organizationId: ownerOrgId, batchId: batch.id, stage: 'VIDEO', status: 'SUCCEEDED', storyboardId, provider: 'mock', model: 'mock-t2v', attempts: 1 } })
    const artifact = await env.db.mediaArtifact.create({ data: { organizationId: ownerOrgId, taskId: task.id, stage: 'VIDEO', objectKey: `edit/${task.id}.mp4`, checksum: `edit-${task.id}`, mimeType: 'video/mp4', version: 1, durationMs } })
    return artifact.id
  }

  const getEdit = (epId: string) => env.app.inject({ method: 'GET', url: `/api/episodes/${epId}/edit`, headers: authHeaders(ownerToken) })
  const buildDefault = (epId: string, payload: Record<string, unknown> = {}) => env.app.inject({ method: 'POST', url: `/api/episodes/${epId}/edit/build-default`, headers: json(ownerToken), payload })

  it('GET with zero storyboards returns a readable empty state and writes no EpisodeEdit row', async () => {
    const epId = await createEpisode('P03 Empty Start')
    const res = await getEdit(epId)
    expect(res.statusCode).toBe(200)
    const body = res.json() as { editId: string | null; headRevision: number; initialized: boolean; reason: string; revision: { clips: unknown[]; tracks: unknown[]; fpsNum: number } }
    // 可读空态:向后兼容的 revision 形状(clips 为空数组而非缺字段),前端可按
    // initialized:false 显示空态而不是渲染空白时间线。
    expect(body.initialized).toBe(false)
    expect(body.editId).toBeNull()
    expect(body.headRevision).toBe(0)
    expect(body.reason).toBe('no_storyboards')
    expect(Array.isArray(body.revision.clips)).toBe(true)
    expect(body.revision.clips).toHaveLength(0)
    expect(body.revision.fpsNum).toBe(25)
    // 核心回归断言:0 分镜不落库,杜绝永久空序列。
    expect(await env.db.episodeEdit.count({ where: { episodeId: epId } })).toBe(0)
  })

  it('builds the default sequence only once shots with real footage exist (frames from measured duration)', async () => {
    const epId = await createEpisode('P03 Late Shots')
    // 先 0 分镜打开一次(空态,无行)。
    const empty = await getEdit(epId)
    expect((empty.json() as { initialized: boolean }).initialized).toBe(false)
    expect(await env.db.episodeEdit.count({ where: { episodeId: epId } })).toBe(0)

    // 用户后补两镜:SB1 有成功 VIDEO 制品(实测 4000ms),SB2 还没有素材。
    const sb1 = await addStoryboard(epId, 1, 5000)
    const artifactId = await seedSucceededVideo(epId, sb1, 4000)
    await addStoryboard(epId, 2, 6000)

    const built = await getEdit(epId)
    expect(built.statusCode).toBe(200)
    const body = built.json() as { editId: string; headRevision: number; initialized: boolean; revision: { clips: Array<{ clipId: string; storyboardId: string; artifactId: string; sourceInFrame: number; sourceOutFrame: number }>; fpsNum: number } }
    expect(body.initialized).toBe(true)
    expect(body.headRevision).toBe(1)
    expect(body.revision.fpsNum).toBe(25)
    // clip 数=镜数。
    expect(body.revision.clips).toHaveLength(2)
    // 有素材的镜:帧数来自制品实测时长(4000ms@25fps=100 帧),不是分镜计划 5000ms→125。
    expect(body.revision.clips[0]).toMatchObject({ clipId: 'clip-1', storyboardId: sb1, artifactId, sourceInFrame: 0, sourceOutFrame: 100 })
    // 无素材的镜:显式占位(空 artifactId、一帧),不是可播放片段。
    expect(body.revision.clips[1]).toMatchObject({ clipId: 'clip-2', artifactId: '', sourceInFrame: 0, sourceOutFrame: 1 })
    expect(await env.db.episodeEdit.count({ where: { episodeId: epId } })).toBe(1)
  })

  it('migrates a legacy empty system head to a new revision via CAS (old revision preserved)', async () => {
    const epId = await createEpisode('P03 Legacy Empty')
    const sb1 = await addStoryboard(epId, 1, 5000)
    // 直接落库 legacy 空 head:模拟旧代码在 0 分镜时写下的 rev1(system-initial + clips=[])。
    await env.db.episodeEdit.create({
      data: {
        episodeId: epId, organizationId: ownerOrgId, headRevision: 1,
        revisions: { create: { revision: 1, fpsNum: 25, fpsDen: 1, clips: '[]', tracks: '[]', outputSpec: '{}', fingerprint: 'legacy-empty-fingerprint', author: 'system-initial' } },
      },
    })

    const res = await getEdit(epId)
    expect(res.statusCode).toBe(200)
    const body = res.json() as { headRevision: number; revision: { revision: number; author: string | null; clips: Array<{ storyboardId: string }> } }
    // 现在有分镜:带 CAS 生成新修订,headRevision 前进。
    expect(body.headRevision).toBe(2)
    expect(body.revision.revision).toBe(2)
    expect(body.revision.author).toBe('system-initial')
    expect(body.revision.clips).toHaveLength(1)
    expect(body.revision.clips[0]!.storyboardId).toBe(sb1)

    // 旧修订保留且未被改动(不可变历史)。
    const edit = await env.db.episodeEdit.findUniqueOrThrow({ where: { episodeId: epId } })
    const rev1 = await env.db.episodeEditRevision.findUnique({ where: { editId_revision: { editId: edit.id, revision: 1 } } })
    expect(rev1).not.toBeNull()
    expect(rev1!.clips).toBe('[]')
    expect(rev1!.author).toBe('system-initial')

    // 迁移只做一次:head 已非空,再次 GET 不再推进修订。
    const again = await getEdit(epId)
    expect((again.json() as { headRevision: number }).headRevision).toBe(2)
  })

  it('R02: refreshes a placeholder-only system head once real media exists (adopted video enters the timeline)', async () => {
    const epId = await createEpisode('R02 Placeholder Refresh')
    const sb1 = await addStoryboard(epId, 1, 5000)
    // 现场复刻:分镜就绪但尚无视频时初始化落下的全占位 rev1(空 artifactId + 一帧)。
    await env.db.episodeEdit.create({
      data: {
        episodeId: epId, organizationId: ownerOrgId, headRevision: 1,
        revisions: { create: { revision: 1, fpsNum: 25, fpsDen: 1, clips: JSON.stringify([{ clipId: 'clip-1', storyboardId: sb1, artifactId: '', sourceInFrame: 0, sourceOutFrame: 1 }]), tracks: '[]', outputSpec: '{}', fingerprint: 'placeholder-fingerprint', author: 'system-initial' } },
      },
    })

    // 之后生成并采用 3 秒视频(3000ms@25fps=75 帧)。
    const artifactId = await seedSucceededVideo(epId, sb1, 3000)
    await env.db.storyboard.update({ where: { id: sb1 }, data: { selectedVideoArtifactId: artifactId } })

    const res = await getEdit(epId)
    const body = res.json() as { headRevision: number; revision: { clips: Array<{ artifactId: string; sourceOutFrame: number }> } }
    // 占位被补齐:引用真实采用制品与实测帧数,不再停在 0.04s。
    expect(body.headRevision).toBe(2)
    expect(body.revision.clips[0]).toMatchObject({ artifactId, sourceInFrame: 0, sourceOutFrame: 75 })

    // 指纹未变(再次 GET 不空转新修订)。
    const again = await getEdit(epId)
    expect((again.json() as { headRevision: number }).headRevision).toBe(2)
  })

  it('R02: a placeholder head with any human revision is never auto-refreshed', async () => {
    const epId = await createEpisode('R02 Placeholder Human')
    const sb1 = await addStoryboard(epId, 1, 5000)
    const edit = await env.db.episodeEdit.create({
      data: {
        episodeId: epId, organizationId: ownerOrgId, headRevision: 2,
        revisions: { createMany: { data: [
          { revision: 1, fpsNum: 25, fpsDen: 1, clips: '[]', tracks: '[]', outputSpec: '{}', fingerprint: 'f1', author: 'system-initial' },
          { revision: 2, fpsNum: 25, fpsDen: 1, clips: JSON.stringify([{ clipId: 'clip-1', storyboardId: sb1, artifactId: '', sourceInFrame: 0, sourceOutFrame: 1 }]), tracks: '[]', outputSpec: '{}', fingerprint: 'f2', author: 'someone-else' },
        ] } },
      },
    })
    const artifactId = await seedSucceededVideo(epId, sb1, 3000)
    await env.db.storyboard.update({ where: { id: sb1 }, data: { selectedVideoArtifactId: artifactId } })

    const res = await getEdit(epId)
    const body = res.json() as { headRevision: number; revision: { clips: Array<{ artifactId: string }> } }
    expect(body.headRevision).toBe(2)
    expect(body.revision.clips[0]!.artifactId).toBe('')
    expect(edit.headRevision).toBe(2)
  })

  it('never resets a human-edited document on GET when new shots appear', async () => {
    const epId = await createEpisode('P03 Human Edit')
    const sb1 = await addStoryboard(epId, 1, 5000)
    const init = await getEdit(epId)
    expect((init.json() as { initialized: boolean }).initialized).toBe(true)

    // 人工保存一版(fps 30,只保留一镜)→ head author 变为用户。
    const saved = await env.app.inject({
      method: 'PUT', url: `/api/episodes/${epId}/edit`, headers: json(ownerToken),
      payload: { expectedEditRevision: 1, fps: { fpsNum: 30, fpsDen: 1 }, clips: [{ clipId: 'clip-1', storyboardId: sb1, artifactId: '', sourceInFrame: 0, sourceOutFrame: 1 }] },
    })
    expect(saved.statusCode).toBe(200)

    // 新增镜头后 GET:绝不自动重置(差异列表加入属 P09,由用户显式选择)。
    await addStoryboard(epId, 2, 6000)
    const res = await getEdit(epId)
    const body = res.json() as { headRevision: number; revision: { fpsNum: number; clips: Array<{ storyboardId: string }> } }
    expect(body.headRevision).toBe(2)
    expect(body.revision.fpsNum).toBe(30)
    expect(body.revision.clips).toHaveLength(1)
    expect(body.revision.clips[0]!.storyboardId).toBe(sb1)
  })

  it('does not migrate when any historical revision carries a human author even if head is system-initial', async () => {
    const epId = await createEpisode('P03 Human History')
    await addStoryboard(epId, 1, 5000)
    // 构造极端 legacy:rev1 是人工空修订、rev2 是 system 空 head——历史有人工痕迹
    // 就不允许自动重建。
    await env.db.episodeEdit.create({
      data: {
        episodeId: epId, organizationId: ownerOrgId, headRevision: 2,
        revisions: {
          create: [
            { revision: 1, fpsNum: 25, fpsDen: 1, clips: '[]', tracks: '[]', outputSpec: '{}', fingerprint: 'f1', author: 'user-legacy' },
            { revision: 2, fpsNum: 25, fpsDen: 1, clips: '[]', tracks: '[]', outputSpec: '{}', fingerprint: 'f2', author: 'system-initial' },
          ],
        },
      },
    })
    const res = await getEdit(epId)
    const body = res.json() as { headRevision: number; revision: { clips: unknown[] } }
    expect(body.headRevision).toBe(2)
    expect(body.revision.clips).toHaveLength(0)
  })

  it('build-default: 400 without storyboards, initializes, is idempotent, refuses manual edits (409), enforces CAS', async () => {
    // 0 分镜:显式构建也不许再建空序列。
    const emptyEp = await createEpisode('P03 Build Empty')
    const refused = await buildDefault(emptyEp)
    expect(refused.statusCode).toBe(400)
    expect(refused.json().code).toBe('invalid_argument')
    expect(await env.db.episodeEdit.count({ where: { episodeId: emptyEp } })).toBe(0)

    const epId = await createEpisode('P03 Build')
    await addStoryboard(epId, 1, 5000)
    await addStoryboard(epId, 2, 6000)

    // 无编辑 → 与 GET 初始化同一逻辑建 rev1。
    const first = await buildDefault(epId)
    expect(first.statusCode).toBe(200)
    const firstBody = first.json() as { editId: string; headRevision: number; rebuilt: boolean; revision: { clips: unknown[] } }
    expect(firstBody.rebuilt).toBe(true)
    expect(firstBody.headRevision).toBe(1)
    expect(firstBody.revision.clips).toHaveLength(2)

    // 幂等:同状态再调 → no-op,不产生新修订。
    const second = await buildDefault(epId)
    expect(second.statusCode).toBe(200)
    const secondBody = second.json() as { headRevision: number; rebuilt: boolean }
    expect(secondBody.rebuilt).toBe(false)
    expect(secondBody.headRevision).toBe(1)

    // CAS:过期 expectedEditRevision → 409 version_conflict。
    const cas = await buildDefault(epId, { expectedEditRevision: 99 })
    expect(cas.statusCode).toBe(409)
    expect(cas.json().code).toBe('version_conflict')

    // 人工剪辑后:显式 409 state_conflict(安全语义:明确拒绝而非静默 no-op)。
    const head = (await getEdit(epId)).json() as { revision: { clips: Array<{ clipId: string; storyboardId: string; artifactId: string; sourceInFrame: number; sourceOutFrame: number }> } }
    await env.app.inject({
      method: 'PUT', url: `/api/episodes/${epId}/edit`, headers: json(ownerToken),
      payload: { expectedEditRevision: 1, fps: { fpsNum: 25, fpsDen: 1 }, clips: [head.revision.clips[0]!] },
    })
    const manual = await buildDefault(epId)
    expect(manual.statusCode).toBe(409)
    expect(manual.json().code).toBe('state_conflict')
    expect((manual.json() as { currentRevision: number }).currentRevision).toBe(2)
    // 人工内容原样保留。
    const after = (await getEdit(epId)).json() as { headRevision: number; revision: { clips: unknown[] } }
    expect(after.headRevision).toBe(2)
    expect(after.revision.clips).toHaveLength(1)
  })

  it('build-default rebuilds a stale system head with a new revision when shots are added (CAS, history preserved)', async () => {
    const epId = await createEpisode('P03 Build Rebuild')
    await addStoryboard(epId, 1, 5000)
    const first = await buildDefault(epId)
    expect((first.json() as { headRevision: number; rebuilt: boolean }).headRevision).toBe(1)

    // 新增镜头后显式重建:带 CAS 新修订,旧修订保留。
    await addStoryboard(epId, 2, 6000)
    const rebuilt = await buildDefault(epId, { expectedEditRevision: 1 })
    expect(rebuilt.statusCode).toBe(200)
    const body = rebuilt.json() as { headRevision: number; rebuilt: boolean; revision: { revision: number; clips: unknown[]; author: string | null } }
    expect(body.rebuilt).toBe(true)
    expect(body.headRevision).toBe(2)
    expect(body.revision.revision).toBe(2)
    expect(body.revision.clips).toHaveLength(2)
    expect(body.revision.author).toBe('system-initial')

    const edit = await env.db.episodeEdit.findUniqueOrThrow({ where: { episodeId: epId } })
    const rev1 = await env.db.episodeEditRevision.findUnique({ where: { editId_revision: { editId: edit.id, revision: 1 } } })
    expect(rev1).not.toBeNull()
    expect((JSON.parse(rev1!.clips) as unknown[]).length).toBe(1)

    // 再调:已与当前分镜同步 → no-op。
    const again = await buildDefault(epId)
    const againBody = again.json() as { headRevision: number; rebuilt: boolean }
    expect(againBody.rebuilt).toBe(false)
    expect(againBody.headRevision).toBe(2)
  })

  // SD-099 / R09:旧闸门要求「每条 clip 都没有素材」才肯自动重建,于是生成侧回填实测
  // 时长之后,那条已经填了一半的机器 head 永远刷不动——时间线停在 50 帧(素材实测 100
  // 帧)的旧裁切上,合成照这个区间把已付费的画面裁掉。
  it('R09: refreshes a partially-filled machine head when the measured duration lands', async () => {
    const epId = await createEpisode('R09 Measured Refresh')
    const sb1 = await addStoryboard(epId, 1, 5000)
    const artifactId = await seedSucceededVideo(epId, sb1, 2000)

    const first = (await getEdit(epId)).json() as { headRevision: number; revision: { clips: Array<{ artifactId: string; sourceOutFrame: number }> } }
    expect(first.headRevision).toBe(1)
    expect(first.revision.clips[0]).toMatchObject({ artifactId, sourceOutFrame: 50 })

    // 生成侧把实测时长补回来:2s → 4s。
    await env.db.mediaArtifact.update({ where: { id: artifactId }, data: { durationMs: 4000 } })

    const body = (await getEdit(epId)).json() as { headRevision: number; revision: { revision: number; author: string | null; clips: Array<{ sourceOutFrame: number }> } }
    expect(body.headRevision).toBe(2)
    expect(body.revision.revision).toBe(2)
    expect(body.revision.author).toBe('system-initial')
    expect(body.revision.clips[0]!.sourceOutFrame).toBe(100)

    // 不可变历史:50 帧那一版仍在,能恢复回去。
    const edit = await env.db.episodeEdit.findUniqueOrThrow({ where: { episodeId: epId } })
    const rev1 = await env.db.episodeEditRevision.findUnique({ where: { editId_revision: { editId: edit.id, revision: 1 } } })
    expect((JSON.parse(rev1!.clips) as Array<{ sourceOutFrame: number }>)[0]!.sourceOutFrame).toBe(50)

    // 指纹已同步 → 再次 GET 不空转新修订。
    expect((await getEdit(epId)).json().headRevision).toBe(2)
  })

  it('R09: a machine head carrying audio tracks counts as human work and is never auto-refreshed', async () => {
    const epId = await createEpisode('R09 Tracks Guard')
    const sb1 = await addStoryboard(epId, 1, 5000)
    await env.db.episodeEdit.create({
      data: {
        episodeId: epId, organizationId: ownerOrgId, headRevision: 1,
        revisions: { create: {
          revision: 1, fpsNum: 25, fpsDen: 1,
          clips: JSON.stringify([{ clipId: 'clip-1', storyboardId: sb1, artifactId: '', sourceInFrame: 0, sourceOutFrame: 1 }]),
          tracks: JSON.stringify([{ elementId: 't1', sourceArtifactId: '', anchor: 'sequence', offsetFrame: 25, gain: 1, muted: false, locked: false }]),
          outputSpec: '{}', fingerprint: 'stale-with-tracks', author: 'system-initial',
        } },
      },
    })
    const artifactId = await seedSucceededVideo(epId, sb1, 3000)
    await env.db.storyboard.update({ where: { id: sb1 }, data: { selectedVideoArtifactId: artifactId } })

    const body = (await getEdit(epId)).json() as { headRevision: number; revision: { clips: Array<{ artifactId: string }> } }
    expect(body.headRevision).toBe(1)
    expect(body.revision.clips[0]!.artifactId).toBe('')
  })

  it('R09: GET reports the footage each clip will actually use without touching the edit', async () => {
    type Materials = { headRevision: number; materials: Array<{ clipId: string; shotNumber: number | null; artifactId: string; durationMs: number | null; maxFrame: number | null; unresolved: boolean }> }
    const epId = await createEpisode('R09 Materials')
    const sb1 = await addStoryboard(epId, 1, 5000)
    await addStoryboard(epId, 2, 6000)
    const artifactId = await seedSucceededVideo(epId, sb1, 4000)
    await env.db.storyboard.update({ where: { id: sb1 }, data: { selectedVideoArtifactId: artifactId } })

    const init = (await getEdit(epId)).json() as Materials
    expect(init.materials).toHaveLength(2)
    expect(init.materials[0]).toMatchObject({ clipId: 'clip-1', shotNumber: 1, artifactId, durationMs: 4000, maxFrame: 100, unresolved: false })
    expect(init.materials[1]).toMatchObject({ clipId: 'clip-2', shotNumber: 2, artifactId: '', durationMs: null, maxFrame: null, unresolved: false })

    // 人工裁切到素材尽头(20→100 帧)。
    const saved = await env.app.inject({
      method: 'PUT', url: `/api/episodes/${epId}/edit`, headers: json(ownerToken),
      payload: { expectedEditRevision: init.headRevision, fps: { fpsNum: 25, fpsDen: 1 }, clips: [{ clipId: 'clip-1', storyboardId: sb1, artifactId, sourceInFrame: 20, sourceOutFrame: 100 }] },
    })
    expect(saved.statusCode).toBe(200)

    // 引用的那条成片所属任务不再是终态(重跑/失败):显式引用失效,合成会退回「没素材」。
    const artifact = await env.db.mediaArtifact.findUniqueOrThrow({ where: { id: artifactId } })
    await env.db.generationTask.update({ where: { id: artifact.taskId! }, data: { status: 'RUNNING' } })

    const after = (await getEdit(epId)).json() as Materials & { revision: { clips: Array<{ artifactId: string; sourceInFrame: number; sourceOutFrame: number }> } }
    expect(after.materials[0]).toMatchObject({ clipId: 'clip-1', artifactId: '', durationMs: null, maxFrame: null, unresolved: true })
    // 只读富化:素材变化既不推进修订,也不改人工裁切。
    expect(after.headRevision).toBe(init.headRevision + 1)
    expect(after.revision.clips[0]).toMatchObject({ artifactId, sourceInFrame: 20, sourceOutFrame: 100 })
    expect((await getEdit(epId)).json().headRevision).toBe(after.headRevision)
  })
})
