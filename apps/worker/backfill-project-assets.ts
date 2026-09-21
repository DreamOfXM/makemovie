// 一次性回填:把已存在的集级素材链接到项目级全局资产库(角色中台地基)。
import { PrismaClient } from '@studio/db'

const db = new PrismaClient()

function normalize(name: string): string {
  return name.replace(/（[^）]*）|\([^)]*\)/g, '').trim()
}

async function main() {
  const assets = await db.asset.findMany({
    where: { projectAssetId: null },
    include: { episode: { select: { projectId: true } }, versions: true },
  })
  const cache = new Map<string, string>()
  let linked = 0
  let libraryCreated = 0
  let versionsMirrored = 0

  for (const asset of assets) {
    const projectId = asset.episode.projectId
    const norm = normalize(asset.name)
    const cacheKey = `${projectId}:${asset.kind}:${norm}`
    let paId = cache.get(cacheKey) ?? null
    if (!paId) {
      const candidates = await db.projectAsset.findMany({ where: { projectId, kind: asset.kind } })
      const match =
        candidates.find(candidate => candidate.name === asset.name) ??
        candidates.find(candidate => norm !== '' && normalize(candidate.name) === norm)
      if (match) {
        paId = match.id
      } else {
        const created = await db.projectAsset.create({
          data: {
            projectId,
            kind: asset.kind,
            name: asset.name,
            description: asset.description,
            status: 'DRAFT',
            generationTaskId: asset.generationTaskId,
          },
        })
        paId = created.id
        libraryCreated++
      }
      cache.set(cacheKey, paId)
    }
    await db.asset.update({ where: { id: asset.id }, data: { projectAssetId: paId } })
    linked++

    for (const v of [...asset.versions].sort((a, b) => a.version - b.version)) {
      if (!v.artifactId) continue
      const libLatest = await db.projectAssetVersion.findFirst({
        where: { projectAssetId: paId },
        orderBy: { version: 'desc' },
      })
      await db.projectAssetVersion.create({
        data: {
          projectAssetId: paId,
          version: (libLatest?.version ?? 0) + 1,
          description: v.description,
          promptSnapshot: v.promptSnapshot,
          artifactId: v.artifactId,
          status: v.status,
        },
      })
      versionsMirrored++
    }
  }

  console.log({ assetsProcessed: assets.length, linked, libraryCreated, versionsMirrored })
  await db.$disconnect()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
