import type { PrismaClient } from '@studio/db'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildObjectKey, synthesizeMockMedia, type Storage } from '@studio/media'
import { recordAudit } from './audit.js'

/**
 * US-008 示例项目的安装与复制。
 *
 * 安装(installExampleProject):把 fixtures 里的示例定义写成组织内一个 isExample
 * 项目——V09:每镜同步生成可播放的演示视频(本机 ffmpeg 构造,不花任何模型钱),
 * 挂在真实 SUCCEEDED 任务链下并钦定为该镜成片:零 key 安装即可播放、可合成、
 * 可交付。幂等:同 slug 已在则跳过。
 * 复制(cloneExampleProject):在目标组织建一份独立副本——新项目、新剧集行、
 * 素材制品改写 organizationId(内容字节共享,元数据独立),isExample=false:
 * 复制品就是用户的私人项目,随便改;原示例永远只读。
 */
export interface ExampleFixtureShot {
  title: string
  description: string
  durationMs: number
  /** 预生成素材的对象键(随分发包/演示环境提供);缺键的镜留占位,不伪造。 */
  artifactObjectKey?: string
  artifactMime?: string
}

export interface ExampleFixture {
  slug: string
  projectName: string
  episodeTitle: string
  storyText: string
  recipeKey: string
  sourceNote: string
  shots: ExampleFixtureShot[]
}

export const EXAMPLE_FIXTURES: readonly ExampleFixture[] = [
  {
    slug: 'example-paper-figure',
    projectName: '示例 · 纸人开眼(第 1 集)',
    episodeTitle: '第 1 集 · 雨夜订单',
    storyText: '深夜的老城,纸扎铺的灯还亮着。一个雨夜,关师傅收到的订单上,写着他自己的名字。',
    recipeKey: 'drama-serial',
    sourceNote: '示例项目:分发包自带的演示素材(本机 ffmpeg 构造的演示画面,可播放、可复制为私人项目练习);复制后再生成需要连接真实模型。',
    shots: [
      { title: '巷口', description: '雨夜的窄巷,纸扎铺的暖灯是唯一光源。', durationMs: 8000 },
      { title: '订单', description: '关师傅展开订单,纸上是他自己的名字。', durationMs: 6000 },
      { title: '回眸', description: '他抬头望向柜台深处的纸人,纸人似乎动了。', durationMs: 5000 },
    ],
  },
]

/**
 * V09:示例媒体的本机构造——不用任何模型连接,安装即可播放。挂在真实
 * SUCCEEDED 任务链下而非裸制品行:选版/延长/合成对「任务产物」的信任条件
 * 原样成立,示例项目走的全是生产路径,不是只读的摆设。
 */
