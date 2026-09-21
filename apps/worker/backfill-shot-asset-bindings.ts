// 一次性回填:按"镜头文本提到素材名"为存量分镜建立镜头-素材绑定。
// 背景与 worker/src/content.ts 的 bindShotsToAssets 相同——分镜 AI 的输出
// 没有镜头级素材关联,存量镜头全部零绑定,首帧的一致性无从谈起。
import { PrismaClient } from '@studio/db'

const db = new PrismaClient()

function normalize(name: string): string {
  return name.replace(/（[^）]*）|\([^)]*\)/g, '').trim()
}

async function main() {
  const shots = await db.storyboard.findMany({
    where: { supersededAt: null },
    select: { id: true, title: true, description: true, dialogue: true, speaker: true, episodeId: true },
  })
  const assets = await db.asset.findMany({ select: { id: true, name: true, kind: true, episodeId: true } })
  let created = 0
  let skipped = 0

  for (const shot of shots) {
    const text = `${shot.title} ${shot.description} ${shot.dialogue} ${shot.speaker ?? ""}`
    for (const asset of assets.filter(item => item.episodeId === shot.episodeId)) {
      const name = normalize(asset.name).trim()
      if (name.length < 2 || !text.includes(name)) continue
      const exists = await db.storyboardAsset.findUnique({
        where: { storyboardId_assetId: { storyboardId: shot.id, assetId: asset.id } },
      })
      if (exists) {
        skipped += 1
        continue
      }
      await db.storyboardAsset.create({ data: { storyboardId: shot.id, assetId: asset.id, role: asset.kind } })
      created += 1
    }
  }
  process.stdout.write(`bindings created: ${created}, already present: ${skipped}\n`)
}

main()
  .catch(error => {
    process.stderr.write(`${error}\n`)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
