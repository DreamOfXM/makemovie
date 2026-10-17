import type { PrismaClient } from '@studio/db'
import { recordAudit } from './audit.js'

/**
 * US-008 示例项目的安装与复制。
 *
 * 安装(installExampleProject):把 fixtures 里的示例定义写成组织内一个 isExample
 * 项目——预生成素材经存储后落 MediaArtifact,带来源说明。幂等:同 slug 已在则跳过。
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
    sourceNote: '示例项目:分发包自带的演示素材,可播放、可复制为私人项目练习;复制后再生成需要连接真实模型。',
    shots: [
      { title: '巷口', description: '雨夜的窄巷,纸扎铺的暖灯是唯一光源。', durationMs: 8000 },
      { title: '订单', description: '关师傅展开订单,纸上是他自己的名字。', durationMs: 6000 },
      { title: '回眸', description: '他抬头望向柜台深处的纸人,纸人似乎动了。', durationMs: 5000 },
    ],
  },
]

export async function installExampleProject(db: PrismaClient, organizationId: string, fixture: ExampleFixture): Promise<{ projectId: string; installed: boolean }> {
  const existing = await db.project.findFirst({ where: { organizationId, isExample: true, name: fixture.projectName } })
  if (existing) return { projectId: existing.id, installed: false }

  const project = await db.$transaction(async tx => {
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
        }
      })
    }
    return created
  })
  return { projectId: project.id, installed: true }
}

export async function cloneExampleProject(db: PrismaClient, exampleProjectId: string, targetOrganizationId: string, actorUserId: string | null): Promise<{ projectId: string }> {
  const source = await db.project.findFirst({
    where: { id: exampleProjectId, isExample: true },
    include: { episodes: { include: { storyboards: { where: { supersededAt: null } }, sourceVersions: true } } },
  })
  if (!source) throw new Error('example project not found')

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
      for (const shot of episode.storyboards) {
        await tx.storyboard.create({
          data: {
            episodeId: episodeClone.id, number: shot.number, title: shot.title, description: shot.description,
            durationMs: shot.durationMs, sourceExcerpt: shot.sourceExcerpt, continuityIn: shot.continuityIn, continuityOut: shot.continuityOut,
          },
        })
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