async function synthesizeExampleMedia(
  db: PrismaClient,
  storage: Storage,
  organizationId: string,
  projectId: string,
  episodeId: string,
  batchId: string,
  storyboardId: string,
  shot: ExampleFixtureShot,
): Promise<string> {
  const taskId = (
    await db.generationTask.create({
      data: {
        organizationId,
        batchId,
        stage: 'VIDEO',
        status: 'SUCCEEDED',
        storyboardId,
        provider: 'example-bundle',
        model: 'example-clip',
        requestSnapshot: JSON.stringify({ model: 'example-clip', input: { prompt: shot.description }, parameters: {} }),
        responseSnapshot: JSON.stringify({ attempt: 1, candidate: { provider: 'example-bundle', model: 'example-clip' }, example: true }),
      },
    })
  ).id
  const workdir = await mkdtemp(path.join(os.tmpdir(), 'studio-example-'))
  try {
    const target = path.join(workdir, 'clip.mp4')
    const media = await synthesizeMockMedia('t2v', target, { durationMs: shot.durationMs })
    const objectKey = buildObjectKey({ tenantId: organizationId, projectId, episodeId, stage: 'VIDEO', entityId: taskId, version: 1, extension: 'mp4' })
    const stored = await storage.put(objectKey, new Uint8Array(await (await import('node:fs/promises')).readFile(target)), 'video/mp4')
    const artifact = await db.mediaArtifact.create({
      data: {
        organizationId,
        taskId,
        stage: 'VIDEO',
        objectKey: stored.key,
        checksum: stored.checksum,
        mimeType: 'video/mp4',
        version: 1,
        width: media.width,
        height: media.height,
        durationMs: media.durationMs,
        metadata: JSON.stringify({ example: true, source: 'local ffmpeg demo clip — no model spend' }),
      },
    })
    return artifact.id
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

export async function installExampleProject(
  db: PrismaClient,
  storage: Storage,
  organizationId: string,
  fixture: ExampleFixture,
): Promise<{ projectId: string; installed: boolean }> {
  const existing = await db.project.findFirst({ where: { organizationId, isExample: true, name: fixture.projectName } })

  const project = existing ?? await db.$transaction(async tx => {
    const created = await tx.project.create({
      data: { organizationId, name: fixture.projectName, isExample: true, exampleSourceNote: fixture.sourceNote },
    })
    const episode = await tx.episode.create({ data: { projectId: created.id, number: 1, title: fixture.episodeTitle } })
    await tx.sourceDocumentVersion.create({
      data: { episodeId: episode.id, version: 1, content: fixture.storyText, checksum: Buffer.from(fixture.storyText).toString('hex').slice(0, 64), status: 'APPROVED' },
    })
    for (const [index, shot] of fixture.shots.entries()) {
      await tx.storyboard.create({
        data: {
          episodeId: episode.id, number: index + 1, title: shot.title,
          description: shot.description, durationMs: shot.durationMs, sourceExcerpt: '', continuityIn: '', continuityOut: '',
        },
      })
    }
    return created
  })

  // V09:媒体生成在事务外(storage.put 不可回滚);任务行创建即 SUCCEEDED,
  // 失败中断只会留下「示例缺媒体」的可见现状,重装幂等由上面的 existing 检查兜底。
  const episode = await db.episode.findFirstOrThrow({ where: { projectId: project.id }, orderBy: { number: 'asc' } })
  const shots = await db.storyboard.findMany({ where: { episodeId: episode.id }, orderBy: { number: 'asc' } })
  const batch = await db.generationBatch.create({
    data: { organizationId, episodeId: episode.id, stage: 'VIDEO', status: 'COMPLETED', plannedCount: shots.length },
  })
  for (const [index, shotRow] of shots.entries()) {
    if (shotRow.selectedVideoArtifactId) {
      const artifact = await db.mediaArtifact.findFirst({ where: { id: shotRow.selectedVideoArtifactId, organizationId }, select: { objectKey: true } })
      if (artifact) {
        const opened = await storage.open(artifact.objectKey)
        if (opened) { opened.body.destroy(); continue }
      }
    }
    const fixtureShot = fixture.shots[index]!
    const artifactId = await synthesizeExampleMedia(db, storage, organizationId, project.id, episode.id, batch.id, shotRow.id, fixtureShot)
    await db.storyboard.update({ where: { id: shotRow.id }, data: { selectedVideoArtifactId: artifactId } })
  }
  return { projectId: project.id, installed: existing === null }
}

export async function cloneExampleProject(db: PrismaClient, exampleProjectId: string, targetOrganizationId: string, actorUserId: string | null): Promise<{ projectId: string }> {
  const source = await db.project.findFirst({
    where: { id: exampleProjectId, isExample: true },
    include: {
      episodes: {
        include: { storyboards: { where: { supersededAt: null } }, sourceVersions: true },
      },
    },
  })
  if (!source) throw new Error('example project not found')
  // V09:示例的每镜钦定制品一并解析(字节共享,行独立)。
  const selectedIds = source.episodes
    .flatMap(episode => episode.storyboards.map(shot => shot.selectedVideoArtifactId))
    .filter((id): id is string => id !== null)
  const artifactById = new Map(
    (await db.mediaArtifact.findMany({ where: { id: { in: selectedIds } } })).map(artifact => [artifact.id, artifact]),
  )
  // (objectKey, version) 全局唯一:同一示例被多个组织复制时,同一 objectKey 的版本
  // 逐次 +1,字节共享且不撞唯一键。
  const versionByObjectKey = new Map<string, number>()

  const clone = await db.$transaction(async tx => {
    const created = await tx.project.create({
      data: {
        organizationId: targetOrganizationId,
        name: source.name.replace(/^示例 · /, '练习 · '),
        recipeKey: source.recipeKey, recipeVersion: source.recipeVersion, recipeSnapshot: source.recipeSnapshot,
        isExample: false,
      },
    })
    for (const episode of source.episodes) {
      const episodeClone = await tx.episode.create({ data: { projectId: created.id, number: episode.number, title: episode.title } })
      for (const version of episode.sourceVersions) {
        await tx.sourceDocumentVersion.create({
          data: { episodeId: episodeClone.id, version: version.version, content: version.content, checksum: version.checksum, status: version.status },
        })
      }
      const videoShots = episode.storyboards.filter(shot => shot.selectedVideoArtifactId && artifactById.has(shot.selectedVideoArtifactId))
      let batchId: string | null = null
      if (videoShots.length > 0) {
        batchId = (await tx.generationBatch.create({
          data: { organizationId: targetOrganizationId, episodeId: episodeClone.id, stage: 'VIDEO', status: 'COMPLETED', plannedCount: videoShots.length },
        })).id
      }
      for (const shot of episode.storyboards) {
        const shotClone = await tx.storyboard.create({
          data: {
            episodeId: episodeClone.id, number: shot.number, title: shot.title, description: shot.description,
            durationMs: shot.durationMs, sourceExcerpt: shot.sourceExcerpt, continuityIn: shot.continuityIn, continuityOut: shot.continuityOut,
          },
        })
        const video = shot.selectedVideoArtifactId ? artifactById.get(shot.selectedVideoArtifactId) : undefined
        if (video && batchId) {
          const taskId = (
            await tx.generationTask.create({
              data: {
                organizationId: targetOrganizationId,
                batchId,
                stage: 'VIDEO',
                status: 'SUCCEEDED',
                storyboardId: shotClone.id,
                provider: 'example-bundle',
                model: 'example-clip',
                requestSnapshot: JSON.stringify({ model: 'example-clip', input: { prompt: shot.description }, parameters: {} }),
                responseSnapshot: JSON.stringify({ attempt: 1, candidate: { provider: 'example-bundle', model: 'example-clip' }, example: true, clonedFrom: video.id }),
              },
            })
          ).id
          const nextVersion = (versionByObjectKey.get(video.objectKey)
            ?? ((await tx.mediaArtifact.aggregate({ _max: { version: true }, where: { objectKey: video.objectKey } }))._max.version ?? 0)) + 1
          versionByObjectKey.set(video.objectKey, nextVersion)
          const artifactId = (
            await tx.mediaArtifact.create({
              data: {
                organizationId: targetOrganizationId,
                taskId,
                stage: 'VIDEO',
                objectKey: video.objectKey,
                checksum: video.checksum,
                mimeType: video.mimeType,
                version: nextVersion,
                width: video.width,
                height: video.height,
                durationMs: video.durationMs,
                metadata: JSON.stringify({ example: true, source: 'cloned from example project', clonedFrom: video.id }),
              },
            })
          ).id
          await tx.storyboard.update({ where: { id: shotClone.id }, data: { selectedVideoArtifactId: artifactId } })
        }
      }
    }
    return created
  })
  await recordAudit(db, {
    organizationId: targetOrganizationId, userId: actorUserId,
    action: 'project.cloneExample', entityType: 'Project', entityId: clone.id,
    payload: { exampleProjectId },
  })
  return { projectId: clone.id }
}
