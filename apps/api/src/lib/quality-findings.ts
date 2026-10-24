import type { PrismaClient } from '@studio/db'
import type { TechnicalCheckResult } from '@studio/media'

/** Both explicit reviews and delivery-time checks publish the same adjudication evidence. */
export async function saveTechnicalReview(db: PrismaClient, composition: {
  id: string; episodeId: string; inputFingerprint: string | null; manifest: string
}, artifact: { id: string; organizationId: string }, result: TechnicalCheckResult, refreshEvidence = true): Promise<void> {
  const fingerprint = composition.inputFingerprint ?? composition.id
  await db.$transaction(async tx => {
    const manifest = { ...JSON.parse(composition.manifest), qualityFindings: result.findings, qualityCheckPassed: result.passed }
    await tx.composition.update({ where: { id: composition.id }, data: { manifest: JSON.stringify(manifest) } })
    const keys = result.findings.map(finding => `technical:${finding.id}`)
    for (const finding of result.findings) {
      const findingKey = `technical:${finding.id}`
      const prior = await tx.qualityFinding.findUnique({ where: { compositionId_findingKey: { compositionId: composition.id, findingKey } } })
      // Delivery backfills missing rows; only a real new review may refresh old evidence.
      if (prior && !refreshEvidence) continue
      const data = { fingerprint, dimension: finding.dimension, severity: finding.severity, message: finding.message, evidenceTimeSeconds: finding.evidenceTimeSeconds, artifactId: artifact.id }
      await tx.qualityFinding.upsert({
        where: { compositionId_findingKey: { compositionId: composition.id, findingKey } },
        create: { ...data, organizationId: artifact.organizationId, episodeId: composition.episodeId, compositionId: composition.id, findingKey },
        update: { ...data, ...(prior?.fingerprint === fingerprint ? {} : { status: 'open', decidedBy: null, reason: null }) },
      })
    }
    await tx.qualityFinding.updateMany({
      where: { compositionId: composition.id, fingerprint, status: { in: ['open', 'stale'] }, findingKey: { startsWith: 'technical:', ...(keys.length ? { notIn: keys } : {}) } },
      data: { status: 'resolved' },
    })
  })
}
