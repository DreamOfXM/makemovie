import type { PrismaClient } from '@studio/db'

export async function recordAssetVersion(db: PrismaClient, task: { stage: string; requestSnapshot: string | null }, artifactId: string, prompt: string): Promise<void> {
  if (task.stage !== 'ASSET') return

  // The task already succeeded at this point, so a snapshot without a usable
  // asset id must not fail it.
  let assetId: string | undefined
  try {
    const parsed = JSON.parse(task.requestSnapshot ?? '') as { assetId?: unknown }
    if (typeof parsed.assetId === 'string' && parsed.assetId !== '') assetId = parsed.assetId
  } catch {
    return
  }
  if (!assetId) return

  const asset = await db.asset.findUnique({ where: { id: assetId } })
  if (!asset) return

  const latest = await db.assetVersion.findFirst({ where: { assetId }, orderBy: { version: 'desc' } })
  // The version card shows this text to the user, so it carries the readable description;
  // the exact prompt stays in promptSnapshot.
  const readable = asset.description || prompt
  await db.assetVersion.create({
    data: {
      assetId,
      version: (latest?.version ?? 0) + 1,
      description: readable,
      promptSnapshot: prompt,
      artifactId,
      status: 'DRAFT',
    },
  })

  // Mirror into the project library: a generated reference image belongs to the global
  // asset identity, so its history accumulates there for reuse across episodes.
  if (asset.projectAssetId) {
    const libLatest = await db.projectAssetVersion.findFirst({
      where: { projectAssetId: asset.projectAssetId },
      orderBy: { version: 'desc' },
    })
    await db.projectAssetVersion.create({
      data: {
        projectAssetId: asset.projectAssetId,
        version: (libLatest?.version ?? 0) + 1,
        description: readable,
        promptSnapshot: prompt,
        artifactId,
        status: 'DRAFT',
      },
    })
  }
}
