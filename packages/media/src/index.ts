export interface MediaArtifact {
  key: string
  checksum: string
  mimeType: string
  width?: number
  height?: number
  durationMs?: number
}

export function buildObjectKey(input: { tenantId: string; projectId: string; episodeId: string; stage: string; entityId: string; version: number; extension: string }): string {
  return [input.tenantId, input.projectId, input.episodeId, input.stage, input.entityId, `v${input.version}.${input.extension}`].join('/')
}
