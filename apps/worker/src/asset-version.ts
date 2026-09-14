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
  await db.assetVersion.create({
    data: {
      assetId,
      version: (latest?.version ?? 0) + 1,
      description: prompt,
      promptSnapshot: prompt,
      artifactId,
      status: 'DRAFT',
    },
  })
}
